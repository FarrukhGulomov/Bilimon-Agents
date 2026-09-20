/**
 * Free-text listing-search mode ("e'lonlar qidiruvi") — a real user request:
 * type a natural-language description of what to buy (a car, an apartment,
 * anything else) and get real, currently-listed matching items from real
 * Uzbekistan classifieds sites, exported as JSON + CSV. Independent of both
 * the BilimOn education pipeline and the market-scan mode — see
 * types/listing-search.ts's doc comment for why, including the explicit
 * note that Telegram channel/group search was requested but is NOT
 * implemented (see README.md's "Listing search" section).
 *
 * In --mock mode, reads from data/fixtures/mock-listing-search.json using a
 * small deterministic keyword heuristic to guess the item type (no LLM call
 * — mirrors services/brief-parser.ts's heuristic mode), so this mode is
 * fully exercisable offline. Real mode is not exercised by execution in
 * this build environment (no live network/API access).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ListingFilters, ListingRecord, ListingSearchResult } from "../types/listing-search.js";
import { parseListingQuery, searchListings } from "../services/listing-search-llm.js";
import { toCsv } from "../services/csv-writer.js";
import { slugify } from "../services/normalizer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = join(__dirname, "..", "..", "data", "export");
const MOCK_PATH = join(__dirname, "..", "..", "data", "fixtures", "mock-listing-search.json");

interface MockListingSearchFile {
  byItemType: Record<string, { listings: ListingRecord[] }>;
  default: { listings: ListingRecord[] };
}

let mockCache: MockListingSearchFile | null = null;
function loadMock(): MockListingSearchFile {
  if (!mockCache) {
    mockCache = JSON.parse(readFileSync(MOCK_PATH, "utf-8"));
  }
  return mockCache as MockListingSearchFile;
}

// Deterministic, no-LLM-call item-type guess for --mock mode only — mirrors
// services/brief-parser.ts's TYPE_KEYWORDS heuristic pattern. Real mode
// uses parseListingQuery (an LLM call) instead; this exists purely so
// --mock can pick a plausible fixture bucket without a network call.
const MOCK_ITEM_TYPE_KEYWORDS: Record<string, string[]> = {
  avtomobil: ["avtomobil", "mashina", "avto ", "krossover", "sedan", " mt ", " at "],
};

/** Pure and exported for offline testing. */
export function guessMockItemType(query: string): string | null {
  const lower = ` ${query.toLowerCase()} `;
  for (const [itemType, keywords] of Object.entries(MOCK_ITEM_TYPE_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return itemType;
  }
  return null;
}

export interface ListingSearchOptions {
  query: string;
  count: number;
  mock: boolean;
}

export async function runListingSearch(opts: ListingSearchOptions): Promise<ListingSearchResult> {
  const rawQuery = opts.query.trim();
  let filters: ListingFilters;
  let listings: ListingRecord[];

  if (opts.mock) {
    const itemType = guessMockItemType(rawQuery);
    filters = { rawQuery, itemType, attributes: {} };
    const mock = loadMock();
    const entry = (itemType ? mock.byItemType[itemType] : undefined) ?? mock.default;
    listings = (entry?.listings ?? []).slice(0, opts.count);
  } else {
    filters = await parseListingQuery(rawQuery);
    const found = await searchListings(filters, opts.count);
    listings = dedupeListingsByUrl(found).slice(0, opts.count);
  }

  return { filters, generatedAt: new Date().toISOString(), listings };
}

/** Pure and exported for offline testing. */
export function dedupeListingsByUrl(listings: ListingRecord[]): ListingRecord[] {
  const seen = new Set<string>();
  const out: ListingRecord[] = [];
  for (const l of listings) {
    if (seen.has(l.sourceUrl)) continue;
    seen.add(l.sourceUrl);
    out.push(l);
  }
  return out;
}

const CSV_COLUMNS: [keyof ListingRecord, string][] = [
  ["title", "Nomi"],
  ["price", "Narxi"],
  ["location", "Manzil"],
  ["sourceSite", "Sayt"],
  ["sourceUrl", "Havola"],
  ["postedDate", "E'lon sanasi"],
  ["description", "Tavsif"],
];

export function listingSearchToCsv(result: ListingSearchResult): string {
  // attributes is a free-form object, not a fixed column — flatten it into
  // one readable "key: value; key: value" cell rather than one column per
  // possible attribute (which would vary wildly between a car search and
  // an apartment search).
  const rows = result.listings.map((l) => ({
    ...l,
    attributesText: Object.entries(l.attributes).map(([k, v]) => `${k}: ${v}`).join("; "),
  }));
  const columns: [string, string][] = [...CSV_COLUMNS, ["attributesText", "Xususiyatlar"]];
  return toCsv(rows, columns as [keyof (typeof rows)[number], string][]);
}

function ensureExportDir(): void {
  if (!existsSync(EXPORT_DIR)) mkdirSync(EXPORT_DIR, { recursive: true });
}

export function writeListingSearchExport(result: ListingSearchResult): { jsonPath: string; csvPath: string } {
  ensureExportDir();
  const slug = slugify(result.filters.rawQuery) || "search";
  const jsonPath = join(EXPORT_DIR, `listing-search-${slug}.json`);
  const csvPath = join(EXPORT_DIR, `listing-search-${slug}.csv`);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf-8");
  writeFileSync(csvPath, listingSearchToCsv(result), "utf-8");
  return { jsonPath, csvPath };
}
