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

export interface ContentResult {
  descriptionUz: string | null;
  descriptionRu: string | null;
  needsContentReview: boolean;
  reason?: string;
}

function stripSuperlatives(text: string): string {
  return text.replace(SUPERLATIVE_PATTERN, "").replace(/\s{2,}/g, " ").trim();
}

/** Mock/no-LLM content generation: a plain templated rendering of verified facts only. */
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

/** Real content generation via OpenAI. Not exercised in this build environment. */
async function buildLiveContent(fields: RawExtractedFields): Promise<ContentResult> {
  const source = fields.descriptionSourceText?.trim();
  if (!source || source.length < MIN_SOURCE_TEXT_LENGTH) {
    return {
      descriptionUz: null,
      descriptionRu: null,
      needsContentReview: true,
      reason: "insufficient source material to generate content",
    };
  }
  const result = await askStructured<{ descriptionUz: string | null; descriptionRu: string | null }>({
    system:
      "You write short (2-4 sentence) marketplace listing descriptions for an education institution " +
      "directory in Uzbekistan, in natural Uzbek and natural (non-mechanical, non-word-for-word-translated) " +
      "Russian. Use ONLY the verified facts provided below — never invent programs, years, counts, or " +
      "achievements not present in the input. NEVER use superlative or ranking claims such as 'best', " +
      "'№1', or 'leading' unless the provided evidence text itself explicitly states such a claim from a " +
      "third party. If the verified facts are too sparse to write a meaningful description, return null " +
      "for both fields instead of padding with generic filler.",
    prompt: `Verified fields (JSON):\n${JSON.stringify(fields, null, 2)}`,
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
