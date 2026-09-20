/**
 * Free-text-query-driven listing search mode ("e'lonlar qidiruvi") —
 * independent of both the BilimOn education pipeline and the market-scan
 * mode (types/market-scan.ts). A user types a natural-language description
 * of what they want to buy — a car ("2023 yil ishlab chiqarilgan onix mt
 * avtomobili oq rangli 53 ming yurgan"), an apartment ("3 xonali kvartira
 * Chilonzorda ipoteka"), or anything else — and this mode parses it into
 * structured filters, then finds real, currently-listed matching items
 * across real Uzbekistan classifieds sites (OLX.uz, Joymee.uz, Uytop.uz,
 * and whatever else a web search surfaces).
 *
 * Deliberately generic rather than car-specific or real-estate-specific:
 * `attributes` is an open key/value bag the parser fills in from whatever
 * the query actually names, not a fixed schema — the same reasoning as
 * market-scan's `category` being free text rather than a closed enum,
 * since a rigid schema can't anticipate every item type a user might type.
 *
 * Telegram channel/group search was explicitly requested but is NOT
 * implemented here — see README.md's "Listing search" section for why
 * (Bot API can't search channels it wasn't already a member of when a
 * message was posted; a user-session/MTProto integration that could is a
 * separate, higher-risk piece of work requiring an interactive login this
 * session couldn't do, and the user asked to build the web-search part
 * first). This mode only covers what a web search can reach.
 */

export interface ListingFilters {
  /** The user's original free-text query, kept verbatim for provenance. */
  rawQuery: string;
  /** Free-text guess at what kind of item this is (e.g. "avtomobil",
   * "kvartira") — not a closed enum; null when the query is too vague to
   * classify. */
  itemType: string | null;
  /** Whatever concrete attributes the query actually named (e.g.
   * {brand: "Chevrolet", model: "Onix", year: "2023", transmission: "MT",
   * color: "Oq", mileageKm: "53000"}) — an open bag, not a fixed schema. */
  attributes: Record<string, string>;
}

export interface ListingRecord {
  title: string;
  /** Verbatim as the source states it — never converted/estimated (same
   * rule as CompetitorRecord.interestRate in market-scan). */
  price: string | null;
  location: string | null;
  /** The site's own domain/name (e.g. "olx.uz"), for grouping/filtering. */
  sourceSite: string;
  /** Hard-required — a listing with no real URL is never included (see
   * services/listing-search-llm.ts). */
  sourceUrl: string;
  /** Whatever attributes THIS specific listing's page actually confirms —
   * a subset of (or matching) the query's requested attributes, never
   * padded with guesses for ones the page doesn't state. */
  attributes: Record<string, string>;
  postedDate: string | null;
  description: string | null;
}

export interface ListingSearchResult {
  filters: ListingFilters;
  generatedAt: string;
  listings: ListingRecord[];
}
