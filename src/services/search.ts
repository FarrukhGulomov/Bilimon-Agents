/**
 * Wraps OpenAI's hosted `web_search` Responses API tool for the Discovery
 * agent's live discovery of learning institutions. Never called in --mock
 * mode.
 */
import { webSearchAndSummarize, type WebSearchResultItem } from "./llm-client.js";

export interface DiscoverySearchResult extends WebSearchResultItem {
  category?: string;
  type?: string;
}

/**
 * Searches for learning institutions in a given city using live web search,
 * optionally narrowed by `category` (a Category enum value, e.g. "IELTS")
 * and/or `type` (an InstitutionType enum value, e.g. "SCHOOL") — both come
 * from the resolved DiscoveryScope (src/services/brief-parser.ts) and either
 * may be omitted for a broader, unscoped search. Returns candidate
 * name/url/snippet triples for the Discovery agent to turn into
 * DiscoveredInstitution records.
 */
export async function searchInstitutions(
  city: string,
  category?: string,
  type?: string
): Promise<DiscoverySearchResult[]> {
  const facetText = [category, type].filter(Boolean).join(" ") || "learning";
  const query = `${facetText} centers in ${city}, Uzbekistan — names, websites, contact info`;
  const results = await webSearchAndSummarize(
    query,
    "You are a discovery agent finding real, currently-operating education institutions " +
      "(language centers, tutoring, schools, exam-prep centers) in Uzbekistan. Only report " +
      "institutions you found genuine evidence for via search — never invent names or URLs."
  );
  return results.map((r) => ({ ...r, category, type }));
}
