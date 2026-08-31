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
import { searchInstitutions } from "../services/search.js";
import { listCities } from "../services/location-mapper.js";
import { loadDefaultScope, type DiscoveryScope } from "../services/brief-parser.js";
import { runWithConcurrency } from "../services/concurrency.js";
import { loadExecutionConfig } from "../services/execution-config.js";
import { CATEGORIES, type InstitutionType, type Category } from "../schemas/enums.js";
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

export interface DiscoveryCandidate extends DiscoveredInstitution {
  fixtureId?: string; // present only in mock mode, used to join with mock-research.json
  type?: string; // present in mock mode; real mode leaves type resolution to the researcher/extractor
  phone?: string | null;
  website?: string | null;
  telegram?: string | null;
  instagram?: string | null;
}

export function loadMockDiscoveryFixture(): MockDiscoveryEntry[] {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
  return raw.institutions as MockDiscoveryEntry[];
}

function matchesScope(entry: MockDiscoveryEntry, scope: DiscoveryScope): boolean {
  const typeOk = scope.types === "all" || scope.types.includes(entry.type as InstitutionType);
  const categoryOk = scope.categories === "all" || scope.categories.includes(entry.category as Category);
  return typeOk && categoryOk;
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

export async function discoverLive(
  count: number,
  scope: DiscoveryScope = loadDefaultScope()
): Promise<DiscoveryCandidate[]> {
  const facets = buildSearchFacets(scope);
  const cities = listCities();
  const units: SearchUnit[] = [];
  for (const facet of facets) for (const city of cities) units.push({ facet, city });

  const { maxConcurrency } = loadExecutionConfig();
  const results: DiscoveryCandidate[] = [];
  let searchesStarted = 0;

  await runWithConcurrency({
    items: units,
    limit: maxConcurrency,
    shouldStop: () => results.length >= count,
    worker: async ({ facet, city }) => {
      const n = ++searchesStarted;
      console.log(
        `Discovery: search ${n}/${units.length} — city=${city.nameEn}` +
          (facet.category ? ` category=${facet.category}` : "") +
          (facet.type ? ` type=${facet.type}` : "")
      );
      const found = await searchInstitutions(city.nameEn, facet.category, facet.type);
      for (const f of found) {
        results.push({
          discoveryId: `${f.url}`,
          rawName: f.title,
          city: city.nameEn,
          category: facet.category,
          type: facet.type,
          sourceUrl: f.url,
          sourceType: "web_search",
          notes: f.snippet,
          discoveredAt: new Date().toISOString(),
        });
      }
    },
  });

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
