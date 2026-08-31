/**
 * Wraps Anthropic's server-side web_search tool for the Discovery agent's
 * live discovery of learning institutions. Never called in --mock mode.
 */
import { webSearchAndSummarize, type WebSearchResultItem } from "./llm-client.js";

export interface DiscoverySearchResult extends WebSearchResultItem {
  category: string;
}

/**
 * Searches for learning institutions in a given city/category using live
 * web search, returning candidate name/url/snippet triples for the
 * Discovery agent to turn into DiscoveredInstitution records.
 */
export async function searchInstitutions(city: string, category: string): Promise<DiscoverySearchResult[]> {
  const query = `${category} learning centers in ${city}, Uzbekistan — names, websites, contact info`;
  const results = await webSearchAndSummarize(
    query,
    "You are a discovery agent finding real, currently-operating education institutions " +
      "(language centers, tutoring, schools, exam-prep centers) in Uzbekistan. Only report " +
      "institutions you found genuine evidence for via search — never invent names or URLs."
  );
  return results.map((r) => ({ ...r, category }));
}
