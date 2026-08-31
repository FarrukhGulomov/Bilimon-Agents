/**
 * PLACEHOLDER zod schema for the BilimOn export record. Mirrors
 * bilimon-reference.example.json / src/types/index.ts BilimOnExportRecord.
 * NOT the authoritative BilimOn schema — see that file's header comment.
 */
import { z } from "zod";
import {
  CATEGORIES,
  DELIVERY_MODES,
  INSTITUTION_STATUSES,
  INSTITUTION_TYPES,
  LANGUAGES,
  MEDIA_TYPES,
} from "./enums.js";

const phoneRegex = /^\+998\d{9}$/;
const urlRegex = /^https?:\/\/.+/i;

export const InstitutionTypeZ = z.enum(INSTITUTION_TYPES);
export const InstitutionStatusZ = z.enum(INSTITUTION_STATUSES);
export const DeliveryModeZ = z.enum(DELIVERY_MODES);
export const CategoryZ = z.enum(CATEGORIES);
export const LanguageCodeZ = z.enum(LANGUAGES);
export const MediaTypeZ = z.enum(MEDIA_TYPES);

export const MediaItemZ = z.object({
  type: MediaTypeZ,
  url: z.string().regex(urlRegex, "media.url must be an http(s) URL"),
});

export const PricingZ = z
  .object({
    min: z.number().nullable(),
    max: z.number().nullable(),
    currency: z.literal("UZS"),
    notes: z.string().nullable(),
  })
  .nullable();

export const BranchZ = z.object({
  id: z.string().min(1),
  address: z.string().nullable(),
  cityId: z.number().int().nullable(),
  phone: z.string().nullable(),
});

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
  id: z.string().min(1),
  nameUz: z.string().min(1),
  nameRu: z.string().min(1),
  nameKey: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be url-safe kebab-case"),
  type: InstitutionTypeZ,
  additionalTypes: z.array(InstitutionTypeZ),
  status: InstitutionStatusZ,
  phone: z.string().regex(phoneRegex, "phone must match +998XXXXXXXXX"),
  phone2: z.string().regex(phoneRegex).nullable(),
  email: z.string().email().nullable(),
  website: z.string().regex(urlRegex).nullable(),
  telegram: z.string().nullable(),
  instagram: z.string().nullable(),
  cityId: z.number().int().positive(),
  regionId: z.number().int().positive(),
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
