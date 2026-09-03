/**
 * REAL BilimOn enum registry — derived from the actual production export
 * at data/reference/bilimon-institutions-reference.json (302 institutions,
 * exported 2026-08-31). Every value below was counted directly from that
 * file, not guessed. See README.md "Schema status: REAL" for the full
 * verification method, including the `id` field convention (this pipeline
 * generates a fresh cuid-shaped `id` itself — BilimOn's real import
 * endpoint rejects `id: null` — see src/services/normalizer.ts and
 * src/types/index.ts).
 *
 * Caveat: the reference export only covers 8 of Uzbekistan's ~14 regions
 * (see src/schemas/locations.ts), so enum members that happen to have zero
 * occurrences in this sample are noted as such below — absence in 302
 * records is evidence, not proof, that a plausible-sounding value doesn't
 * exist elsewhere in BilimOn's real schema.
 */

// CONFIRMED — all 5 values observed: LANGUAGE_CENTER (138), COURSE_CENTER (98),
// TUTORING (55), SCHOOL (8), LYCEUM (3). additionalTypes draws from this same
// enum (only COURSE_CENTER observed there, 6 records).
export const INSTITUTION_TYPES = [
  "LANGUAGE_CENTER",
  "COURSE_CENTER",
  "TUTORING",
  "SCHOOL",
  "LYCEUM",
] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

// CONFIRMED — exactly 3 values observed: PENDING (261), ACTIVE (34), INACTIVE (7).
// The old placeholder's guessed 4th value, APPROVED, does NOT appear anywhere
// in the real export and has been removed — reintroduce only if BilimOn
// confirms it exists.
export const INSTITUTION_STATUSES = ["PENDING", "ACTIVE", "INACTIVE"] as const;
export type InstitutionStatus = (typeof INSTITUTION_STATUSES)[number];

// OFFLINE (301) and HYBRID (1) are CONFIRMED. ONLINE has zero occurrences in
// the 302-record sample. Kept in the enum (schema-legal, not rejected
// outright) rather than dropped, since a 0-count in an 8-region sample isn't
// proof a fully-remote institution can never exist in BilimOn's real schema
// — but src/services/validator.ts flags any ONLINE record for review rather
// than silently treating it as routine, precisely because it's unconfirmed.
export const DELIVERY_MODES = ["OFFLINE", "HYBRID", "ONLINE"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

// CONFIRMED — all 9 values observed in details.categories across the real
// export: LANGUAGES (138), SCHOOL_SUBJECTS (74), UNIVERSITY_PREP (73),
// KIDS_EDUCATION (56), IELTS (43), CEFR (16), SAT (15), IT_COURSES (1),
// PROFESSIONAL_CERTIFICATION (1). Replaces the old placeholder's 5-value guess.
export const CATEGORIES = [
  "LANGUAGES",
  "SCHOOL_SUBJECTS",
  "UNIVERSITY_PREP",
  "KIDS_EDUCATION",
  "IELTS",
  "CEFR",
  "SAT",
  "IT_COURSES",
  "PROFESSIONAL_CERTIFICATION",
] as const;
export type Category = (typeof CATEGORIES)[number];

// details.languages real codes observed: uz (301), ru (296), en (22), de (1)
// — lowercase, unlike the old placeholder's guessed uppercase "UZ"/"RU"/"EN".
// Treated as a controlled-but-extensible list, not a closed zod enum: the
// zod schema (bilimon-export.zod.ts) only enforces the lowercase 2-3-letter
// shape, and src/services/validator.ts soft-flags any code outside this
// known set for review instead of hard-rejecting it, since more languages
// almost certainly exist once coverage expands beyond these 8 regions.
export const KNOWN_LANGUAGE_CODES = ["uz", "ru", "en", "de"] as const;
export type LanguageCode = string;

// `media` and `branches` are always `[]` in all 302 real records — their
// real per-element schema is genuinely unconfirmed by this export. No media
// "type" enum exists to confirm, so the old placeholder's guessed
// MEDIA_TYPES ("image"/"logo") has been removed rather than carried forward
// as fact. See src/types/index.ts MediaItem/BranchRecord.

export function isValidEnum<T extends readonly string[]>(
  values: T,
  candidate: unknown
): candidate is T[number] {
  return typeof candidate === "string" && (values as readonly string[]).includes(candidate);
}
