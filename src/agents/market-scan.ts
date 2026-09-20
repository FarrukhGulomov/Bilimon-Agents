/**
 * Keyword-driven "market scan" mode — a general-purpose competitor lookup,
 * deliberately independent of the BilimOn education-institution pipeline
 * (see types/market-scan.ts's doc comment for why). Given a free-text
 * keyword (e.g. "onlayn kredit"), discovers real providers and researches
 * each one's concrete offer, then exports the result as JSON + CSV
 * (services/csv-writer.ts — Excel opens CSV natively).
 *
 * In --mock mode, reads from data/fixtures/mock-market-scan.json so this
 * mode is fully exercisable offline (same convention as every other mode
 * in this codebase). Real mode is not exercised by execution in this build
 * environment (no live network/API access).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { CompetitorRecord, MarketScanResult } from "../types/market-scan.js";
import { discoverCompetitors, researchCompetitor, type CompetitorCandidate } from "../services/market-scan-llm.js";
import { handleProviderError } from "../services/llm-client.js";
import { toCsv } from "../services/csv-writer.js";
import { normalizeNameKey, slugify } from "../services/normalizer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = join(__dirname, "..", "..", "data", "export");
const MOCK_PATH = join(__dirname, "..", "..", "data", "fixtures", "mock-market-scan.json");

interface MockMarketScanFile {
  byKeyword: Record<string, { competitors: CompetitorRecord[] }>;
  default: { competitors: CompetitorRecord[] };
}

let mockCache: MockMarketScanFile | null = null;
function loadMock(): MockMarketScanFile {
  if (!mockCache) {
    mockCache = JSON.parse(readFileSync(MOCK_PATH, "utf-8"));
  }
  return mockCache as MockMarketScanFile;
}

export interface MarketScanOptions {
  keyword: string;
  count: number;
  mock: boolean;
}

const STRING_FIELDS = [
  "providerName", "productName", "category", "website", "phone",
  "interestRate", "loanAmountRange", "loanTermRange", "description",
] as const;

/** Drops nulls/empty strings so an "I found nothing" answer never looks
 * like a real value. Pure and exported for offline testing — mirrors
 * agents/researcher.ts::normalizeResearchFields' shape/intent for this
 * mode's own field set. */
export function normalizeCompetitorFields(raw: Record<string, unknown> | null | undefined): Partial<CompetitorRecord> {
  const out: Partial<CompetitorRecord> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of STRING_FIELDS) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) out[key] = value.trim();
  }
  const requirements = raw.requirements;
  if (Array.isArray(requirements)) {
    const items = requirements.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
    if (items.length > 0) out.requirements = items;
  }
  return out;
}

// Same non-determinism mitigation as agents/researcher.ts::researchLive —
// a web-search-grounded call can land badly once; retry a bounded number
// of times before accepting "not confirmed" as final.
const MAX_RESEARCH_ATTEMPTS = 2;

async function researchCompetitorWithRetry(candidate: CompetitorCandidate, keyword: string): Promise<CompetitorRecord | null> {
  for (let attempt = 1; attempt <= MAX_RESEARCH_ATTEMPTS; attempt++) {
    try {
      const result = await researchCompetitor(candidate, keyword);
      if (result && result.isRealProvider === true) {
        const fields = normalizeCompetitorFields(result.fields);
        const citedUrls = Array.isArray(result.sourceUrls)
          ? result.sourceUrls.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u))
          : [];
        return {
          providerName: fields.providerName ?? candidate.name,
          productName: fields.productName ?? null,
          category: fields.category ?? null,
          website: fields.website ?? candidate.website ?? null,
          phone: fields.phone ?? null,
          interestRate: fields.interestRate ?? null,
          loanAmountRange: fields.loanAmountRange ?? null,
          loanTermRange: fields.loanTermRange ?? null,
          requirements: fields.requirements ?? [],
          description: fields.description ?? null,
          sourceUrls: citedUrls,
        };
      }
      console.log(
        `Market scan: "${candidate.name}" not confirmed as a real provider on attempt ${attempt}/${MAX_RESEARCH_ATTEMPTS} ` +
          `(isRealProvider=${result?.isRealProvider ?? "null (no parseable response)"}).`
      );
    } catch (err) {
      const info = handleProviderError(err);
      console.warn(`Market scan: research failed for "${candidate.name}" on attempt ${attempt}/${MAX_RESEARCH_ATTEMPTS} — ${info.message}`);
    }
  }
  return null;
}

/** Pure and exported for offline testing. */
export function dedupeCandidatesByName(candidates: CompetitorCandidate[]): CompetitorCandidate[] {
  const seen = new Set<string>();
  const out: CompetitorCandidate[] = [];
  for (const c of candidates) {
    const key = normalizeNameKey(c.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export async function runMarketScan(opts: MarketScanOptions): Promise<MarketScanResult> {
  const keyword = opts.keyword.trim();
  let competitors: CompetitorRecord[] = [];

  if (opts.mock) {
    const mock = loadMock();
    const entry = mock.byKeyword[normalizeNameKey(keyword)] ?? mock.default;
    competitors = (entry?.competitors ?? []).slice(0, opts.count);
  } else {
    const candidates = dedupeCandidatesByName(await discoverCompetitors(keyword, opts.count)).slice(0, opts.count);
    for (const cand of candidates) {
      const record = await researchCompetitorWithRetry(cand, keyword);
      if (record) competitors.push(record);
    }
  }

  return { keyword, generatedAt: new Date().toISOString(), competitors };
}

const CSV_COLUMNS: [keyof CompetitorRecord, string][] = [
  ["providerName", "Provayder"],
  ["productName", "Mahsulot"],
  ["category", "Turkum"],
  ["website", "Sayt"],
  ["phone", "Telefon"],
  ["interestRate", "Foiz stavkasi"],
  ["loanAmountRange", "Kredit summasi"],
  ["loanTermRange", "Muddat"],
  ["requirements", "Talablar"],
  ["description", "Tavsif"],
];

export function marketScanToCsv(result: MarketScanResult): string {
  return toCsv(result.competitors, CSV_COLUMNS);
}

function ensureExportDir(): void {
  if (!existsSync(EXPORT_DIR)) mkdirSync(EXPORT_DIR, { recursive: true });
}

export function writeMarketScanExport(result: MarketScanResult): { jsonPath: string; csvPath: string } {
  ensureExportDir();
  const slug = slugify(result.keyword) || "scan";
  const jsonPath = join(EXPORT_DIR, `market-scan-${slug}.json`);
  const csvPath = join(EXPORT_DIR, `market-scan-${slug}.csv`);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf-8");
  writeFileSync(csvPath, marketScanToCsv(result), "utf-8");
  return { jsonPath, csvPath };
}
