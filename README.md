# BilimOn Agents — Multi-Agent Data Pipeline

A multi-agent pipeline that discovers, researches, enriches, localizes,
validates, and exports learning-institution data for **BilimOn**, an
education marketplace for Uzbekistan. Output is a `bilimon-import.json`
file intended for human review and manual import — this pipeline never
writes to any live BilimOn system.

## ⚠️ Critical caveat: PLACEHOLDER schema

**No real BilimOn reference JSON, schema export, or codebase was available
when this pipeline was built.** Every schema field, enum value, and
city/region id in this repository is a **best-guess placeholder** derived
only from the example JSON shape given in the build spec — not the
authoritative BilimOn schema. This is called out at the top of every file
that defines it:

- `src/schemas/bilimon-reference.example.json` — the placeholder reference record
- `src/schemas/enums.ts` — placeholder enum registry (some values CONFIRMED
  by the example, others flagged PLACEHOLDER GUESS)
- `src/schemas/locations.ts` — placeholder Uzbekistan city/region ids
- `src/schemas/bilimon-export.zod.ts` — zod validator mirroring the placeholder shape

**Do not use this pipeline's output for a real import until the real
schema has been substituted.**

### Swapping in the real schema

1. Replace `src/schemas/bilimon-reference.example.json` with a real,
   authentic BilimOn institution record (or the real schema/OpenAPI/Prisma/SQL
   definition, if that's what's available).
2. Update `src/schemas/enums.ts` to match the real enum members exactly
   (do not keep any placeholder value that isn't confirmed real).
3. Update `src/types/index.ts` (`BilimOnExportRecord` and friends) and
   `src/schemas/bilimon-export.zod.ts` to match the real field names,
   types, and nesting.
4. Replace the placeholder `cityId`/`regionId` values in
   `src/schemas/locations.ts` with BilimOn's real ids for each city/region.
5. Re-run `npm run build` and `npm test` — the agents in `src/agents/*`
   and services in `src/services/*` are written generically against the
   types/schema files, not against hardcoded field names, so this should
   be a schema-and-types change, not an agent-logic rewrite.
6. Re-review `config/thresholds.json` and `config/priority-categories.json`
   against real BilimOn product requirements.

## Fixtures vs. real data

`data/fixtures/mock-discovery.json` and `data/fixtures/mock-research.json`
contain **synthetic, clearly-fictional** Uzbekistan learning institutions
(fake names, phone numbers, addresses, websites) used **only** to exercise
pipeline mechanics end-to-end without live network/API access. They are
explicitly labeled `_FIXTURE_NOTICE` at the top of each file. **Never**
treat fixture data as real discovered institutions, and never let it reach
a real BilimOn import — `--mock` mode output is for pipeline testing only.

## Architecture

```
Orchestrator (src/agents/orchestrator.ts)
  │
  ├─ Discovery agent        → raw candidates (live web search, or --mock fixtures)
  ├─ Deduplicator service   → deterministic name/phone/domain/social matching
  │                            + AI-assisted fallback for ambiguous cases
  ├─ Researcher agent       → per-institution evidence (scrape+extract, or --mock fixtures)
  ├─ Content Manager agent  → natural Uzbek/Russian descriptions from verified facts only
  ├─ BilimOn Exporter agent → maps merged fields → placeholder BilimOn schema
  ├─ Scoring service        → sourceConfidence / dataCompleteness / qualityScore
  └─ Validator service      → schema + enum + required-field + batch-uniqueness checks
                               → quality gate: APPROVED / NEEDS_REVIEW / REJECTED
```

Per-institution state is tracked in `data/state/<id>.json` through the
states `DISCOVERED → RESEARCHING → VERIFIED → CONTENT_READY → JSON_READY →
APPROVED | NEEDS_REVIEW | REJECTED`. Re-running `pipeline run` is
idempotent: institutions already in a terminal state (`APPROVED` /
`NEEDS_REVIEW` / `REJECTED`) are skipped rather than reprocessed, and
`services/scraper.ts` never refetches a URL already cached under
`data/cache/<sha256-of-url>.json`.

### Directory structure

```
src/
  types/            internal pipeline record types + BilimOn export type
  schemas/          placeholder BilimOn schema, enum registry, zod validator, location seed table
  agents/           orchestrator, discovery, researcher, content-manager, bilimon-exporter
  services/         search, scraper, extractor, deduplicator, normalizer, validator,
                     location-mapper, scoring, llm-client (Anthropic SDK wrapper)
  cli.ts            `pipeline run|validate|export`

config/
  thresholds.json           score cutoffs for the quality gate
  priority-categories.json  discovery priority order

data/
  fixtures/    synthetic mock-discovery.json / mock-research.json (tracked in git)
  discovered/, research/, processed/, review/, rejected/, export/, state/, cache/
               (real run output — gitignored except .gitkeep)
```

## How to run

```bash
npm install

# Mock mode — no API key needed, fully deterministic, safe to run anywhere:
npx tsx src/cli.ts run --count 5 --mock
npx tsx src/cli.ts run --count 20 --mock
npx tsx src/cli.ts validate
npx tsx src/cli.ts export

# Real mode — requires ANTHROPIC_API_KEY (copy .env.example to .env first):
export ANTHROPIC_API_KEY=sk-ant-...
npx tsx src/cli.ts run --count 500
```

- `--mock` (or `PIPELINE_MOCK=1`) makes Discovery and the Researcher read
  from `data/fixtures/*` instead of calling the LLM/web search — no
  `ANTHROPIC_API_KEY` needed.
- `pipeline run --count N` discovers up to N raw candidates (fixture rows
  in mock mode, live search results in real mode), dedupes them, runs them
  through research → content → export → scoring, and writes
  `data/export/bilimon-import.json` (APPROVED records only) and
  `data/export/report.json`.
- `pipeline validate` re-validates `data/export/bilimon-import.json` (or,
  if absent, everything under `data/processed/`) against
  `src/services/validator.ts` and exits non-zero on any invalid record.
- `pipeline export` re-derives `bilimon-import.json`/`report.json` from
  the current `data/state/`+`data/processed/` contents without re-running
  discovery/research.
- Real (non-mock) LLM calls use model `claude-sonnet-5` by default,
  overridable via `ANTHROPIC_MODEL`. Missing `ANTHROPIC_API_KEY` produces
  a clear, actionable error message rather than an opaque crash.

Run the unit tests with `npm test` (plain tsx script, no framework):

```bash
npm test
```

## Production safety notes

- This pipeline **never** writes to any live BilimOn system, API, or
  database. Its only output is local JSON files under `data/export/` for
  human review and manual import.
- `data/discovered/`, `data/research/`, `data/processed/`, `data/review/`,
  `data/rejected/`, `data/export/`, `data/state/`, and `data/cache/` are
  gitignored (except `.gitkeep`) so real scraped/research data from a
  live run is never accidentally committed. `data/fixtures/` is the one
  tracked exception, since it's synthetic test data.
- The Content Manager never invents facts: it only draws on fields the
  Researcher marked as coming from real evidence, forbids superlative/
  ranking claims unless the evidence itself supports them, and leaves
  descriptions `null` (flagging the record for review) rather than
  padding with generic filler when source material is too sparse.
- Enum values are validated strictly — an unrecognized enum value is
  never silently accepted; it routes the record to `NEEDS_REVIEW`.

## Cost optimization notes

- Everything deterministic is plain code, not an LLM call: name/phone/URL
  normalization, slug/id generation, deterministic dedupe matching
  (name+city / phone / domain / social handle), location resolution,
  scoring, and schema/enum validation (`src/services/*.ts`).
- LLM calls are reserved for genuinely ambiguous or generative work: live
  web discovery/research (`services/search.ts`, `services/extractor.ts`),
  AI-assisted dedupe fallback for near-duplicate names with no shared
  phone/domain (`services/deduplicator.ts::isAmbiguousDuplicate`), and
  bilingual content generation (`agents/content-manager.ts`) — and even
  content generation is skipped entirely (no LLM call) when there isn't
  enough source material to write a real description.
- `services/scraper.ts` caches every fetched page under
  `data/cache/<sha256-of-url>.json` and never refetches a cached URL, and
  `data/research/<id>.json` evidence files are append-only (deduped by
  source URL) so re-running research for an already-researched
  institution costs nothing.
- The orchestrator's idempotent state machine means a re-run of
  `pipeline run` after a partial failure only pays for the institutions
  that haven't yet reached a terminal state.

## Current status / what's NOT done yet

This delivery is **pipeline infrastructure plus a validated mock
end-to-end run** — it is not a completed real-data import. Specifically
NOT done:

- **Live discovery of the real ~500 target institutions has not been
  run.** It requires (a) the real BilimOn reference schema (see the
  caveat above), (b) a live `ANTHROPIC_API_KEY` with real search/LLM
  budget, and (c) a decision on how heavily to lean on Anthropic's
  server-side `web_search` tool vs. supplementing with a dedicated SERP
  API for coverage/cost.
- The real-mode code paths (`services/search.ts`, `services/scraper.ts`
  live fetch, `services/extractor.ts`, live `content-manager.ts`,
  `deduplicator.ts::isAmbiguousDuplicate`) are structurally complete and
  isolated from the mock paths, but were **not exercised by execution**
  in this build environment (no outbound network / API key available) —
  only `--mock` mode has been run and validated end-to-end.
- Pricing (`pricing` field), media, and `branches` are left as empty/null
  placeholders throughout — the researcher/extractor don't yet attempt to
  find pricing or multi-branch data, since the real schema's expectations
  for those fields are unknown.

### What has been validated (see below for exact commands/results)

- `pipeline run --count 5 --mock` end-to-end: DISCOVERED → ... →
  APPROVED/NEEDS_REVIEW, valid `bilimon-import.json` + `report.json`.
- `pipeline run --count 21 --mock` (20 unique institutions after dedupe
  collapses one deliberate duplicate pair) end-to-end, plus a second run
  confirming idempotency (no reprocessing, no duplicate export entries).
- `npm test`: 19 assertions covering slug determinism, phone validation,
  dedupe collapse, enum rejection, and city-alias resolution — all
  passing.
