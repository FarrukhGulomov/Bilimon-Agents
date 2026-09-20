/**
 * LLM calls for the free-text listing-search mode (agents/listing-search.ts):
 * parse a natural-language query into structured filters, then find real,
 * currently-listed matching items across real Uzbekistan classifieds sites.
 *
 * Unlike market-scan's two-stage discovery+per-candidate-deep-research
 * shape, this is a SINGLE search call after parsing: a classifieds listing
 * page is normally self-contained (price, attributes, contact all on one
 * page/search snippet), unlike an institution's scattered evidence across
 * a site/socials/directories — and the user explicitly asked for results
 * "qisqa vaqt ichida" (quickly), so this deliberately avoids an N-call
 * fan-out per candidate.
 *
 * Not exercised by execution in this build environment (no live network/API
 * access) — same constraint as every other real-mode-only LLM call in this
 * codebase; --mock mode (agents/listing-search.ts's fixture path) is what's
 * actually run and verified here.
 */
import { askStructured, webSearchStructuredList } from "./llm-client.js";
import type { ListingFilters, ListingRecord } from "../types/listing-search.js";

const FILTERS_SCHEMA = `{"itemType": string|null, "attributes": {[key: string]: string}}`;

/**
 * Parses a free-text query (Uzbek/Russian/English) into structured filters.
 * Never invents an attribute the query didn't name — an ambiguous or
 * sparse query just yields fewer attributes, not guessed ones.
 */
export async function parseListingQuery(rawQuery: string): Promise<ListingFilters> {
  const result = await askStructured<{ itemType: string | null; attributes: Record<string, string> }>({
    system:
      "You parse a free-text shopping query (Uzbek, Russian, or English) written by someone looking to " +
      "buy something in Uzbekistan into structured search filters. Identify `itemType` (a short free-text " +
      "guess at the category, e.g. \"avtomobil\", \"kvartira\", \"uy\", \"telefon\" — null if genuinely " +
      "unclear) and `attributes`: every concrete, specific attribute the query actually names, as " +
      "key/value pairs using short English snake_case-ish keys (e.g. brand, model, year, transmission, " +
      "color, mileage_km, rooms, area_sqm, district, price_max, condition). Only include an attribute the " +
      "query actually states — never infer or add one it doesn't mention. Keep values close to the " +
      "query's own wording/units (e.g. \"53 ming\" stays \"53000\" for mileage_km, a color name stays as " +
      "written).",
    prompt: `Query: "${rawQuery}"`,
    schemaDescription: FILTERS_SCHEMA,
  });
  return {
    rawQuery,
    itemType: typeof result.itemType === "string" && result.itemType.trim() ? result.itemType.trim() : null,
    attributes: sanitizeAttributes(result.attributes),
  };
}

function sanitizeAttributes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim().length > 0 && key.trim().length > 0) {
      out[key.trim()] = value.trim();
    }
  }
  return out;
}

interface RawListingSearchResult {
  title?: unknown;
  price?: unknown;
  location?: unknown;
  sourceSite?: unknown;
  sourceUrl?: unknown;
  attributes?: unknown;
  postedDate?: unknown;
  description?: unknown;
}

const LISTING_SCHEMA = `[{
  "title": string, "price": string|null, "location": string|null,
  "sourceSite": string, "sourceUrl": string,
  "attributes": {[key: string]: string}, "postedDate": string|null, "description": string|null
}]`;

/**
 * Searches real Uzbekistan classifieds sites (OLX.uz, Joymee.uz, Uytop.uz,
 * and any other real site a web search surfaces) for up to `count` real,
 * currently-listed items matching `filters`. Every returned entry MUST
 * carry a real `sourceUrl` the model actually opened — an entry without
 * one is dropped by the caller (agents/listing-search.ts), never trusted
 * as a real listing on the strength of a title alone.
 */
export async function searchListings(filters: ListingFilters, count: number): Promise<ListingRecord[]> {
  const attributeLines = Object.entries(filters.attributes)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  const query =
    `Find real, currently-listed items for sale in Uzbekistan matching this request.\n` +
    `Original query: "${filters.rawQuery}"\n` +
    (filters.itemType ? `Item type: ${filters.itemType}\n` : "") +
    (attributeLines ? `Requested attributes:\n${attributeLines}\n` : "") +
    `Search real Uzbekistan classifieds/marketplace sites: olx.uz, joymee.uz, uytop.uz, and any other ` +
    `real site a search turns up.`;

  const instructions =
    "You are a listing-search agent. Find real, currently-listed items for sale in Uzbekistan that " +
    "match the requested filters, by actually opening real classifieds/marketplace pages (olx.uz, " +
    "joymee.uz, uytop.uz, and others) — never invent a listing, its price, or its attributes.\n\n" +
    "HARD RULE: every result MUST have a real `sourceUrl` you actually opened and that genuinely shows " +
    "this specific listing — a title/price you are not confident came from a real page you opened is " +
    "worthless here and must be left out entirely, not included with a guessed or omitted URL.\n\n" +
    "For each listing, only fill `attributes` with what THAT listing's own page actually states — never " +
    "copy the requested filters onto a listing whose page doesn't confirm them (e.g. don't assume the " +
    "requested color if the page photo/text doesn't state it). A listing that matches some but not all " +
    "requested attributes is still worth including — the caller decides relevance, you report facts. " +
    "`price` and all attribute values are verbatim as the source states them — never converted, " +
    "estimated, or rounded. `description`: 1-2 factual sentences from the listing itself.\n\n" +
    "Most Uzbekistan classifieds are in Uzbek or Russian — search and read in those languages too. If " +
    "you cannot verify any real matching listing, return an empty array rather than guessing.";

  const results = await webSearchStructuredList<RawListingSearchResult>(
    query,
    instructions,
    LISTING_SCHEMA,
    Math.min(Math.max(count * 2, 5), 15)
  );

  return results
    .map(normalizeListing)
    .filter((l): l is ListingRecord => l !== null);
}

function normalizeListing(raw: RawListingSearchResult): ListingRecord | null {
  const sourceUrl = typeof raw.sourceUrl === "string" ? raw.sourceUrl.trim() : "";
  // Hard rule enforced here, not just in the prompt: a listing without a
  // real, fetchable URL is not a verifiable listing — see this module's
  // header comment.
  if (!/^https?:\/\//i.test(sourceUrl)) return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;

  let sourceSite = typeof raw.sourceSite === "string" ? raw.sourceSite.trim() : "";
  if (!sourceSite) {
    try {
      sourceSite = new URL(sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      sourceSite = "";
    }
  }

  return {
    title,
    price: typeof raw.price === "string" && raw.price.trim() ? raw.price.trim() : null,
    location: typeof raw.location === "string" && raw.location.trim() ? raw.location.trim() : null,
    sourceSite,
    sourceUrl,
    attributes: sanitizeAttributes(raw.attributes),
    postedDate: typeof raw.postedDate === "string" && raw.postedDate.trim() ? raw.postedDate.trim() : null,
    description: typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : null,
  };
}
