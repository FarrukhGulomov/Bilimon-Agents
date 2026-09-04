/**
 * Thin wrapper around the OpenAI SDK for all LLM calls in this pipeline —
 * now supporting TWO interchangeable providers behind one interface:
 *
 *   - "openai" (default): OpenAI's own Responses API
 *     (client.responses.create) with the hosted `web_search` tool.
 *   - "openrouter": OpenRouter's OpenAI-compatible Chat Completions API
 *     (https://openrouter.ai/api/v1/chat/completions — same `openai` npm
 *     SDK, just pointed at a different baseURL/apiKey), using OpenRouter's
 *     `web` plugin (`plugins: [{id: "web"}]`) for search grounding. This
 *     lets a real (non-mock) run be tested against OpenRouter's model
 *     catalog/pricing instead of OpenAI's directly.
 *
 * Select the provider with `SEARCH_PROVIDER=openai|openrouter` (default
 * "openai" — existing behavior/callers are unaffected unless this is set).
 *
 * MODEL NAME CAVEAT (read before deploying real/non-mock runs):
 * "gpt-5.1" below is the most reliably-corroborated current-generation
 * OpenAI model id available at the time this was written, resolved from
 * an actual OpenAI docs page. Live web search for "OpenAI's latest model"
 * at the time turned up inconsistent, low-quality aggregator claims about
 * a "GPT-5.6 Sol/Terra/Luna" lineup that could not be corroborated on any
 * real OpenAI docs page and does not match OpenAI's actual naming
 * conventions — those claims were NOT used here. A "gpt-5.5" /
 * "gpt-5.5-pro" docs page also appeared to resolve at the same time but
 * was not picked as the default out of caution (single-source, not
 * cross-checked). Model names change frequently and this default may
 * already be stale by the time you read this — before running a real
 * (non-mock) discovery/research pass, check
 * https://platform.openai.com/docs/models for the actual current
 * flagship model id and either export OPENAI_MODEL=<that id> or update
 * DEFAULT_MODEL below. For OpenRouter there is no hardcoded default at
 * all — OPENROUTER_MODEL is required when SEARCH_PROVIDER=openrouter,
 * since OpenRouter's catalog (and the right model id format, e.g.
 * "openai/gpt-4o-mini" or "anthropic/claude-..." — provider-prefixed
 * slugs) is exactly what the user wants to choose and test themselves.
 * Check https://openrouter.ai/models for available model ids.
 *
 * OPENROUTER WEB SEARCH CAVEAT: the `plugins: [{id: "web"}]` mechanism
 * used here is OpenRouter's documented web-search plugin (confirmed
 * against an actual openrouter.ai/docs page at the time this was
 * written: https://openrouter.ai/docs/guides/features/plugins/web-search).
 * OpenRouter's own docs note a newer `openrouter:web_search` server tool
 * is intended to eventually supersede this plugin — if `plugins` stops
 * working in the future, that's the mechanism to migrate to.
 *
 * This module is exercised structurally by --mock runs (never invoked), and
 * is otherwise untested-by-execution in this environment per the task
 * constraints — no real network/API calls were made building this pipeline.
 */
import OpenAI from "openai";

export type Provider = "openai" | "openrouter";

export function getProvider(): Provider {
  return process.env.SEARCH_PROVIDER?.trim().toLowerCase() === "openrouter" ? "openrouter" : "openai";
}

/** Whether the currently-active provider's API key is set — used by callers
 * (cli.ts, brief-parser.ts) that need to decide real-vs-mock or LLM-vs-
 * heuristic mode without hardcoding a single provider's env var name. */
export function hasApiKey(): boolean {
  return getProvider() === "openrouter" ? !!process.env.OPENROUTER_API_KEY : !!process.env.OPENAI_API_KEY;
}

export const DEFAULT_MODEL = "gpt-5.1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function getModel(): string {
  if (getProvider() === "openrouter") {
    const model = process.env.OPENROUTER_MODEL?.trim();
    if (!model) {
      throw new Error(
        "SEARCH_PROVIDER=openrouter but OPENROUTER_MODEL is not set. " +
          "Pick a model id from https://openrouter.ai/models (e.g. \"openai/gpt-4o-mini\") and set OPENROUTER_MODEL=<that id>."
      );
    }
    return model;
  }
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

export class MissingApiKeyError extends Error {
  constructor() {
    const provider = getProvider();
    const keyName = provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";
    super(
      `${keyName} is not set. Real (non-mock) LLM/web-search calls require it (current SEARCH_PROVIDER=${provider}).\n` +
        `Fix: copy .env.example to .env and set ${keyName}=..., or export it in your shell.\n` +
        "Alternatively, run the pipeline with --mock (or PIPELINE_MOCK=1) to exercise the pipeline " +
        "end-to-end against local fixtures without any API key."
    );
    this.name = "MissingApiKeyError";
  }
}

// --- Best-effort token usage accumulator ---------------------------------
// OpenAI's Responses API reports usage as input_tokens/output_tokens;
// OpenRouter's Chat Completions API reports it as prompt_tokens/
// completion_tokens (both call sites normalize to this shape before
// calling recordUsage — see askStructured/webSearchAndSummarize below).
// This is a plain in-process running total for the current `pipeline run`
// invocation — not persisted, and reset per process. Included in the final
// report.json as `estimatedTokenUsage` so a human watching a large real
// batch run (batches can be any size) has a rough sense of LLM volume.
// Deliberately token counts only, no dollar figure: pricing differs by
// provider/model and is not verified in this codebase — compute cost
// yourself against https://platform.openai.com/docs/pricing or
// https://openrouter.ai/models for whatever model is in use. Untouched in
// --mock mode, since no LLM calls happen there.
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

let tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };

/** Exported (not just internal) so test/run-all.ts can exercise the
 * accumulator's math without making a real API call. */
export function recordUsage(usage: { input_tokens?: number; output_tokens?: number } | null | undefined): void {
  if (!usage) return;
  tokenUsage.inputTokens += usage.input_tokens ?? 0;
  tokenUsage.outputTokens += usage.output_tokens ?? 0;
  tokenUsage.calls += 1;
}

export function getTokenUsage(): TokenUsage {
  return { ...tokenUsage };
}

export function resetTokenUsage(): void {
  tokenUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };
}

// A web-search-augmented call can legitimately take a while, but with no
// timeout at all a stalled connection hangs forever with zero signal —
// observed as "logs stopped moving, no error, no result" during the first
// real Railway run. 120s is generous for a single call (including the
// model's own tool-use round-trip); override with OPENAI_TIMEOUT_MS /
// OPENROUTER_TIMEOUT_MS if a given deployment needs more/less.
let openaiClient: OpenAI | null = null;
let openrouterClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new MissingApiKeyError();
  if (!openaiClient) {
    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? 120_000);
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: timeoutMs, maxRetries: 2 });
  }
  return openaiClient;
}

function getOpenRouterClient(): OpenAI {
  if (!process.env.OPENROUTER_API_KEY) throw new MissingApiKeyError();
  if (!openrouterClient) {
    const timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS ?? 120_000);
    openrouterClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
      timeout: timeoutMs,
      maxRetries: 2,
      // Optional but recommended by OpenRouter for attribution on their
      // dashboard/leaderboard — harmless to omit, so no error if unset.
      defaultHeaders: {
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://bilimon.uz",
        "X-Title": "BilimOn Agents",
      },
    });
  }
  return openrouterClient;
}

export interface AskStructuredParams {
  system: string;
  prompt: string;
  schemaDescription: string;
  maxTokens?: number;
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return text.slice(first, last + 1);
  }
  return text.trim();
}

/**
 * Ask the model for a JSON object matching `schemaDescription` and parse
 * it. Uses OpenAI's Responses API when SEARCH_PROVIDER=openai (default),
 * or OpenRouter's OpenAI-compatible Chat Completions API otherwise. Asks
 * explicitly for JSON-only output.
 */
export async function askStructured<T>(params: AskStructuredParams): Promise<T> {
  const systemPrompt = `${params.system}\n\nRespond with ONLY a single JSON object matching this shape (no prose, no markdown fences):\n${params.schemaDescription}`;
  let text: string | null | undefined;

  if (getProvider() === "openrouter") {
    const client = getOpenRouterClient();
    const response = await client.chat.completions.create({
      model: getModel(),
      max_tokens: params.maxTokens ?? 2048,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: params.prompt },
      ],
    });
    recordUsage({ input_tokens: response.usage?.prompt_tokens, output_tokens: response.usage?.completion_tokens });
    text = response.choices[0]?.message?.content;
  } else {
    const openai = getOpenAIClient();
    const response = await openai.responses.create({
      model: getModel(),
      max_output_tokens: params.maxTokens ?? 2048,
      instructions: systemPrompt,
      input: params.prompt,
    });
    recordUsage(response.usage);
    text = response.output_text;
  }

  if (!text) {
    throw new Error("LLM response contained no output text to parse as JSON");
  }
  const jsonText = extractJson(text);
  try {
    return JSON.parse(jsonText) as T;
  } catch (err) {
    throw new Error(`Failed to parse LLM JSON response: ${(err as Error).message}\nRaw text: ${text}`);
  }
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * Runs a live web search and asks the model to summarize/list findings
 * relevant to `query` as a JSON array of {title,url,snippet}. Requires the
 * active provider's API key (OPENAI_API_KEY, or OPENROUTER_API_KEY when
 * SEARCH_PROVIDER=openrouter). Never called in --mock mode. Kept as the
 * thin "just give me links" wrapper over webSearchStructuredList below,
 * which is what the provider branching now lives in.
 */
export async function webSearchAndSummarize(query: string, instructions: string): Promise<WebSearchResultItem[]> {
  return webSearchStructuredList<WebSearchResultItem>(
    query,
    instructions,
    `[{"title": string, "url": string, "snippet": string}]`
  );
}

/**
 * The single provider-branching web-search call every grounded call in this
 * pipeline goes through. Returns the model's raw response text (or null when
 * the provider returned no text at all).
 *
 * OpenAI path: declares the hosted `web_search` Responses API tool
 * (confirmed against the installed `openai` package's bundled type
 * definitions: resources/responses/responses.d.ts, WebSearchTool,
 * `type: "web_search"`) — if a future SDK version renames or drops this
 * tool type, this call will throw a clear API error rather than silently
 * no-op.
 *
 * OpenRouter path: uses the `web` plugin (`plugins: [{id: "web"}]`) over
 * Chat Completions — see the OPENROUTER WEB SEARCH CAVEAT in this file's
 * header comment for the source/caveats on this mechanism.
 */
async function runWebSearch(query: string, instructions: string, maxWebResults = 5): Promise<string | null> {
  if (getProvider() === "openrouter") {
    const client = getOpenRouterClient();
    const response = await client.chat.completions.create({
      model: getModel(),
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: query },
      ],
      // @ts-expect-error -- `plugins` is an OpenRouter-specific extension to
      // the OpenAI-compatible Chat Completions request body; the `openai`
      // npm package's types don't know about it, but OpenRouter's API
      // accepts it as a top-level request field. See file header comment.
      plugins: [{ id: "web", max_results: maxWebResults }],
    });
    recordUsage({ input_tokens: response.usage?.prompt_tokens, output_tokens: response.usage?.completion_tokens });
    return response.choices[0]?.message?.content ?? null;
  }
  const openai = getOpenAIClient();
  const response = await openai.responses.create({
    model: getModel(),
    tools: [{ type: "web_search" }],
    instructions,
    input: query,
  });
  recordUsage(response.usage);
  return response.output_text ?? null;
}

/**
 * Runs a live web search and asks the model to return a JSON ARRAY of
 * objects matching `schemaDescription`. Requires the active provider's API
 * key (OPENAI_API_KEY, or OPENROUTER_API_KEY when
 * SEARCH_PROVIDER=openrouter). Never called in --mock mode.
 *
 * Used by the Discovery agent (services/search.ts) to get a structured
 * *profile* per institution rather than a bare link — see that file for why
 * a bare {title,url,snippet} triple was not enough in real mode.
 */
export async function webSearchStructuredList<T>(
  query: string,
  instructions: string,
  schemaDescription: string,
  maxWebResults = 8
): Promise<T[]> {
  const fullInstructions =
    `${instructions}\n\n` +
    `After searching, respond with ONLY a JSON array (no prose, no markdown fences) ` +
    `whose elements match this shape:\n${schemaDescription}`;
  const text = await runWebSearch(query, fullInstructions, maxWebResults);
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    return [];
  }
  return coerceToArray<T>(parsed);
}

/**
 * Runs a live web search scoped to ONE named institution and asks the model
 * for a single JSON OBJECT matching `schemaDescription`. Returns null when
 * the model produced nothing parseable (treated by the caller as "this
 * source yielded no evidence", never as a crash).
 *
 * This is Agent 2's (Deep Research) primary source. The pipeline's original
 * real-mode research was a naive `fetch()` + regex tag-strip of ONE
 * discovery URL: against the real web that returns nothing usable for the
 * majority of sources (Instagram/Telegram/Facebook serve login walls,
 * modern JS sites serve empty shells, many hosts 403 a non-browser
 * user-agent), so evidence arrays came back empty and every real run
 * produced zero usable records. A search-grounded call reads what a human
 * researcher would actually read, so it is the primary path and the scrape
 * is supplementary — see agents/researcher.ts.
 */
export async function webSearchStructuredObject<T>(
  query: string,
  instructions: string,
  schemaDescription: string,
  maxWebResults = 8
): Promise<T | null> {
  const fullInstructions =
    `${instructions}\n\n` +
    `After searching, respond with ONLY a single JSON object (no prose, no markdown fences) ` +
    `matching this shape:\n${schemaDescription}`;
  const text = await runWebSearch(query, fullInstructions, maxWebResults);
  if (!text) return null;
  try {
    const parsed = JSON.parse(extractJson(text));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
    // A model that wrapped the object in a one-element array is a common,
    // harmless deviation — unwrap it rather than discarding real research.
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object") return parsed[0] as T;
    return null;
  } catch {
    return null;
  }
}

// Models don't always honor "respond with ONLY a JSON array" literally —
// a common failure mode is wrapping the array in an object (e.g.
// {"results": [...]}, {"institutions": [...]}) or, when nothing was
// found, returning {} or a single object instead of []. Real-world crash
// observed: an un-coerced non-array reaching `.map()` in
// services/search.ts threw "results.map is not a function" and crashed
// the whole pipeline run. Never let a malformed model response take down
// the process — unwrap known wrapper shapes, otherwise treat it as "no
// results found" rather than a fatal error.
export function coerceToArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    for (const key of ["results", "items", "institutions", "data"]) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  console.warn(
    "web search: model response was not a JSON array (and no known wrapper key matched) — " +
      "treating as zero results instead of crashing. Raw parsed value:",
    JSON.stringify(value).slice(0, 500)
  );
  return [];
}

/** Back-compat alias kept because it is the name the existing test suite and
 * services/search.ts already use; identical behavior, typed to the
 * {title,url,snippet} shape. */
export function coerceToResultArray(value: unknown): WebSearchResultItem[] {
  return coerceToArray<WebSearchResultItem>(value);
}

// --- Agent 2 (Deep Research): per-institution grounded research ----------

export interface InstitutionResearchInput {
  /** Institution name exactly as discovery found it. */
  name: string;
  city?: string;
  /** Anything Agent 1 already saw — official site, socials, the directory
   * listing it was found on. Given to the model as starting points to open,
   * NOT as facts to repeat back. */
  knownLinks?: (string | null | undefined)[];
}

export interface InstitutionResearchResult {
  /** The RawExtractedFields-shaped facts the model actually found. Typed
   * loosely (Record) here because llm-client deliberately does no schema
   * validation — the Researcher agent narrows/validates it. */
  fields: Record<string, unknown>;
  /** The URLs the model says it actually opened/used. Recorded as the
   * evidence item's provenance and used as extra scrape targets. */
  sourceUrls: string[];
  /** Real production failure: "look up by name" mode (RunOptions.
   * institutionName) was tested with "Registon" — the Registan, a famous
   * Samarkand historical monument, not a learning center — and this call
   * happily researched and returned facts about it anyway, since nothing
   * ever asked the model to verify the named entity IS an education
   * institution before describing it. true only when the model actually
   * confirmed (via a source) that the named entity is a currently-operating
   * education/learning institution; false when it's clearly something else
   * (a monument, museum, mosque, government office, company, product,
   * person, etc.); null when the model could not determine this either way
   * (treated the same as false by the caller — never assumed true). See
   * researcher.ts::researchLive, which discards `fields`/`sourceUrls`
   * entirely when this isn't true. */
  isEducationInstitution: boolean | null;
}

const INSTITUTION_RESEARCH_SCHEMA = `{
  "isEducationInstitution": boolean|null,
  "fields": {
    "nameUz": string|null, "nameRu": string|null, "nameLatin": string|null,
    "phone": string|null, "phone2": string|null, "email": string|null,
    "website": string|null, "telegram": string|null, "instagram": string|null,
    "city": string|null, "address": string|null,
    "foundedYear": number|null, "studentCount": number|null, "teacherCount": number|null,
    "languages": string[], "programs": string[], "shifts": string[], "specializations": string[],
    "achievements": string|null,
    "pricingNote": string|null,
    "descriptionSourceText": string|null
  },
  "sourceUrls": string[]
}`;

/**
 * Agent 2's primary source: one web-search-grounded research call scoped to
 * a single named institution, returning the institution's "sales" facts.
 *
 * Why this exists (real production failure): real-mode research used to be
 * a single naive fetch() + regex tag-strip of one discovery URL. Instagram/
 * Telegram/Facebook serve login walls to that, modern JS sites serve an
 * empty shell, and many Uzbek hosts 403 a non-browser user-agent — so
 * `page.text` was empty for most candidates, the evidence array came out
 * length 0, and every real run produced zero extracted fields and zero
 * usable records. A search-grounded call reads what a human researcher
 * would read (official site, socials, directory listings) and is therefore
 * the primary path; the HTML scrape is now only supplementary.
 *
 * Returns null when the model produced nothing parseable — a normal "no
 * evidence from this source" outcome, never a crash.
 */
export async function researchInstitutionViaWebSearch(
  input: InstitutionResearchInput
): Promise<InstitutionResearchResult | null> {
  const links = (input.knownLinks ?? []).filter((l): l is string => !!l && l.trim().length > 0);
  const query =
    `Institution: "${input.name}"${input.city ? `, ${input.city}, Uzbekistan` : ", Uzbekistan"}.\n` +
    (links.length > 0 ? `Known links to start from:\n${links.map((l) => `- ${l}`).join("\n")}\n` : "") +
    `Also try business-oriented search variants of the name, e.g. "${input.name} o'quv markazi", ` +
    `"${input.name} LC", "${input.name} ta'lim markazi", "${input.name} learning center" — Uzbek ` +
    `education businesses very commonly share a bare name with an unrelated place, historical site, or ` +
    `common word, and only a name-plus-business-word search surfaces them.\n` +
    `Research this ONE institution and report only what you actually find.`;

  const instructions =
    "You are a deep-research agent preparing a marketplace listing for ONE named education " +
    "institution in Uzbekistan. FIRST verify the named entity actually IS a real, " +
    "currently-operating education/learning institution (a language center, tutoring service, " +
    "course center, or exam-prep center) — not a historical monument, museum, mosque, government " +
    "office, company, product, public figure, or anything else that merely shares or resembles the " +
    "name.\n\n" +
    "IMPORTANT — name collisions are common and expected: a bare name (e.g. \"Registon\") is often " +
    "shared between an unrelated famous place/word and a genuine education business that added a " +
    "business word to it (e.g. \"Registon LC\", \"Registon o'quv markazi\", website rgn.uz, listed on " +
    "Google/Yandex Maps as a business with its own address, phone, and reviews). The single most " +
    "prominent general search result for the bare name (a landmark, a Wikipedia page) is NOT proof " +
    "that no business by that name exists — before concluding `isEducationInstitution: false`, you " +
    "MUST specifically check Google/Yandex Maps business listings, the institution's own website if " +
    "one is findable, Instagram/Telegram, and kursi24.uz/yellowpages.uz/goldenpages.uz for a business " +
    "matching the name (see the search-variant suggestions in the query). Only set it to false once " +
    "those checks turn up nothing, or clearly show every business-like result is actually the same " +
    "unrelated landmark/place under a different pretext.\n\n" +
    "Set `isEducationInstitution` to true once a source (official site, social page, maps listing, or " +
    "directory entry) confirms a currently-operating education business by this name; set it to false " +
    "if, after the checks above, the sources clearly show only the unrelated entity; set it to null if " +
    "you genuinely cannot tell. If it is not confirmed true, leave every field in `fields` null/empty " +
    "and `sourceUrls` empty — do NOT describe the unrelated entity instead, even if it is " +
    "well-documented and would otherwise make for a rich-looking listing.\n\n" +
    "Once confirmed, check, in this order: (1) the institution's official website, " +
    "(2) its Instagram and Telegram pages, (3) kursi24.uz/uz (a directory dedicated to Uzbekistan " +
    "learning/course centers) and general Uzbekistan business directories yellowpages.uz and " +
    "goldenpages.uz, all of which carry structured phone/address data that an institution's own site " +
    "or social page often omits, (4) any other page that genuinely describes this institution. " +
    "Most real institutions publish in Uzbek or Russian, not English — search in Uzbek and Russian " +
    "too, and do not skip a source because it is not in English.\n\n" +
    "Extract the facts that make this institution sellable to a student: contact details " +
    "(phone, second phone, email, website, telegram, instagram), address and city, the programs/" +
    "courses it actually offers, its specializations, teaching languages, class shifts, founding " +
    "year, student and teacher counts, and any achievements/accreditations it genuinely claims. " +
    "`programs` and `specializations` must be as COMPLETE as the sources actually allow, not just " +
    "the one or two the homepage happens to headline — if the official site has a dedicated courses/" +
    "subjects page (often linked as \"Kurslar\", \"Yo'nalishlar\", \"Fanlar\", \"Курсы\", \"Направления\", " +
    "or similar in the site's own menu), open it and list every subject/course/direction it names, " +
    "not just the first few. A real center commonly teaches many subjects at once (e.g. multiple " +
    "languages, school subjects, exam prep, IT); report all of them if the sources show them, and " +
    "only report fewer when the sources genuinely only describe fewer.\n\n" +
    "CRITICAL — `programs`/`specializations` must be the ACTUAL course/subject NAMES as titled on the " +
    "institution's own courses page or materials (e.g. \"General English\", \"IELTS\", \"CEFR (ingliz " +
    "tili)\", \"Abituriyent fanlar\", \"Matematika\") — NEVER a search-engine RESULT TITLE or article " +
    "headline ABOUT the institution. A search result's title is marketing copy about the business, not " +
    "a course name, even when it contains real words like a subject or city. Concretely, never include " +
    "an item that: (a) repeats the institution's own name, (b) names a city, region, or the country " +
    "(\"Toshkentda ...\", \"Chirchiqda ...\", \"O'zbekistonda ...\", \"... viloyatidagi ...\") — a real " +
    "course name never mentions where it's taught, (c) describes the business itself rather than a " +
    "subject (\"... o'quv markazi\", \"... markazlar tarmog'i\", \"... filiallar\"), or (d) is a " +
    "superlative/ranking claim about the institution (\"eng yaxshi ...\", \"top 10 ...\"). If you are " +
    "not looking at the institution's own course-listing page/material and cannot name the actual " +
    "course titles, leave `programs`/`specializations` as whatever narrower list you ARE sure of " +
    "(even empty) rather than filling them with search-result headlines.\n\n" +
    "Put any price information you find (e.g. monthly fee ranges) in `pricingNote` as plain text " +
    "quoting what the source says — do not convert or estimate.\n\n" +
    "`descriptionSourceText` must be 2-5 factual sentences about this institution in its own terms, " +
    "drawn from what the sources actually say — this is the raw material the content stage writes " +
    "from, so it is the most important field: never leave it null when you found any real " +
    "description of the institution.\n\n" +
    "HARD RULE: every field you did not actually find must be null (or an empty array). Never " +
    "invent or guess a phone number, address, founding year, count, program, price, or URL, and " +
    "never carry over a fact from a DIFFERENT institution with a similar name. `sourceUrls` must " +
    "list only URLs you actually opened and used.";

  return webSearchStructuredObject<InstitutionResearchResult>(query, instructions, INSTITUTION_RESEARCH_SCHEMA);
}

// --- Provider error classification ---------------------------------------
// Real production failure (the user's latest real run): an OpenRouter
// `APIError: 402 This request would exceed your available credits` escaped
// a single discovery search, propagated out of runWithConcurrency, and
// killed the whole process with a raw stack trace mid-discovery — losing
// the run and telling the user nothing actionable. Two things were wrong:
// one failing search must not destroy a batch, and a credits/auth/rate-limit
// error must read as a human-readable line, not a stack dump.
//
// classifyProviderError is a PURE function (no network, no SDK types) so it
// is unit-testable offline — it reads `status`/`code` off whatever the SDK
// threw and falls back to sniffing the message text, since different SDK
// versions/providers surface the status differently.

export type ProviderErrorKind = "auth" | "credits" | "rate_limit" | "other";

export interface ProviderErrorInfo {
  kind: ProviderErrorKind;
  status: number | null;
  /** True for errors that every subsequent call will hit identically (bad
   * key, no credits). Burning the rest of a 200-institution batch against
   * the same wall helps nobody — the caller stops the run instead. */
  fatal: boolean;
  /** One human-readable line naming the provider and the required action. */
  message: string;
}

function statusFromError(err: unknown): number | null {
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown }; message?: unknown };
  for (const candidate of [e?.status, e?.statusCode, e?.response?.status]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  const message = typeof e?.message === "string" ? e.message : "";
  // SDK errors commonly stringify as "402 This request would exceed your
  // available credits" or "Error code: 429 - ..." — read the status back out
  // when it wasn't exposed as a field.
  const match = message.match(/\b(401|402|403|429)\b/);
  return match ? Number(match[1]) : null;
}

export function classifyProviderError(err: unknown): ProviderErrorInfo {
  const provider = getProvider();
  const providerLabel = provider === "openrouter" ? "OpenRouter" : "OpenAI";
  const status = statusFromError(err);
  const raw = (err as Error)?.message ?? String(err);
  const topUpUrl = provider === "openrouter" ? "https://openrouter.ai/credits" : "https://platform.openai.com/settings/organization/billing";
  const keyName = provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";

  if (status === 402 || /insufficient|exceed your available credits|quota/i.test(raw)) {
    return {
      kind: "credits",
      status: status ?? 402,
      fatal: true,
      message:
        `${providerLabel} returned ${status ?? 402}: out of credits — top up at ${topUpUrl}, ` +
        `or switch SEARCH_PROVIDER (openai|openrouter). Stopping the run: every remaining ` +
        `search/research call would fail the same way.`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      status,
      fatal: true,
      message:
        `${providerLabel} returned ${status}: the API key was rejected — check ${keyName} ` +
        `(and, for OpenRouter, that the key is allowed to use OPENROUTER_MODEL). Stopping the run: ` +
        `every remaining call would fail the same way.`,
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limit",
      status,
      fatal: false,
      message:
        `${providerLabel} returned 429: rate limited — this unit of work is skipped and the run continues. ` +
        `Lower PIPELINE_MAX_CONCURRENCY (currently applied from config/execution.json) if this repeats.`,
    };
  }
  return {
    kind: "other",
    status,
    fatal: false,
    message: `${providerLabel} call failed${status ? ` (HTTP ${status})` : ""}: ${raw.slice(0, 300)}`,
  };
}

/** Thrown to unwind out of a batch when classifyProviderError says the
 * failure is fatal. Carries the already-formatted human-readable line, so
 * cli.ts can print exactly that and exit non-zero without a stack dump. */
export class FatalProviderError extends Error {
  readonly info: ProviderErrorInfo;
  constructor(info: ProviderErrorInfo) {
    super(info.message);
    this.name = "FatalProviderError";
    this.info = info;
  }
}

export function isFatalProviderError(err: unknown): err is FatalProviderError {
  return err instanceof FatalProviderError;
}

/**
 * Classifies `err`; returns the info for a non-fatal failure (caller logs a
 * warning and moves on with zero results for that unit of work) and throws
 * FatalProviderError for a fatal one (caller lets it unwind to cli.ts).
 * MissingApiKeyError is passed straight through — cli.ts already prints it.
 */
export function handleProviderError(err: unknown): ProviderErrorInfo {
  if (err instanceof MissingApiKeyError || err instanceof FatalProviderError) throw err;
  const info = classifyProviderError(err);
  if (info.fatal) throw new FatalProviderError(info);
  return info;
}
