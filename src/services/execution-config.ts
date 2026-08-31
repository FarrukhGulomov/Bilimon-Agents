/**
 * Loads config/execution.json — the scale/concurrency settings used when
 * running the orchestrator at large batch sizes (up to the ~500-institution
 * target). See that file's `_comment` for what each field does.
 *
 * `maxConcurrency` can be overridden per-run via the PIPELINE_MAX_CONCURRENCY
 * env var (e.g. `PIPELINE_MAX_CONCURRENCY=10 npx tsx src/cli.ts run ...`)
 * without editing the config file.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "..", "config", "execution.json");

export interface ExecutionConfig {
  maxConcurrency: number;
  progressReportEvery: number;
}

const DEFAULTS: ExecutionConfig = { maxConcurrency: 5, progressReportEvery: 5 };

let cached: ExecutionConfig | null = null;

export function loadExecutionConfig(): ExecutionConfig {
  if (cached) return cached;
  let fileConfig: Partial<ExecutionConfig> = {};
  try {
    fileConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    // Missing/unreadable config/execution.json falls back to DEFAULTS below.
  }

  const envConcurrency = Number(process.env.PIPELINE_MAX_CONCURRENCY);
  const maxConcurrency =
    Number.isFinite(envConcurrency) && envConcurrency > 0
      ? Math.floor(envConcurrency)
      : fileConfig.maxConcurrency && fileConfig.maxConcurrency > 0
        ? Math.floor(fileConfig.maxConcurrency)
        : DEFAULTS.maxConcurrency;

  const progressReportEvery =
    fileConfig.progressReportEvery && fileConfig.progressReportEvery > 0
      ? Math.floor(fileConfig.progressReportEvery)
      : DEFAULTS.progressReportEvery;

  cached = { maxConcurrency, progressReportEvery };
  return cached;
}

/** Test-only: clears the cached config so a test can re-read env/file changes. */
export function _resetExecutionConfigCache(): void {
  cached = null;
}
