/**
 * Thin wrapper around the OpenAI SDK for all LLM calls in this pipeline.
 * Centralizes: model selection (OPENAI_MODEL env, default gpt-5.1), a clear
 * error when OPENAI_API_KEY is missing, and JSON-structured response
 * parsing used by the extractor/dedupe/content-manager services.
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
 * DEFAULT_MODEL below.
 *
 * This module is exercised structurally by --mock runs (never invoked), and
 * is otherwise untested-by-execution in this environment per the task
 * constraints — no real network/API calls were made building this pipeline.
 */
import OpenAI from "openai";

export const DEFAULT_MODEL = "gpt-5.1";

export function getModel(): string {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "OPENAI_API_KEY is not set. Real (non-mock) LLM/web-search calls require it.\n" +
        "Fix: copy .env.example to .env and set OPENAI_API_KEY=sk-..., or export it in your shell.\n" +
        "Alternatively, run the pipeline with --mock (or PIPELINE_MOCK=1) to exercise the pipeline " +
        "end-to-end against local fixtures without any API key."
    );
    this.name = "MissingApiKeyError";
  }
}

// --- Best-effort token usage accumulator ---------------------------------
// The OpenAI SDK's `response.usage` (Responses API) reports input_tokens /
// output_tokens per call when the API returns usage info. This is a plain
// in-process running total for the current `pipeline run` invocation —
// not persisted, and reset per process. Included in the final report.json
// as `estimatedTokenUsage` so a human watching a large real batch run
// (batches can be any size) has a rough sense of LLM volume. Deliberately
// token counts only, no dollar figure: pricing is not verified in this
// codebase and would go stale immediately — compute cost yourself against
// https://platform.openai.com/docs/pricing for whatever OPENAI_MODEL is in
// use. Untouched in --mock mode, since no LLM calls happen there.
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

let tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };

/** Exported (not just internal) so test/run-all.ts can exercise the
 * accumulator's math without making a real OpenAI call. */
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

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new MissingApiKeyError();
  }
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
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
 * it, via OpenAI's Responses API (client.responses.create). Asks
 * explicitly for JSON-only output and parses the returned `output_text`.
 */
export async function askStructured<T>(params: AskStructuredParams): Promise<T> {
  const openai = getClient();
  const response = await openai.responses.create({
    model: getModel(),
    max_output_tokens: params.maxTokens ?? 2048,
    instructions: `${params.system}\n\nRespond with ONLY a single JSON object matching this shape (no prose, no markdown fences):\n${params.schemaDescription}`,
    input: params.prompt,
  });
  recordUsage(response.usage);
  const text = response.output_text;
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
 * Runs a live web search via OpenAI's hosted `web_search` Responses API
 * tool and asks the model to summarize/list findings relevant to `query`
 * as structured JSON. Requires OPENAI_API_KEY. Never called in --mock
 * mode.
 *
 * Wired the same way the prior Anthropic web_search_20250305 integration
 * was: declare the hosted tool, let the model search and answer in one
 * call, then parse the JSON it's instructed to return. Confirmed against
 * the installed `openai` package's bundled type definitions
 * (resources/responses/responses.d.ts: WebSearchTool, `type: "web_search"`)
 * — if a future SDK version renames or drops this tool type, this call
 * will throw a clear API error rather than silently no-op; there is no
 * separate SERP API fallback wired in.
 */
export async function webSearchAndSummarize(query: string, instructions: string): Promise<WebSearchResultItem[]> {
  const openai = getClient();
  const response = await openai.responses.create({
    model: getModel(),
    tools: [{ type: "web_search" }],
    instructions:
      `${instructions}\n\n` +
      `After searching, respond with ONLY a JSON array of objects: ` +
      `[{"title": string, "url": string, "snippet": string}]`,
    input: query,
  });
  recordUsage(response.usage);
  const text = response.output_text;
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
