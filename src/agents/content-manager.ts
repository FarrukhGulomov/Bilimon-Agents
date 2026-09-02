/**
 * Content Manager agent. Builds nameUz/nameRu-aware Uzbek and Russian
 * descriptions using ONLY verified fields from the research evidence file
 * — never inventing facts. Forbids superlative/ranking claims ("best",
 * "№1", "leading", "top") unless the source evidence text itself contains
 * them. Skips generation (leaves descriptions null, flags content review)
 * when there isn't enough real source material.
 *
 * In --mock mode this uses a plain-code template (no LLM call) so the
 * pipeline is fully exercisable offline; in real mode it calls OpenAI via
 * services/llm-client.ts with the constraints above baked into the prompt.
 */
import type { RawExtractedFields } from "../types/index.js";
import { askStructured } from "../services/llm-client.js";

const SUPERLATIVE_PATTERN = /\b(best|number\s*1|№\s*1|no\.?\s*1|leading|top-rated|top\s+choice)\b/i;
const MIN_SOURCE_TEXT_LENGTH = 40;

/**
 * Whether there is enough REAL material to write from.
 *
 * Real production failure: the live path gated on `descriptionSourceText`
 * alone (>= 40 chars). That field only ever came from the LLM extractor
 * running on scraped page text — which was empty for most institutions in
 * real mode (see agents/researcher.ts) — so content was almost always null,
 * and a null description additionally flagged the record for review. The
 * gate now accepts any combination of genuinely-verified facts: identity
 * (a name), a place, what kind of institution it is, and at least two
 * substantive facts to actually say something about. Nothing here loosens
 * the truthfulness rules — the writer still only ever uses these fields.
 *
 * Pure and exported so the gate is testable offline.
 */
export interface MaterialAssessment {
  sufficient: boolean;
  /** Names of the substantive facts found — used in the review reason. */
  facts: string[];
  reason?: string;
}

const MIN_SUBSTANTIVE_FACTS = 2;

export function assessContentMaterial(fields: RawExtractedFields): MaterialAssessment {
  const has = (v: unknown): boolean => {
    if (v === undefined || v === null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "string") return v.trim().length > 0;
    return true;
  };

  const facts: string[] = [];
  let weight = 0;
  const sourceText = fields.descriptionSourceText?.trim();
  // Real source text in the institution's own terms counts double: it is a
  // paragraph to write FROM, not a single data point.
  if (sourceText && sourceText.length >= MIN_SOURCE_TEXT_LENGTH) {
    facts.push("descriptionSourceText");
    weight += 2;
  }
  for (const key of [
    "programs",
    "specializations",
    "foundedYear",
    "address",
    "studentCount",
    "teacherCount",
    "languages",
    "shifts",
    "achievements",
  ] as (keyof RawExtractedFields)[]) {
    if (has(fields[key])) {
      facts.push(key);
      weight += 1;
    }
  }

  const hasName = has(fields.nameUz) || has(fields.nameRu) || has(fields.nameLatin);
  const hasPlace = has(fields.city) || has(fields.address);
  const hasKind = has(fields.type) || has(fields.categories);
  const missing: string[] = [];
  if (!hasName) missing.push("a name");
  if (!hasPlace) missing.push("a city or address");
  if (!hasKind) missing.push("an institution type or category");
  if (weight < MIN_SUBSTANTIVE_FACTS) missing.push(`at least ${MIN_SUBSTANTIVE_FACTS} substantive facts (programs, specializations, founding year, address, counts, languages, shifts, achievements, or real source text)`);

  if (missing.length > 0) {
    return {
      sufficient: false,
      facts,
      reason: `insufficient verified material to generate content — missing ${missing.join("; ")}`,
    };
  }
  return { sufficient: true, facts };
}

export interface ContentResult {
  descriptionUz: string | null;
  descriptionRu: string | null;
  needsContentReview: boolean;
  reason?: string;
}

function stripSuperlatives(text: string): string {
  return text.replace(SUPERLATIVE_PATTERN, "").replace(/\s{2,}/g, " ").trim();
}

/** Mock/no-LLM content generation: a plain templated rendering of verified
 * facts only. Deliberately keeps its stricter descriptionSourceText
 * requirement rather than adopting assessContentMaterial: this is a string
 * template, not a writer — with no source paragraph there is nothing for it
 * to render, and --mock output stays byte-identical to before this change.
 * The material gate that mattered was the LIVE one, below. */
function buildMockContent(fields: RawExtractedFields): ContentResult {
  const source = fields.descriptionSourceText?.trim();
  if (!source || source.length < MIN_SOURCE_TEXT_LENGTH) {
    return {
      descriptionUz: null,
      descriptionRu: null,
      needsContentReview: true,
      reason: "insufficient source material (descriptionSourceText missing or too short) to generate content",
    };
  }
  const cleaned = stripSuperlatives(source);
  const name = fields.nameUz ?? fields.nameLatin ?? "Bu ta'lim markazi";
  const descriptionUz = `${name} haqida: ${cleaned}`;
  const descriptionRu = fields.nameRu
    ? `${fields.nameRu}: ${cleaned}`
    : null;
  return {
    descriptionUz,
    descriptionRu,
    needsContentReview: !descriptionRu, // flag for review if we couldn't produce the Russian side
    reason: descriptionRu ? undefined : "no nameRu/Russian source material available — descriptionRu left null",
  };
}

/** Real content generation via the configured LLM provider (Agent 3). Not
 * exercised by execution in this build environment. */
async function buildLiveContent(fields: RawExtractedFields): Promise<ContentResult> {
  const material = assessContentMaterial(fields);
  if (!material.sufficient) {
    return {
      descriptionUz: null,
      descriptionRu: null,
      needsContentReview: true,
      reason: material.reason ?? "insufficient source material to generate content",
    };
  }
  const result = await askStructured<{ descriptionUz: string | null; descriptionRu: string | null }>({
    system:
      "You write short (2-4 sentence) marketplace listing descriptions for an education institution " +
      "directory in Uzbekistan, from a set of verified facts about ONE institution.\n\n" +
      "LANGUAGE: descriptionUz must read as natural, modern, idiomatic Uzbek written by an Uzbek " +
      "copywriter, and descriptionRu as natural Russian written by a Russian copywriter. They are two " +
      "independent pieces of writing about the same facts — NOT a word-for-word translation of each " +
      "other. Sentence order and phrasing may legitimately differ between them; what must not differ " +
      "is the facts.\n\n" +
      "TRUTHFULNESS (hard rules): use ONLY the verified facts provided — never invent or infer " +
      "programs, founding years, student/teacher counts, achievements, prices, or accreditations that " +
      "are not in the input. Do not restate a fact more precisely than the input states it. NEVER use " +
      "superlative or ranking claims such as 'best', 'eng yaxshi', 'лучший', '№1', or 'leading' unless " +
      "the provided evidence text itself explicitly contains such a claim made by a third party. " +
      "Prices, if present, appear as a free-text `pricingNote` — quote it as the source phrased it or " +
      "leave it out; never convert, average, or estimate a number.\n\n" +
      "If the verified facts are too sparse to write something a real prospective student would find " +
      "informative, return null for both fields instead of padding with generic filler.",
    prompt:
      `Verified fields (JSON):\n${JSON.stringify(fields, null, 2)}\n\n` +
      `Substantive facts available: ${material.facts.join(", ")}`,
    schemaDescription: `{"descriptionUz": string|null, "descriptionRu": string|null}`,
  });
  const needsContentReview = !result.descriptionUz && !result.descriptionRu;
  return {
    descriptionUz: result.descriptionUz,
    descriptionRu: result.descriptionRu,
    needsContentReview,
    reason: needsContentReview ? "LLM judged available facts insufficient for a description" : undefined,
  };
}

export async function generateContent(fields: RawExtractedFields, mock: boolean): Promise<ContentResult> {
  return mock ? buildMockContent(fields) : buildLiveContent(fields);
}
