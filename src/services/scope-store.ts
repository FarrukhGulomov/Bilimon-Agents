/**
 * Tiny on-disk persistence for the most recently resolved DiscoveryScope
 * (src/services/brief-parser.ts), so `pipeline export`/`finalizeExport()` —
 * which itself takes no --brief — can still record in report.json which
 * brief/scope produced the current batch of results. Kept as its own module
 * (rather than living in orchestrator.ts or bilimon-exporter.ts) so the two
 * don't end up importing each other.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DiscoveryScope } from "./brief-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = join(__dirname, "..", "..", "data", "export");
const LAST_SCOPE_PATH = join(EXPORT_DIR, "last-scope.json");

/** Persists the resolved DiscoveryScope from the most recent `pipeline run`. */
export function persistLastScope(scope: DiscoveryScope): void {
  if (!existsSync(EXPORT_DIR)) mkdirSync(EXPORT_DIR, { recursive: true });
  writeFileSync(LAST_SCOPE_PATH, JSON.stringify(scope, null, 2), "utf-8");
}

/** Reads back the last-persisted DiscoveryScope, or null if no run has ever
 * persisted one (e.g. a fresh checkout's first `pipeline export`). */
export function readLastScope(): DiscoveryScope | null {
  if (!existsSync(LAST_SCOPE_PATH)) return null;
  return JSON.parse(readFileSync(LAST_SCOPE_PATH, "utf-8")) as DiscoveryScope;
}
