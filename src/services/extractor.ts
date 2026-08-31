/**
 * LLM-assisted structured field extraction from scraped page text.
 * Used by the Researcher agent in real (non-mock) mode; in --mock mode the
 * Researcher reads pre-extracted fields straight from the fixture instead.
 */
import { askStructured } from "./llm-client.js";
import type { RawExtractedFields } from "../types/index.js";

const SCHEMA_DESCRIPTION = `{
  "nameUz": string|null, "nameRu": string|null, "nameLatin": string|null,
  "phone": string|null, "phone2": string|null, "email": string|null,
  "website": string|null, "telegram": string|null, "instagram": string|null,
  "city": string|null, "address": string|null,
  "foundedYear": number|null, "studentCount": number|null, "teacherCount": number|null,
  "programs": string[], "specializations": string[], "achievements": string|null,
  "descriptionSourceText": string|null
}`;

/**
 * Extracts structured fields from raw scraped text. Only returns facts the
 * model claims to have found in the text — the caller (Researcher agent)
 * is responsible for treating this as one evidence item among possibly
 * several, not ground truth on its own.
 */
export async function extractFieldsFromText(
  sourceUrl: string,
  rawText: string
): Promise<Partial<RawExtractedFields>> {
  const result = await askStructured<Partial<RawExtractedFields>>({
    system:
      "You extract factual contact/profile fields for an education institution from a scraped " +
      "web page. Only include a field if the text actually states it — never guess or infer " +
      "values that are not present. Use null for anything not found. Do not invent phone " +
      "numbers, addresses, or founding years.",
    prompt: `Source URL: ${sourceUrl}\n\nPage text:\n${rawText.slice(0, 8000)}`,
    schemaDescription: SCHEMA_DESCRIPTION,
  });
  return result;
}
