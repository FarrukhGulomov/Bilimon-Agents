/**
 * Live web search for the Discovery agent (Agent 1). Never called in --mock
 * mode. The provider branching (OpenAI hosted `web_search` tool vs
 * OpenRouter's `web` plugin) lives in services/llm-client.ts; this file owns
 * the query/prompt/result shape — i.e. what Agent 1 asks for and what it
 * gets back per institution.
 */
import {
  handleProviderError,
  webSearchStructuredList,
  type WebSearchResultItem,
} from "./llm-client.js";
import type { Category, InstitutionType } from "../schemas/enums.js";

/**
 * What one live search returns per institution.
 *
 * Real production failure this shape fixes: search used to return only
 * {title, url, snippet}, so a live-mode DiscoveryCandidate carried nothing
 * but a name and one link — even though DiscoveryCandidate has had
 * website/telegram/instagram/phone fields all along (only the mock fixtures
 * ever populated them). Agent 1's actual job, per the spec, is to find
 * institutions AND their websites and social-network addresses, so the
 * model is now asked for a structured profile per institution. Everything
 * it fills in flows through the orchestrator's "fill in from discovery if
 * research didn't supply it" fallback, which means a candidate is no longer
 * empty-handed when Agent 2's sources come back thin.
 */
export interface DiscoverySearchResult extends WebSearchResultItem {
  /** Institution name as published by the source (may be Uzbek/Russian). */
  name?: string | null;
  website?: string | null;
  instagram?: string | null;
  telegram?: string | null;
  facebook?: string | null;
  phone?: string | null;
  address?: string | null;
  /** City as stated by the source; the caller falls back to the searched city. */
  city?: string | null;
  category?: string;
  type?: string;
}

/** Max institutions requested per paid search call. A single live search is
 * slow and costs real money either way, so asking for one link back is poor
 * value — ask for a batch of profiles instead. */
const MAX_RESULTS_PER_SEARCH = 10;

const RESULT_SCHEMA = `[{
  "name": string,            // institution name as published (Uzbek/Russian/English)
  "url": string,             // the page you found it on
  "snippet": string|null,    // one short factual line about it, from the source
  "website": string|null,    // official site, if you actually saw one
  "instagram": string|null,  // full instagram URL or @handle, if you actually saw one
  "telegram": string|null,   // full t.me URL or @handle, if you actually saw one
  "facebook": string|null,
  "phone": string|null,
  "address": string|null,
  "city": string|null
}]`;

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
 * may be omitted for a broader, unscoped search. Returns up to
 * MAX_RESULTS_PER_SEARCH institution profiles (name + found-on URL + website
 * + socials + phone + address) for the Discovery agent to turn into
 * DiscoveryCandidate records.
 *
 * Never throws for an ordinary search failure: a failing search yields zero
 * results for that (city, facet) unit and a logged warning. Only a fatal
 * provider error (bad key / no credits) escapes, so the run can stop with a
 * clear message instead of hitting the same wall on every remaining search.
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
  const query =
    `${facetText} — ${city}, Uzbekistan. Find up to ${MAX_RESULTS_PER_SEARCH} distinct real ` +
    `institutions. For each one report its name, the page you found it on, its official website, ` +
    `its Instagram and Telegram pages, phone, and address. ` +
    `Check yellowpages.uz and goldenpages.uz (Uzbekistan business directories with structured ` +
    `listings — name, phone, address, category — for exactly this kind of institution) in ` +
    `addition to official websites/social pages and general search results.`;

  let results: DiscoverySearchResult[];
  try {
    results = await webSearchStructuredList<DiscoverySearchResult>(
      query,
      "You are a discovery agent finding real, currently-operating education institutions " +
        "(language centers, tutoring, schools, exam-prep centers) in Uzbekistan, and recording each " +
        "one's contact profile: website and social-network addresses (Instagram, Telegram, Facebook), " +
        "phone and address. " +
        // Real production issue: a KIDS_EDUCATION-facet search returned "SOS
        // Children's Villages Uzbekistan" — a children's charity/orphanage
        // network, not a learning institution — because its name/description
        // mentions children. Category labels like "bolalar rivojlanish
        // markazi" (kids development center) can match a charity's wording
        // even though it offers no paid courses/classes. Excluding by
        // organization TYPE (charity/NGO/foundation/social-care), not by
        // topic, keeps genuine kids' education centers in scope.
        "ONLY include organizations that actually deliver paid or structured educational " +
        "courses/classes/lessons to students (language centers, tutoring/course centers, schools, " +
        "lyceums, exam-prep centers, kids' development/education centers that run classes). " +
        "EXCLUDE charities, NGOs, foundations, orphanages, shelters, social-care or humanitarian " +
        "organizations, government agencies, and hospitals/clinics, even if their name or " +
        "description mentions children, education, or development — those are not learning " +
        "institutions for this purpose. Most real " +
        "institutions are named and have websites/social pages in Uzbek or Russian, not English " +
        "— actively search in Uzbek and Russian as well as English, and do not skip an institution " +
        "just because its name or site is not in English. Uzbekistan business directories like " +
        "yellowpages.uz and goldenpages.uz list many real institutions with structured contact " +
        "details (phone, address) in one place — check them specifically, not just general search " +
        "results or official sites, since they often have the phone/address data an institution's " +
        "own website or social page omits. " +
        `Return up to ${MAX_RESULTS_PER_SEARCH} distinct institutions per search — more real ` +
        "institutions per search is better, but never pad the list with duplicates or guesses. " +
        "HARD RULE: every one of website/instagram/telegram/facebook/phone/address must come from " +
        "something you actually saw in the search results for THAT institution; anything you did " +
        "not actually see must be null. Never invent names, URLs, handles, phone numbers, or " +
        "addresses, and never attach one institution's contact details to another.",
      RESULT_SCHEMA
    );
  } catch (err) {
    // Real production failure: an OpenRouter 402 (out of credits) thrown by
    // ONE search propagated out of runWithConcurrency and killed the whole
    // process with a raw stack trace mid-discovery. A single failing search
    // must only cost its own results. handleProviderError rethrows
    // FatalProviderError for 401/402 (every later call would fail
    // identically — discovery.ts stops the run on that), and returns a
    // one-line description for everything else.
    const info = handleProviderError(err);
    console.warn(
      `Discovery: search failed for city=${city}` +
        (category ? ` category=${category}` : "") +
        (type ? ` type=${type}` : "") +
        ` — ${info.message} (continuing with 0 results for this search)`
    );
    return [];
  }

  // Defense-in-depth: webSearchStructuredList() already coerces malformed
  // model output to [], but never trust a boundary twice for free. Drop
  // entries with no usable name/url rather than creating nameless
  // candidates downstream.
  return (Array.isArray(results) ? results : [])
    .filter((r) => !!(r && (r.name || r.title) && r.url))
    .slice(0, MAX_RESULTS_PER_SEARCH)
    .map((r) => ({ ...r, title: r.title ?? r.name ?? "", category, type }));
}
