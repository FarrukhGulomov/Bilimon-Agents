/**
 * PLACEHOLDER ENUM REGISTRY — NOT AUTHORITATIVE.
 *
 * These enum sets are derived only from the example JSON in the build spec
 * (see `bilimon-reference.example.json`). Some values are confirmed by the
 * example (marked CONFIRMED); others are placeholder guesses added to make
 * the pipeline runnable and are flagged PLACEHOLDER GUESS below. None of
 * this has been checked against the real BilimOn schema, because no real
 * reference JSON or codebase was supplied at build time.
 *
 * Before a real import: replace every list here with the authoritative
 * enum values from BilimOn's real schema/DB, and re-run validation.
 */

// CONFIRMED by example: LANGUAGE_CENTER. Others are PLACEHOLDER GUESSes
// for institution types that make sense for an education marketplace.
export const INSTITUTION_TYPES = [
  "LANGUAGE_CENTER",
  "COURSE_CENTER",
  "TUTORING",
  "SCHOOL",
  "LYCEUM",
] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

// CONFIRMED by example: PENDING. INACTIVE mentioned in spec as "seen in
// examples". ACTIVE/APPROVED are PLACEHOLDER GUESSes flagged for
// confirmation against the real schema.
export const INSTITUTION_STATUSES = [
  "PENDING",
  "INACTIVE",
  "ACTIVE",
  "APPROVED",
] as const;
export type InstitutionStatus = (typeof INSTITUTION_STATUSES)[number];

// CONFIRMED by example: OFFLINE. ONLINE/HYBRID are PLACEHOLDER GUESSes.
export const DELIVERY_MODES = ["OFFLINE", "ONLINE", "HYBRID"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

// PLACEHOLDER GUESS — categories matching the four priority verticals
// named in the build spec (config/priority-categories.json).
export const CATEGORIES = [
  "LANGUAGES",
  "IELTS",
  "UNIVERSITY_PREP",
  "SCHOOL_SUBJECTS",
  "KIDS_EDUCATION",
] as const;
export type Category = (typeof CATEGORIES)[number];

// PLACEHOLDER GUESS — instruction language codes.
export const LANGUAGES = ["UZ", "RU", "EN"] as const;
export type LanguageCode = (typeof LANGUAGES)[number];

// PLACEHOLDER GUESS — media kinds referenced by the placeholder `media` array.
export const MEDIA_TYPES = ["image", "logo"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export function isValidEnum<T extends readonly string[]>(
  values: T,
  candidate: unknown
): candidate is T[number] {
  return typeof candidate === "string" && (values as readonly string[]).includes(candidate);
}
