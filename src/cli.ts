#!/usr/bin/env node
/**
 * CLI entrypoint.
 *
 *   pipeline run --count 5|20|500 [--mock]
 *   pipeline validate
 *   pipeline export
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPipeline, finalizeExport } from "./agents/orchestrator.js";
import { validateBatch } from "./services/validator.js";
import type { BilimOnExportRecord } from "./types/index.js";
import { MissingApiKeyError } from "./services/llm-client.js";

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
  if (!mock && !process.env.ANTHROPIC_API_KEY) {
    console.error(new MissingApiKeyError().message);
    process.exitCode = 1;
    return;
  }
  console.log(`Running pipeline: count=${count} mock=${mock}`);
  const summary = await runPipeline({ count, mock });
  console.log(
    `Discovery+dedupe: ${summary.processedIds.length} unique candidates processed, ` +
      `${summary.duplicateIds.length} duplicates merged away.`
  );
  console.log(
    `Outcomes this run: approved=${summary.approved} needsReview=${summary.needsReview} rejected=${summary.rejected}`
  );
  const { importPath, reportPath, report } = finalizeExport();
  console.log(`Wrote ${importPath}`);
  console.log(`Wrote ${reportPath}`);
  console.log(JSON.stringify(report, null, 2));
}

function cmdExport() {
  const { importPath, reportPath, report } = finalizeExport();
  console.log(`Wrote ${importPath}`);
  console.log(`Wrote ${reportPath}`);
  console.log(JSON.stringify(report, null, 2));
}

function cmdValidate() {
  const importFile = join(EXPORT_DIR, "bilimon-import.json");
  let records: BilimOnExportRecord[] = [];
  if (existsSync(importFile)) {
    records = JSON.parse(readFileSync(importFile, "utf-8"));
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
        cmdExport();
        break;
      default:
        console.log("Usage: pipeline <run|validate|export> [--count N] [--mock]");
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

main();
