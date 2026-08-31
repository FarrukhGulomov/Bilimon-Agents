/**
 * sourceConfidence / dataCompleteness / qualityScore computation and the
 * approved/needs_review/rejected status thresholds. Thresholds are loaded
 * from config/thresholds.json (configurable without a code change).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { EnrichedInstitution, ScoreResult } from "../types/index.js";

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
