/**
 * Discovery agent. In --mock mode, reads synthetic candidates from
 * data/fixtures/mock-discovery.json (clearly labeled FIXTURE/TEST DATA —
 * never real institutions). In real mode, runs live web search per
 * priority category / seed city via services/search.ts (requires
 * OPENAI_API_KEY; not exercised in this build environment).
 *
 * Both modes are scoped by a `DiscoveryScope` (src/services/brief-parser.ts),
 * resolved from an optional free-text `--brief` or, when no brief is given,
 * from the pre-existing config/priority-categories.json default — see
 * README.md "Brief-driven discovery" for the full design.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { searchInstitutions, type DiscoverySearchResult } from "../services/search.js";
import { listCities, resolveCity } from "../services/location-mapper.js";
import { loadDefaultScope, type DiscoveryScope } from "../services/brief-parser.js";
import { runWithConcurrency } from "../services/concurrency.js";
import { loadExecutionConfig } from "../services/execution-config.js";
import { CATEGORIES, type InstitutionType, type Category } from "../schemas/enums.js";
import { isFatalProviderError } from "../services/llm-client.js";
import {
  crawlKursi24,
  inferCategoriesFromLabels,
  inferTypesFromLabels,
  KURSI24_SEED_URLS,
  type Kursi24Listing,
} from "../services/kursi24.js";
import type { DiscoveredInstitution } from "../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "..", "..", "data", "fixtures", "mock-discovery.json");

export interface MockDiscoveryEntry {
  fixtureId: string;
  rawName: string;
  city: string;
  category: string;
  /** Real BilimOn `type` enum value this fixture is tagged with (added so
   * --mock discovery can exercise brief-driven scope filtering by type, not
   * just by category). */
  type: string;
  phone: string | null;
  website: string | null;
  telegram: string | null;
  instagram: string | null;
  sourceUrl: string;
}

/**
 * A discovered institution plus the contact profile Agent 1 saw while
 * finding it. Real production failure: in live mode only `rawName`/
 * `sourceUrl`/`city`/`category` were ever populated — the website/telegram/
 * instagram/phone fields below existed but were set by the mock fixtures
 * ONLY, so the spec's "Agent 1 also finds their websites and social-network
 * addresses" was simply not implemented. services/search.ts now returns a
 * per-institution profile and mapSearchResultToCandidate() below carries all
 * of it onto the candidate, where the orchestrator's existing
 * "fill in from discovery if research didn't supply it" block picks it up.
 */
export interface DiscoveryCandidate extends DiscoveredInstitution {
  fixtureId?: string; // present only in mock mode, used to join with mock-research.json
  type?: string; // present in mock mode; real mode leaves type resolution to the researcher/extractor
  phone?: string | null;
  website?: string | null;
  telegram?: string | null;
  instagram?: string | null;
  /** Facebook page, if Agent 1 saw one. Not a BilimOn export field (the real
   * schema has no facebook column) — kept as a research starting point for
   * Agent 2, never exported. */
  facebook?: string | null;
  address?: string | null;
  /** Present only for sourceType "kursi24_scrape" — deterministically parsed
   * from the listing's embedded map coordinates, not geocoded/guessed. */
  lat?: number | null;
  lng?: number | null;
  /** Real prose describing the institution, taken verbatim from its
   * kursi24.uz listing page (sourceType "kursi24_scrape" only) — the same
   * role EvidenceItem.extractedFields.descriptionSourceText plays for
   * research evidence, carried this early because the scrape already IS a
   * primary-source page read, not a search summary. */
  descriptionSourceText?: string | null;
}

/**
 * Maps one live search result onto a DiscoveryCandidate. Pure and exported
 * so the mapping is testable offline without a network call.
 *
 * `searchedCity` is the city the search was run for; a city the source
 * itself states wins over it, since a directory listing knows better than
 * the query does. Empty strings are normalized to null so a blank model
 * field never looks like a real value downstream.
 */
export function mapSearchResultToCandidate(
  result: DiscoverySearchResult,
  searchedCity: string,
  discoveredAt: string = new Date().toISOString()
): DiscoveryCandidate {
  const clean = (v: string | null | undefined): string | null => {
    const trimmed = typeof v === "string" ? v.trim() : "";
    return trimmed.length > 0 ? trimmed : null;
  };
  const name = clean(result.name) ?? clean(result.title) ?? "";
  return {
    discoveryId: `${result.url}`,
    rawName: name,
    city: clean(result.city) ?? searchedCity,
    category: result.category,
    type: result.type,
    sourceUrl: result.url,
    sourceType: "web_search",
    notes: clean(result.snippet) ?? undefined,
    phone: clean(result.phone),
    website: clean(result.website),
    telegram: clean(result.telegram),
    instagram: clean(result.instagram),
    facebook: clean(result.facebook),
    address: clean(result.address),
    discoveredAt,
  };
}

export function loadMockDiscoveryFixture(): MockDiscoveryEntry[] {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
  return raw.institutions as MockDiscoveryEntry[];
}

function matchesScope(entry: MockDiscoveryEntry, scope: DiscoveryScope): boolean {
  const typeOk = scope.types === "all" || scope.types.includes(entry.type as InstitutionType);
  const categoryOk = scope.categories === "all" || scope.categories.includes(entry.category as Category);
  // Real production gap: this used to ignore scope.regions entirely, so a
  // city-scoped brief (e.g. the web frontend's city dropdown, or "--brief
  // 'Buxoroda'") silently returned fixtures from EVERY city in --mock mode,
  // even though discoverLive already hard-filters live search by region —
  // --mock's whole purpose is exercising the same scoping logic offline.
  const regionOk = scope.regions === "all" || scope.regions.includes(entry.city);
  return typeOk && categoryOk && regionOk;
}

/**
 * Mock discovery: filters the 40 fixture entries down to those matching
 * `scope`'s `type`/`categories`, then takes the first `count` of those (in
 * fixture-file order) — so e.g. scope.types === ["SCHOOL","LYCEUM"] returns
 * only the SCHOOL/LYCEUM-tagged fixtures, and the default "all"/"all" scope
 * returns the full 40, matching pre-brief-feature behavior exactly.
 */
export function discoverMock(count: number, scope: DiscoveryScope = loadDefaultScope()): DiscoveryCandidate[] {
  const entries = loadMockDiscoveryFixture();
  const inScope = entries.filter((e) => matchesScope(e, scope));
  return inScope.slice(0, count).map((e) => ({
    discoveryId: e.fixtureId,
    fixtureId: e.fixtureId,
    rawName: e.rawName,
    city: e.city,
    category: e.category,
    type: e.type,
    sourceUrl: e.sourceUrl,
    sourceType: "fixture" as const,
    phone: e.phone,
    website: e.website,
    telegram: e.telegram,
    instagram: e.instagram,
    discoveredAt: new Date().toISOString(),
  }));
}

/**
 * Real discovery: iterates scope categories x scope types x seed cities
 * running live web search until `count` candidates are collected. "all" for
 * either dimension expands to the full real enum list from
 * src/schemas/enums.ts. Requires OPENAI_API_KEY (see
 * services/llm-client.ts MissingApiKeyError).
 */
/** A (category, type) search facet — one or the other (or both) may be
 * undefined, meaning "don't narrow the search query on that dimension". */
interface SearchFacet {
  category?: string;
  type?: string;
}

/** Builds the list of (category, type) facets to search, without a full
 * category x type cross product blowing up the search count when only one
 * dimension is actually narrowed by the brief:
 *  - both narrowed  -> cross product of the (small) narrowed lists
 *  - only categories narrowed -> one facet per category (pre-existing
 *    default-scope behavior: the 4 config/priority-categories.json values)
 *  - only types narrowed -> one facet per type
 *  - neither narrowed ("all"/"all", e.g. an unscoped brief) -> one facet per
 *    real category, covering the full institution-type space via `type`
 *    being left unset (broadest possible real-mode search). */
function buildSearchFacets(scope: DiscoveryScope): SearchFacet[] {
  const categoriesNarrowed = scope.categories !== "all";
  const typesNarrowed = scope.types !== "all";
  if (categoriesNarrowed && typesNarrowed) {
    const facets: SearchFacet[] = [];
    for (const category of scope.categories as string[]) {
      for (const type of scope.types as string[]) facets.push({ category, type });
    }
    return facets;
  }
  if (categoriesNarrowed) {
    return (scope.categories as string[]).map((category) => ({ category }));
  }
  if (typesNarrowed) {
    return (scope.types as string[]).map((type) => ({ type }));
  }
  return [...CATEGORIES].map((category) => ({ category }));
}

/** One (facet, city) live web-search unit of work. The default scope alone
 * is 4 categories x 9 cities = 36 possible searches; run sequentially
 * (the original implementation) that's up to 36 slow (tens of seconds
 * each) OpenAI web-search calls back-to-back before ever reaching the
 * per-institution stages — observed in practice as a multi-minute "nothing
 * is happening" real run. runWithConcurrency + shouldStop below bounds
 * both the wall-clock time (searches run `maxConcurrency` at a time) and
 * the worst-case overshoot past `count` (at most `maxConcurrency` searches
 * already in flight when the target is reached, never the full facet x
 * city cross product). */
interface SearchUnit {
  facet: SearchFacet;
  city: ReturnType<typeof listCities>[number];
}

/** Maps one kursi24.uz listing onto a DiscoveryCandidate. Pure and exported
 * so the mapping is testable offline without a network call. */
export function mapKursi24ListingToCandidate(listing: Kursi24Listing): DiscoveryCandidate {
  const categories = inferCategoriesFromLabels(listing.categoryLabels);
  const types = inferTypesFromLabels(listing.categoryLabels);
  return {
    discoveryId: listing.url,
    rawName: listing.name ?? "",
    city: listing.city ?? undefined,
    category: categories[0],
    type: types[0],
    sourceUrl: listing.url,
    sourceType: "kursi24_scrape",
    notes: listing.categoryLabels.length > 0 ? listing.categoryLabels.join(", ") : undefined,
    phone: listing.phone,
    website: listing.website,
    telegram: listing.telegram,
    instagram: listing.instagram,
    facebook: listing.facebook,
    address: listing.address,
    lat: listing.lat,
    lng: listing.lng,
    descriptionSourceText: listing.descriptionSourceText,
    discoveredAt: new Date().toISOString(),
  };
}

/** City scope is a hard filter here, same as the live-search facet loop
 * below — a real, reliably-derived city name (from the address's own first
 * segment) makes this as trustworthy as the live-search path's city
 * targeting. Category/type scope is deliberately NOT filtered: kursi24's own
 * category labels only map onto the real enum via keyword matching (see
 * inferCategoriesFromLabels), which is necessarily lossy — an unscoped
 * default brief's 4 priority categories would otherwise silently discard
 * most kursi24 institutions whose label just didn't hit a keyword, defeating
 * the entire point of this source (surfacing as much of kursi24.uz's real
 * data as possible). An uncategorized candidate still flows through
 * normally; later stages (research/quality gate) fill categories in. */
function kursi24CandidateInScope(cand: DiscoveryCandidate, scope: DiscoveryScope): boolean {
  if (scope.regions === "all") return true;
  if (!cand.city) return false;
  const resolved = resolveCity(cand.city);
  if (!resolved) return false;
  return (scope.regions as string[]).includes(resolved.cityName);
}

export async function discoverLive(
  count: number,
  scope: DiscoveryScope = loadDefaultScope()
): Promise<DiscoveryCandidate[]> {
  const results: DiscoveryCandidate[] = [];

  // kursi24.uz scrape — a separate, additional discovery source (real user
  // request, 2026-09-03): deterministic and free (no LLM call at all), so
  // tried first; only the shortfall is filled by the LLM-search facet loop
  // below.
  try {
    const listings = await crawlKursi24(KURSI24_SEED_URLS, count);
    let kursi24Found = 0;
    for (const listing of listings) {
      const cand = mapKursi24ListingToCandidate(listing);
      if (!kursi24CandidateInScope(cand, scope)) continue;
      results.push(cand);
      kursi24Found++;
      if (results.length >= count) break;
    }
    if (kursi24Found > 0) {
      console.log(`Discovery: kursi24.uz scrape found ${kursi24Found} candidate(s) in scope.`);
    }
  } catch (err) {
    console.warn(`Discovery: kursi24.uz scrape failed — ${(err as Error).message}`);
  }

  if (results.length >= count) return results.slice(0, count);

  const facets = buildSearchFacets(scope);
  // A brief naming a specific city (e.g. "Toshkentda") is a HARD filter
  // here, not just a hint: it bounds how many (facet, city) live-search
  // calls run, directly controlling real API cost/time. Falls back to all
  // seed cities if the named region matched nothing in the known table
  // (defensive — resolveBriefHeuristic only ever returns names it found in
  // the same table, so this should not normally trigger).
  const allCities = listCities();
  const cities =
    scope.regions === "all"
      ? allCities
      : allCities.filter((c) => (scope.regions as string[]).includes(c.nameEn));
  const effectiveCities = cities.length > 0 ? cities : allCities;
  const units: SearchUnit[] = [];
  for (const facet of facets) for (const city of effectiveCities) units.push({ facet, city });

  const { maxConcurrency } = loadExecutionConfig();
  let searchesStarted = 0;
  // Set when a search hits a fatal provider error (bad key / no credits).
  // Every remaining search would fail identically, so stop pulling new work
  // and rethrow once the in-flight searches have settled — cli.ts turns this
  // into one clear line and a non-zero exit instead of a stack dump.
  let fatal: unknown = null;

  await runWithConcurrency({
    items: units,
    limit: maxConcurrency,
    shouldStop: () => fatal !== null || results.length >= count,
    worker: async ({ facet, city }) => {
      const n = ++searchesStarted;
      console.log(
        `Discovery: search ${n}/${units.length} — city=${city.nameEn}` +
          (facet.category ? ` category=${facet.category}` : "") +
          (facet.type ? ` type=${facet.type}` : "")
      );
      let found: DiscoverySearchResult[] = [];
      try {
        found = await searchInstitutions(city.nameEn, facet.category, facet.type);
      } catch (err) {
        // searchInstitutions already swallows ordinary failures; anything
        // reaching here is fatal (or a MissingApiKeyError). Record it and
        // let the batch wind down rather than throwing out of
        // runWithConcurrency mid-flight, which is exactly how the user's
        // last real run died.
        if (fatal === null) fatal = err;
        if (!isFatalProviderError(err)) throw err;
        return;
      }
      for (const f of found) {
        results.push(mapSearchResultToCandidate(f, city.nameEn));
      }
    },
  });

  if (fatal !== null) throw fatal;

  // Concurrent workers can overshoot `count` slightly (multiple in-flight
  // searches settling around the same time, each potentially returning
  // several results) — cap to `count` here, matching discoverMock's
  // contract of returning at most `count` candidates.
  return results.slice(0, count);
}

export async function runDiscovery(
  count: number,
  mock: boolean,
  scope: DiscoveryScope = loadDefaultScope()
): Promise<DiscoveryCandidate[]> {
  return mock ? discoverMock(count, scope) : discoverLive(count, scope);
}
