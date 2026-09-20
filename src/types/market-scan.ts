/**
 * Keyword-driven competitor/market-scan mode — deliberately independent of
 * the BilimOn education-institution schema (schemas/bilimon-export.zod.ts):
 * a bank's credit product has nothing to do with a learning center's
 * programs/city/type fields, and BilimOn's real import schema was never
 * meant to carry this data (this project's core rule is adapting agents to
 * BilimOn's REAL schema, never inventing fields onto it — a "credit
 * product" is not an education institution and forcing it into that shape
 * would violate that same rule in the other direction). This is its own
 * schema, reusing the same discovery -> research -> export agent shape
 * (services/market-scan-llm.ts, agents/market-scan.ts) but with fields that
 * actually fit a "who offers X, and on what terms" question.
 */

export interface CompetitorRecord {
  /** The company/organization offering the product (e.g. a bank's name). */
  providerName: string;
  /** The specific product/service name, when the source names one distinctly
   * from the provider itself (e.g. "Ipoteka Bank Onlayn Kredit"). */
  productName: string | null;
  /** Free-text category the source suggests (e.g. "bank", "mikromoliya
   * tashkiloti") — not a closed enum, since this mode covers arbitrary
   * keywords/industries, unlike BilimOn's fixed InstitutionType. */
  category: string | null;
  website: string | null;
  phone: string | null;
  /** Verbatim from the source — never converted/estimated (same rule as
   * RawExtractedFields.pricingNote in the education pipeline). */
  interestRate: string | null;
  loanAmountRange: string | null;
  loanTermRange: string | null;
  requirements: string[];
  description: string | null;
  sourceUrls: string[];
}

export interface MarketScanResult {
  keyword: string;
  generatedAt: string;
  competitors: CompetitorRecord[];
}
