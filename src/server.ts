#!/usr/bin/env node
/**
 * Minimal web frontend: a form to request learning-center discovery by
 * free-text brief (e.g. "ingliz tili bo'yicha" or "IT sohasi") + a count, and
 * a JSON download of the resulting bilimon-import.json. Built on node:http
 * with zero new dependencies, matching this project's existing style (no
 * framework anywhere else in src/).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPipeline, finalizeExport } from "./agents/orchestrator.js";
import { MissingApiKeyError, hasApiKey, isFatalProviderError } from "./services/llm-client.js";
import { listCities } from "./services/location-mapper.js";
import type { BilimOnExportRecord } from "./types/index.js";

// Uzbek display labels for the frontend's city dropdown, keyed by the real
// CitySeed.nameEn (src/schemas/locations.ts) so the dropdown's option value
// is exactly the string services/brief-parser.ts::matchCityNames already
// knows how to match — no separate mapping to keep in sync on the backend
// side. Display-only; never used for matching or resolution.
const CITY_LABELS_UZ: Record<string, string> = {
  Tashkent: "Toshkent",
  Samarkand: "Samarqand",
  Bukhara: "Buxoro",
  Namangan: "Namangan",
  Fergana: "Farg'ona",
  Andijan: "Andijon",
  Karshi: "Qarshi",
  Jizzakh: "Jizzax",
  "Tashkent Region": "Toshkent viloyati (shahar aniqlanmagan)",
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const EXPORT_DIR = join(__dirname, "..", "data", "export");
const IMPORT_FILE = join(EXPORT_DIR, "bilimon-import.json");
const PORT = Number(process.env.PORT ?? 3000);

// A run can legitimately take minutes in live mode (per-institution web
// search + research calls), so a request body this small isn't worth
// streaming/parsing incrementally, but the count needs a hard ceiling: an
// unbounded --count from an open web form is real API spend per click.
const MAX_COUNT = Number(process.env.PIPELINE_MAX_COUNT ?? 50);
const MAX_BRIEF_LENGTH = 300;

// Single-process, single-run-at-a-time: this is an internal tool, not a
// multi-tenant service, and two overlapping runPipeline() calls would race
// on the same data/state and data/export files.
let runInProgress = false;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    // Defensive cap on request body size — this endpoint only ever needs a
    // tiny {brief, count} object.
    if (chunks.reduce((n, c) => n + c.length, 0) > 10_000) {
      throw new Error("Request body too large");
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function parseRunRequest(
  raw: string
): { brief?: string; count: number; topOnly: boolean; institutionName?: string } | { error: string } {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return { error: "Noto'g'ri so'rov formati (JSON kutilgan)." };
  }
  const body = (parsed ?? {}) as Record<string, unknown>;

  let brief: string | undefined;
  if (body.brief !== undefined && body.brief !== null) {
    if (typeof body.brief !== "string") return { error: "\"brief\" matn bo'lishi kerak." };
    brief = body.brief.trim().slice(0, MAX_BRIEF_LENGTH);
    if (!brief) brief = undefined;
  }

  let city: string | undefined;
  if (body.city !== undefined && body.city !== null) {
    if (typeof body.city !== "string") return { error: "\"city\" matn bo'lishi kerak." };
    city = body.city.trim().slice(0, MAX_BRIEF_LENGTH);
    if (!city) city = undefined;
  }

  const rawCount = body.count ?? 5;
  const count = Number(rawCount);
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 1) {
    return { error: "\"count\" 1 dan katta butun son bo'lishi kerak." };
  }
  if (count > MAX_COUNT) {
    return { error: `"count" ${MAX_COUNT} dan oshmasligi kerak.` };
  }

  // The city dropdown's value is a real CitySeed.nameEn (or omitted for "all
  // cities") — folded straight into the free-text brief rather than plumbed
  // through as a separate RunOptions field, since resolveBrief() already
  // runs matchCityNames() unconditionally over whatever brief text it gets
  // (see brief-parser.ts) and matches on nameEn/its aliases regardless of
  // what language the rest of the brief is in.
  const combinedBrief = [brief, city].filter(Boolean).join(" ") || undefined;

  const topOnly = body.topOnly === true;

  // "Look up by name" mode: real user request — type one specific
  // institution's name and have it researched directly. Passed straight
  // through to RunOptions.institutionName; see its doc comment in
  // orchestrator.ts for why this bypasses brief/city/count/topOnly entirely
  // once set.
  let institutionName: string | undefined;
  if (body.institutionName !== undefined && body.institutionName !== null) {
    if (typeof body.institutionName !== "string") return { error: "\"institutionName\" matn bo'lishi kerak." };
    institutionName = body.institutionName.trim().slice(0, MAX_BRIEF_LENGTH);
    if (!institutionName) institutionName = undefined;
  }

  return { brief: combinedBrief, count, topOnly, institutionName };
}

async function handleApiRun(req: IncomingMessage, res: ServerResponse) {
  if (runInProgress) {
    sendJson(res, 409, { error: "Boshqa so'rov hozir bajarilmoqda. Biroz kuting va qayta urinib ko'ring." });
    return;
  }

  const raw = await readBody(req);
  const parsedRequest = parseRunRequest(raw);
  if ("error" in parsedRequest) {
    sendJson(res, 400, { error: parsedRequest.error });
    return;
  }
  const { brief, count, topOnly, institutionName } = parsedRequest;

  const mock = process.env.PIPELINE_MOCK === "1";
  if (!mock && !hasApiKey()) {
    sendJson(res, 400, { error: new MissingApiKeyError().message });
    return;
  }

  runInProgress = true;
  try {
    const summary = await runPipeline({ count, mock, brief, topOnly, institutionName });
    const { report, importPath } = finalizeExport();
    sendJson(res, 200, {
      ok: true,
      summary: {
        processed: summary.processedIds.length,
        duplicates: summary.duplicateIds.length,
        approved: summary.approved,
        needsReview: summary.needsReview,
        rejected: summary.rejected,
        resolvedScope: summary.resolvedScope,
        requested: count,
        shortfall: summary.shortfall,
        searchExhausted: summary.searchExhausted,
        topOnly,
        institutionName: institutionName ?? null,
      },
      report,
      results: summary.results,
      // The full import file content is embedded directly in this response
      // (not just a /api/download URL to fetch afterward) so the browser
      // can download it from data it already has, with no dependency on a
      // second round-trip. Real production bug: on a host with no
      // persistent volume (e.g. Railway without an attached volume), the
      // container's local disk can reset between requests — a restart, a
      // redeploy, or multiple replicas each with their own ephemeral disk —
      // so a user who successfully ran the pipeline could still get "Hali
      // natija yo'q" from /api/download moments later, through no fault of
      // their own. downloadUrl is kept for convenience (e.g. revisiting via
      // curl) but the frontend no longer relies on it.
      importFile: readImportFile(importPath),
      // Real user complaint: the results table shows NEEDS_REVIEW
      // institutions too (they already have a real name/phone/website
      // found), but bilimon-import.json only ever contains APPROVED
      // records — there was no way to get the needsReview ones out of the
      // pipeline at all. Same envelope shape as importFile so a human
      // reviewing them can compare directly, just a separate file/button.
      reviewFile: buildRecordsFile(summary.needsReviewRecords),
      // Real user request: rather than the first `count` institutions to
      // clear the ordinary quality gate, search a wider net and surface
      // only the `count` highest-qualityScore ones — "top sifatli o'quv
      // markazlari". Populated only when topOnly was requested; same
      // envelope shape as importFile/reviewFile.
      topFile: topOnly ? buildRecordsFile(summary.topRecords) : undefined,
      downloadUrl: "/api/download",
    });
  } catch (err) {
    if (isFatalProviderError(err)) {
      const { report, importPath } = finalizeExport();
      sendJson(res, 200, {
        ok: false,
        warning: `So'rov to'xtatildi: ${err.info.message}`,
        report,
        importFile: readImportFile(importPath),
        downloadUrl: existsSync(IMPORT_FILE) ? "/api/download" : undefined,
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: `Ichki xatolik: ${message}` });
  } finally {
    runInProgress = false;
  }
}

function readImportFile(importPath: string): unknown {
  try {
    return JSON.parse(readFileSync(importPath, "utf-8"));
  } catch {
    return null;
  }
}

function buildRecordsFile(records: BilimOnExportRecord[]): unknown {
  return { version: 1, exportedAt: new Date().toISOString(), institutions: records };
}

function handleApiCities(res: ServerResponse) {
  const cities = listCities().map((c) => ({
    nameEn: c.nameEn,
    label: CITY_LABELS_UZ[c.nameEn] ?? c.nameEn,
  }));
  sendJson(res, 200, { cities });
}

function handleApiDownload(res: ServerResponse) {
  if (!existsSync(IMPORT_FILE)) {
    sendJson(res, 404, { error: "Hali natija yo'q. Avval so'rov yuboring." });
    return;
  }
  const data = readFileSync(IMPORT_FILE);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": "attachment; filename=\"bilimon-import.json\"",
    "Content-Length": data.length,
  });
  res.end(data);
}

function handleIndex(res: ServerResponse) {
  const indexPath = join(PUBLIC_DIR, "index.html");
  if (!existsSync(indexPath)) {
    sendJson(res, 500, { error: "public/index.html not found" });
    return;
  }
  const html = readFileSync(indexPath, "utf-8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  (async () => {
    if (req.method === "GET" && url.pathname === "/") {
      handleIndex(res);
    } else if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
    } else if (req.method === "GET" && url.pathname === "/api/cities") {
      handleApiCities(res);
    } else if (req.method === "POST" && url.pathname === "/api/run") {
      await handleApiRun(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/download") {
      handleApiDownload(res);
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  })().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Unhandled request error:", message);
    if (!res.headersSent) sendJson(res, 500, { error: `Ichki xatolik: ${message}` });
  });
});

// Live discovery+research runs can take minutes; don't let Node's default
// socket timeouts cut off a still-running request.
server.requestTimeout = 0;
server.headersTimeout = 0;

// Only actually bind a port when this file is run directly (`npm start` /
// `npm run server`), not when it's imported for testing (test/run-all.ts
// imports parseRunRequest() for its own validation coverage — importing it
// must never open a real socket as a side effect).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => {
    console.log(`BilimOn Agents web frontend listening on port ${PORT}`);
  });
}
