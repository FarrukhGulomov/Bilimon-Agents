/**
 * Brief-parser: turns a free-text "brief" (Uzbek/Russian/English, e.g.
 * "top IELTS markazlari", "O'zbekistondagi barcha maktablar",
 * "universitetga tayyorlov kurslari") into a structured DiscoveryScope that
 * agents/discovery.ts uses to filter/prioritize candidates, instead of
 * discovery being hardcoded to the 4 categories in
 * config/priority-categories.json forever.
 *
 * Two modes:
 *  - LLM mode (OPENAI_API_KEY set): asks the model (services/llm-client.ts)
 *    to map the brief onto the REAL enum values from src/schemas/enums.ts —
 *    the real lists are embedded in the prompt so the model can only choose
 *    values that actually exist. Any value the model returns that is NOT a
 *    real enum member is dropped with a console.warn, and if that empties a
 *    dimension entirely it falls back to "all" for that dimension rather
 *    than crashing or silently narrowing to nothing.
 *  - Heuristic mode (default here — no OPENAI_API_KEY in this environment):
 *    pure deterministic keyword matching, no network/LLM call, fully
 *    testable and exercised by test/run-all.ts. This is the mode that
 *    actually runs and is validated in this build environment.
 *
 * No brief at all (--brief omitted) resolves to the pre-existing
 * config/priority-categories.json default scope — same 4 categories as
 * before this feature existed — so brief-less callers/tests are unaffected.
 * An unscoped/unmatched brief (e.g. "top o'quv markazlari" with no specific
 * keyword hit) resolves to types:"all"/categories:"all", i.e. the broadest
 * possible run across every institution type — exactly what "prepare data
 * about Uzbekistan's top learning institutions" with no category named
 * should mean for a general-purpose product.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CATEGORIES,
  INSTITUTION_TYPES,
  isValidEnum,
  type Category,
  type InstitutionType,
} from "../schemas/enums.js";
import { askStructured } from "./llm-client.js";
import { listCities } from "./location-mapper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRIORITY_PATH = join(__dirname, "..", "..", "config", "priority-categories.json");

export type ScopeSource = "default" | "heuristic" | "llm" | "llm-fallback";

export interface DiscoveryScope {
  /** "all" means every real InstitutionType — the broad, unscoped case. */
  types: InstitutionType[] | "all";
  /** "all" means every real Category — the broad, unscoped case. */
  categories: Category[] | "all";
  /** Free-text region/city hints pulled from the brief, or "all". Best-effort —
   * discovery.ts treats this as a soft prioritization hint, not a hard filter,
   * since real city coverage is itself incomplete (see README.md coverage gap). */
  regions: string[] | "all";
  /** Raw keyword tokens that drove the match, kept for the report.json trail. */
  keywords: string[];
  /** The original brief text, or null for the config-file default. */
  briefText: string | null;
  source: ScopeSource;
}

// --- Default scope (config/priority-categories.json), unchanged behavior ---

let cachedDefaultScope: DiscoveryScope | null = null;

/** The pre-existing config/priority-categories.json behavior, expressed as a
 * DiscoveryScope: categories = the 4 configured priority categories, types
 * and regions left "all" (the pipeline never restricted `type` before this
 * feature existed). This is what a brief-less `pipeline run` resolves to —
 * kept byte-for-byte behavior-compatible with pre-brief-feature runs. */
export function loadDefaultScope(): DiscoveryScope {
  if (cachedDefaultScope) return cachedDefaultScope;
  const raw = JSON.parse(readFileSync(PRIORITY_PATH, "utf-8"));
  const categories = raw.order.map((o: { category: string }) => o.category) as Category[];
  cachedDefaultScope = {
    types: "all",
    categories,
    regions: "all",
    keywords: [],
    briefText: null,
    source: "default",
  };
  return cachedDefaultScope;
}

// --- Heuristic keyword mode -------------------------------------------------

// Uzbek / Russian / English keyword phrases for each real `type` value.
// Longer/more specific phrases are listed so accidental substring collisions
// with category keywords (e.g. "til" inside both "til markazi" and "ingliz
// tili") stay intentional rather than coincidental.
const TYPE_KEYWORDS: Record<InstitutionType, string[]> = {
  SCHOOL: ["maktab", "maktablar", "school", "schools", "школа", "школы", "школ"],
  LYCEUM: ["litsey", "litseylar", "lyceum", "lyceums", "лицей", "лицеи", "лицея"],
  LANGUAGE_CENTER: [
    "til markazi",
    "til markazlari",
    "language center",
    "language centre",
    "language centers",
    "language centres",
    "языковой центр",
    "языковые центры",
  ],
  COURSE_CENTER: ["kurs markazi", "kurslar", "kurs", "course center", "course centre", "courses", "course", "курсы", "курс"],
  TUTORING: ["repetitor", "repetitorlik", "tutoring", "tutor", "репетитор", "репетиторство"],
};

// Uzbek / Russian / English keyword phrases for each real `categories` value.
const CATEGORY_KEYWORDS: Record<Category, string[]> = {
  IELTS: ["ielts"],
  SCHOOL_SUBJECTS: ["maktab fanlari", "school subjects", "школьные предметы", "школьные предметы"],
  UNIVERSITY_PREP: [
    "universitetga tayyorlov",
    "universitetga tayyorgarlik",
    "abituriyent",
    "abituriyentlar",
    "university prep",
    "university entrance",
    "поступление в университет",
    "подготовка к поступлению",
  ],
  KIDS_EDUCATION: [
    "bolalar rivojlanishi",
    "bolalar uchun",
    "bolalar",
    "kids",
    "children",
    "child development",
    "детск",
  ],
  LANGUAGES: ["ingliz tili", "chet tili", "chet tillari", "english", "language learning", "tillarni o'rganish", "язык"],
  CEFR: ["cefr"],
  SAT: ["sat"],
  IT_COURSES: ["dasturlash", "it kurs", "it kurslari", "it courses", "programming", "программирован"],
  PROFESSIONAL_CERTIFICATION: ["sertifikat", "sertifikatlash", "certification", "professional certification", "сертифика"],
};

function matchKeywords<T extends string>(
  briefLower: string,
  table: Record<T, string[]>
): { matched: T[]; hits: string[] } {
  const matched: T[] = [];
  const hits: string[] = [];
  for (const key of Object.keys(table) as T[]) {
    for (const kw of table[key]) {
      if (briefLower.includes(kw)) {
        matched.push(key);
        hits.push(kw);
        break;
      }
    }
  }
  return { matched, hits };
}

/** Pure, deterministic keyword-matching fallback — no LLM call, no network,
 * fully testable without OPENAI_API_KEY. Any dimension with no keyword hit
 * defaults to "all" (broadest), which is the desired behavior for a vague or
 * unscoped brief like "top o'quv markazlari" (no specific category named). */
/** Scans the brief for a known city name/alias (Latin, Cyrillic, or common
 * transliteration variants — reusing the same CITIES table location-mapper
 * resolves discovered addresses against) and returns the matched cities'
 * canonical `nameEn` values plus the raw text that matched, for the
 * DiscoveryScope's `regions`/`keywords` fields. A brief naming a city is
 * meant as a HARD restriction in discovery.ts (not just a soft hint) —
 * this exists specifically so e.g. `--brief "Toshkentda"` searches only
 * Tashkent instead of all 9 seed cities, bounding real API cost/time. */
function matchCityNames(briefLower: string): { matched: string[]; hits: string[] } {
  const matched = new Set<string>();
  const hits = new Set<string>();
  for (const city of listCities()) {
    const candidates = [city.nameEn, ...city.aliases];
    for (const candidate of candidates) {
      const needle = candidate.toLowerCase();
      if (needle.length >= 3 && briefLower.includes(needle)) {
        matched.add(city.nameEn);
        hits.add(candidate);
      }
    }
  }
  return { matched: [...matched], hits: [...hits] };
}

export function resolveBriefHeuristic(brief: string): DiscoveryScope {
  const briefLower = brief.trim().toLowerCase();
  const { matched: types, hits: typeHits } = matchKeywords(briefLower, TYPE_KEYWORDS);
  const { matched: categories, hits: categoryHits } = matchKeywords(briefLower, CATEGORY_KEYWORDS);
  const { matched: cities, hits: cityHits } = matchCityNames(briefLower);
  return {
    types: types.length > 0 ? [...new Set(types)] : "all",
    categories: categories.length > 0 ? [...new Set(categories)] : "all",
    regions: cities.length > 0 ? cities : "all",
    keywords: [...new Set([...typeHits, ...categoryHits, ...cityHits])],
    briefText: brief,
    source: "heuristic",
  };
}

// --- LLM mode ----------------------------------------------------------------

interface LlmBriefResponse {
  types?: string[] | "all";
  categories?: string[] | "all";
  keywords?: string[];
}

/** LLM mode: asks the model to map the brief onto the REAL enum lists (passed
 * into the prompt verbatim so it can't invent a value). Any returned value
 * outside the real enums is dropped with a console.warn; if that empties a
 * dimension, that dimension falls back to "all" rather than crashing or
 * silently narrowing to nothing. Not exercised by execution in this
 * environment (no OPENAI_API_KEY here) — structurally complete, same caveat
 * as the rest of the pipeline's real-mode code paths. */
export async function resolveBriefWithLlm(brief: string): Promise<DiscoveryScope> {
  const schemaDescription =
    `{"types": string[] | "all", "categories": string[] | "all", "keywords": string[]}\n` +
    `"types" must only contain values from this exact list (or the literal string "all" if the brief names no specific institution type): ${JSON.stringify(INSTITUTION_TYPES)}\n` +
    `"categories" must only contain values from this exact list (or the literal string "all" if the brief names no specific subject/category): ${JSON.stringify(CATEGORIES)}\n` +
    `"keywords" is a short list of the words/phrases from the brief that drove your choice.`;

  const response = await askStructured<LlmBriefResponse>({
    system:
      "You map a free-text brief (Uzbek, Russian, or English) describing what kind of Uzbekistan " +
      "learning institutions to discover, onto a structured scope using ONLY real BilimOn enum values. " +
      "Never invent a value outside the given lists. If the brief is broad/unspecific (e.g. asks for " +
      '"all top learning institutions" with no particular type or subject named), return "all" for that dimension.',
    prompt: brief,
    schemaDescription,
  });

  let types: InstitutionType[] | "all" = "all";
  if (response.types === "all" || response.types === undefined) {
    types = "all";
  } else if (Array.isArray(response.types)) {
    const valid = response.types.filter((t): t is InstitutionType => isValidEnum(INSTITUTION_TYPES, t));
    const dropped = response.types.filter((t) => !isValidEnum(INSTITUTION_TYPES, t));
    if (dropped.length > 0) {
      console.warn(`brief-parser: LLM returned unrecognized type value(s) ${JSON.stringify(dropped)} — dropped, not real BilimOn types.`);
    }
    types = valid.length > 0 ? valid : "all";
  }

  let categories: Category[] | "all" = "all";
  if (response.categories === "all" || response.categories === undefined) {
    categories = "all";
  } else if (Array.isArray(response.categories)) {
    const valid = response.categories.filter((c): c is Category => isValidEnum(CATEGORIES, c));
    const dropped = response.categories.filter((c) => !isValidEnum(CATEGORIES, c));
    if (dropped.length > 0) {
      console.warn(`brief-parser: LLM returned unrecognized category value(s) ${JSON.stringify(dropped)} — dropped, not real BilimOn categories.`);
    }
    categories = valid.length > 0 ? valid : "all";
  }

  return {
    types,
    categories,
    regions: "all",
    keywords: Array.isArray(response.keywords) ? response.keywords : [],
    briefText: brief,
    source: "llm",
  };
}

/**
 * Resolves a --brief string (or its absence) into a DiscoveryScope.
 *  - No brief / empty string -> the pre-existing config/priority-categories.json
 *    default scope (unchanged behavior).
 *  - Brief given, OPENAI_API_KEY set -> LLM mode; on any error, falls back to
 *    heuristic mode with a console.warn (never crashes the run over a brief
 *    parsing failure).
 *  - Brief given, no OPENAI_API_KEY -> heuristic mode directly.
 */
export async function resolveBrief(brief: string | undefined | null): Promise<DiscoveryScope> {
  if (!brief || !brief.trim()) {
    return loadDefaultScope();
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      return await resolveBriefWithLlm(brief);
    } catch (err) {
      console.warn(`brief-parser: LLM mode failed (${(err as Error).message}) — falling back to heuristic keyword matching.`);
      const fallback = resolveBriefHeuristic(brief);
      return { ...fallback, source: "llm-fallback" };
    }
  }
  return resolveBriefHeuristic(brief);
}
