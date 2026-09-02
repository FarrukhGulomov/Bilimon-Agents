/**
 * Deterministic normalization helpers: name keys, slugs, phone numbers, URLs.
 * No LLM calls here — kept as plain code for cost/determinism (see README
 * "Cost optimization notes").
 */
import { createHash } from "node:crypto";

const DIACRITIC_MAP: Record<string, string> = {
  ʻ: "'",
  ʼ: "'",
  "’": "'",
  "‘": "'",
  ō: "o",
  ū: "u",
  ā: "a",
  ʺ: "",
  ʹ: "",
};

/** Strip diacritics, lowercase, collapse whitespace/punctuation for matching. */
export function normalizeNameKey(name: string): string {
  let s = name.trim().toLowerCase();
  for (const [from, to] of Object.entries(DIACRITIC_MAP)) {
    s = s.split(from).join(to);
  }
  // Normalize unicode combining diacritics (e.g. accented Latin letters).
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Drop common legal/entity suffixes and generic words that cause false negatives.
  s = s.replace(/\b(llc|mchj|ltd|inc|centre|center|lc)\b/g, (m) =>
    m === "centre" || m === "center" ? "" : m === "lc" ? "" : ""
  );
  // Remove punctuation, collapse whitespace.
  s = s.replace(/['".,()]/g, "");
  s = s.replace(/[^a-z0-9\s]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** URL-safe kebab-case slug, e.g. "cambridge-learning-center-tashkent". */
export function slugify(...parts: string[]): string {
  const combined = parts.filter(Boolean).join(" ");
  let s = combined
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['".,()]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!s) s = "institution";
  return s;
}

/**
 * Deterministic, pipeline-internal id: a stable slug-based string, prefixed
 * so it can never be confused with a real BilimOn cuid (which looks like
 * "cmrfw8t5o001an3ogocewc8g6" — see data/reference/bilimon-institutions-reference.json).
 * This id keys data/state|processed|review/<id>.json for idempotent reruns;
 * it is NOT written to BilimOnExportRecord.id — see that field's doc
 * comment in src/types/index.ts for the still-open question on what value
 * (if any) BilimOn's real import expects there.
 */
export function generateId(nameKey: string, city: string): string {
  const base = slugify(nameKey, city);
  return `pipeline-${base}`;
}

/** Deterministic short hash, used for cache filenames and disambiguation suffixes. */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface PhoneNormalizeResult {
  valid: boolean;
  normalized?: string; // E.164-ish +998XXXXXXXXX
  reason?: string;
}

/**
 * Normalize a phone number to +998XXXXXXXXX (Uzbekistan), rejecting malformed
 * input. Handles a single number only — real BilimOn `phone2` values
 * sometimes hold multiple comma-separated numbers in one string (e.g.
 * "+998909007966,+998944130900"); callers that need to normalize a `phone2`
 * value should split on "," first (see agents/bilimon-exporter.ts) rather
 * than rejecting the whole field, since BilimOn's own field accepts this
 * free-form shape.
 */
export function normalizePhone(raw: string | null | undefined): PhoneNormalizeResult {
  if (!raw || !raw.trim()) {
    return { valid: false, reason: "empty phone" };
  }
  // Strip everything except digits and a leading +.
  let digits = raw.trim().replace(/[^\d+]/g, "");
  digits = digits.replace(/(?!^)\+/g, ""); // drop any non-leading +

  let national: string | null = null;
  if (digits.startsWith("+998")) {
    national = digits.slice(4);
  } else if (digits.startsWith("998")) {
    national = digits.slice(3);
  } else if (digits.startsWith("0")) {
    // Not a valid Uzbekistan mobile/local convention for this schema; reject.
    return { valid: false, reason: "leading 0 without country code is not accepted" };
  } else if (/^\d{9}$/.test(digits)) {
    national = digits; // bare 9-digit local number, assume UZ
  } else {
    return { valid: false, reason: "unrecognized phone format" };
  }

  if (!/^\d{9}$/.test(national)) {
    return { valid: false, reason: `expected 9 digits after country code, got ${national.length}` };
  }

  return { valid: true, normalized: `+998${national}` };
}

/** Normalize a website/social URL: ensure scheme, lowercase host, strip trailing slash. */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) {
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    u.hostname = u.hostname.toLowerCase();
    let out = u.toString();
    if (out.endsWith("/") && u.pathname === "/") {
      out = out.slice(0, -1);
    }
    return out;
  } catch {
    return null;
  }
}

/** Extract a registrable domain from a URL for dedupe purposes, or null. */
export function extractDomain(raw: string | null | undefined): string | null {
  const normalized = normalizeUrl(raw);
  if (!normalized) return null;
  try {
    const host = new URL(normalized).hostname.replace(/^www\./, "");
    return host;
  } catch {
    return null;
  }
}

/**
 * Maps a free-text language name onto BilimOn's real ISO-style code.
 *
 * Real production failure this fixes: the Deep Research agent's live
 * extraction returned `details.languages` as human-readable names in
 * Russian — ["Узбекский", "Русский", "Английский"] — because that is how
 * the source pages themselves write it. The real BilimOn export uses
 * lowercase 2-3 letter codes (uz/ru/en/de, counted across all 302 real
 * records), so the validator rejected the record and an institution that
 * had ALREADY passed the quality gate (confidence 93, completeness 73)
 * was dropped to NEEDS_REVIEW over nothing but a label format. Normalizing
 * here, rather than hoping the model always emits codes, is the reliable
 * fix: a model asked for structured data will keep echoing whatever the
 * source page uses.
 *
 * An unrecognized value is returned lowercased and trimmed rather than
 * dropped — the validator still soft-flags codes outside the known set
 * (the real export covers only 4 languages and cannot prove others are
 * illegal), so a genuinely new language survives to human review instead
 * of being silently deleted.
 */
const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  // Uzbek
  uz: "uz", uzb: "uz", uzbek: "uz", uzbekcha: "uz", "o'zbek": "uz", ozbek: "uz",
  "o'zbekcha": "uz", ozbekcha: "uz", "o'zbek tili": "uz", "ozbek tili": "uz",
  узбекский: "uz", узбек: "uz", "узбекский язык": "uz",
  // Russian
  ru: "ru", rus: "ru", russian: "ru", ruscha: "ru", "rus tili": "ru",
  русский: "ru", "русский язык": "ru",
  // English
  en: "en", eng: "en", english: "en", ingliz: "en", inglizcha: "en", "ingliz tili": "en",
  английский: "en", "английский язык": "en", англ: "en",
  // German
  de: "de", ger: "de", german: "de", deutsch: "de", nemis: "de", "nemis tili": "de",
  немецкий: "de", "немецкий язык": "de",
};

/** Normalize one language label to its code, or null for empty input. */
export function normalizeLanguageCode(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return LANGUAGE_NAME_TO_CODE[key] ?? key;
}

/** Normalize a languages array, dropping empties and duplicates. */
export function normalizeLanguages(raw: string[] | null | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const code = normalizeLanguageCode(item);
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}
