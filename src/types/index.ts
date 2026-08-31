/**
 * Internal pipeline types. The `BilimOnExportRecord` shape mirrors the
 * PLACEHOLDER schema in src/schemas/bilimon-reference.example.json — see
 * that file's header comment and README.md for the caveat that this is
 * not the authoritative BilimOn schema.
 */
import type {
  Category,
  DeliveryMode,
  InstitutionStatus,
  InstitutionType,
  LanguageCode,
  MediaType,
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
  id: string; // deterministic slug-based id
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

export interface MediaItem {
  type: MediaType;
  url: string;
}

export interface PricingInfo {
  min: number | null;
  max: number | null;
  currency: "UZS";
  notes: string | null;
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

export interface BranchRecord {
  id: string;
  address: string | null;
  cityId: number | null;
  phone: string | null;
}

/** The placeholder BilimOn export record shape. See schema caveat above. */
export interface BilimOnExportRecord {
  id: string;
  nameUz: string;
  nameRu: string;
  nameKey: string;
  slug: string;
  type: InstitutionType;
  additionalTypes: InstitutionType[];
  status: InstitutionStatus;
  phone: string;
  phone2: string | null;
  email: string | null;
  website: string | null;
  telegram: string | null;
  instagram: string | null;
  cityId: number;
  regionId: number;
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
  generatedAt: string;
}
