/**
 * Fetches a URL and extracts readable text, with an on-disk cache under
 * data/cache/<sha256-of-url>.json. A URL already cached is never refetched
 * (see orchestrator resumability requirement).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
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

/** Cap on the response body actually read into memory, in bytes. Generous
 * for a scrape-and-slice-to-20000-chars use case; override with
 * SCRAPER_MAX_BYTES. See the SSRF comment block below for why this is
 * enforced while STREAMING, not after materializing the whole body. */
const DEFAULT_MAX_BYTES = 2_000_000;

/** Hop cap for manually-followed redirects — see the SSRF comment block below. */
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// SSRF hardening.
//
// Real risk this closes: every URL `fetchAndCache` fetches ultimately
// originates from an LLM's web-search output (services/search.ts's
// discovered website/telegram/etc. fields, agents/researcher.ts's cited
// source URLs) — content an LLM, itself processing untrusted web text,
// chose to hand back. Fetching such a URL with no destination check is a
// textbook SSRF: a malicious or compromised source page could point this
// server at http://169.254.169.254/latest/meta-data/ (cloud instance
// metadata), an internal admin panel on 10.0.0.0/8, or localhost itself —
// and this scraper would fetch it and hand the response text straight into
// the extraction pipeline.
//
// Three independent protections, all enforced before/while the actual
// network read happens (never after the fact):
//   1. Scheme + resolved-hostname classification (isBlockedIp/
//      classifyUrlForFetch below) — DNS resolution is checked, not just
//      whether the URL text contains a literal private IP, since an
//      innocuous-looking hostname can still resolve to one.
//   2. Redirects are followed MANUALLY (redirect: "manual"), re-checking
//      the destination of EVERY hop against the same classification — a URL
//      that passes the initial check can still redirect server-side to an
//      internal address, and "redirect: follow" would have fetched that
//      hop with zero validation.
//   3. The response body is read via its stream with a running byte count,
//      capped at SCRAPER_MAX_BYTES — never materialized in full before a
//      size check, so a malicious/misconfigured server returning gigabytes
//      cannot be read into memory before anything notices.
// ---------------------------------------------------------------------------

/**
 * Classifies an already-resolved IP address as blocked (private, loopback,
 * link-local, or otherwise non-routable-from-the-public-internet) or not.
 * Pure — no I/O — so this is unit-testable without DNS. Deliberately
 * conservative: an unparseable address is blocked.
 */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP at all — refuse rather than guess
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local, incl. 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 shared/CGNAT address space
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const norm = ip.toLowerCase();
  if (norm === "::1" || norm === "::") return true; // loopback / unspecified
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — classify the embedded IPv4 address.
  const mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  const firstGroup = norm.split(":")[0];
  if (/^f[cd][0-9a-f]{0,2}$/.test(firstGroup)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]?$/.test(firstGroup)) return true; // fe80::/10 link-local
  return false;
}

export interface UrlSafetyResult {
  safe: boolean;
  reason?: string;
}

/**
 * Full destination check for a URL about to be fetched: scheme allowlist,
 * then DNS resolution (or direct classification for a literal IP) against
 * isBlockedIp for every resolved address. Async only because of the DNS
 * lookup — the actual decision logic (isBlockedIp) is the pure, offline-
 * testable part.
 */
export async function classifyUrlForFetch(url: URL): Promise<UrlSafetyResult> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { safe: false, reason: `unsupported scheme "${url.protocol}"` };
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost") {
    return { safe: false, reason: "hostname is localhost" };
  }
  if (isIP(hostname)) {
    return isBlockedIp(hostname)
      ? { safe: false, reason: `resolves to blocked address ${hostname}` }
      : { safe: true };
  }
  let addresses: string[];
  try {
    const results = await dnsLookup(hostname, { all: true });
    addresses = results.map((r) => r.address);
  } catch (err) {
    return { safe: false, reason: `DNS lookup failed for "${hostname}": ${(err as Error).message}` };
  }
  if (addresses.length === 0) {
    return { safe: false, reason: `DNS lookup for "${hostname}" returned no addresses` };
  }
  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      return { safe: false, reason: `"${hostname}" resolves to blocked address ${addr}` };
    }
  }
  return { safe: true };
}

/** True for an HTTP redirect status code. Pure, exported for tests. */
export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Resolves a `Location` header against the URL it was returned for. Pure —
 * no I/O — exported so the redirect-hop logic is unit-testable in isolation. */
export function resolveRedirectTarget(location: string, baseUrl: string): string | null {
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Concatenates chunks up to (and truncating at) `maxBytes`. Pure — no
 * streams — so the byte-cap logic is unit-testable without a live response.
 */
export function capChunks(chunks: Uint8Array[], maxBytes: number): Buffer {
  const kept: Buffer[] = [];
  let total = 0;
  for (const chunk of chunks) {
    if (total >= maxBytes) break;
    const buf = Buffer.from(chunk);
    const remaining = maxBytes - total;
    if (buf.length <= remaining) {
      kept.push(buf);
      total += buf.length;
    } else {
      kept.push(buf.subarray(0, remaining));
      total += remaining;
      break;
    }
  }
  return Buffer.concat(kept);
}

/** Streams a response body, stopping once `maxBytes` has been read — never
 * materializes the full body first. A cap hit is a normal truncated-but-
 * usable outcome (partial HTML is still often usable), not an error. */
async function readBodyWithCap(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // best-effort; we already have enough bytes
          }
          break;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released via cancel()
    }
  }
  return capChunks(chunks, maxBytes).toString("utf-8");
}

/** Skip/treat-as-empty anything that isn't text-ish — no reason to run a
 * PDF/image/video through a tag-stripping text extractor. Loose by design:
 * an absent Content-Type (some misconfigured hosts) is treated as text
 * rather than rejected outright. */
function isTextLikeContentType(contentType: string): boolean {
  if (!contentType) return true;
  return /^(text\/|application\/(xhtml\+xml|xml|json))/i.test(contentType.trim());
}

function failEntry(url: string, error: string): CachedPage {
  return { url, fetchedAt: new Date().toISOString(), status: null, text: "", error };
}

/**
 * Fetch + cache a URL's readable text. Returns the cached copy without any
 * network call if one already exists. Real network fetches are not
 * exercised in this build environment; --mock mode never calls this.
 *
 * A failure (network error, timeout, 403/404/5xx, blocked SSRF destination,
 * or a page whose readable text is empty) is a NORMAL outcome here, not an
 * error condition: it is cached as `text: ""` with an `error`/status note
 * and the caller simply gets no supplementary evidence from that URL.
 * Failures stay cached so a rerun is idempotent and does not re-hammer a
 * host that already refused (or re-probe an internal address).
 */
export async function fetchAndCache(url: string): Promise<CachedPage> {
  const cached = readCache(url);
  if (cached) return cached;

  const timeoutMs = Number(process.env.SCRAPER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const maxBytes = Number(process.env.SCRAPER_MAX_BYTES ?? DEFAULT_MAX_BYTES);

  try {
    let currentUrl = url;
    let res: Response | null = null;
    let parsed: URL | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        parsed = new URL(currentUrl);
      } catch {
        const entry = failEntry(url, `invalid URL: ${currentUrl}`);
        writeCache(entry);
        return entry;
      }

      const check = await classifyUrlForFetch(parsed);
      if (!check.safe) {
        const entry = failEntry(url, `refused to fetch — ${check.reason}`);
        writeCache(entry);
        return entry;
      }

      res = await fetch(parsed.toString(), {
        redirect: "manual", // every hop is re-validated above before being fetched
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const location = res.headers.get("location");
      if (isRedirectStatus(res.status) && location) {
        const next = resolveRedirectTarget(location, parsed.toString());
        if (!next) {
          const entry = failEntry(url, `redirect to unparseable location "${location}"`);
          writeCache(entry);
          return entry;
        }
        currentUrl = next;
        continue;
      }
      break;
    }

    if (!res || (isRedirectStatus(res.status) && res.headers.get("location"))) {
      const entry = failEntry(url, `too many redirects (>${MAX_REDIRECTS})`);
      writeCache(entry);
      return entry;
    }

    const contentType = res.headers.get("content-type") ?? "";
    let html = "";
    if (res.ok && isTextLikeContentType(contentType) && res.body) {
      html = await readBodyWithCap(res.body, maxBytes);
    }
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
    const entry = failEntry(url, (err as Error).message);
    writeCache(entry);
    return entry;
  }
}
