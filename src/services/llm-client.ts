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
 * relevant to `query` as structured JSON. Requires the active provider's
 * API key (OPENAI_API_KEY, or OPENROUTER_API_KEY when
 * SEARCH_PROVIDER=openrouter). Never called in --mock mode.
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
export async function webSearchAndSummarize(query: string, instructions: string): Promise<WebSearchResultItem[]> {
  const fullInstructions =
    `${instructions}\n\n` +
    `After searching, respond with ONLY a JSON array of objects: ` +
    `[{"title": string, "url": string, "snippet": string}]`;
  let text: string | null | undefined;

  if (getProvider() === "openrouter") {
    const client = getOpenRouterClient();
    const response = await client.chat.completions.create({
      model: getModel(),
      messages: [
        { role: "system", content: fullInstructions },
        { role: "user", content: query },
      ],
      // @ts-expect-error -- `plugins` is an OpenRouter-specific extension to
      // the OpenAI-compatible Chat Completions request body; the `openai`
      // npm package's types don't know about it, but OpenRouter's API
      // accepts it as a top-level request field. See file header comment.
      plugins: [{ id: "web", max_results: 5 }],
    });
    recordUsage({ input_tokens: response.usage?.prompt_tokens, output_tokens: response.usage?.completion_tokens });
    text = response.choices[0]?.message?.content;
  } else {
    const openai = getOpenAIClient();
    const response = await openai.responses.create({
      model: getModel(),
      tools: [{ type: "web_search" }],
      instructions: fullInstructions,
      input: query,
    });
    recordUsage(response.usage);
    text = response.output_text;
  }

  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    return [];
  }
  return coerceToResultArray(parsed);
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
export function coerceToResultArray(value: unknown): WebSearchResultItem[] {
  if (Array.isArray(value)) return value as WebSearchResultItem[];
  if (value && typeof value === "object") {
    for (const key of ["results", "items", "institutions", "data"]) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as WebSearchResultItem[];
    }
  }
  console.warn(
    "webSearchAndSummarize: model response was not a JSON array (and no known wrapper key matched) — " +
      "treating as zero results instead of crashing. Raw parsed value:",
    JSON.stringify(value).slice(0, 500)
  );
  return [];
}
