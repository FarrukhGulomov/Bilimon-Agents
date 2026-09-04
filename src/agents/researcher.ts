/**
 * Deep Research agent (Agent 2). In --mock mode, reads evidence from
 * data/fixtures/mock-research.json (FIXTURE/TEST DATA).
 *
 * REAL MODE — two sources per institution (not exercised by execution in
 * this build environment; no live network/API access):
 *
 *  1. PRIMARY, always: one web-search-grounded research call scoped to this
 *     single institution (llm-client.ts::researchInstitutionViaWebSearch).
 *     It is told to check the official site, Instagram/Telegram, kursi24.uz/uz
 *     (an Uzbekistan learning-center directory), and the yellowpages.uz /
 *     goldenpages.uz directories, and to return the full "sales" fact set
 *     including descriptionSourceText — the field Agent 3 writes from.
 *  2. SUPPLEMENTARY, best-effort: the plain HTML scrape (scraper.ts +
 *     extractor.ts) of the URLs we know about. A failed or empty fetch is a
 *     normal, silent outcome.
 *
 * Why (real production failure): this used to be scrape-only, over exactly
 * ONE url (the orchestrator passed `[cand.sourceUrl]`), through a naive
 * fetch() + regex tag-strip. Against the real web that yields nothing for
 * most sources — Instagram/Telegram/Facebook serve login walls, JS-only
 * sites serve empty shells, many hosts 403 a non-browser user-agent — so
 * `page.text` was empty, the loop `continue`d, and the evidence array came
 * out length 0. Zero evidence means zero extracted fields, which is why
 * every real run produced no usable records while --mock looked perfect.
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
import { computeEvidenceConfidence, countCorroboratedFields } from "../services/scoring.js";
import { handleProviderError, researchInstitutionViaWebSearch } from "../services/llm-client.js";

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

/** Everything Agent 1 knows about one institution, handed to Agent 2 as
 * research starting points (never as facts to repeat back). */
export interface LiveResearchInput {
  name: string;
  city?: string;
  website?: string | null;
  telegram?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  /** The page discovery found the institution on (a directory listing, a
   * blog roundup, the official site — whatever the search returned). */
  sourceUrl?: string | null;
}

/** At most this many pages are scraped per institution. The scrape is the
 * supplementary source; it is not worth minutes of wall clock per record. */
const MAX_SCRAPE_URLS = 4;

/** Synthetic, stable provenance key for the search-grounded research item —
 * used ONLY as a last-resort fallback when the model cited zero real URLs
 * (see selectResearchEvidenceSource below). An EvidenceItem always needs
 * some sourceUrl to satisfy the type and appendEvidence's dedupe-by-sourceUrl
 * logic. */
function researchEvidenceUrl(nameKey: string): string {
  return `research://web-search/${encodeURIComponent(nameKey)}`;
}

/**
 * Picks the search-grounded evidence item's real sourceUrl.
 *
 * Real production bug: the primary web-search research call's evidence item
 * — where most extracted fields (phone, address, programs, etc.) actually
 * come from — was ALWAYS recorded under the synthetic
 * `research://web-search/...` placeholder, even when the same call returned
 * `research.sourceUrls` (real cited https:// URLs). Those real URLs were
 * only ever used transiently to seed the separate supplementary scrape pass
 * — never preserved on the evidence item itself. A human reviewer opening
 * data/research/<id>.json to answer "where did this phone number come from?"
 * saw a fake URI instead of the real page(s) the model actually cited.
 *
 * Now: when the model cited at least one real URL, the evidence item's
 * sourceUrl IS that real URL (the first one), with any further cited URLs
 * preserved in `additionalSourceUrls` rather than discarded — the real
 * URL(s) stay visible in data/research/<id>.json. Only when the model
 * genuinely returned zero real cited URLs do we fall back to the synthetic
 * placeholder. Pure and exported for offline tests.
 */
export function selectResearchEvidenceSource(
  nameKey: string,
  citedUrls: string[]
): { sourceUrl: string; additionalSourceUrls?: string[] } {
  const real = citedUrls.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
  if (real.length === 0) return { sourceUrl: researchEvidenceUrl(nameKey) };
  const [primary, ...rest] = real;
  return rest.length > 0 ? { sourceUrl: primary, additionalSourceUrls: rest } : { sourceUrl: primary };
}

/** Classifies a URL for confidence purposes — see SOURCE_TYPE_BASE in
 * services/scoring.ts for what each kind is worth. */
export function classifySourceUrl(url: string): EvidenceItem["sourceType"] {
  const u = url.toLowerCase();
  if (/(instagram\.com|t\.me|telegram\.me|facebook\.com|fb\.com)/.test(u)) return "social";
  if (/(kursi24\.uz|yellowpages\.uz|goldenpages\.uz|maps\.|2gis\.|olx\.uz|orgpage|yandex\.[a-z]+\/maps)/.test(u)) return "directory";
  if (/^https?:\/\//.test(u)) return "website";
  return "other";
}

// Real production bug: real-mode web-search research for "Registon o'quv
// markazi" returned `programs` entries that were actually SEO-style search
// RESULT TITLES about the institution — "REGISTON o'quv markazlari
// tarmog'i (filiallar)", "Chirchiqda ingliz tili kurslari", "O'zbekistonda
// ingliz tili kurslari", "Farg'ona va Farg'ona viloyatidagi o'quv markazi"
// — instead of real course/subject names ("General English", "IELTS",
// "CEFR (ingliz tili)", as actually listed on the institution's own
// rgn.uz/kurslar/ page). The model conflated "search results ABOUT the
// institution" with "courses OFFERED by the institution". A phrase that
// repeats the institution's own name, or is a city/branch/marketing
// description rather than a subject name, is never a real course — this
// is a deterministic backstop that drops it before export, on top of the
// prompt asking the model not to do this in the first place (see
// llm-client.ts::researchInstitutionViaWebSearch).
// Uzbek text in the wild mixes the straight apostrophe ('), the curly ones
// (' '), and the modifier letter turned comma (ʻ) for the same sound —
// real observed input used U+2018 ("O‘zbekistondagi o‘quv markazi") — so
// the optional-apostrophe slot below must match all of them, not just '.
const APOSTROPHE = "['‘’ʻʼ]?";
const JUNK_PROGRAM_PATTERN = new RegExp(
  `(o${APOSTROPHE}quv markaz|filial|tarmog|shahrida|shahridagi|viloyatidagi|eng yaxshi|top\\s*\\d*\\s*(kurs|markaz)|o${APOSTROPHE}zbekiston|uzbekistan|узбекистан)`,
  "i"
);

/** Pure and exported for offline testing. */
export function isLikelyRealProgramName(item: string, instituteNames: (string | null | undefined)[]): boolean {
  const lower = item.toLowerCase();
  for (const name of instituteNames) {
    if (name && name.trim().length > 0 && lower.includes(name.trim().toLowerCase())) return false;
  }
  return !JUNK_PROGRAM_PATTERN.test(lower);
}

/**
 * Normalizes whatever the research call returned into RawExtractedFields:
 * drops nulls, empty strings and empty arrays (so an "I found nothing"
 * answer never looks like a real value), keeps only known field names, and
 * coerces the numeric fields. Pure and exported so it is testable offline.
 */
export function normalizeResearchFields(raw: Record<string, unknown> | null | undefined): Partial<RawExtractedFields> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return out;

  const stringFields = [
    "nameUz", "nameRu", "nameLatin", "phone", "phone2", "email", "website",
    "telegram", "instagram", "city", "address", "achievements", "pricingNote",
    "descriptionSourceText",
  ];
  const arrayFields = ["languages", "programs", "shifts", "specializations"];
  const numberFields = ["foundedYear", "studentCount", "teacherCount"];

  for (const key of stringFields) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) out[key] = value.trim();
  }
  const instituteNames = [out.nameUz, out.nameRu, out.nameLatin] as (string | undefined)[];
  for (const key of arrayFields) {
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    let items = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
    if (key === "programs" || key === "specializations") {
      items = items.filter((item) => isLikelyRealProgramName(item, instituteNames));
    }
    if (items.length > 0) out[key] = items;
  }
  for (const key of numberFields) {
    const value = raw[key];
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(n) && n > 0) out[key] = Math.round(n);
  }
  return out as Partial<RawExtractedFields>;
}

/**
 * Assigns each evidence item a confidence that reflects what it actually
 * contributed: its source kind, how much substantive detail it yielded, and
 * how many identifying facts (phone/website/address) the OTHER items agree
 * on. Replaces the old hardcoded 0.6 (see EvidenceItem.confidence in
 * types/index.ts for why that constant broke every real run). Pure and
 * exported for offline tests.
 */
export function scoreEvidenceItems(
  items: Omit<EvidenceItem, "confidence">[]
): EvidenceItem[] {
  return items.map((item, i) => {
    const others = items.filter((_, j) => j !== i).map((o) => o.extractedFields);
    return {
      ...item,
      confidence: computeEvidenceConfidence({
        sourceType: item.sourceType,
        fields: item.extractedFields,
        corroboratedFieldCount: countCorroboratedFields(item.extractedFields, others),
      }),
    };
  });
}

/** Ordered, deduped list of pages worth scraping for one institution. */
function buildScrapeTargets(input: LiveResearchInput, researchCitedUrls: string[]): string[] {
  const ordered = [input.website, input.sourceUrl, ...researchCitedUrls, input.telegram, input.instagram];
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const url of ordered) {
    if (!url || typeof url !== "string") continue;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) continue; // "@handle" and bare domains aren't fetchable as-is
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    targets.push(trimmed);
    if (targets.length >= MAX_SCRAPE_URLS) break;
  }
  return targets;
}

/**
 * Real research for one institution. Never throws for an ordinary failure:
 * a failing search call, a refused fetch or a failing extraction each cost
 * only their own evidence item, so one bad institution can never take down
 * a batch. Only a fatal provider error (bad key / no credits) escapes, so
 * the orchestrator can stop the run with a clear message.
 *
 * Not exercised by execution in this build environment (no network/API key).
 */
export async function researchLive(
  id: string,
  nameKey: string,
  input: LiveResearchInput
): Promise<ResearchRecord> {
  const unscored: Omit<EvidenceItem, "confidence">[] = [];
  const now = () => new Date().toISOString();

  // --- Source 1 (primary): web-search-grounded research on this institution.
  let citedUrls: string[] = [];
  try {
    const research = await researchInstitutionViaWebSearch({
      name: input.name,
      city: input.city,
      knownLinks: [input.website, input.telegram, input.instagram, input.facebook, input.sourceUrl],
    });
    // Real production bug: "look up by name" mode was tested with
    // "Registon" (the Registan, a Samarkand historical monument, not a
    // learning center) and this call happily returned facts about it — the
    // schema now asks the model to self-report whether the named entity is
    // actually a currently-operating education institution
    // (isEducationInstitution), and anything not explicitly confirmed true
    // is discarded here rather than merged as if it were real evidence.
    if (research && research.isEducationInstitution !== true) {
      console.log(`Research: "${input.name}" not confirmed as an education institution — discarding research fields (isEducationInstitution=${research.isEducationInstitution}).`);
    } else if (research) {
      const fields = normalizeResearchFields(research.fields);
      citedUrls = Array.isArray(research.sourceUrls)
        ? research.sourceUrls.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u))
        : [];
      if (Object.keys(fields).length > 0) {
        const { sourceUrl, additionalSourceUrls } = selectResearchEvidenceSource(nameKey, citedUrls);
        unscored.push({
          fetchedAt: now(),
          sourceUrl,
          additionalSourceUrls,
          sourceType: "search",
          extractedFields: fields,
          rawTextExcerpt: fields.descriptionSourceText?.slice(0, 500),
        });
      }
    }
  } catch (err) {
    // Fatal (401/402) rethrows for the orchestrator to stop the run on;
    // anything else is one institution's bad luck, logged and survived.
    const info = handleProviderError(err);
    console.warn(`Research: web-search research failed for "${input.name}" — ${info.message}`);
  }

  // --- Source 2 (supplementary, best-effort): plain HTML scrape.
  for (const url of buildScrapeTargets(input, citedUrls)) {
    try {
      const page = await fetchAndCache(url);
      // No text is the NORMAL case for login-walled socials, JS-only sites
      // and 403s — silent, not an error, and never the only path to
      // evidence any more.
      if (!page.text || page.text.length < 200) continue;
      const extracted = await extractFieldsFromText(url, page.text);
      const fields = normalizeResearchFields(extracted as Record<string, unknown>);
      if (Object.keys(fields).length === 0) continue;
      unscored.push({
        fetchedAt: now(),
        sourceUrl: url,
        sourceType: classifySourceUrl(url),
        extractedFields: fields,
        rawTextExcerpt: page.text.slice(0, 500),
      });
    } catch (err) {
      const info = handleProviderError(err);
      console.warn(`Research: scrape/extract failed for ${url} — ${info.message}`);
    }
  }

  return appendEvidence(id, nameKey, scoreEvidenceItems(unscored));
}

/** Merge all evidence for a research record into one RawExtractedFields, preferring
 * higher-confidence, more-recently-appended evidence for each SCALAR field,
 * and UNIONING list fields (programs, specializations, languages, shifts)
 * across every source instead of letting one source's list clobber another's.
 *
 * Real production bug: a "look up by name" run for "Registon o'quv markazi"
 * came back with only 2 programs ("General English", "IELTS") even though
 * the real institution's own site lists many more subjects/directions — the
 * primary web-search evidence item and the supplementary site-scrape
 * evidence item each separately found real, distinct program lists, but the
 * old scalar-overwrite logic let whichever item happened to have the higher
 * confidence completely replace the other's array instead of combining them,
 * silently discarding real facts the lower-confidence source had actually
 * found. Order/dedup is stable: list items are combined in confidence order
 * (ascending) and de-duplicated case-insensitively so the same program named
 * slightly differently by two sources doesn't produce a doubled entry, while
 * genuinely different items from either source are kept. */
export function mergeEvidence(record: ResearchRecord): { fields: RawExtractedFields; evidenceCount: number; bestSourceConfidence: number } {
  const merged: RawExtractedFields = {};
  let bestSourceConfidence = 0;
  // Sort ascending by confidence so higher-confidence evidence is applied last (wins ties).
  const sorted = [...record.evidence].sort((a, b) => a.confidence - b.confidence);
  for (const item of sorted) {
    bestSourceConfidence = Math.max(bestSourceConfidence, item.confidence);
    for (const [key, value] of Object.entries(item.extractedFields)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        const existing = (merged as Record<string, unknown>)[key];
        if (Array.isArray(existing)) {
          const seen = new Map<string, string>(); // lowercased -> original casing kept
          for (const v of [...existing, ...value]) {
            if (typeof v !== "string") continue;
            const norm = v.trim().toLowerCase();
            if (norm && !seen.has(norm)) seen.set(norm, v.trim());
          }
          (merged as Record<string, unknown>)[key] = [...seen.values()];
        } else {
          (merged as Record<string, unknown>)[key] = [...value];
        }
        continue;
      }
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return { fields: merged, evidenceCount: record.evidence.length, bestSourceConfidence };
}
