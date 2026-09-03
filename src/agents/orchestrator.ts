/**
 * Orchestrator: drives DISCOVERED -> RESEARCHING -> VERIFIED ->
 * CONTENT_READY -> JSON_READY -> APPROVED/NEEDS_REVIEW/REJECTED for each
 * institution, tracking per-institution state in data/state/<id>.json so
 * reruns are idempotent (already-past-a-stage institutions are skipped,
 * cached URLs are never refetched — see services/scraper.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PipelineState, StateRecord, RawExtractedFields } from "../types/index.js";
import { runDiscovery, type DiscoveryCandidate } from "./discovery.js";
import { deterministicDedupe, type DedupeCandidate } from "../services/deduplicator.js";
import { researchMock, researchLive, mergeEvidence } from "./researcher.js";
import { generateContent } from "./content-manager.js";
import { buildExportRecord, exportFinalArtifacts, writeProcessedRecord, readProcessedRecord } from "./bilimon-exporter.js";
import { scoreInstitution } from "../services/scoring.js";
import { validateRecord } from "../services/validator.js";
import { generateDuplicateBookkeepingId, generateId, normalizeNameKey, slugify } from "../services/normalizer.js";
import { runWithConcurrency } from "../services/concurrency.js";
import { loadExecutionConfig } from "../services/execution-config.js";
import { resolveBrief, type DiscoveryScope } from "../services/brief-parser.js";
import { persistLastScope } from "../services/scope-store.js";
import { isFatalProviderError } from "../services/llm-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, "..", "..", "data", "state");
const REVIEW_DIR = join(__dirname, "..", "..", "data", "review");
const REJECTED_DIR = join(__dirname, "..", "..", "data", "rejected");

const MAX_RETRIES = 3;

function ensureDirs(): void {
  for (const d of [STATE_DIR, REVIEW_DIR, REJECTED_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function statePath(id: string): string {
  return join(STATE_DIR, `${id}.json`);
}

function readState(id: string): StateRecord | null {
  const p = statePath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as StateRecord;
}

function writeState(state: StateRecord): void {
  ensureDirs();
  writeFileSync(statePath(state.id), JSON.stringify(state, null, 2), "utf-8");
}

function transition(state: StateRecord, next: PipelineState, note?: string): StateRecord {
  state.state = next;
  state.updatedAt = new Date().toISOString();
  state.history.push({ state: next, at: state.updatedAt, note });
  writeState(state);
  return state;
}

function getOrCreateState(id: string): StateRecord {
  const existing = readState(id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const fresh: StateRecord = {
    id,
    state: "DISCOVERED",
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    history: [{ state: "DISCOVERED", at: now }],
  };
  writeState(fresh);
  return fresh;
}

const STAGE_ORDER: PipelineState[] = [
  "DISCOVERED",
  "RESEARCHING",
  "VERIFIED",
  "CONTENT_READY",
  "JSON_READY",
  "APPROVED", // terminal states share the same "done" rank for skip purposes
];

function stageRank(state: PipelineState): number {
  if (state === "NEEDS_REVIEW" || state === "REJECTED") return 999; // terminal, always skip
  const idx = STAGE_ORDER.indexOf(state);
  return idx === -1 ? 0 : idx;
}

function isPastStage(state: PipelineState, stage: PipelineState): boolean {
  return stageRank(state) >= stageRank(stage);
}

export interface ProgressSnapshot {
  completed: number;
  total: number;
  approved: number;
  needsReview: number;
  rejected: number;
  duplicates: number;
}

export interface RunOptions {
  count: number;
  mock: boolean;
  /** Free-text brief (Uzbek/Russian/English) describing what kind of
   * institutions to discover, e.g. "top IELTS markazlari" or "barcha
   * maktablar". Resolved to a DiscoveryScope via
   * services/brief-parser.ts::resolveBrief. Omit (or pass undefined/empty)
   * for the pre-existing config/priority-categories.json default scope —
   * unchanged behavior for brief-less callers. */
  brief?: string;
  /** Called after each institution finishes the RESEARCHING..gate pipeline
   * (and every time an already-terminal one is skipped), so a caller (the
   * CLI) can print a running progress line during a long batch. Optional —
   * defaults to a no-op so callers/tests that don't care can ignore it. */
  onProgress?: (snapshot: ProgressSnapshot) => void;
}

/** One row of this run's results for a UI table (src/server.ts's
 * /api/run response) — deliberately built from whatever is already on disk
 * for `id` (data/processed/<id>.json when a record was built, otherwise the
 * discovery-time candidate fields) rather than threaded through
 * processCandidate()'s many return points, so this stays a read-only
 * side-effect-free step after the run completes. */
export interface RunResultRow {
  id: string;
  name: string;
  phone: string | null;
  website: string | null;
  city: string | null;
  type: string | null;
  categories: string[];
  status: "approved" | "needsReview" | "rejected" | "pending";
}

function buildResultRow(id: string, cand: DiscoveryCandidate): RunResultRow {
  const state = readState(id);
  const record = state?.state === "APPROVED" || state?.state === "NEEDS_REVIEW" ? readProcessedRecord(id) : null;
  const status: RunResultRow["status"] =
    state?.state === "APPROVED"
      ? "approved"
      : state?.state === "NEEDS_REVIEW"
        ? "needsReview"
        : state?.state === "REJECTED"
          ? "rejected"
          : "pending"; // retry-pending, or (shouldn't happen) never reached a terminal state
  return {
    id,
    name: record?.nameUz ?? cand.rawName,
    phone: record?.phone ?? cand.phone ?? null,
    website: record?.website ?? cand.website ?? null,
    city: cand.city ?? null,
    type: record?.type ?? cand.type ?? null,
    categories: record?.details.categories ?? (cand.category ? [cand.category] : []),
    status,
  };
}

export interface RunSummary {
  processedIds: string[];
  duplicateIds: string[];
  approved: number;
  needsReview: number;
  rejected: number;
  resolvedScope: DiscoveryScope;
  /** Per-institution rows for this run only (unlike report.json's
   * cumulative-across-all-runs totals) — see RunResultRow. */
  results: RunResultRow[];
}

type CandidateOutcome = "approved" | "needsReview" | "rejected" | "retry-pending";

/** Runs deterministic dedupe over raw discovery candidates and returns
 * canonical survivors plus a map id -> merged-away duplicate ids. Exported
 * so the id-collision fix below is testable without spinning up the full
 * runPipeline(). */
export function dedupeCandidates(candidates: DiscoveryCandidate[]): {
  survivors: DiscoveryCandidate[];
  mergedAwayIds: Set<string>;
} {
  const dedupeInput: DedupeCandidate[] = candidates.map((c) => ({
    id: c.discoveryId,
    name: c.rawName,
    city: c.city,
    phone: c.phone,
    website: c.website,
    telegram: c.telegram,
    instagram: c.instagram,
  }));
  const groups = deterministicDedupe(dedupeInput);
  const mergedAwayIds = new Set<string>();
  for (const g of groups) {
    for (const id of g.mergedIds) mergedAwayIds.add(id);
  }
  const survivors = candidates.filter((c) => !mergedAwayIds.has(c.discoveryId));
  return { survivors, mergedAwayIds };
}

/**
 * Picks the EXPORT-facing nameKey/slug from the best name actually known by
 * the time a record is built — never from `cand.rawName` alone.
 *
 * Real production bug: a live search result's `name` is sometimes just the
 * generic facet label ("til markazi", i.e. Uzbek for "language center")
 * rather than the actual institution name — this happens when Agent 1 found
 * the institution via a directory listing whose title wasn't a clean name.
 * `nameKey`/`slug` used to be computed from `cand.rawName` once, at
 * discovery time, and never revisited — so every institution matching that
 * generic label exported the identical nameKey/slug ("til-markazi-
 * tashkent"), which would collide on import. Research (Agent 2) usually
 * resolves a real name into `fields.nameUz`/`nameLatin`/`nameRu` by the time
 * the record is built, so prefer that over the raw discovery name. Pure and
 * exported so this is testable without running the full pipeline.
 *
 * This is deliberately separate from the pipeline-internal `id` (see
 * services/normalizer.ts::generateId), which still keys off the ORIGINAL
 * discovery-time name for state/processed/review filenames — changing that
 * mid-flight would break idempotency across reruns. Only the values written
 * into the exported record change here.
 */
export function resolveExportIdentity(
  fields: RawExtractedFields,
  cand: Pick<DiscoveryCandidate, "rawName" | "city">
): { nameKey: string; slug: string } {
  const bestName = fields.nameUz ?? fields.nameLatin ?? fields.nameRu ?? cand.rawName;
  return {
    nameKey: normalizeNameKey(bestName),
    slug: slugify(bestName, fields.city ?? cand.city ?? ""),
  };
}

export async function runPipeline(opts: RunOptions): Promise<RunSummary> {
  ensureDirs();
  const scope = await resolveBrief(opts.brief);
  persistLastScope(scope);
  if (!opts.mock) {
    console.log(
      "Discovery: running live web search (per-search progress logs below; each search can take tens of seconds)..."
    );
  }
  const candidates = await runDiscovery(opts.count, opts.mock, scope);
  if (!opts.mock) {
    console.log(`Discovery: found ${candidates.length} raw candidate(s) before dedupe.`);
  }
  const { survivors, mergedAwayIds } = dedupeCandidates(candidates);

  // Record duplicates in state so report.json can count them, without
  // reprocessing them on subsequent runs.
  //
  // Real production bug: this used to key the bookkeeping state entry with
  // `generateId(normalizeNameKey(cand.rawName), cand.city)` — the SAME id
  // function processCandidate() uses for the SURVIVING candidate. Two
  // candidates with identical rawName+city (matched into the same dedupe
  // group via phone/domain/social, or via name+city itself) produce the
  // SAME id here and in processCandidate(); the duplicate's REJECTED write
  // would then make the real survivor's later processCandidate() call see
  // an already-terminal state and skip it — silently dropping a real
  // institution. See generateDuplicateBookkeepingId()'s doc comment.
  for (const dupId of mergedAwayIds) {
    const cand = candidates.find((c) => c.discoveryId === dupId);
    if (!cand) continue;
    const provisionalId = generateDuplicateBookkeepingId(cand.discoveryId);
    const st = getOrCreateState(provisionalId);
    if (st.state !== "REJECTED") {
      st.lastError = "duplicate";
      transition(st, "REJECTED", "merged as duplicate during dedupe");
    }
  }

  const processedIds: string[] = [];
  let approved = 0;
  let needsReview = 0;
  let rejectedCount = 0;
  const duplicatesSoFar = mergedAwayIds.size;

  /** Runs one candidate through RESEARCHING -> ... -> quality gate. Mutates
   * per-institution state on disk exactly as the original sequential loop
   * did; returns only the terminal-outcome tag so the caller can update
   * shared counters and progress after each candidate settles. Candidates
   * are otherwise independent (separate state/processed/review files), so
   * this is safe to run several at a time via runWithConcurrency below. */
  async function processCandidate(cand: DiscoveryCandidate): Promise<CandidateOutcome> {
    const nameKey = normalizeNameKey(cand.rawName);
    const id = generateId(nameKey, cand.city ?? "");
    const slug = slugify(cand.rawName, cand.city ?? "");
    const state = getOrCreateState(id);

    if (state.state === "NEEDS_REVIEW" || state.state === "REJECTED" || state.state === "APPROVED") {
      // Already terminal from a prior run — idempotent skip, no reprocessing.
      if (state.state === "NEEDS_REVIEW") return "needsReview";
      if (state.state === "REJECTED") return "rejected";
      return "approved";
    }

    try {
      // --- RESEARCHING ---
      if (!isPastStage(state.state, "RESEARCHING")) {
        transition(state, "RESEARCHING");
      }
      // Real production failure: this used to pass `[cand.sourceUrl]` — a
      // SINGLE url — into a scrape-only researcher, so Agent 2 had exactly
      // one chance to get anything at all, through the one mechanism (naive
      // fetch + regex tag-strip) that the real web most reliably defeats.
      // Agent 2 now gets the institution's identity plus every link Agent 1
      // saw, and runs a search-grounded research call over them with the
      // scrape as a supplement.
      const researchRecord = opts.mock
        ? researchMock(id, nameKey, cand.fixtureId ?? cand.discoveryId)
        : await researchLive(id, nameKey, {
            name: cand.rawName,
            city: cand.city,
            website: cand.website,
            telegram: cand.telegram,
            instagram: cand.instagram,
            facebook: cand.facebook,
            sourceUrl: cand.sourceUrl,
          });
      const { fields, evidenceCount, bestSourceConfidence } = mergeEvidence(researchRecord);
      // Fill in city/category from discovery if research didn't supply them.
      // Real production bug: researchLive's extraction prompt never asks for
      // a name field at all, so a candidate whose research pass found no
      // other evidence had fields.nameUz/nameLatin both empty and got
      // rejected with "no nameUz/nameLatin available" — even though the
      // institution's name (cand.rawName, from the discovery web-search
      // result title) was known the whole time and already used for this
      // candidate's id/slug. Always fall back to it.
      if (!fields.nameUz && !fields.nameLatin && cand.rawName) fields.nameLatin = cand.rawName;
      if (!fields.city && cand.city) fields.city = cand.city;
      if ((!fields.categories || fields.categories.length === 0) && cand.category) {
        // category comes from discovery as a plain string matching the enum name.
        fields.categories = [cand.category as any];
      }
      if (!fields.type && cand.type) {
        // type comes from discovery (mock fixtures, or the resolved
        // DiscoveryScope facet in live mode) as a plain string matching the
        // real InstitutionType enum name.
        fields.type = cand.type as any;
      }
      if (!fields.phone && cand.phone) fields.phone = cand.phone;
      if (!fields.website && cand.website) fields.website = cand.website;
      if (!fields.telegram && cand.telegram) fields.telegram = cand.telegram;
      if (!fields.instagram && cand.instagram) fields.instagram = cand.instagram;
      // address is a REQUIRED_FOR_COMPLETENESS field (services/scoring.ts),
      // and in live mode Agent 1 now often has it from a yellowpages.uz /
      // goldenpages.uz listing even when research came back without one.
      if (!fields.address && cand.address) fields.address = cand.address;

      // Real production bug: `nameKey`/`slug` above are computed from
      // `cand.rawName` at DISCOVERY time, before research runs — and a live
      // search result's `name` is sometimes just the generic facet label
      // ("til markazi", i.e. "language center") rather than the actual
      // institution name, especially when the model found it via a
      // directory listing whose title wasn't a clean name. Research
      // (Agent 2) usually resolves a much better name into fields.nameUz/
      // nameLatin/nameRu. Left unfixed, EVERY institution matching that
      // generic label would export the same nameKey/slug ("til-markazi-
      // tashkent"), colliding on import. The pipeline-internal `id` (used
      // for state/processed/review filenames, and for idempotency across
      // reruns) deliberately still keys off the ORIGINAL discovery-time
      // name — changing it mid-flight would break resumability — only the
      // EXPORTED nameKey/slug are recomputed from the best name actually
      // resolved by the time we're about to build the record.
      const { nameKey: exportNameKey, slug: exportSlug } = resolveExportIdentity(fields, cand);

      transition(state, "VERIFIED");

      // --- CONTENT_READY ---
      const content = await generateContent(fields, opts.mock);
      transition(state, "CONTENT_READY", content.needsContentReview ? content.reason : undefined);

      // --- JSON_READY ---
      const built = buildExportRecord(id, exportSlug, exportNameKey, fields, content);
      if (!built.record) {
        writeFileSync(
          join(REVIEW_DIR, `${id}.json`),
          JSON.stringify({ id, reasons: built.buildErrors }, null, 2),
          "utf-8"
        );
        state.lastError = built.buildErrors.join("; ");
        console.log(`NEEDS_REVIEW: ${nameKey} (${id}) — failed to build export record: ${built.buildErrors.join("; ")}`);
        transition(state, "NEEDS_REVIEW", "failed to build export record");
        return "needsReview";
      }
      writeProcessedRecord(id, built.record);
      transition(state, "JSON_READY");

      // --- Scoring + quality gate ---
      const score = scoreInstitution({
        id,
        nameKey,
        slug,
        fields,
        evidenceCount,
        bestSourceConfidence,
      });
      state.scores = score;

      if (score.status === "REJECTED") {
        writeFileSync(
          join(REJECTED_DIR, `${id}.json`),
          JSON.stringify({ id, reasons: [`quality score ${score.qualityScore} below REJECTED threshold`], score }, null, 2),
          "utf-8"
        );
        console.log(
          `REJECTED: ${nameKey} (${id}) — quality score ${score.qualityScore} ` +
            `(completeness=${score.dataCompleteness} confidence=${score.sourceConfidence}) below REJECTED threshold`
        );
        transition(state, "REJECTED", `quality score ${score.qualityScore}`);
        return "rejected";
      }

      const validation = validateRecord(built.record);
      if (score.status === "NEEDS_REVIEW" || !validation.valid) {
        const reasons = score.status === "NEEDS_REVIEW"
          ? [`quality score ${score.qualityScore} in NEEDS_REVIEW band (completeness=${score.dataCompleteness} confidence=${score.sourceConfidence})`, ...validation.reasons]
          : validation.reasons;
        writeFileSync(
          join(REVIEW_DIR, `${id}.json`),
          JSON.stringify({ id, reasons, score }, null, 2),
          "utf-8"
        );
        console.log(`NEEDS_REVIEW: ${nameKey} (${id}) — ${reasons.join("; ")}`);
        transition(state, "NEEDS_REVIEW", reasons.join("; "));
        return "needsReview";
      }

      // score.status is APPROVED or APPROVED_WITH_WARNINGS, and validation passed.
      transition(state, "APPROVED", `quality score ${score.qualityScore} (${score.status})`);
      return "approved";
    } catch (err) {
      // A fatal provider error (bad key / out of credits) will hit every
      // remaining institution identically — retrying it MAX_RETRIES times
      // per candidate just burns the rest of the batch against the same
      // wall. Let it unwind to cli.ts, which prints one clear line and
      // exits non-zero. Work already written to data/state|processed stays
      // on disk, so a rerun picks up where this stopped.
      if (isFatalProviderError(err)) {
        state.lastError = (err as Error).message;
        writeState(state);
        throw err;
      }
      state.retryCount = (state.retryCount ?? 0) + 1;
      state.lastError = (err as Error).message;
      if (state.retryCount >= MAX_RETRIES) {
        transition(state, "REJECTED", `exceeded max retries (${MAX_RETRIES}): ${state.lastError}`);
        return "rejected";
      }
      writeState(state); // stay in current state, retry on next run
      return "retry-pending";
    }
  }

  for (const cand of survivors) {
    const id = generateId(normalizeNameKey(cand.rawName), cand.city ?? "");
    processedIds.push(id);
  }

  const { maxConcurrency, progressReportEvery } = loadExecutionConfig();
  let completed = 0;
  const onProgress = opts.onProgress ?? (() => {});

  await runWithConcurrency({
    items: survivors,
    limit: maxConcurrency,
    worker: processCandidate,
    onSettled: (outcome) => {
      if (outcome === "approved") approved++;
      else if (outcome === "needsReview") needsReview++;
      else if (outcome === "rejected") rejectedCount++;
      // "retry-pending" contributes to none of the terminal counters yet.
      completed++;
      const isLast = completed === survivors.length;
      if (isLast || completed % progressReportEvery === 0) {
        onProgress({
          completed,
          total: survivors.length,
          approved,
          needsReview,
          rejected: rejectedCount,
          duplicates: duplicatesSoFar,
        });
      }
    },
  });

  const results = survivors.map((cand) =>
    buildResultRow(generateId(normalizeNameKey(cand.rawName), cand.city ?? ""), cand)
  );

  return {
    processedIds,
    duplicateIds: [...mergedAwayIds],
    approved,
    needsReview,
    rejected: rejectedCount,
    resolvedScope: scope,
    results,
  };
}

export function finalizeExport() {
  return exportFinalArtifacts();
}
