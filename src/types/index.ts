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
import type { DiscoveryScope } from "../services/brief-parser.js";

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
  /** "search" is the web-search-grounded per-institution research call
   * (agents/researcher.ts, Agent 2's primary source); the others are
   * fetched/scraped pages, or "fixture" for --mock evidence. */
  sourceType: "website" | "social" | "directory" | "search" | "fixture" | "other";
  extractedFields: Partial<RawExtractedFields>;
  rawTextExcerpt?: string;
  /** When the search-grounded research call cited more than one real page
   * for this same evidence snapshot, the rest live here (sourceUrl carries
   * only the primary one) — see agents/researcher.ts::selectResearchEvidenceSource.
   * Never populated for scrape-sourced evidence items (those are one URL
   * each already). */
  additionalSourceUrls?: string[];
  /** 0-1, this evidence item's own reliability. Real mode derives it from
   * source type, how much substantive detail the source actually yielded,
   * and how many other sources corroborate it — see
   * services/scoring.ts::computeEvidenceConfidence. It used to be the
   * constant 0.6 for every real-mode item, which (with an evidence array
   * that was never longer than 1) pinned sourceConfidence at exactly 52 on
   * every real run and made APPROVED mathematically unreachable. */
  confidence: number;
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
  /** Free-text price information exactly as a source stated it (e.g. "oyiga
   * 500 000 so'mdan"). Deliberately NOT mapped to the export's `pricing`
   * field: the real BilimOn pricing shape needs numeric monthlyMin/
   * monthlyMax/paymentMethods, and deriving those from a free-text hint
   * means guessing numbers. Kept as evidence for the human reviewing a
   * NEEDS_REVIEW record, and as material the content stage may quote. */
  pricingNote?: string;
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
   * REVISED (superseding the earlier 2026-08-31 "BilimOn assigns id on
   * import" decision): that assumption was disproven by BilimOn's actual
   * production import endpoint (POST /api/v1/super-admin/import/
   * institutions), which rejected a real exported batch with `id: null`
   * outright — a 400 with `{"code":"invalid_type","expected":"string",
   * "received":"null","path":["institutions",0,"id"]}`. The endpoint
   * requires the client to supply an id string. Every record this pipeline
   * exports now carries a cuid-shaped id generated client-side (matching
   * the shape of every id in the real reference export, e.g.
   * "cmrfw8t5o001an3ogocewc8g6") — see
   * services/normalizer.ts::generateBilimonRecordId and
   * agents/bilimon-exporter.ts::buildExportRecord.
   * Pipeline-internal state tracking uses a separate, clearly-prefixed id
   * (see StateRecord.id / services/normalizer.ts::generateId) — never this field.
   */
  id: string;
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

/**
 * The envelope bilimon-import.json must actually be written in.
 *
 * CONFIRMED against data/reference/bilimon-institutions-reference.json (the
 * real BilimOn production export the user supplied): its top level is
 * `{version, exportedAt, institutions: [...]}`, NOT a bare array. Real
 * production bug: bilimon-exporter.ts used to write `approvedRecords`
 * directly as a top-level JSON array — every record inside it matched the
 * real schema, but the file itself was not shaped like a real BilimOn
 * export/import file at all, which the user caught by pasting the actual
 * reference file's shape back for comparison. `version` is a plain
 * integer (1 in the reference file, not a semver string).
 */
export interface BilimOnImportFile {
  version: number;
  exportedAt: string;
  institutions: BilimOnExportRecord[];
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
  /** The DiscoveryScope (src/services/brief-parser.ts) that produced this
   * batch — records which --brief (if any) was used and what it resolved to
   * (types/categories/keywords/source), so a human reviewing a run later can
   * see what was requested. null only if no run has ever persisted a scope
   * (e.g. a fresh checkout's first `pipeline export` before any `run`). */
  resolvedScope: DiscoveryScope | null;
  generatedAt: string;
}
