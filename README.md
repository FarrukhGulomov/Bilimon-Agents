# BilimOn Agents — Multi-Agent Data Pipeline

A multi-agent pipeline that discovers, researches, enriches, localizes,
validates, and exports learning-institution data for **BilimOn**, an
education marketplace for Uzbekistan. Output is a `bilimon-import.json`
file intended for human review and manual import — this pipeline never
writes to any live BilimOn system. The pipeline runs in batches of any
size and is designed to eventually cover every learning institution
nationwide as more are discovered — there is no fixed target count.

## Schema status: REAL (as of 2026-08-31)

The schema in this repository is now derived from an **actual BilimOn
production export**, not a guess. The user supplied the real export at
`data/reference/bilimon-institutions-reference.json` — 302 real
institutions across 8 of Uzbekistan's ~14 regions — and every field name,
enum value, nullability, and city/region id below was verified directly
against it (counted, not guessed; see the verification script results
summarized here). This supersedes the old placeholder schema entirely; the
placeholder file (`src/schemas/bilimon-reference.example.json`) has been
deleted.

**Confirmed field set** (all 302 records share exactly this top-level key
set): `id, nameUz, nameRu, nameKey, slug, type, additionalTypes, status,
phone, phone2, email, website, telegram, instagram, cityId, regionId,
address, lat, lng, isVerified, trialLessonEnabled, deliveryMode, details,
pricing, media, branches` — plus `details`'s own sub-object:
`descriptionUz, descriptionRu, foundedYear, studentCount, teacherCount,
languages, programs, shifts, specializations, achievements, categories`.

**Confirmed enums** (`src/schemas/enums.ts`):
- `type` / `additionalTypes`: `LANGUAGE_CENTER`, `COURSE_CENTER`,
  `TUTORING`, `SCHOOL`, `LYCEUM` — exactly 5 values, all observed.
- `status`: `PENDING`, `ACTIVE`, `INACTIVE` — exactly 3. The old
  placeholder's guessed 4th value, `APPROVED`, does **not** appear anywhere
  in the real export and has been removed.
- `deliveryMode`: `OFFLINE` (301) and `HYBRID` (1) are confirmed; `ONLINE`
  has zero occurrences but is kept as schema-legal (not dropped) since an
  8-region sample can't prove it never occurs — `src/services/validator.ts`
  flags it for review rather than treating it as routine.
- `details.categories`: 9 real values — `LANGUAGES, SCHOOL_SUBJECTS,
  UNIVERSITY_PREP, KIDS_EDUCATION, IELTS, CEFR, SAT, IT_COURSES,
  PROFESSIONAL_CERTIFICATION` — replacing the old placeholder's 5-value guess.
- `details.languages`: lowercase codes `uz, ru, en, de` observed — treated
  as a controlled-but-extensible list (not a closed enum); an unrecognized
  code is soft-flagged for review, not hard-rejected.

**Real, non-placeholder city/region ids**: `cityId`/`regionId` are cuid
strings from BilimOn's real database (e.g.
`cmrfw8t3y000fn3og703hdh1a`), not sequential integers. `src/schemas/locations.ts`
now seeds the 9 real (city, region) pairs that appear in the export, plus
the "region known, city unspecified" case (`cityId: null`, `regionId` set —
11 real records) and the "fully unknown location" case (`cityId: null`,
`regionId: null` — 3 real records), both of which the real schema legally
allows (both fields are nullable in `src/schemas/bilimon-export.zod.ts`).

**Known coverage gap**: the reference export has zero institutions from
Navoiy, Termez/Surxondaryo, Guliston/Sirdaryo, Urganch/Xorazm, or
Nukus/Qoraqalpog'iston. `src/schemas/locations.ts` deliberately does not
invent ids for these — an institution resolving to one of these cities
routes to `NEEDS_REVIEW` with reason "city not present in known BilimOn
reference data — real cityId/regionId unconfirmed" instead of getting a
fabricated id. This is a limitation of the current reference export, not a
permanent one: extend the table the moment BilimOn supplies real ids for
the remaining regions.

**Other real-data quirks now handled** (see field-level comments in
`src/schemas/bilimon-export.zod.ts` and `src/agents/bilimon-exporter.ts`):
`phone` is `null` in 259/302 real records (not required) and 10 more have
raw messy formats (`"+998 (90) 900-79-66"`); `phone2` sometimes holds
multiple comma-separated numbers in one string; `telegram`/`instagram` are
sometimes a bare handle and sometimes a full URL (bare handle is the more
common real shape, so the pipeline's own generated data defaults to that);
`pricing` is `{monthlyMin, monthlyMax, paymentMethods: string[]}` and
non-null in only 34/302 records, replacing the old placeholder's guessed
`{min, max, currency, notes}` shape; `media` and `branches` are always `[]`
in all 302 real records, so their real per-element schema is genuinely
unconfirmed — kept as `unknown[]` rather than carrying forward an invented
shape.

**Open question for the user**: the 302 real records all carry cuid-style
`id`s (e.g. `cmrfw8t5o001an3ogocewc8g6`) that look auto-assigned on insert
rather than client-supplied — but this data export alone can't confirm
BilimOn's real import mechanism. This pipeline therefore defaults to
**not** fabricating a fake-looking cuid: exported records leave `id: null`
and rely on BilimOn's own import to assign the real id. If BilimOn's real
import instead requires a client-supplied cuid, that default needs to
change — see the doc comment on `BilimOnExportRecord.id` in
`src/types/index.ts` and `services/normalizer.ts::generateId` (the
separate, clearly `pipeline-`-prefixed id used only for this pipeline's own
internal state tracking, never written to the exported record).

## Fixtures vs. real data

`data/fixtures/mock-discovery.json` and `data/fixtures/mock-research.json`
contain **40 synthetic, clearly-fictional** Uzbekistan learning
institutions (fake names, phone numbers, addresses, websites — including
one deliberate duplicate pair) used **only** to exercise pipeline
mechanics end-to-end without live network/API access, at a scale large
enough to visibly exercise the concurrency limiter and progress reporting
described below. They are explicitly labeled `_FIXTURE_NOTICE` at the top
of each file. **Never** treat fixture data as real discovered
institutions, and never let it reach a real BilimOn import — `--mock`
mode output is for pipeline testing only.

## Architecture

```
Orchestrator (src/agents/orchestrator.ts)
  │
  ├─ Discovery agent        → raw candidates (live web search, or --mock fixtures)
  ├─ Deduplicator service   → deterministic name/phone/domain/social matching
  │                            + AI-assisted fallback for ambiguous cases
  ├─ Concurrency limiter    → caps how many institutions run the two stages below
  │  (services/concurrency.ts) at once (config/execution.json maxConcurrency)
  ├─ Researcher agent       → per-institution evidence (scrape+extract, or --mock fixtures)
  ├─ Content Manager agent  → natural Uzbek/Russian descriptions from verified facts only
  ├─ BilimOn Exporter agent → maps merged fields → real BilimOn schema
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
`data/cache/<sha256-of-url>.json`. This still holds with the concurrency
limiter in place — verified by actually running `--mock` batches partway
(e.g. `--count 20` then `--count 40`) and confirming the first batch's
outcomes are unchanged and only the newly-added institutions are
processed on the second run.

### Scaling to nationwide coverage: concurrency, progress, token tracking

These three pieces exist to make a future large real batch run
operationally sane, run after run, as the pipeline scales up toward
covering every learning institution nationwide (there is no fixed target
count — 500 was only ever an initial milestone, not a ceiling). They do
not themselves unblock a real run (see the "Current status" section below
— the OpenAI-API-access blocker is unchanged; the schema blocker is now
resolved, see "Schema status" above).

- **Concurrency control.** The Researcher and Content Manager stages are
  the LLM-call-heavy part of the pipeline, so the orchestrator processes
  institutions through them with a bounded number in flight at once
  instead of firing every institution's LLM calls simultaneously. This is
  a plain async worker-pool (`services/concurrency.ts::runWithConcurrency`)
  — no new dependency, no real threads, just N async "workers" pulling the
  next item off a shared cursor. The limit comes from
  `config/execution.json`'s `maxConcurrency` (default `5`), overridable
  per-run via `PIPELINE_MAX_CONCURRENCY` (e.g.
  `PIPELINE_MAX_CONCURRENCY=10 npx tsx src/cli.ts run --count 200`)
  without editing the config file. Per-institution state/processed/review
  files are independent, so running several institutions concurrently is
  safe with no locking needed.
- **Progress reporting.** `pipeline run` prints a running progress line —
  `progress: processed 42/200, approved 30, needs_review 8, rejected 4,
  duplicates 6` — every `config/execution.json`'s `progressReportEvery`
  completions (default every 5) and always once more at the end of the
  batch, instead of only printing a final summary. Useful for a
  long-running batch a human is watching in a terminal. `runPipeline()`
  exposes this via an optional `onProgress` callback (`RunOptions`); the
  CLI (`src/cli.ts`) is what actually prints it, keeping the orchestrator
  itself free of console output, consistent with the existing split.
- **Cost/token tracking (best-effort placeholder).** `services/llm-client.ts`
  now accumulates `input_tokens`/`output_tokens` from OpenAI's Responses
  API `usage` field (when the API returns it) across all real LLM calls in
  a process, and `report.json` includes the running total as
  `estimatedTokenUsage: { inputTokens, outputTokens, calls }`. This is
  **token counts only — deliberately no dollar figure**, since OpenAI
  pricing isn't verified anywhere in this codebase and would go stale the
  moment it was written down; compute actual cost yourself against
  https://platform.openai.com/docs/pricing for whichever `OPENAI_MODEL`
  you run with. `--mock` mode makes no LLM calls, so `estimatedTokenUsage`
  is always `{0, 0, 0}` there — this has been exercised (see validation
  below), but the real (non-mock) accumulation itself has **not** been
  exercised against a live API in this build environment, same caveat as
  the rest of the real-mode code paths.

### Directory structure

```
src/
  types/            internal pipeline record types + BilimOn export type
  schemas/          REAL BilimOn schema, enum registry, zod validator, location seed table
  agents/           orchestrator, discovery, researcher, content-manager, bilimon-exporter
  services/         search, scraper, extractor, deduplicator, normalizer, validator,
                     location-mapper, scoring, llm-client (OpenAI SDK wrapper)
  cli.ts            `pipeline run|validate|export`

config/
  thresholds.json           score cutoffs for the quality gate
  priority-categories.json  discovery priority order
  execution.json            maxConcurrency / progressReportEvery for large batches (see below)

data/
  reference/   the real BilimOn production export (bilimon-institutions-reference.json,
               302 institutions) this schema is derived from — read-only ground truth,
               never written to and never the source of bilimon-import.json's contents
  fixtures/    synthetic mock-discovery.json / mock-research.json (tracked in git)
  discovered/, research/, processed/, review/, rejected/, export/, state/, cache/
               (real run output — gitignored except .gitkeep)
```

## How to run

```bash
npm install

# Mock mode — no API key needed, fully deterministic, safe to run anywhere:
npx tsx src/cli.ts run --count 5 --mock
npx tsx src/cli.ts run --count 40 --mock
npx tsx src/cli.ts validate
npx tsx src/cli.ts export

# Real mode — requires OPENAI_API_KEY (copy .env.example to .env first).
# --count N is an arbitrary batch size, not a fixed target — run repeatedly
# in whatever batch sizes suit your budget/schedule as coverage grows:
export OPENAI_API_KEY=sk-...
npx tsx src/cli.ts run --count 200

# Optional: override the concurrency cap for a large real run without
# editing config/execution.json:
PIPELINE_MAX_CONCURRENCY=10 npx tsx src/cli.ts run --count 200
```

- `--mock` (or `PIPELINE_MOCK=1`) makes Discovery and the Researcher read
  from `data/fixtures/*` instead of calling the LLM/web search — no
  `OPENAI_API_KEY` needed. This is the only path validated by actually
  running it in this build environment.
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
- Real (non-mock) LLM calls go through OpenAI's Responses API
  (`src/services/llm-client.ts`) and default to model `gpt-5.1`,
  overridable via `OPENAI_MODEL`. **Model name caveat:** `gpt-5.1` is the
  most reliably-corroborated current-generation OpenAI model id at the
  time this was written (resolved from an actual OpenAI docs page); other
  candidates surfaced by live search at the time (a claimed "GPT-5.6
  Sol/Terra/Luna" lineup, and a separately-glimpsed "gpt-5.5"/"gpt-5.5-pro"
  docs page) were not adopted as the default — the former because it
  wasn't corroborated by any real OpenAI docs page and doesn't match
  OpenAI's naming conventions, the latter because it was only
  single-sourced at the time. **Model names change frequently and this
  default may already be stale** — check
  https://platform.openai.com/docs/models for the actual current flagship
  model id before running a real (non-mock) discovery/research pass, and
  set `OPENAI_MODEL` accordingly rather than trusting the shipped default.
  Missing `OPENAI_API_KEY` produces a clear, actionable error message
  rather than an opaque crash.
- Live web discovery uses OpenAI's hosted `web_search` Responses API tool
  (`{ type: "web_search" }`), confirmed present in the installed `openai`
  npm package's (v7.8.0) bundled type definitions. This is wired the same
  way the pipeline's prior Anthropic `web_search_20250305` integration
  was — declare the tool, let the model search and answer in one call —
  but has not been exercised against the live OpenAI API in this build
  environment (no network/API key here); if a future SDK version renames
  or drops this tool, the call will surface a clear API error rather than
  silently returning nothing, and there is no separate SERP-API fallback
  wired in.

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

This delivery is **pipeline infrastructure, now schema-verified against
real BilimOn production data, plus a validated mock end-to-end run** — it
is not yet a completed real-data import. Status of the two original
blockers:

- **Real schema ✅ resolved.** The schema, enums, and city/region ids are
  now derived from and verified against the actual 302-record BilimOn
  export (see "Schema status: REAL" above) — this is no longer a blocker.
  One open question remains (the `id` field convention) for the user to
  confirm with the real BilimOn backend/import mechanism.
- **Real city/region ids for 8 of ~14 regions ✅.** Navoiy,
  Termez/Surxondaryo, Guliston/Sirdaryo, Urganch/Xorazm, and
  Nukus/Qoraqalpog'iston have no real ids yet (see the coverage-gap note
  above) — institutions there correctly route to `NEEDS_REVIEW` rather
  than getting a fabricated id, pending BilimOn supplying real ids for the
  remaining regions.
- **`OPENAI_API_KEY` ⏳ not yet available.** The user does not have an
  OpenAI token set up yet and will add one later — this pipeline has
  deliberately not been run in real (non-mock) mode.
- **Live discovery/research ⏳ blocked on the API key above,** not on
  anything else. Once a key is available: (a) confirm the current
  flagship OpenAI model id against https://platform.openai.com/docs/models
  (see the model-name caveat below — `gpt-5.1` is a best-effort default,
  not a verified-current one), and (b) decide how heavily to lean on
  OpenAI's hosted `web_search` Responses API tool vs. supplementing with a
  dedicated SERP API for coverage/cost. The real-mode code paths
  (`services/search.ts`, `services/scraper.ts` live fetch,
  `services/extractor.ts`, live `content-manager.ts`,
  `deduplicator.ts::isAmbiguousDuplicate`) are structurally complete and
  isolated from the mock paths, but have **not been exercised by
  execution** in this build environment (no outbound network / API key
  available) — only `--mock` mode has been run and validated end-to-end.
- Pricing (`pricing` field), media, and `branches` are left as
  null/empty-array throughout the pipeline's own output — the
  researcher/extractor don't yet attempt to find pricing or multi-branch
  data. This is no longer "expectations unknown" (pricing's real shape is
  now confirmed — see "Schema status" above) but simply not yet
  implemented as a research target.
- The concurrency limiter, progress reporting, and token-usage accumulator
  are **scaffolding for a future large real batch run** (there is no
  fixed target count — see the top of this README), not a resolution of
  the API-key blocker above. They have only ever been exercised via
  `--mock` mode (no LLM calls happen there, so `estimatedTokenUsage` is
  always `{0, 0, 0}` in every mock run) — the concurrency limiter has
  never actually throttled real concurrent OpenAI calls, and the token
  accumulator's real-mode wiring (reading `response.usage` off an actual
  Responses API call) has not been exercised against a live API in this
  build environment.

### What has been validated (see below for exact commands/results)

- All 302 real records in
  `data/reference/bilimon-institutions-reference.json` parse successfully
  against the new `BilimOnExportRecordZ` zod schema — the actual proof the
  schema now matches reality, not just the field-by-field verification
  notes above.
- `pipeline run --count 5 --mock` end-to-end: DISCOVERED → ... →
  APPROVED/NEEDS_REVIEW, valid `bilimon-import.json` + `report.json`
  against the real schema.
- `pipeline run --count 40 --mock` (39 unique institutions after dedupe
  collapses one deliberate duplicate pair) end-to-end, with the
  concurrency limiter and periodic `progress: processed X/Y, ...` lines
  both visibly exercised across the full batch, and 5 fixture institutions
  from cities outside the real export's 8-region coverage (Navoiy, Termez,
  Nukus, Guliston, Urganch) correctly routing to `NEEDS_REVIEW` instead of
  getting a fabricated cityId/regionId.
- Resumability with the concurrency code: `pipeline run --count 5 --mock`
  followed by `pipeline run --count 40 --mock` (simulating an interrupted
  job resumed with a larger target count) — confirmed the first batch's
  outcomes were unchanged and only the newly-added institutions were
  processed, and that re-running the same `--count` twice in a row is a
  no-op on outcomes (idempotency unaffected by the concurrency changes).
- `PIPELINE_MAX_CONCURRENCY=1` override confirmed to take effect (env var
  takes priority over `config/execution.json`).
- `npm test`: 37 assertions covering slug determinism (including two real
  examples from the reference export, "King's Academy" → `kings-academy`
  and "Najot Ta'lim" → `najot-talim`), phone validation, dedupe collapse,
  enum rejection, real city-alias resolution (including the coverage-gap
  cities correctly resolving to `null` rather than a fabricated id),
  `cityId:null`/`regionId:null` being accepted as legal, the real pricing
  shape being accepted and the old placeholder pricing shape being
  rejected, the concurrency limiter's in-flight cap/ordering/edge cases,
  and the token-usage accumulator's summing/reset/no-op-on-missing-usage
  behavior — all passing.
- `npm run build` (`tsc`): clean, no errors.
