/**
 * Builds a REAL-schema BilimOnExportRecord from merged research fields +
 * generated content, and writes the final data/export/bilimon-import.json
 * (APPROVED records only) and data/export/report.json. This never writes a
 * copy of data/reference/bilimon-institutions-reference.json itself —
 * bilimon-import.json only ever contains pipeline-processed candidates.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  BilimOnExportRecord,
  BilimOnImportFile,
  ExportReport,
  RawExtractedFields,
  StateRecord,
} from "../types/index.js";
import type { ContentResult } from "./content-manager.js";
import { resolveCity } from "../services/location-mapper.js";
import { normalizePhone, normalizeUrl, normalizeLanguages } from "../services/normalizer.js";
import { getTokenUsage } from "../services/llm-client.js";
import { readLastScope } from "../services/scope-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = join(__dirname, "..", "..", "data", "export");
const STATE_DIR = join(__dirname, "..", "..", "data", "state");
const PROCESSED_DIR = join(__dirname, "..", "..", "data", "processed");

export interface BuildRecordResult {
  record: BilimOnExportRecord | null;
  buildErrors: string[];
}

/**
 * Maps merged evidence fields + generated content into the real BilimOn
 * export shape. Returns buildErrors for anything that could not be
 * resolved (e.g. unmapped city, invalid phone) so the caller can route the
 * record to NEEDS_REVIEW instead of silently guessing — in particular, a
 * city not present in the real reference data's 8 covered regions (see
 * schemas/locations.ts) always fails to resolve here rather than being
 * assigned a fabricated cityId/regionId.
 *
 * `id` here is the pipeline-internal id (see services/normalizer.ts) used
 * only for state/processed/review filenames — it is deliberately NOT
 * written into the returned record's `id` field. CONFIRMED convention (see
 * BilimOnExportRecord.id in src/types/index.ts): BilimOn's own backend
 * assigns the real cuid `id` when a record is imported, so this pipeline
 * never generates or guesses one — every exported record leaves `id: null`.
 */
export function buildExportRecord(
  id: string,
  slug: string,
  nameKey: string,
  fields: RawExtractedFields,
  content: ContentResult
): BuildRecordResult {
  const buildErrors: string[] = [];

  const cityRes = resolveCity(fields.city);
  if (!cityRes) {
    buildErrors.push(`could not resolve city "${fields.city ?? "(missing)"}" — city not present in known BilimOn reference data — real cityId/regionId unconfirmed`);
  }

  // Real BilimOn data: phone is null in 259/302 (86%) of actual records —
  // a missing phone is NOT invalid, it's the common case, and must not
  // block export. Only a phone that WAS supplied but doesn't parse as a
  // real Uzbekistan number is a build error; missing entirely just
  // resolves to null. (Real production bug: this used to hard-fail every
  // candidate with no discoverable phone number, which is most of them.)
  const phoneProvided = !!fields.phone?.trim();
  const phoneRes = normalizePhone(fields.phone);
  if (phoneProvided && !phoneRes.valid) {
    buildErrors.push(`invalid phone "${fields.phone}": ${phoneRes.reason}`);
  }
  // Real BilimOn phone2 values sometimes hold multiple comma-separated
  // numbers in one string (e.g. "+998909007966,+998944130900"). Normalize
  // the first number if possible; otherwise pass the raw value through as-is
  // rather than dropping it, since BilimOn's own field accepts a free-form
  // string here.
  const rawPhone2 = fields.phone2?.trim() || null;
  const isMultiNumberPhone2 = !!rawPhone2 && rawPhone2.includes(",");
  const normalizedPhone2 = rawPhone2 && !isMultiNumberPhone2 ? normalizePhone(rawPhone2) : null;

  if (!fields.nameUz && !fields.nameLatin) {
    buildErrors.push("no nameUz/nameLatin available");
  }

  if (buildErrors.length > 0) {
    return { record: null, buildErrors };
  }

  const record: BilimOnExportRecord = {
    id: null, // CONFIRMED: BilimOn assigns id on import — see doc comment on BilimOnExportRecord.id
    nameUz: fields.nameUz ?? fields.nameLatin!,
    nameRu: fields.nameRu ?? fields.nameUz ?? fields.nameLatin!,
    nameKey,
    slug,
    type: fields.type ?? "COURSE_CENTER",
    additionalTypes: fields.additionalTypes ?? [],
    status: "PENDING",
    phone: phoneRes.valid ? phoneRes.normalized! : null,
    // Multi-number strings (e.g. "+998909007966,+998944130900") pass through
    // as-is rather than being rejected; a single number is normalized when
    // it validates, otherwise passed through raw rather than dropped.
    phone2: isMultiNumberPhone2 ? rawPhone2 : normalizedPhone2?.valid ? normalizedPhone2.normalized! : rawPhone2,
    email: fields.email ?? null,
    // Real production bug: a bare domain like "mathuz.uz" (no scheme) from
    // a search result/extraction passed straight through here and then
    // failed the export schema's strict `https?://` URL check downstream,
    // even though normalizeUrl() (already used elsewhere for dedupe) exists
    // specifically to add the missing scheme. Now actually used.
    website: normalizeUrl(fields.website),
    telegram: fields.telegram ?? null,
    instagram: fields.instagram ?? null,
    cityId: cityRes!.cityId,
    regionId: cityRes!.regionId,
    address: fields.address ?? null,
    lat: fields.lat ?? null,
    lng: fields.lng ?? null,
    isVerified: false,
    trialLessonEnabled: false,
    deliveryMode: fields.deliveryMode ?? "OFFLINE",
    details: {
      descriptionUz: content.descriptionUz,
      descriptionRu: content.descriptionRu,
      foundedYear: fields.foundedYear ?? null,
      studentCount: fields.studentCount ?? null,
      teacherCount: fields.teacherCount ?? null,
      // Normalized, not passed through: live extraction returns whatever the
      // source page writes ("Узбекский", "Ingliz tili", ...) while the real
      // BilimOn export uses uz/ru/en/de codes. See normalizeLanguages().
      languages: normalizeLanguages(fields.languages),
      programs: fields.programs ?? [],
      shifts: fields.shifts ?? [],
      specializations: fields.specializations ?? [],
      achievements: fields.achievements ?? null,
      categories: fields.categories ?? [],
    },
    pricing: null,
    media: [],
    branches: [],
  };

  return { record, buildErrors: [] };
}

function ensureDirs(): void {
  for (const d of [EXPORT_DIR, PROCESSED_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

export function writeProcessedRecord(id: string, record: BilimOnExportRecord): void {
  ensureDirs();
  writeFileSync(join(PROCESSED_DIR, `${id}.json`), JSON.stringify(record, null, 2), "utf-8");
}

export function readProcessedRecord(id: string): BilimOnExportRecord | null {
  const p = join(PROCESSED_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as BilimOnExportRecord;
}

function readAllStates(): StateRecord[] {
  if (!existsSync(STATE_DIR)) return [];
  return readdirSync(STATE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(STATE_DIR, f), "utf-8")) as StateRecord);
}

/** Writes bilimon-import.json (APPROVED-state records only) and report.json. */
export function exportFinalArtifacts(): { importPath: string; reportPath: string; report: ExportReport } {
  ensureDirs();
  const states = readAllStates();

  const approvedRecords: BilimOnExportRecord[] = [];
  let completenessSum = 0;
  let confidenceSum = 0;
  let scoredCount = 0;
  let duplicates = 0;
  let needsReview = 0;
  let rejected = 0;
  let totalProcessed = 0;

  for (const s of states) {
    const isDuplicate = s.lastError === "duplicate";
    if (isDuplicate) duplicates++;
    if (s.state === "NEEDS_REVIEW") needsReview++;
    if (s.state === "REJECTED" && !isDuplicate) rejected++;
    if (["JSON_READY", "APPROVED", "NEEDS_REVIEW"].includes(s.state)) totalProcessed++;
    if (s.scores) {
      completenessSum += s.scores.dataCompleteness;
      confidenceSum += s.scores.sourceConfidence;
      scoredCount++;
    }
    if (s.state === "APPROVED") {
      const rec = readProcessedRecord(s.id);
      if (rec) approvedRecords.push(rec);
    }
  }

  // Real production bug: this used to write `approvedRecords` directly as a
  // bare top-level array. Every record inside matched the real schema, but
  // the FILE ITSELF didn't match a real BilimOn export/import file, whose
  // top level is {version, exportedAt, institutions: [...]} — confirmed
  // against data/reference/bilimon-institutions-reference.json (see
  // BilimOnImportFile in src/types/index.ts). Wrap it the same way.
  const importFile: BilimOnImportFile = {
    version: 1,
    exportedAt: new Date().toISOString(),
    institutions: approvedRecords,
  };
  const importPath = join(EXPORT_DIR, "bilimon-import.json");
  writeFileSync(importPath, JSON.stringify(importFile, null, 2), "utf-8");

  const report: ExportReport = {
    totalDiscovered: states.length,
    totalProcessed,
    approved: approvedRecords.length,
    needsReview,
    rejected,
    duplicates,
    averageCompleteness: scoredCount > 0 ? Math.round(completenessSum / scoredCount) : 0,
    averageConfidence: scoredCount > 0 ? Math.round(confidenceSum / scoredCount) : 0,
    estimatedTokenUsage: getTokenUsage(),
    resolvedScope: readLastScope(),
    generatedAt: new Date().toISOString(),
  };
  const reportPath = join(EXPORT_DIR, "report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

  return { importPath, reportPath, report };
}
