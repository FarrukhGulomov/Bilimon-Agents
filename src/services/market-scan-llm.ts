/**
 * LLM calls for the keyword-driven "market scan" mode (agents/market-scan.ts):
 * given a free-text keyword (e.g. "onlayn kredit"), find real providers
 * offering it in Uzbekistan, then research each one's concrete offer. Built
 * on the same two-stage discovery+research shape as the education pipeline
 * (services/search.ts + services/llm-client.ts's institution research), and
 * the same "self-report whether this is even real, discard everything if
 * not confirmed" pattern that agents/researcher.ts::researchLive uses for
 * `isEducationInstitution` — here as `isRealProvider` — since the same
 * failure mode applies: a bare keyword search can surface an unrelated
 * result (an article ABOUT the market, a defunct company, a name that
 * merely resembles a real provider) that must not be described as if it
 * were a real, currently-operating offer.
 *
 * Not exercised by execution in this build environment (no live network/API
 * access) — exactly the same constraint as every other real-mode-only LLM
 * call in this codebase; --mock mode (agents/market-scan.ts's fixture path)
 * is what's actually run and verified here.
 */
import { webSearchStructuredList, webSearchStructuredObject } from "./llm-client.js";

export interface CompetitorCandidate {
  name: string;
  website: string | null;
}

const DISCOVERY_SCHEMA = `[{"name": string, "website": string|null}]`;

/**
 * Finds up to `count` real, currently-operating providers of `keyword` in
 * Uzbekistan. Never invents a name — an inconclusive search returns fewer
 * candidates (or none) rather than padding the list with guesses.
 */
export async function discoverCompetitors(keyword: string, count: number): Promise<CompetitorCandidate[]> {
  const query = `"${keyword}" — Uzbekistan market. List real, currently-operating providers of this product/service.`;
  const instructions =
    `You are a market-research agent. Find up to ${count} REAL, currently-operating companies or ` +
    `organizations in Uzbekistan that actually offer "${keyword}" as a product or service. If the ` +
    `keyword names a financial product, list the actual banks/microfinance organizations offering it; ` +
    `for any other kind of product/service, list the actual companies offering it. Search in Uzbek and ` +
    `Russian as well as English — most Uzbekistan businesses publish in those languages, not English. ` +
    `Only include an entry you can actually verify offers this — never invent a name or guess a website. ` +
    `Return each as {"name": the provider's real name, "website": its real website if you found one, ` +
    `else null}. If you cannot verify at least one real provider, return an empty array rather than ` +
    `guessing or listing something unrelated (e.g. a news article about the market, a government body).`;
  const results = await webSearchStructuredList<CompetitorCandidate>(
    query,
    instructions,
    DISCOVERY_SCHEMA,
    Math.min(Math.max(count * 2, 5), 15)
  );
  return results.filter((r): r is CompetitorCandidate => !!r && typeof r.name === "string" && r.name.trim().length > 0);
}

export interface CompetitorResearchResult {
  /** Same pattern as InstitutionResearchResult.isEducationInstitution (see
   * llm-client.ts) — true only once a source confirms this is a real,
   * currently-operating provider actually offering the named product/
   * service; false when sources clearly show otherwise; null when
   * undetermined. Not `true` means the caller discards `fields` entirely. */
  isRealProvider: boolean | null;
  fields: Record<string, unknown>;
  sourceUrls: string[];
}

const COMPETITOR_RESEARCH_SCHEMA = `{
  "isRealProvider": boolean|null,
  "fields": {
    "providerName": string|null, "productName": string|null, "category": string|null,
    "website": string|null, "phone": string|null,
    "interestRate": string|null, "loanAmountRange": string|null, "loanTermRange": string|null,
    "requirements": string[], "description": string|null
  },
  "sourceUrls": string[]
}`;

/**
 * Deep-researches ONE candidate provider's concrete offer for `keyword`.
 * Returns null when the model produced nothing parseable — a normal "no
 * evidence" outcome, never a crash (same contract as
 * llm-client.ts::researchInstitutionViaWebSearch).
 */
export async function researchCompetitor(
  candidate: CompetitorCandidate,
  keyword: string
): Promise<CompetitorResearchResult | null> {
  const query =
    `Provider: "${candidate.name}"${candidate.website ? `\nKnown website: ${candidate.website}` : ""}\n` +
    `Product/service keyword: "${keyword}", Uzbekistan market.\n` +
    `Research this ONE provider's offering for this keyword and report only what you actually find.`;

  const instructions =
    "You are a deep-research agent gathering ONE provider's real offering details for a market/" +
    "competitor comparison in Uzbekistan.\n\n" +
    "STEP 1 — confirm this is a real, currently-operating provider that actually offers the named " +
    "product/service (not a defunct company, an unrelated business, or a name you cannot verify). Set " +
    "`isRealProvider: true` only once a source confirms it; `false` if sources clearly show otherwise; " +
    "`null` if you can't tell. Not `true` means every `fields` entry stays null/empty — do NOT describe " +
    "a different, unrelated entity instead.\n\n" +
    "STEP 2 — once confirmed, check the provider's official website and any other page genuinely " +
    "describing this specific offering. Search in Uzbek/Russian as well as English.\n\n" +
    "STEP 3 — extract: the product's own name if distinct from the provider, its category, contact " +
    "(website, phone), and the concrete offer terms (interest rate, loan amount range, loan term range, " +
    "requirements) EXACTLY as the source states them — verbatim, never converted, estimated, or " +
    "averaged. `requirements` is a list of concrete eligibility conditions (e.g. \"O'zbekiston " +
    "fuqaroligi\", \"18 yoshdan katta\"), not marketing copy. `description`: 1-3 factual sentences about " +
    "this specific offering, drawn from the source.\n\n" +
    "HARD RULE: a field you did not actually find is null/empty, never invented or guessed. " +
    "`sourceUrls` lists only URLs you actually opened.";

  return webSearchStructuredObject<CompetitorResearchResult>(query, instructions, COMPETITOR_RESEARCH_SCHEMA);
}
