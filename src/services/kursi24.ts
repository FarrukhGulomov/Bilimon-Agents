/**
 * Deterministic scraper for kursi24.uz — a real Uzbekistan directory of
 * learning/course centers. Added as a SEPARATE, additional discovery source
 * per explicit user request (2026-09-03), alongside (not instead of) the
 * existing LLM-search-based discovery — no LLM call needed for this path at
 * all, so it costs nothing per institution found.
 *
 * Every selector below was verified against a real captured page — the user
 * supplied the actual page source of
 * https://kursi24.uz/uz/centre/result-english-school, saved at
 * data/reference/kursi24-sample-detail.html — never guessed. If kursi24.uz
 * changes its markup, parseKursi24DetailPage's regexes will simply return
 * fewer fields (never throw); test/run-all.ts's fixture-backed test is the
 * place to notice drift by re-capturing a real page.
 *
 * This pipeline has NOT verified kursi24.uz's category/listing-page markup
 * (no sample of one was available), so crawlKursi24 deliberately never
 * guesses that structure. Instead it grows its frontier purely from each
 * detail page's own confirmed "Yaqin atrofdagi o'quv markazlari" (nearby
 * learning centers) links — a real, verified mechanism for discovering
 * further institutions without needing a listing-page URL scheme at all.
 */
import { fetchAndCache } from "./scraper.js";
import { matchKeywords, CATEGORY_KEYWORDS, TYPE_KEYWORDS } from "./brief-parser.js";
import type { Category, InstitutionType } from "../schemas/enums.js";

export const KURSI24_BASE_URL = "https://kursi24.uz";

/** A handful of real, known-good starting points — crawlKursi24 grows far
 * beyond these via each page's own nearby-centers links (see module doc). */
export const KURSI24_SEED_URLS = [`${KURSI24_BASE_URL}/uz/centre/result-english-school`];

export interface Kursi24Listing {
  url: string;
  name: string | null;
  /** Raw address text exactly as kursi24.uz shows it (often Russian even on
   * the /uz/ page — a real quirk of the source, not a bug in this parser). */
  address: string | null;
  /** Best-effort city name derived from the address's first comma-separated
   * segment (this source's consistent convention: "City, street, ..."). */
  city: string | null;
  phone: string | null;
  website: string | null;
  instagram: string | null;
  facebook: string | null;
  telegram: string | null;
  /** Course/category labels exactly as kursi24.uz's own listing shows them
   * (e.g. "Ingliz tili") — see inferCategoriesFromLabels/inferTypesFromLabels
   * for mapping these to the real BilimOn enums. */
  categoryLabels: string[];
  lat: number | null;
  lng: number | null;
  /** Real prose describing the institution, taken verbatim from its
   * kursi24.uz listing page — a primary-source page read, not a search
   * summary, so it can seed descriptionSourceText directly. */
  descriptionSourceText: string | null;
  /** Other /uz/centre/... URLs linked from this page's "nearby learning
   * centers" widget — the crawl frontier (see module doc). */
  nearbyUrls: string[];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function cleanText(html: string): string {
  const text = decodeEntities(html.replace(/<[^>]+>/g, " "));
  return text
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

function absoluteUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return `${KURSI24_BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
}

/**
 * Parses one kursi24.uz institution detail page. Pure and exported for
 * offline testing against the real captured fixture — never calls the
 * network itself. Every field is independently optional: a markup change
 * that breaks one selector degrades gracefully (that field comes back
 * null/empty) rather than throwing and losing every other field.
 */
export function parseKursi24DetailPage(html: string, url: string): Kursi24Listing {
  const nameM = html.match(/<h1 class="stomser__7_rtu_h4">\s*([^<]+?)\s*<\/h1>/);
  const name = nameM ? decodeEntities(nameM[1]).trim() : null;

  let address: string | null = null;
  const addrBlockM = html.match(/<div class="courses_readmorebtncosd">([\s\S]*?)<\/div>/);
  if (addrBlockM) {
    const pM = addrBlockM[1].match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (pM) {
      const cleaned = cleanText(pM[1]);
      address = cleaned.length > 0 ? cleaned : null;
    }
  }
  // This source's consistent convention is "City, street, building" — the
  // first comma-separated segment is the city name, matched later against
  // the real city/alias table (services/location-mapper.ts) rather than
  // treated as a guaranteed-correct city on its own.
  const city = address ? address.split(",")[0]?.trim() || null : null;

  const phoneM = html.match(/href="tel:(\+?\d[\d\s()-]*\d)"\s+class="numbers-popup__number/);
  const phone = phoneM ? phoneM[1].replace(/[\s()-]/g, "") : null;

  const categoryLabels: string[] = [];
  const catBlockM = html.match(/<div class="kursi-spec__links">([\s\S]*?)<\/div>/);
  if (catBlockM) {
    for (const m of catBlockM[1].matchAll(/<a href="[^"]*">([^<]+)<\/a>/g)) {
      const label = decodeEntities(m[1]).trim();
      if (label) categoryLabels.push(label);
    }
  }

  let website: string | null = null;
  let instagram: string | null = null;
  let facebook: string | null = null;
  let telegram: string | null = null;
  for (const m of html.matchAll(/class="courses_s_lo_aaa"\s*\n?\s*href="([^"]+)">\s*([^<]+?)\s*<\/a>/g)) {
    const href = m[1].trim();
    const label = decodeEntities(m[2]).trim().toLowerCase();
    if (label === "website") website = href;
    else if (label === "instagram") instagram = href;
    else if (label === "facebook") facebook = href;
    else if (label === "telegram") telegram = href;
  }

  let lat: number | null = null;
  let lng: number | null = null;
  const geoM = html.match(/'LON':'([\d.]+)','LAT':'([\d.]+)'/);
  if (geoM) {
    lng = Number(geoM[1]);
    lat = Number(geoM[2]);
  }

  let descriptionSourceText: string | null = null;
  const descM = html.match(
    /id="pills-home" role="tabpanel" aria-labelledby="pills-home-tab">([\s\S]*?)<div class="kursi-spec">/
  );
  if (descM) {
    const withBreaks = descM[1].replace(/<br\s*\/?>/gi, "\n");
    const cleaned = cleanText(withBreaks);
    descriptionSourceText = cleaned.length > 0 ? cleaned : null;
  }

  const nearbyUrls: string[] = [];
  for (const m of html.matchAll(/<h3><a\s+href="(\/uz\/centre\/[^"]+)">[^<]*<\/a><\/h3>/g)) {
    nearbyUrls.push(absoluteUrl(m[1]));
  }

  return {
    url,
    name,
    address,
    city,
    phone,
    website,
    instagram,
    facebook,
    telegram,
    categoryLabels,
    lat,
    lng,
    descriptionSourceText,
    nearbyUrls,
  };
}

/** Maps kursi24.uz's own category labels (e.g. "Ingliz tili") to the real
 * BilimOn Category enum via the exact keyword tables services/brief-parser.ts
 * already uses to parse a free-text brief — reusing that table rather than
 * inventing a second mapping that could silently drift out of sync with it.
 * Best-effort: a label with no keyword match is simply omitted, never
 * guessed — an institution with no inferred category still flows through
 * normally, it just relies on later stages (research/manual review) to fill
 * `categories` in. */
export function inferCategoriesFromLabels(labels: string[]): Category[] {
  if (labels.length === 0) return [];
  const joined = labels.join(" ").toLowerCase();
  return matchKeywords(joined, CATEGORY_KEYWORDS).matched;
}

/** Same idea as inferCategoriesFromLabels, for InstitutionType. */
export function inferTypesFromLabels(labels: string[]): InstitutionType[] {
  if (labels.length === 0) return [];
  const joined = labels.join(" ").toLowerCase();
  return matchKeywords(joined, TYPE_KEYWORDS).matched;
}

/**
 * BFS crawl seeded from known kursi24.uz/uz/centre/... URLs, following each
 * page's own "nearby o'quv markazlari" links to discover more (see module
 * doc for why — no listing-page markup has been verified). Never throws for
 * an individual page failure (a 404, a refused fetch, a page whose markup
 * yields no name) — that page is just skipped, matching this pipeline's
 * "one bad source costs only itself" convention (see researcher.ts).
 *
 * fetchAndCache's on-disk cache (data/cache/) makes repeat crawls of the
 * same URL free, so calling this again with a larger targetCount mostly
 * just extends the frontier further rather than re-fetching everything.
 */
export async function crawlKursi24(
  seedUrls: string[],
  targetCount: number,
  maxVisited = 300
): Promise<Kursi24Listing[]> {
  const queue = [...seedUrls];
  const visited = new Set<string>();
  const results: Kursi24Listing[] = [];

  while (queue.length > 0 && results.length < targetCount && visited.size < maxVisited) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    let page;
    try {
      page = await fetchAndCache(url);
    } catch (err) {
      console.warn(`kursi24 crawl: fetch failed for ${url} — ${(err as Error).message}`);
      continue;
    }
    if (!page.html) continue;

    const listing = parseKursi24DetailPage(page.html, url);
    if (listing.name) results.push(listing);

    for (const next of listing.nearbyUrls) {
      if (!visited.has(next)) queue.push(next);
    }
  }

  return results;
}
