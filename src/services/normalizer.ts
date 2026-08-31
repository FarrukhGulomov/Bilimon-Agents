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

/** Deterministic id: stable slug-based string id (see schema doc assumption). */
export function generateId(nameKey: string, city: string): string {
  const base = slugify(nameKey, city);
  return base;
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

/** Normalize a phone number to +998XXXXXXXXX (Uzbekistan), rejecting malformed input. */
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
