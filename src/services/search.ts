/**
 * Wraps OpenAI's hosted `web_search` Responses API tool for the Discovery
 * agent's live discovery of learning institutions. Never called in --mock
 * mode.
 */
import { webSearchAndSummarize, type WebSearchResultItem } from "./llm-client.js";
import type { Category, InstitutionType } from "../schemas/enums.js";

export interface DiscoverySearchResult extends WebSearchResultItem {
  category?: string;
  type?: string;
}

// The raw enum codes (e.g. "SCHOOL_SUBJECTS", "IELTS") are internal
// identifiers, not search terms — the vast majority of real Uzbekistan
// institutions are named and indexed in Uzbek or Russian, never in English,
// so a query built by literally concatenating enum codes into English text
// (the original, buggy behavior) systematically undersearches everything
// that isn't already English-named. These map each enum value to natural
// Uzbek/Russian/English phrasing to actually search with.
const CATEGORY_LABELS: Record<Category, string> = {
  LANGUAGES: "til markazi / курсы иностранных языков / language center",
  SCHOOL_SUBJECTS: "maktab fanlari kurslari / школьные предметы курсы / school subjects tutoring",
  UNIVERSITY_PREP: "universitetga tayyorlov / подготовка к поступлению в вуз / university entrance prep",
  KIDS_EDUCATION: "bolalar rivojlanish markazi / детский развивающий центр / kids development center",
  IELTS: "IELTS tayyorgarlik kursi / курсы подготовки к IELTS",
  CEFR: "CEFR ingliz tili sertifikati / курсы CEFR",
  SAT: "SAT tayyorgarlik kursi / курсы подготовки к SAT",
  IT_COURSES: "IT kurslari / dasturlash kurslari / курсы программирования",
  PROFESSIONAL_CERTIFICATION: "kasbiy sertifikatlash kurslari / курсы профессиональной сертификации",
};

const TYPE_LABELS: Record<InstitutionType, string> = {
  LANGUAGE_CENTER: "til markazi / языковой центр",
  COURSE_CENTER: "o'quv kursi markazi / учебный центр",
  TUTORING: "repetitorlik / репетиторство",
  SCHOOL: "maktab / школа",
  LYCEUM: "litsey / лицей",
};

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
  const facetLabels = [
    category ? CATEGORY_LABELS[category as Category] : undefined,
    type ? TYPE_LABELS[type as InstitutionType] : undefined,
  ].filter(Boolean);
  const facetText = facetLabels.length > 0 ? facetLabels.join(" / ") : "ta'lim markazi / образовательный центр / learning center";
  const query = `${facetText} — ${city}, Uzbekistan. Names, websites, contact info.`;
  const results = await webSearchAndSummarize(
    query,
    "You are a discovery agent finding real, currently-operating education institutions " +
      "(language centers, tutoring, schools, exam-prep centers) in Uzbekistan. Most real " +
      "institutions are named and have websites/social pages in Uzbek or Russian, not English " +
      "— actively search in Uzbek and Russian as well as English, and do not skip an institution " +
      "just because its name or site is not in English. Only report institutions you found " +
      "genuine evidence for via search — never invent names or URLs."
  );
  // Defense-in-depth: webSearchAndSummarize() already coerces malformed
  // model output to [], but never trust a boundary twice for free.
  return (Array.isArray(results) ? results : []).map((r) => ({ ...r, category, type }));
}
