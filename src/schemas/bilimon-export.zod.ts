/**
 * REAL zod schema for the BilimOn export record, mirroring the actual
 * production export at data/reference/bilimon-institutions-reference.json
 * (302 real institutions) and src/types/index.ts BilimOnExportRecord. See
 * README.md "Schema status: REAL" for how each field/enum was verified.
 */
import { z } from "zod";
import {
  CATEGORIES,
  DELIVERY_MODES,
  INSTITUTION_STATUSES,
  INSTITUTION_TYPES,
} from "./enums.js";

// Our own pipeline normalizes any phone it fills in to this shape (see
// services/normalizer.ts::normalizePhone), but the real export shows this
// is NOT a schema-level guarantee: 259/302 real records have phone:null and
// 10 more have raw messy formats ("+998 (90) 900-79-66"). The zod schema
// below is therefore permissive on `phone`/`phone2` shape (nullable free-form
// string) — src/services/validator.ts soft-flags an unnormalized phone for
// review rather than the zod layer hard-rejecting real-shaped data.
export const phoneRegex = /^\+998\d{9}$/;
const urlRegex = /^https?:\/\/.+/i;
// details.languages: lowercase 2-3 letter code. Real observed set is
// uz/ru/en/de but this is treated as extensible, not closed — see enums.ts.
const languageCodeRegex = /^[a-z]{2,3}$/;

export const InstitutionTypeZ = z.enum(INSTITUTION_TYPES);
export const InstitutionStatusZ = z.enum(INSTITUTION_STATUSES);
export const DeliveryModeZ = z.enum(DELIVERY_MODES);
export const CategoryZ = z.enum(CATEGORIES);
export const LanguageCodeZ = z.string().regex(languageCodeRegex, "language code must be a lowercase 2-3 letter code");

// media/branches are always [] in the real export; per-element shape is
// genuinely unconfirmed, so we accept anything rather than asserting a
// guessed structure (see src/types/index.ts MediaItem/BranchRecord).
export const MediaItemZ = z.unknown();
export const BranchZ = z.unknown();

// Real shape, observed in 34/302 records: {monthlyMin, monthlyMax, paymentMethods}.
// Replaces the old placeholder's guessed {min, max, currency, notes} shape.
export const PricingZ = z
  .object({
    monthlyMin: z.number(),
    monthlyMax: z.number(),
    paymentMethods: z.array(z.string()),
  })
  .nullable();

export const DetailsZ = z.object({
  descriptionUz: z.string().nullable(),
  descriptionRu: z.string().nullable(),
  foundedYear: z.number().int().nullable(),
  studentCount: z.number().int().nullable(),
  teacherCount: z.number().int().nullable(),
  languages: z.array(LanguageCodeZ),
  programs: z.array(z.string()),
  shifts: z.array(z.string()),
  specializations: z.array(z.string()),
  achievements: z.string().nullable(),
  categories: z.array(CategoryZ),
});

export const BilimOnExportRecordZ = z.object({
  // See src/types/index.ts BilimOnExportRecord.id doc comment — nullable
  // pending confirmation of BilimOn's real import id convention.
  id: z.string().min(1).nullable(),
  nameUz: z.string().min(1),
  nameRu: z.string().min(1),
  nameKey: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be url-safe kebab-case"),
  type: InstitutionTypeZ,
  additionalTypes: z.array(InstitutionTypeZ),
  status: InstitutionStatusZ,
  phone: z.string().nullable(), // real data: null in 259/302 records, one empty string, or a raw messy format
  phone2: z.string().nullable(), // real data: sometimes multiple comma-separated numbers in one string
  email: z.string().email().nullable(),
  website: z.string().regex(urlRegex).nullable(),
  telegram: z.string().nullable(), // real data: bare handle or full URL, both legal
  instagram: z.string().nullable(), // real data: bare handle or full URL, both legal
  // Both nullable: the real export has cityId:null+regionId:set (11 records,
  // region known/city unspecified) and cityId:null+regionId:null (3 records,
  // fully unknown location) — both are legal per the real schema.
  cityId: z.string().min(1).nullable(),
  regionId: z.string().min(1).nullable(),
  address: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  isVerified: z.boolean(),
  trialLessonEnabled: z.boolean(),
  deliveryMode: DeliveryModeZ,
  details: DetailsZ,
  pricing: PricingZ,
  media: z.array(MediaItemZ),
  branches: z.array(BranchZ),
});

export type BilimOnExportRecordParsed = z.infer<typeof BilimOnExportRecordZ>;
