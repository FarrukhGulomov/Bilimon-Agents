#!/usr/bin/env node
/**
 * CLI entrypoint.
 *
 *   pipeline run --count N [--mock] [--brief "<free text>"]
 *     (N is an arbitrary batch size, e.g. 5, 20, 200, ...; --brief is
 *     optional free text like "top IELTS markazlari" or "barcha maktablar" —
 *     see services/brief-parser.ts and README.md "Brief-driven discovery")
 *   pipeline validate
 *   pipeline export
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPipeline, finalizeExport } from "./agents/orchestrator.js";
import { validateBatch } from "./services/validator.js";
import type { BilimOnExportRecord } from "./types/index.js";
import { MissingApiKeyError, hasApiKey, isFatalProviderError } from "./services/llm-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = join(__dirname, "..", "data", "export");
const PROCESSED_DIR = join(__dirname, "..", "data", "processed");

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { command, flags };
}

function isMock(flags: Record<string, string | boolean>): boolean {
  return Boolean(flags.mock) || process.env.PIPELINE_MOCK === "1";
}

async function cmdRun(flags: Record<string, string | boolean>) {
  const count = Number(flags.count ?? 5);
  const mock = isMock(flags);
  const brief = typeof flags.brief === "string" ? flags.brief : undefined;
  if (!mock && !hasApiKey()) {
    console.error(new MissingApiKeyError().message);
    process.exitCode = 1;
    return;
  }
  console.log(`Running pipeline: count=${count} mock=${mock}${brief ? ` brief="${brief}"` : ""}`);
  let summary;
  try {
    summary = await runPipeline({
      count,
      mock,
      brief,
      onProgress: (p) =>
        console.log(
          `progress: processed ${p.completed}/${p.total}, approved ${p.approved}, ` +
            `needs_review ${p.needsReview}, rejected ${p.rejected}, duplicates ${p.duplicates}`
        ),
    });
  } catch (err) {
    // Real production failure: an OpenRouter `APIError: 402 This request
    // would exceed your available credits` escaped a single discovery search
    // and killed the run with a multi-screen stack trace mid-discovery. A
    // provider being out of credits (or holding a bad key) is an operator
    // problem with a one-line fix, so print exactly that one line, still
    // export whatever earlier institutions completed (their state/processed
    // files are already on disk, and a rerun resumes from there), and exit
    // non-zero.
    if (isFatalProviderError(err)) {
      console.error(`\nRun stopped: ${err.info.message}`);
      const partial = finalizeExport();
      console.log(`Wrote ${partial.importPath} (records completed before the run stopped)`);
      console.log(`Wrote ${partial.reportPath}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  console.log(
    `Resolved scope (source=${summary.resolvedScope.source}): ` +
      `types=${JSON.stringify(summary.resolvedScope.types)}, ` +
      `categories=${JSON.stringify(summary.resolvedScope.categories)}` +
      (summary.resolvedScope.keywords.length ? `, keywords=${JSON.stringify(summary.resolvedScope.keywords)}` : "")
  );
  console.log(
    `Discovery+dedupe: ${summary.processedIds.length} unique candidates processed, ` +
      `${summary.duplicateIds.length} duplicates merged away.`
  );
  console.log(
    `Outcomes this run: approved=${summary.approved} needsReview=${summary.needsReview} rejected=${summary.rejected}`
  );
  if (summary.shortfall > 0) {
    console.log(
      `Shortfall: requested ${count}, approved ${summary.approved} (${summary.shortfall} short)` +
        (summary.searchExhausted ? " — search space exhausted for this scope." : " — hit the retry/cost ceiling.")
    );
  }
  const { importPath, reportPath, report } = finalizeExport();
  console.log(`Wrote ${importPath}`);
  console.log(`Wrote ${reportPath}`);
  console.log(JSON.stringify(report, null, 2));
  maybePrintImportFile(flags, importPath);
}

function cmdExport(flags: Record<string, string | boolean>) {
  const { importPath, reportPath, report } = finalizeExport();
  console.log(`Wrote ${importPath}`);
  console.log(`Wrote ${reportPath}`);
  console.log(JSON.stringify(report, null, 2));
  maybePrintImportFile(flags, importPath);
}

// On platforms with no persistent/attached storage (e.g. a bare Railway
// service container, which is destroyed on redeploy), there is no way to
// download data/export/bilimon-import.json after the run. Passing
// --print-import (or PIPELINE_PRINT_IMPORT=1) dumps its full contents to
// stdout so it's visible in the platform's deploy/run logs instead.
function maybePrintImportFile(flags: Record<string, string | boolean>, importPath: string) {
  const shouldPrint = Boolean(flags["print-import"]) || process.env.PIPELINE_PRINT_IMPORT === "1";
  if (!shouldPrint) return;
  console.log("----- BEGIN bilimon-import.json -----");
  console.log(readFileSync(importPath, "utf-8"));
  console.log("----- END bilimon-import.json -----");
}

function cmdValidate() {
  const importFile = join(EXPORT_DIR, "bilimon-import.json");
  let records: BilimOnExportRecord[] = [];
  if (existsSync(importFile)) {
    // bilimon-import.json is {version, exportedAt, institutions: [...]},
    // not a bare array — see BilimOnImportFile in src/types/index.ts.
    const parsed = JSON.parse(readFileSync(importFile, "utf-8"));
    records = Array.isArray(parsed) ? parsed : (parsed.institutions ?? []);
  } else if (existsSync(PROCESSED_DIR)) {
    records = readdirSync(PROCESSED_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(PROCESSED_DIR, f), "utf-8")));
  }
  if (records.length === 0) {
    console.log("No records found to validate. Run `pipeline run --mock` first.");
    return;
  }
  const results = validateBatch(records);
  let invalidCount = 0;
  for (const [id, result] of results) {
    if (!result.valid) {
      invalidCount++;
      console.log(`INVALID ${id}:`);
      for (const reason of result.reasons) console.log(`  - ${reason}`);
    }
  }
  console.log(`Validated ${records.length} records: ${records.length - invalidCount} valid, ${invalidCount} invalid.`);
  process.exitCode = invalidCount > 0 ? 1 : 0;
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  try {
    switch (command) {
      case "run":
        await cmdRun(flags);
        break;
      case "validate":
        cmdValidate();
        break;
      case "export":
        cmdExport(flags);
        break;
      default:
        console.log(
          'Usage: pipeline <run|validate|export> [--count N] [--mock] [--brief "<free text>"] [--print-import]'
        );
        process.exitCode = command ? 1 : 0;
    }
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

// An unhandled promise rejection out of main() prints a raw stack trace and,
// on some Node versions, a confusing "[UnhandledPromiseRejection]" crash —
// which is exactly what the user saw when a provider error escaped a real
// run. Every path out of the process now prints a readable message and sets
// a non-zero exit code.
main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Pipeline failed: ${message}`);
  if (process.env.PIPELINE_DEBUG === "1" && err instanceof Error && err.stack) {
    console.error(err.stack);
  } else {
    console.error("(set PIPELINE_DEBUG=1 for the full stack trace)");
  }
  process.exitCode = 1;
});
