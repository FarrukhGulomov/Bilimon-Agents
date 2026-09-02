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

// Real production failure: `fetch(url)` with no headers sends node's default
// user-agent, and a large share of real Uzbek sites (and anything behind
// Cloudflare) answer that with a 403 or an interstitial — so the scrape
// returned no text for pages a browser loads fine. Sending an ordinary
// browser UA plus Uzbek/Russian Accept-Language costs nothing and recovers
// the plain static sites, which is most of what this scraper can usefully
// read at all. It does NOT (and cannot) defeat login walls on Instagram/
// Telegram/Facebook or render JS-only pages — that is precisely why the
// scrape is now the SUPPLEMENTARY source and the search-grounded research
// call in agents/researcher.ts is the primary one.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "uz,ru;q=0.9,en;q=0.8",
};

/** Per-request timeout. Without one, a single unresponsive host stalls an
 * institution's whole research pass behind the default (very long) socket
 * timeout. Override with SCRAPER_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Fetch + cache a URL's readable text. Returns the cached copy without any
 * network call if one already exists. Real network fetches are not
 * exercised in this build environment; --mock mode never calls this.
 *
 * A failure (network error, timeout, 403/404/5xx, or a page whose readable
 * text is empty) is a NORMAL outcome here, not an error condition: it is
 * cached as `text: ""` with an `error`/status note and the caller simply
 * gets no supplementary evidence from that URL. Failures stay cached so a
 * rerun is idempotent and does not re-hammer a host that already refused.
 */
export async function fetchAndCache(url: string): Promise<CachedPage> {
  const cached = readCache(url);
  if (cached) return cached;

  const timeoutMs = Number(process.env.SCRAPER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const html = res.ok ? await res.text() : "";
    const entry: CachedPage = {
      url,
      fetchedAt: new Date().toISOString(),
      status: res.status,
      text: htmlToText(html).slice(0, 20000),
      error: res.ok ? undefined : `HTTP ${res.status}`,
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
