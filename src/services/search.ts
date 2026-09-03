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
// MVP scope decision (user, 2026-09-02): full universities/institutes and
// K-12 schools/lyceums are planned as their OWN separate product phase
// later — right now this pipeline targets only "o'quv markazlari" (learning
// centers): language centers, course centers, tutoring, and exam-prep. Real
// production issue this fixes: a UNIVERSITY_PREP-facet search returned
// "INHA University Tashkent" and "Tashkent Metropolitan University" — full
// degree-granting universities (Bachelor's/Master's/MBA) — because their own
// English-language/foundation-year prep programs matched the facet's
// wording. Gated on `type`, not hardcoded globally: a caller that explicitly
// asks for SCHOOL/LYCEUM (once that later phase exists and a brief narrows
// to it) gets the schools-inclusive instructions instead — this is a
// current-scope narrowing, not a permanent architectural exclusion.
// Real production risk found on review (not yet an observed failure, but a
// plausible one): the original wording excluded by LEGAL FORM ("charities,
// NGOs, foundations"), but many genuine, prominent Uzbekistan learning
// centers are legally registered as a jamg'arma (foundation) or jamoat
// tashkiloti (public association/NGO) while still running real paid or
// free educational courses as their actual activity. Excluding by legal
// form risks losing real institutions; the exclusion below is written by
// ACTIVITY instead — an org whose real, observable work is education stays
// in scope regardless of its legal structure, and only organizations whose
// real activity is humanitarian aid/child welfare/shelter/medical treatment
// (not education) are excluded.
const NON_EDUCATIONAL_ACTIVITY_EXCLUSION =
  "EXCLUDE organizations whose ACTUAL, PRIMARY ACTIVITY is humanitarian aid, orphan/child " +
  "welfare care, sheltering, medical treatment/diagnosis, or government administration — " +
  "regardless of legal form (this applies even if the organization is legally structured as a " +
  "foundation/jamg'arma or NGO/public association). If an organization's real, observable " +
  "activity IS delivering paid or free educational courses/classes/lessons, include it even if " +
  "it happens to be run by a foundation or NGO — many genuine Uzbekistan learning centers are " +
  "legally structured that way. Do not exclude based on the words \"foundation\", \"jamg'arma\", " +
  "or \"NGO\" alone.";

export function buildScopeInstruction(type: string | undefined): string {
  if (type === "SCHOOL" || type === "LYCEUM") {
    return (
      "ONLY include organizations that actually deliver paid or structured educational " +
      "courses/classes/lessons to students (schools, lyceums, and other K-12 institutions). " +
      NON_EDUCATIONAL_ACTIVITY_EXCLUSION +
      " Also exclude hospitals/clinics even if their name or description mentions children, " +
      "education, or development — those are not learning institutions for this purpose."
    );
  }
  return (
    "ONLY include \"o'quv markazi\"-style learning centers that deliver paid or structured " +
    "courses/classes/lessons directly to students: language centers, tutoring/course centers, " +
    "and exam-prep centers (IELTS, SAT, university-entrance-prep courses, kids' development " +
    "centers that run classes). " +
    "EXCLUDE: (1) full degree-granting universities, institutes, colleges, and academies that " +
    "confer Bachelor's/Master's/MBA/PhD degrees — even if the university also runs its own " +
    "English-language, foundation-year, or exam-prep courses, the university itself is out of " +
    "scope for now (a separate universities/institutes product phase is planned later); " +
    "(2) full K-12 schools and lyceums (also a separate later phase); " +
    "(3) hospitals/clinics, even if their name or description mentions children, education, or " +
    "development. " +
    NON_EDUCATIONAL_ACTIVITY_EXCLUSION +
    " None of the excluded categories above are learning-center institutions for this purpose."
  );
}

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
  // TEMPORARY (per explicit user request, 2026-09-03): general web search
  // (official sites, social pages, yellowpages.uz/goldenpages.uz, plain
  // search results) was bringing back low-quality/irrelevant results.
  // Restricted to kursi24.uz/uz ONLY until this is revisited. To restore
  // full-web discovery, revert this block — git history has the prior
  // multi-source query/instructions.
  const query =
    `${facetText} — ${city}, Uzbekistan. Find up to ${MAX_RESULTS_PER_SEARCH} distinct real ` +
    `institutions listed on kursi24.uz/uz ONLY. For each one report its name, the kursi24.uz/uz ` +
    `page you found it on, its official website, its Instagram and Telegram pages, phone, and ` +
    `address — but only fields kursi24.uz/uz's own listing actually shows; do not look them up ` +
    `elsewhere.`;

  let results: DiscoverySearchResult[];
  try {
    results = await webSearchStructuredList<DiscoverySearchResult>(
      query,
      "You are a discovery agent finding real, currently-operating education institutions " +
        "(language centers, tutoring, exam-prep centers) in Uzbekistan, and recording each " +
        "one's contact profile: website and social-network addresses (Instagram, Telegram, Facebook), " +
        "phone and address. " +
        buildScopeInstruction(type) +
        " Most real " +
        "institutions are named and have websites/social pages in Uzbek or Russian, not English " +
        "— actively search in Uzbek and Russian as well as English, and do not skip an institution " +
        "just because its name or site is not in English. " +
        "SOURCE RESTRICTION (temporary): search ONLY kursi24.uz/uz (an Uzbekistan directory " +
        "dedicated specifically to learning/course centers). Do NOT use official institution " +
        "websites, Instagram/Telegram/Facebook, yellowpages.uz, goldenpages.uz, maps, or general " +
        "search results as a source for this task — every institution and every field must come " +
        "from a kursi24.uz/uz listing page you actually saw. If kursi24.uz/uz has nothing relevant " +
        "for this search, return an empty list rather than falling back to another source. " +
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
