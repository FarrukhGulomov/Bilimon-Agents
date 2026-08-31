/**
 * Thin wrapper around the Anthropic SDK for all LLM calls in this pipeline.
 * Centralizes: model selection (ANTHROPIC_MODEL env, default claude-sonnet-5),
 * a clear error when ANTHROPIC_API_KEY is missing, and JSON-structured
 * response parsing used by the extractor/dedupe/content-manager services.
 *
 * This module is exercised structurally by --mock runs (never invoked), and
 * is otherwise untested-by-execution in this environment per the task
 * constraints — no real network/API calls were made building this pipeline.
 */
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-sonnet-5";

export function getModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set. Real (non-mock) LLM/web-search calls require it.\n" +
        "Fix: copy .env.example to .env and set ANTHROPIC_API_KEY=sk-ant-..., or export it in your shell.\n" +
        "Alternatively, run the pipeline with --mock (or PIPELINE_MOCK=1) to exercise the pipeline " +
        "end-to-end against local fixtures without any API key."
    );
    this.name = "MissingApiKeyError";
  }
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new MissingApiKeyError();
  }
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
 * Ask Claude for a JSON object matching `schemaDescription` and parse it.
 * Uses adaptive thinking off (this is a structured-extraction call, not an
 * open-ended reasoning task) and asks explicitly for JSON-only output.
 */
export async function askStructured<T>(params: AskStructuredParams): Promise<T> {
  const anthropic = getClient();
  const response = await anthropic.messages.create({
    model: getModel(),
    max_tokens: params.maxTokens ?? 2048,
    system: `${params.system}\n\nRespond with ONLY a single JSON object matching this shape (no prose, no markdown fences):\n${params.schemaDescription}`,
    messages: [{ role: "user", content: params.prompt }],
  });
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) {
    throw new Error("LLM response contained no text block to parse as JSON");
  }
  const jsonText = extractJson(textBlock.text);
  try {
    return JSON.parse(jsonText) as T;
  } catch (err) {
    throw new Error(`Failed to parse LLM JSON response: ${(err as Error).message}\nRaw text: ${textBlock.text}`);
  }
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * Runs a live web search via Anthropic's server-side web_search tool and
 * asks Claude to summarize/list findings relevant to `query` as structured
 * JSON. Requires ANTHROPIC_API_KEY. Never called in --mock mode.
 */
export async function webSearchAndSummarize(query: string, instructions: string): Promise<WebSearchResultItem[]> {
  const anthropic = getClient();
  const response = await anthropic.messages.create({
    model: getModel(),
    max_tokens: 4096,
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
      } as unknown as Anthropic.Tool,
    ],
    system:
      `${instructions}\n\n` +
      `After searching, respond with ONLY a JSON array of objects: ` +
      `[{"title": string, "url": string, "snippet": string}]`,
    messages: [{ role: "user", content: query }],
  });
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) return [];
  try {
    return JSON.parse(extractJson(textBlock.text)) as WebSearchResultItem[];
  } catch {
    return [];
  }
}
