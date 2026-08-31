/**
 * Internal pipeline types. The `BilimOnExportRecord` shape mirrors the REAL
 * BilimOn production export at
 * data/reference/bilimon-institutions-reference.json (302 institutions) —
 * see README.md "Schema status: REAL" for the verification method and the
 * one still-open question (the `id` field convention, noted on that field
 * below).
 */
import type {
  Category,
  DeliveryMode,
  InstitutionStatus,
  InstitutionType,
  LanguageCode,
} from "../schemas/enums.js";

export type PipelineState =
  | "DISCOVERED"
  | "RESEARCHING"
  | "VERIFIED"
  | "CONTENT_READY"
  | "JSON_READY"
  | "APPROVED"
  | "NEEDS_REVIEW"
  | "REJECTED";

export interface StateRecord {
  /** Deterministic, pipeline-internal id (see services/normalizer.ts::generateId) —
   * deliberately NOT a BilimOn cuid and NOT the value written to
   * BilimOnExportRecord.id. Used only to key data/state|processed|review/<id>.json. */
  id: string;
  state: PipelineState;
  createdAt: string;
  updatedAt: string;
  retryCount: number;
  lastError?: string;
  history: { state: PipelineState; at: string; note?: string }[];
  scores?: ScoreResult;
}

/** Raw candidate found by the Discovery agent, pre-dedupe/pre-research. */
export interface DiscoveredInstitution {
  discoveryId: string; // temp id before nameKey/slug are finalized
  rawName: string;
  city?: string;
  category?: string;
  sourceUrl?: string;
  sourceType: "web_search" | "fixture" | "manual";
  notes?: string;
  discoveredAt: string;
}

/** One piece of evidence gathered by the Researcher agent for one institution. */
export interface EvidenceItem {
  fetchedAt: string;
  sourceUrl: string;
  sourceType: "website" | "social" | "directory" | "fixture" | "other";
  extractedFields: Partial<RawExtractedFields>;
  rawTextExcerpt?: string;
  confidence: number; // 0-1, this evidence item's own reliability
}

/** Research evidence file: data/research/<id>.json — append-only. */
export interface ResearchRecord {
  id: string;
  nameKey: string;
  evidence: EvidenceItem[];
}

/** Fields the extractor/researcher may populate from source material. */
export interface RawExtractedFields {
  nameUz?: string;
  nameRu?: string;
  nameLatin?: string;
  type?: InstitutionType;
  additionalTypes?: InstitutionType[];
  phone?: string;
  phone2?: string;
  email?: string;
  website?: string;
  telegram?: string;
  instagram?: string;
  city?: string;
  address?: string;
  lat?: number;
  lng?: number;
  deliveryMode?: DeliveryMode;
  foundedYear?: number;
  studentCount?: number;
  teacherCount?: number;
  languages?: LanguageCode[];
  programs?: string[];
  shifts?: string[];
  specializations?: string[];
  achievements?: string;
  categories?: Category[];
  descriptionSourceText?: string; // real source text the content manager may draw on
}

/** Merged, deduped, research-backed candidate prior to content generation. */
export interface EnrichedInstitution {
  id: string;
  nameKey: string;
  slug: string;
  fields: RawExtractedFields;
  duplicateOf?: string; // set if merged into another record
  mergedFromIds?: string[];
  evidenceCount: number;
  bestSourceConfidence: number;
}

export interface ScoreResult {
  sourceConfidence: number; // 0-100
  dataCompleteness: number; // 0-100
  qualityScore: number; // 0-100 combined
  status: "APPROVED" | "APPROVED_WITH_WARNINGS" | "NEEDS_REVIEW" | "REJECTED";
}

/**
 * `media` is always `[]` in all 302 real reference records — its real
 * per-element schema is genuinely unconfirmed. Kept as `unknown` rather
 * than carrying forward the old placeholder's invented {type, url} shape.
 */
export type MediaItem = unknown;

/** Real pricing shape, observed in 34/302 records (268/302 have pricing: null). */
export interface PricingInfo {
  monthlyMin: number;
  monthlyMax: number;
  paymentMethods: string[];
}

export interface InstitutionDetails {
  descriptionUz: string | null;
  descriptionRu: string | null;
  foundedYear: number | null;
  studentCount: number | null;
  teacherCount: number | null;
  languages: LanguageCode[];
  programs: string[];
  shifts: string[];
  specializations: string[];
  achievements: string | null;
  categories: Category[];
}

/**
 * `branches` is always `[]` in all 302 real reference records — its real
 * per-element schema is genuinely unconfirmed. Kept as `unknown` rather
 * than carrying forward the old placeholder's invented shape.
 */
export type BranchRecord = unknown;

/** The REAL BilimOn export record shape (see README.md "Schema status: REAL"). */
export interface BilimOnExportRecord {
  /**
   * OPEN QUESTION for the user to confirm against BilimOn's real
   * backend/import mechanism: the 302 real records all carry cuid-style ids
   * (e.g. "cmrfw8t5o001an3ogocewc8g6") that look auto-assigned on insert,
   * not client-supplied. We cannot inspect BilimOn's real import code from
   * this data export alone, so this pipeline defaults to NOT fabricating a
   * fake-looking cuid: exported records leave `id` null and let BilimOn's
   * own import assign the real id. If BilimOn's import instead requires a
   * client-supplied cuid, generate one here and update this comment.
   * Pipeline-internal state tracking uses a separate, clearly-prefixed id
   * (see StateRecord.id / services/normalizer.ts::generateId) — never this field.
   */
  id: string | null;
  nameUz: string;
  nameRu: string;
  nameKey: string;
  slug: string;
  type: InstitutionType;
  additionalTypes: InstitutionType[];
  status: InstitutionStatus;
  /** Nullable in the real data: 259/302 real records have phone:null, and 10
   * more have raw messy formats ("+998 (90) 900-79-66") rather than
   * normalized +998XXXXXXXXX — see README.md field-quirks notes. */
  phone: string | null;
  phone2: string | null;
  email: string | null;
  website: string | null;
  telegram: string | null;
  instagram: string | null;
  /** null only for the "region known, city unspecified" real case — see schemas/locations.ts. */
  cityId: string | null;
  /** null for the "fully unknown location" real case (3/302 records) — see schemas/locations.ts. */
  regionId: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  isVerified: boolean;
  trialLessonEnabled: boolean;
  deliveryMode: DeliveryMode;
  details: InstitutionDetails;
  pricing: PricingInfo | null;
  media: MediaItem[];
  branches: BranchRecord[];
}

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

export interface ExportReport {
  totalDiscovered: number;
  totalProcessed: number;
  approved: number;
  needsReview: number;
  rejected: number;
  duplicates: number;
  averageCompleteness: number;
  averageConfidence: number;
  /** Best-effort running total of OpenAI token usage across this process's
   * LLM calls (see services/llm-client.ts). Always {0,0,0} in --mock mode,
   * since mock mode makes no LLM calls. Token counts only — no dollar
   * figure; compute cost yourself against current OpenAI pricing for
   * whichever OPENAI_MODEL was used. */
  estimatedTokenUsage: { inputTokens: number; outputTokens: number; calls: number };
  generatedAt: string;
}
