/**
 * sourceConfidence / dataCompleteness / qualityScore computation and the
 * approved/needs_review/rejected status thresholds. Thresholds are loaded
 * from config/thresholds.json (configurable without a code change).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { EnrichedInstitution, EvidenceItem, RawExtractedFields, ScoreResult } from "../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const thresholdsPath = join(__dirname, "..", "..", "config", "thresholds.json");

interface ThresholdsConfig {
  APPROVED: number;
  APPROVED_WITH_WARNINGS: number;
  NEEDS_REVIEW: number;
  REJECTED: number;
  weights: { sourceConfidence: number; dataCompleteness: number };
}

let cachedThresholds: ThresholdsConfig | null = null;
export function loadThresholds(): ThresholdsConfig {
  if (!cachedThresholds) {
    cachedThresholds = JSON.parse(readFileSync(thresholdsPath, "utf-8"));
  }
  return cachedThresholds as ThresholdsConfig;
}

const REQUIRED_FOR_COMPLETENESS: (keyof EnrichedInstitution["fields"])[] = [
  "nameUz",
  "phone",
  "city",
  "address",
  "type",
  "categories",
  "deliveryMode",
];

const BONUS_FIELDS: (keyof EnrichedInstitution["fields"])[] = [
  "email",
  "website",
  "telegram",
  "instagram",
  "foundedYear",
  "studentCount",
  "teacherCount",
  "programs",
  "specializations",
];

export function computeDataCompleteness(fields: EnrichedInstitution["fields"]): number {
  const requiredPresent = REQUIRED_FOR_COMPLETENESS.filter((k) => {
    const v = fields[k];
    return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== "";
  }).length;
  const bonusPresent = BONUS_FIELDS.filter((k) => {
    const v = fields[k];
    return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== "";
  }).length;

  const requiredScore = (requiredPresent / REQUIRED_FOR_COMPLETENESS.length) * 80;
  const bonusScore = (bonusPresent / BONUS_FIELDS.length) * 20;
  return Math.round(requiredScore + bonusScore);
}

/** sourceConfidence: derived from evidence count and best single-source confidence. */
export function computeSourceConfidence(evidenceCount: number, bestSourceConfidence: number): number {
  const countFactor = Math.min(evidenceCount, 3) / 3; // saturates at 3 corroborating sources
  const raw = bestSourceConfidence * 0.7 + countFactor * 0.3;
  return Math.round(raw * 100);
}

// --- Per-evidence confidence (real mode) ---------------------------------
//
// Real production bug this replaces: agents/researcher.ts hardcoded
// `confidence: 0.6` on every real-mode evidence item, and the evidence array
// was never longer than 1 (one URL scraped, and usually not even that). So
// computeSourceConfidence(1, 0.6) = 0.6*0.7 + (1/3)*0.3 = 0.52 — every real
// run logged confidence=52, exactly, forever. With the 50/50 weights in
// config/thresholds.json and a typical completeness around 55, qualityScore
// landed near 54 and the APPROVED threshold of 85 could not be reached by
// any institution, no matter how good the data was. Confidence has to be a
// function of the evidence, not a constant.
//
// The model below is deliberately simple and defensible:
//   base        — how much a source of this KIND is worth on its own. An
//                 institution's own website is the strongest single source;
//                 a curated directory listing (yellowpages.uz/goldenpages.uz)
//                 is next; a search-grounded research summary spans several
//                 pages but is model-mediated; a social profile is thin and
//                 often marketing copy.
//   richness    — how much substantive detail this source actually yielded.
//                 A page that produced a phone, an address, a website and a
//                 program list is worth more than one that produced a name.
//   corroborate — how many identifying facts (phone / website / address)
//                 another independent source agreed on. Two sources agreeing
//                 on a phone number is the strongest signal this pipeline
//                 can get without a human.
// Capped at 0.95: nothing this pipeline gathers is human-verified, and
// isVerified is always false on export.

const SOURCE_TYPE_BASE: Record<EvidenceItem["sourceType"], number> = {
  website: 0.72, // the institution's own site
  directory: 0.62, // yellowpages.uz / goldenpages.uz style structured listing
  search: 0.58, // web-search-grounded research summary over several pages
  social: 0.55, // Instagram/Telegram profile text
  fixture: 0.6, // --mock only; fixtures carry their own confidence, so unused in practice
  other: 0.5,
};

/** Fields that mean a source actually told us something sellable, rather
 * than just echoing a name. Matches the "sales facts" Agent 2 is asked for. */
const SUBSTANTIVE_FIELDS: (keyof RawExtractedFields)[] = [
  "phone",
  "address",
  "website",
  "email",
  "telegram",
  "instagram",
  "programs",
  "specializations",
  "foundedYear",
  "descriptionSourceText",
];

const RICHNESS_SATURATION = 6; // 6+ substantive fields is a fully-detailed source
const MAX_RICHNESS_BONUS = 0.18;
const CORROBORATION_STEP = 0.05;
const MAX_CORROBORATION_BONUS = 0.1;
const MAX_EVIDENCE_CONFIDENCE = 0.95;
const MIN_EVIDENCE_CONFIDENCE = 0.3;

function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

export interface EvidenceConfidenceInput {
  sourceType: EvidenceItem["sourceType"];
  fields: Partial<RawExtractedFields>;
  /** How many identifying facts (phone/website/address) at least one OTHER
   * source independently agreed on — see countCorroboratedFields. */
  corroboratedFieldCount?: number;
}

export function computeEvidenceConfidence(input: EvidenceConfidenceInput): number {
  const base = SOURCE_TYPE_BASE[input.sourceType] ?? SOURCE_TYPE_BASE.other;
  const substantive = SUBSTANTIVE_FIELDS.filter((k) => hasValue(input.fields[k])).length;
  const richness = (Math.min(substantive, RICHNESS_SATURATION) / RICHNESS_SATURATION) * MAX_RICHNESS_BONUS;
  const corroboration = Math.min(
    (input.corroboratedFieldCount ?? 0) * CORROBORATION_STEP,
    MAX_CORROBORATION_BONUS
  );
  const raw = base + richness + corroboration;
  return Math.min(MAX_EVIDENCE_CONFIDENCE, Math.max(MIN_EVIDENCE_CONFIDENCE, Number(raw.toFixed(4))));
}

/** Identifying facts used to decide whether two sources are talking about
 * the same institution with the same details. Deliberately narrow: agreeing
 * on "programs" is weak, agreeing on a phone number is not. */
const CORROBORATING_FIELDS: (keyof RawExtractedFields)[] = ["phone", "website", "address"];

function comparableValue(field: keyof RawExtractedFields, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (field === "phone") return trimmed.replace(/[^0-9]/g, "").slice(-9) || null; // compare national part
  if (field === "website") return trimmed.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  return trimmed.replace(/\s+/g, " ");
}

/**
 * How many identifying fields in `fields` are independently stated, with the
 * same value, by at least one of `others`. Pure — exported for tests.
 */
export function countCorroboratedFields(
  fields: Partial<RawExtractedFields>,
  others: Partial<RawExtractedFields>[]
): number {
  let count = 0;
  for (const field of CORROBORATING_FIELDS) {
    const mine = comparableValue(field, fields[field]);
    if (!mine) continue;
    const agreed = others.some((other) => comparableValue(field, other[field]) === mine);
    if (agreed) count++;
  }
  return count;
}

export function computeStatus(qualityScore: number): ScoreResult["status"] {
  const t = loadThresholds();
  if (qualityScore >= t.APPROVED) return "APPROVED";
  if (qualityScore >= t.APPROVED_WITH_WARNINGS) return "APPROVED_WITH_WARNINGS";
  if (qualityScore >= t.NEEDS_REVIEW) return "NEEDS_REVIEW";
  return "REJECTED";
}

export function scoreInstitution(enriched: EnrichedInstitution): ScoreResult {
  const t = loadThresholds();
  const dataCompleteness = computeDataCompleteness(enriched.fields);
  const sourceConfidence = computeSourceConfidence(enriched.evidenceCount, enriched.bestSourceConfidence);
  const qualityScore = Math.round(
    sourceConfidence * t.weights.sourceConfidence + dataCompleteness * t.weights.dataCompleteness
  );
  const status = computeStatus(qualityScore);
  return { sourceConfidence, dataCompleteness, qualityScore, status };
}
