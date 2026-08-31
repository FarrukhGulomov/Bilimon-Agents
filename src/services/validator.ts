/**
 * Validates BilimOnExportRecord candidates against the PLACEHOLDER schema
 * (src/schemas/bilimon-export.zod.ts) plus batch-level rules (slug
 * uniqueness, duplicate detection). Unrecognized enum values are never
 * silently accepted — they route to NEEDS_REVIEW via a validation failure.
 */
import type { BilimOnExportRecord, ValidationResult } from "../types/index.js";
import { BilimOnExportRecordZ } from "../schemas/bilimon-export.zod.js";
import { isKnownCityId, isKnownRegionId } from "./location-mapper.js";
import { normalizeNameKey } from "./normalizer.js";

/** Validates a single record's shape/enums/ids. Does not check batch-level uniqueness. */
export function validateRecord(record: BilimOnExportRecord): ValidationResult {
  const reasons: string[] = [];

  const parsed = BilimOnExportRecordZ.safeParse(record);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      reasons.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  }

  if (!isKnownCityId(record.cityId)) {
    reasons.push(`cityId ${record.cityId} not found in the placeholder location seed table`);
  }
  if (!isKnownRegionId(record.regionId)) {
    reasons.push(`regionId ${record.regionId} not found in the placeholder location seed table`);
  }

  if (record.details.categories.length === 0) {
    reasons.push("details.categories must be non-empty");
  }

  // Descriptions are not hard-required (content manager may leave them null
  // when source material is insufficient), but at least one language should
  // exist once a record reaches APPROVED status.
  if (!record.details.descriptionUz && !record.details.descriptionRu) {
    reasons.push("both descriptionUz and descriptionRu are null — insufficient content for export");
  }

  return { valid: reasons.length === 0, reasons };
}

/** Batch-level checks: slug uniqueness and duplicate nameKey+city detection. */
export function validateBatch(records: BilimOnExportRecord[]): Map<string, ValidationResult> {
  const results = new Map<string, ValidationResult>();
  const slugCounts = new Map<string, number>();
  const nameCityCounts = new Map<string, number>();

  for (const r of records) {
    slugCounts.set(r.slug, (slugCounts.get(r.slug) ?? 0) + 1);
    const nameCityKey = `${normalizeNameKey(r.nameUz)}|${r.cityId}`;
    nameCityCounts.set(nameCityKey, (nameCityCounts.get(nameCityKey) ?? 0) + 1);
  }

  for (const r of records) {
    const single = validateRecord(r);
    const reasons = [...single.reasons];

    if ((slugCounts.get(r.slug) ?? 0) > 1) {
      reasons.push(`slug "${r.slug}" is not unique across the batch`);
    }
    const nameCityKey = `${normalizeNameKey(r.nameUz)}|${r.cityId}`;
    if ((nameCityCounts.get(nameCityKey) ?? 0) > 1) {
      reasons.push(`duplicate institution detected in batch (same normalized name + city as another record)`);
    }

    results.set(r.id, { valid: reasons.length === 0, reasons });
  }

  return results;
}
