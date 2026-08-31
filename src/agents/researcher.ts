/**
 * Deep Research agent. In --mock mode, reads evidence from
 * data/fixtures/mock-research.json (FIXTURE/TEST DATA). In real mode,
 * would scrape discovered URLs (services/scraper.ts) and run LLM-assisted
 * extraction (services/extractor.ts) — not exercised in this build
 * environment (no live network/API access).
 *
 * Research evidence files under data/research/<id>.json are append-only:
 * existing evidence items (matched by sourceUrl) are never overwritten,
 * and re-running research for an already-researched id only adds evidence
 * for source URLs not already recorded.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { EvidenceItem, RawExtractedFields, ResearchRecord } from "../types/index.js";
import { fetchAndCache } from "../services/scraper.js";
import { extractFieldsFromText } from "../services/extractor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESEARCH_DIR = join(__dirname, "..", "..", "data", "research");
const MOCK_RESEARCH_PATH = join(__dirname, "..", "..", "data", "fixtures", "mock-research.json");

interface MockResearchFile {
  byFixtureId: Record<string, { evidence: Omit<EvidenceItem, "fetchedAt">[] }>;
}

let mockResearchCache: MockResearchFile | null = null;
function loadMockResearch(): MockResearchFile {
  if (!mockResearchCache) {
    mockResearchCache = JSON.parse(readFileSync(MOCK_RESEARCH_PATH, "utf-8"));
  }
  return mockResearchCache as MockResearchFile;
}

function researchPath(id: string): string {
  return join(RESEARCH_DIR, `${id}.json`);
}

function ensureDir(): void {
  if (!existsSync(RESEARCH_DIR)) mkdirSync(RESEARCH_DIR, { recursive: true });
}

export function readResearchRecord(id: string): ResearchRecord | null {
  const p = researchPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as ResearchRecord;
}

/** Append-only write: merges new evidence items (by sourceUrl) into the existing file. */
function appendEvidence(id: string, nameKey: string, newItems: EvidenceItem[]): ResearchRecord {
  ensureDir();
  const existing = readResearchRecord(id) ?? { id, nameKey, evidence: [] };
  const seenUrls = new Set(existing.evidence.map((e) => e.sourceUrl));
  for (const item of newItems) {
    if (!seenUrls.has(item.sourceUrl)) {
      existing.evidence.push(item);
      seenUrls.add(item.sourceUrl);
    }
  }
  writeFileSync(researchPath(id), JSON.stringify(existing, null, 2), "utf-8");
  return existing;
}

/** Gathers evidence for a fixture-backed candidate in mock mode. */
export function researchMock(id: string, nameKey: string, fixtureId: string): ResearchRecord {
  const mock = loadMockResearch();
  const entry = mock.byFixtureId[fixtureId];
  const items: EvidenceItem[] = (entry?.evidence ?? []).map((e) => ({
    ...e,
    fetchedAt: new Date().toISOString(),
  }));
  return appendEvidence(id, nameKey, items);
}

/** Real research: scrape + extract from a set of source URLs. Not exercised in this build. */
export async function researchLive(
  id: string,
  nameKey: string,
  sourceUrls: string[]
): Promise<ResearchRecord> {
  const items: EvidenceItem[] = [];
  for (const url of sourceUrls) {
    const page = await fetchAndCache(url);
    if (!page.text) continue;
    const extracted = await extractFieldsFromText(url, page.text);
    items.push({
      fetchedAt: new Date().toISOString(),
      sourceUrl: url,
      sourceType: "website",
      extractedFields: extracted,
      rawTextExcerpt: page.text.slice(0, 500),
      confidence: 0.6, // heuristic default for a single unverified source in real mode
    });
  }
  return appendEvidence(id, nameKey, items);
}

/** Merge all evidence for a research record into one RawExtractedFields, preferring
 * higher-confidence, more-recently-appended evidence for each field. */
export function mergeEvidence(record: ResearchRecord): { fields: RawExtractedFields; evidenceCount: number; bestSourceConfidence: number } {
  const merged: RawExtractedFields = {};
  let bestSourceConfidence = 0;
  // Sort ascending by confidence so higher-confidence evidence is applied last (wins ties).
  const sorted = [...record.evidence].sort((a, b) => a.confidence - b.confidence);
  for (const item of sorted) {
    bestSourceConfidence = Math.max(bestSourceConfidence, item.confidence);
    for (const [key, value] of Object.entries(item.extractedFields)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return { fields: merged, evidenceCount: record.evidence.length, bestSourceConfidence };
}
