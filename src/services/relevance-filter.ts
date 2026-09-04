/**
 * Deterministic, code-level safety net against non-educational organizations
 * slipping through discovery — a defense-in-depth backstop, not a
 * replacement for the search prompt's own exclusion instructions
 * (src/services/search.ts::buildScopeInstruction).
 *
 * Real production failure this fixes: the search prompt already explicitly
 * said "EXCLUDE ... hospitals/clinics, even if their name or description
 * mentions children, education, or development" (added for the earlier SOS
 * Children's Villages charity case), yet a live run still approved "Neo
 * Clinic Tashkent" — a neurology/pediatrics/EEG-diagnostics/ABA-therapy
 * medical clinic — as a KIDS_EDUCATION "learning center". A live web-search
 * model does not reliably follow every exclusion in a long instruction
 * block, especially for a borderline case (a clinic that also does
 * "therapy" and "development" work reads adjacent to education). Prompt
 * instructions alone are not enough; this is the deterministic check that
 * can't be silently skipped.
 *
 * Also catches non-institution entities more broadly: "look up by name"
 * mode (RunOptions.institutionName) was tested with "Registon" — the
 * Registan, a famous Samarkand historical monument/tourist landmark, not a
 * learning center — and the per-institution research call (which never
 * verifies the named entity is actually a currently-operating education
 * institution) happily researched and exported it as one. Same lesson:
 * a keyword-based deterministic check catches what a research prompt alone
 * did not.
 *
 * Pure and exported for offline testing — never calls an LLM.
 */
import type { RawExtractedFields } from "../types/index.js";

// Deliberately narrow to strong, low-ambiguity medical-organization signals.
// Words like "reabilitatsiya"/"terapiya"/"logoped"/"defektolog" are common in
// LEGITIMATE kids' development centers (speech therapy, sensory integration)
// too, so they're excluded from this list to avoid false-positiving real
// education institutions — only include terms that are essentially always
// medical in context.
const MEDICAL_KEYWORDS = [
  "clinic", "klinika", "клиника",
  "hospital", "gospital", "госпиталь",
  "poliklinika", "поликлиника",
  "dispanser", "диспансер",
  "nevrolog", "невролог", "nevrologiya", "неврология",
  "pediatr", "педиатр", "pediatriya", "педиатрия",
  "psixiatr", "психиатр",
  "gastroenterolog", "гастроэнтеролог",
  "endokrinolog", "эндокринолог",
  "kardiolog", "кардиолог",
  // Deliberately NOT included: "shifokor"/"врач" (generic word "doctor").
  // A real learning institution can legitimately use it in an achievements
  // section ("bitiruvchilarimiz orasida shifokorlar bor" — "some of our
  // graduates became doctors") or in a pre-med prep course's own
  // description, without being a clinic itself — too high a false-positive
  // risk for a single generic word. Named medical specialties above
  // (nevrolog, pediatr, ...) are specific enough that a course center
  // describing itself in those terms is implausible.
  "tibbiyot markazi", "tibbiy markaz", "медицинский центр",
  "eeg", "ээг", "электроэнцефалография", "elektroensefalografiya",
];

// Real production failure: "look up by name" mode (RunOptions.institutionName)
// was given "Registon" — the Registan, a famous Samarkand historical
// monument/tourist landmark, not a learning center at all — and the
// per-institution research call (which never verifies the named entity is
// actually a currently-operating education institution) happily researched
// and exported it as one. Deliberately narrow to strong, low-ambiguity
// heritage/monument/museum signals — a real institution's curriculum might
// mention history topics, but these specific phrases describe the SUBJECT
// being a historical site/monument itself, not a business teaching about one.
const LANDMARK_KEYWORDS = [
  "jahon merosi", "world heritage", "всемирного наследия",
  "yunesko", "unesco", "юнеско",
  "tarixiy yodgorlik", "tarixiy obida", "исторический памятник", "архитектурный памятник",
  "yodgorlik majmuasi", "arxitektura yodgorligi",
  "muzey-qo'riqxona", "музей-заповедник",
  "me'moriy ansambl", "архитектурный ансамбль",
];

function textIncludesAny(text: string, keywords: string[]): string | null {
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

/**
 * Checks the merged research fields (+ generated content, when available)
 * for strong medical-organization signals. Returns a human-readable reason
 * string if flagged, or null if nothing matched. A match routes the
 * candidate to NEEDS_REVIEW for human confirmation rather than a hard
 * REJECTED — the goal is catching the "Neo Clinic" case, not
 * false-positiving a legitimate education institution that happens to
 * mention a related word once.
 */
export function detectNonEducationalOrg(
  fields: RawExtractedFields,
  content?: { descriptionUz?: string | null; descriptionRu?: string | null }
): string | null {
  const haystacks: string[] = [
    fields.nameUz,
    fields.nameRu,
    fields.nameLatin,
    fields.achievements,
    ...(fields.programs ?? []),
    ...(fields.specializations ?? []),
    content?.descriptionUz ?? undefined,
    content?.descriptionRu ?? undefined,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  for (const text of haystacks) {
    const medicalHit = textIncludesAny(text, MEDICAL_KEYWORDS);
    if (medicalHit) {
      return `looks like a medical/healthcare organization, not a learning center (matched "${medicalHit}" in "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}") — MVP scope is learning centers only`;
    }
    const landmarkHit = textIncludesAny(text, LANDMARK_KEYWORDS);
    if (landmarkHit) {
      return `looks like a historical monument/museum/landmark, not a currently-operating learning center (matched "${landmarkHit}" in "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}") — MVP scope is learning centers only`;
    }
  }
  return null;
}
