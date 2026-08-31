/**
 * Discovery agent. In --mock mode, reads synthetic candidates from
 * data/fixtures/mock-discovery.json (clearly labeled FIXTURE/TEST DATA —
 * never real institutions). In real mode, runs live web search per
 * priority category / seed city via services/search.ts (requires
 * ANTHROPIC_API_KEY; not exercised in this build environment).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { searchInstitutions } from "../services/search.js";
import { listCities } from "../services/location-mapper.js";
import type { DiscoveredInstitution } from "../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "..", "..", "data", "fixtures", "mock-discovery.json");
const PRIORITY_PATH = join(__dirname, "..", "..", "config", "priority-categories.json");

export interface MockDiscoveryEntry {
  fixtureId: string;
  rawName: string;
  city: string;
  category: string;
  phone: string | null;
  website: string | null;
  telegram: string | null;
  instagram: string | null;
  sourceUrl: string;
}

export interface DiscoveryCandidate extends DiscoveredInstitution {
  fixtureId?: string; // present only in mock mode, used to join with mock-research.json
  phone?: string | null;
  website?: string | null;
  telegram?: string | null;
  instagram?: string | null;
}

export function loadMockDiscoveryFixture(): MockDiscoveryEntry[] {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
  return raw.institutions as MockDiscoveryEntry[];
}

function loadPriorityCategories(): string[] {
  const raw = JSON.parse(readFileSync(PRIORITY_PATH, "utf-8"));
  return raw.order.map((o: { category: string }) => o.category);
}

/** Mock discovery: take the first `count` fixture entries, in list order. */
export function discoverMock(count: number): DiscoveryCandidate[] {
  const entries = loadMockDiscoveryFixture();
  return entries.slice(0, count).map((e) => ({
    discoveryId: e.fixtureId,
    fixtureId: e.fixtureId,
    rawName: e.rawName,
    city: e.city,
    category: e.category,
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
 * Real discovery: iterates priority categories x seed cities running live
 * web search until `count` candidates are collected. Requires
 * ANTHROPIC_API_KEY (see services/llm-client.ts MissingApiKeyError).
 */
export async function discoverLive(count: number): Promise<DiscoveryCandidate[]> {
  const categories = loadPriorityCategories();
  const cities = listCities();
  const results: DiscoveryCandidate[] = [];

  outer: for (const category of categories) {
    for (const city of cities) {
      if (results.length >= count) break outer;
      const found = await searchInstitutions(city.nameEn, category);
      for (const f of found) {
        if (results.length >= count) break;
        results.push({
          discoveryId: `${f.url}`,
          rawName: f.title,
          city: city.nameEn,
          category,
          sourceUrl: f.url,
          sourceType: "web_search",
          notes: f.snippet,
          discoveredAt: new Date().toISOString(),
        });
      }
    }
  }
  return results;
}

export async function runDiscovery(count: number, mock: boolean): Promise<DiscoveryCandidate[]> {
  return mock ? discoverMock(count) : discoverLive(count);
}
