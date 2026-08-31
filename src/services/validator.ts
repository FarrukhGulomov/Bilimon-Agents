/**
 * Validates BilimOnExportRecord candidates against the REAL schema
 * (src/schemas/bilimon-export.zod.ts) plus batch-level rules (slug
 * uniqueness, duplicate detection). Unrecognized enum values are never
 * silently accepted — they route to NEEDS_REVIEW via a validation failure.
 * Also soft-flags a couple of real-data-observed-but-unconfirmed cases
 * (deliveryMode ONLINE, an unrecognized language code) for review rather
 * than treating them as routine, without hard-rejecting values the real
 * schema may legally allow — see schemas/enums.ts for the reasoning.
 */
import type { BilimOnExportRecord, ValidationResult } from "../types/index.js";
import { BilimOnExportRecordZ } from "../schemas/bilimon-export.zod.js";
import { isKnownCityId, isKnownRegionId } from "./location-mapper.js";
import { normalizeNameKey, normalizePhone } from "./normalizer.js";
import { KNOWN_LANGUAGE_CODES } from "../schemas/enums.js";

/** Validates a single record's shape/enums/ids. Does not check batch-level uniqueness. */
export function validateRecord(record: BilimOnExportRecord): ValidationResult {
  const reasons: string[] = [];

  const parsed = BilimOnExportRecordZ.safeParse(record);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      reasons.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  }

  // null cityId/regionId is a legal real-schema value (see schemas/locations.ts) —
  // only a non-null id that isn't in our known table is treated as a problem.
  if (!isKnownCityId(record.cityId)) {
    reasons.push(`cityId ${record.cityId} not found in the real BilimOn location reference table (city not present in known BilimOn reference data — real cityId/regionId unconfirmed)`);
  }
  if (!isKnownRegionId(record.regionId)) {
    reasons.push(`regionId ${record.regionId} not found in the real BilimOn location reference table (region not present in known BilimOn reference data — real regionId unconfirmed)`);
  }

  // `phone` is legally nullable in the real schema (259/302 real records
  // have phone:null) and real records also contain raw messy formats — this
  // pipeline's own generated records should always be normalized, so an
  // unnormalized (but present) phone is soft-flagged for review rather than
  // hard-rejected at the zod layer (which must still accept real-shaped data).
  if (record.phone && !normalizePhone(record.phone).valid) {
    reasons.push(`phone "${record.phone}" is not normalized to +998XXXXXXXXX — flagged for review (real BilimOn export contains raw/messy phone formats too, but this pipeline's own output should be normalized)`);
  }

  if (record.deliveryMode === "ONLINE") {
    reasons.push("deliveryMode ONLINE has zero occurrences in the real reference export — schema-legal but flagged for review pending confirmation");
  }

  const unknownLanguages = record.details.languages.filter(
    (l) => !(KNOWN_LANGUAGE_CODES as readonly string[]).includes(l)
  );
  if (unknownLanguages.length > 0) {
    reasons.push(
      `details.languages contains code(s) not yet observed in the real BilimOn export (${unknownLanguages.join(", ")}) — flagged for review, may still be legal`
    );
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

/** Batch-level checks: slug uniqueness and duplicate nameKey+city detection.
 * Keyed by `slug` rather than `id`, since `id` is nullable in the real
 * schema (see BilimOnExportRecord.id doc comment) and slug is always
 * present and unique within a batch. */
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

    results.set(r.slug, { valid: reasons.length === 0, reasons });
  }

  return results;
}
