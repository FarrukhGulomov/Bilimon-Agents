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
import type { PipelineState, StateRecord } from "../types/index.js";
import { runDiscovery, type DiscoveryCandidate } from "./discovery.js";
import { deterministicDedupe, type DedupeCandidate } from "../services/deduplicator.js";
import { researchMock, researchLive, mergeEvidence } from "./researcher.js";
import { generateContent } from "./content-manager.js";
import { buildExportRecord, exportFinalArtifacts, writeProcessedRecord } from "./bilimon-exporter.js";
import { scoreInstitution } from "../services/scoring.js";
import { validateRecord } from "../services/validator.js";
import { generateId, normalizeNameKey, slugify } from "../services/normalizer.js";

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

export interface RunOptions {
  count: number;
  mock: boolean;
}

export interface RunSummary {
  processedIds: string[];
  duplicateIds: string[];
  approved: number;
  needsReview: number;
  rejected: number;
}

/** Runs deterministic dedupe over raw discovery candidates and returns
 * canonical survivors plus a map id -> merged-away duplicate ids. */
function dedupeCandidates(candidates: DiscoveryCandidate[]): {
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

export async function runPipeline(opts: RunOptions): Promise<RunSummary> {
  ensureDirs();
  const candidates = await runDiscovery(opts.count, opts.mock);
  const { survivors, mergedAwayIds } = dedupeCandidates(candidates);

  // Record duplicates in state so report.json can count them, without
  // reprocessing them on subsequent runs.
  for (const dupId of mergedAwayIds) {
    const cand = candidates.find((c) => c.discoveryId === dupId);
    if (!cand) continue;
    const provisionalId = generateId(normalizeNameKey(cand.rawName), cand.city ?? "");
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

  for (const cand of survivors) {
    const nameKey = normalizeNameKey(cand.rawName);
    const id = generateId(nameKey, cand.city ?? "");
    const slug = slugify(cand.rawName, cand.city ?? "");
    let state = getOrCreateState(id);
    processedIds.push(id);

    if (state.state === "NEEDS_REVIEW" || state.state === "REJECTED" || state.state === "APPROVED") {
      // Already terminal from a prior run — idempotent skip, no reprocessing.
      if (state.state === "NEEDS_REVIEW") needsReview++;
      else if (state.state === "REJECTED") rejectedCount++;
      else approved++;
      continue;
    }

    try {
      // --- RESEARCHING ---
      if (!isPastStage(state.state, "RESEARCHING")) {
        transition(state, "RESEARCHING");
      }
      const researchRecord = opts.mock
        ? researchMock(id, nameKey, cand.fixtureId ?? cand.discoveryId)
        : await researchLive(id, nameKey, [cand.sourceUrl].filter(Boolean) as string[]);
      const { fields, evidenceCount, bestSourceConfidence } = mergeEvidence(researchRecord);
      // Fill in city/category from discovery if research didn't supply them.
      if (!fields.city && cand.city) fields.city = cand.city;
      if (!fields.categories || fields.categories.length === 0) {
        // category comes from discovery as a plain string matching the enum name.
        fields.categories = [cand.category as any];
      }
      if (!fields.phone && cand.phone) fields.phone = cand.phone;
      if (!fields.website && cand.website) fields.website = cand.website;
      if (!fields.telegram && cand.telegram) fields.telegram = cand.telegram;
      if (!fields.instagram && cand.instagram) fields.instagram = cand.instagram;

      transition(state, "VERIFIED");

      // --- CONTENT_READY ---
      const content = await generateContent(fields, opts.mock);
      transition(state, "CONTENT_READY", content.needsContentReview ? content.reason : undefined);

      // --- JSON_READY ---
      const built = buildExportRecord(id, slug, nameKey, fields, content);
      if (!built.record) {
        writeFileSync(
          join(REVIEW_DIR, `${id}.json`),
          JSON.stringify({ id, reasons: built.buildErrors }, null, 2),
          "utf-8"
        );
        state.lastError = built.buildErrors.join("; ");
        transition(state, "NEEDS_REVIEW", "failed to build export record");
        needsReview++;
        continue;
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
        transition(state, "REJECTED", `quality score ${score.qualityScore}`);
        rejectedCount++;
        continue;
      }

      const validation = validateRecord(built.record);
      if (score.status === "NEEDS_REVIEW" || !validation.valid) {
        const reasons = score.status === "NEEDS_REVIEW"
          ? [`quality score ${score.qualityScore} in NEEDS_REVIEW band`, ...validation.reasons]
          : validation.reasons;
        writeFileSync(
          join(REVIEW_DIR, `${id}.json`),
          JSON.stringify({ id, reasons, score }, null, 2),
          "utf-8"
        );
        transition(state, "NEEDS_REVIEW", reasons.join("; "));
        needsReview++;
        continue;
      }

      // score.status is APPROVED or APPROVED_WITH_WARNINGS, and validation passed.
      transition(state, "APPROVED", `quality score ${score.qualityScore} (${score.status})`);
      approved++;
    } catch (err) {
      state.retryCount = (state.retryCount ?? 0) + 1;
      state.lastError = (err as Error).message;
      if (state.retryCount >= MAX_RETRIES) {
        transition(state, "REJECTED", `exceeded max retries (${MAX_RETRIES}): ${state.lastError}`);
        rejectedCount++;
      } else {
        writeState(state); // stay in current state, retry on next run
      }
    }
  }

  return {
    processedIds,
    duplicateIds: [...mergedAwayIds],
    approved,
    needsReview,
    rejected: rejectedCount,
  };
}

export function finalizeExport() {
  return exportFinalArtifacts();
}
