/**
 * Builds a PLACEHOLDER BilimOnExportRecord from merged research fields +
 * generated content, and writes the final data/export/bilimon-import.json
 * (APPROVED records only) and data/export/report.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  BilimOnExportRecord,
  ExportReport,
  RawExtractedFields,
  StateRecord,
} from "../types/index.js";
import type { ContentResult } from "./content-manager.js";
import { resolveCity } from "../services/location-mapper.js";
import { normalizePhone } from "../services/normalizer.js";
import { getTokenUsage } from "../services/llm-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = join(__dirname, "..", "..", "data", "export");
const STATE_DIR = join(__dirname, "..", "..", "data", "state");
const PROCESSED_DIR = join(__dirname, "..", "..", "data", "processed");

export interface BuildRecordResult {
  record: BilimOnExportRecord | null;
  buildErrors: string[];
}

/**
 * Maps merged evidence fields + generated content into the placeholder
 * BilimOn export shape. Returns buildErrors for anything that could not be
 * resolved (e.g. unmapped city, invalid phone) so the caller can route the
 * record to NEEDS_REVIEW instead of silently guessing.
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
    buildErrors.push(`could not resolve city "${fields.city ?? "(missing)"}" against the placeholder location table`);
  }

  const phoneRes = normalizePhone(fields.phone);
  if (!phoneRes.valid) {
    buildErrors.push(`invalid/missing phone: ${phoneRes.reason}`);
  }
  const phone2Res = fields.phone2 ? normalizePhone(fields.phone2) : null;

  if (!fields.nameUz && !fields.nameLatin) {
    buildErrors.push("no nameUz/nameLatin available");
  }

  if (buildErrors.length > 0) {
    return { record: null, buildErrors };
  }

  const record: BilimOnExportRecord = {
    id,
    nameUz: fields.nameUz ?? fields.nameLatin!,
    nameRu: fields.nameRu ?? fields.nameUz ?? fields.nameLatin!,
    nameKey,
    slug,
    type: fields.type ?? "COURSE_CENTER",
    additionalTypes: fields.additionalTypes ?? [],
    status: "PENDING",
    phone: phoneRes.normalized!,
    phone2: phone2Res?.valid ? phone2Res.normalized! : null,
    email: fields.email ?? null,
    website: fields.website ?? null,
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
      languages: fields.languages ?? [],
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

  const importPath = join(EXPORT_DIR, "bilimon-import.json");
  writeFileSync(importPath, JSON.stringify(approvedRecords, null, 2), "utf-8");

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
    generatedAt: new Date().toISOString(),
  };
  const reportPath = join(EXPORT_DIR, "report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

  return { importPath, reportPath, report };
}
