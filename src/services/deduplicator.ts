/**
 * Deterministic dedupe: normalized-name/phone/domain/social matching.
 * An AI-assisted fallback (callLLMForAmbiguousMatch) is provided for cases
 * the deterministic rules can't confidently resolve — it is only invoked
 * when useAi=true and never in --mock mode (see agents/discovery.ts /
 * researcher.ts callers).
 */
import { normalizeNameKey, normalizePhone, extractDomain } from "./normalizer.js";
import { askStructured } from "./llm-client.js";

export interface DedupeCandidate {
  id: string; // caller-assigned identifier for this candidate
  name: string;
  city?: string | null;
  phone?: string | null;
  website?: string | null;
  telegram?: string | null;
  instagram?: string | null;
}

export interface DedupeGroup {
  keptId: string;
  mergedIds: string[]; // ids merged into keptId (excludes keptId itself)
  reason: string;
}

function socialHandle(url: string | null | undefined): string | null {
  if (!url) return null;
  const domain = extractDomain(url);
  if (!domain) return null;
  try {
    const path = new URL(url.startsWith("http") ? url : `https://${url}`).pathname
      .replace(/\/$/, "")
      .toLowerCase();
    return `${domain}${path}`;
  } catch {
    return domain;
  }
}

/** Deterministic key set used to decide whether two candidates are the same institution. */
function matchKeys(c: DedupeCandidate): { nameCity: string; phone: string | null; domain: string | null; tg: string | null; ig: string | null } {
  const phoneResult = normalizePhone(c.phone ?? undefined);
  return {
    nameCity: `${normalizeNameKey(c.name)}|${(c.city ?? "").trim().toLowerCase()}`,
    phone: phoneResult.valid ? phoneResult.normalized! : null,
    domain: extractDomain(c.website ?? undefined),
    tg: socialHandle(c.telegram ?? undefined),
    ig: socialHandle(c.instagram ?? undefined),
  };
}

/**
 * Groups candidates that deterministically look like the same institution:
 * same normalized-name+city, OR same phone, OR same website domain, OR same
 * telegram/instagram handle. Returns groups; singletons are omitted.
 */
export function deterministicDedupe(candidates: DedupeCandidate[]): DedupeGroup[] {
  const keyed = candidates.map((c) => ({ c, k: matchKeys(c) }));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    // Attach the later root under the earlier one so the first-seen id
    // stays canonical (deterministic given stable input order).
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const { c } of keyed) if (!parent.has(c.id)) parent.set(c.id, c.id);

  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const a = keyed[i];
      const b = keyed[j];
      const same =
        a.k.nameCity === b.k.nameCity ||
        (a.k.phone && b.k.phone && a.k.phone === b.k.phone) ||
        (a.k.domain && b.k.domain && a.k.domain === b.k.domain) ||
        (a.k.tg && b.k.tg && a.k.tg === b.k.tg) ||
        (a.k.ig && b.k.ig && a.k.ig === b.k.ig);
      if (same) union(a.c.id, b.c.id);
    }
  }

  const groups = new Map<string, string[]>();
  for (const { c } of keyed) {
    const root = find(c.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(c.id);
  }

  const result: DedupeGroup[] = [];
  for (const [root, ids] of groups) {
    if (ids.length <= 1) continue;
    // Keep the first-seen id as canonical; deterministic given stable input order.
    const kept = ids.includes(root) ? root : ids[0];
    const merged = ids.filter((id) => id !== kept);
    result.push({ keptId: kept, mergedIds: merged, reason: "deterministic name/phone/domain/social match" });
  }
  return result;
}

/**
 * AI-assisted fallback for two candidates the deterministic rules could not
 * confidently merge or split (e.g. similar-but-not-identical names, no
 * shared phone/domain). Requires ANTHROPIC_API_KEY; never called in mock
 * mode. Returns true if the LLM judges them the same real-world institution.
 */
export async function isAmbiguousDuplicate(a: DedupeCandidate, b: DedupeCandidate): Promise<boolean> {
  const result = await askStructured<{ sameInstitution: boolean; reasoning: string }>({
    system:
      "You resolve entity-matching ambiguity for an education-institution directory in Uzbekistan. " +
      "Given two candidate records, decide whether they refer to the same real-world institution " +
      "(e.g. a rebrand, a shortened name, a branch vs a chain-level listing) or are genuinely distinct. " +
      "Respond only with the requested JSON.",
    prompt: `Candidate A: ${JSON.stringify(a)}\nCandidate B: ${JSON.stringify(b)}`,
    schemaDescription: `{"sameInstitution": boolean, "reasoning": string}`,
  });
  return result.sameInstitution;
}
