/**
 * Fetches a URL and extracts readable text, with an on-disk cache under
 * data/cache/<sha256-of-url>.json. A URL already cached is never refetched
 * (see orchestrator resumability requirement).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sha256 } from "./normalizer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "..", "data", "cache");

export interface CachedPage {
  url: string;
  fetchedAt: string;
  status: number | null;
  text: string;
  error?: string;
}

function cachePath(url: string): string {
  return join(CACHE_DIR, `${sha256(url)}.json`);
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

/** Very small HTML->text reducer: strips tags/scripts/styles, collapses whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function readCache(url: string): CachedPage | null {
  const p = cachePath(url);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CachedPage;
  } catch {
    return null;
  }
}

function writeCache(entry: CachedPage): void {
  ensureCacheDir();
  writeFileSync(cachePath(entry.url), JSON.stringify(entry, null, 2), "utf-8");
}

/**
 * Fetch + cache a URL's readable text. Returns the cached copy without any
 * network call if one already exists. Real network fetches are not
 * exercised in this build environment; --mock mode never calls this.
 */
export async function fetchAndCache(url: string): Promise<CachedPage> {
  const cached = readCache(url);
  if (cached) return cached;

  try {
    const res = await fetch(url, { redirect: "follow" });
    const html = await res.text();
    const entry: CachedPage = {
      url,
      fetchedAt: new Date().toISOString(),
      status: res.status,
      text: htmlToText(html).slice(0, 20000),
    };
    writeCache(entry);
    return entry;
  } catch (err) {
    const entry: CachedPage = {
      url,
      fetchedAt: new Date().toISOString(),
      status: null,
      text: "",
      error: (err as Error).message,
    };
    writeCache(entry);
    return entry;
  }
}
