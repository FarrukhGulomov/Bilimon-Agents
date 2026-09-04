/**
 * Minimal plain-node/tsx test runner (no test framework). Asserts:
 *  - slug generation is deterministic, and matches the real BilimOn export's
 *    own slug convention for two real examples (King's Academy, Najot Ta'lim)
 *  - phone normalization rejects malformed numbers
 *  - dedupe collapses the known Cambridge duplicate pair
 *  - validator rejects an unknown enum value
 *  - validator accepts the real (cityId:null, regionId:null) location case
 *  - validator accepts the real pricing shape and rejects the old
 *    placeholder pricing shape
 *  - location-mapper resolves Tashkent/Toshkent/Ташкент to the same real cityId
 *  - location-mapper does NOT invent an id for a city outside the real
 *    reference export's 8-region coverage (e.g. Nukus/Qoraqalpog'iston)
 *  - runWithConcurrency caps in-flight work at `limit` and preserves order
 *  - llm-client's token usage accumulator sums input/output tokens per call
 *  - real-mode evidence confidence varies with source kind, detail and
 *    corroboration (the old hardcoded 0.6 pinned every real run at
 *    sourceConfidence=52 and made APPROVED unreachable)
 *  - a well-researched institution reaches APPROVED while a thin one stays
 *    in NEEDS_REVIEW
 *  - discovery maps a full search profile (website/socials/phone/address)
 *    onto the candidate instead of just a link
 *  - the content manager's "enough material" gate accepts any real fact set,
 *    not only descriptionSourceText
 *  - provider errors (401/402/403/429) are classified into one actionable
 *    line, and only the genuinely fatal ones stop a run
 *
 * Run with: npm test  (== tsx test/run-all.ts)
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { slugify, normalizePhone, generateId, generateDuplicateBookkeepingId, generateBilimonRecordId, normalizeNameKey, normalizeLanguages, normalizeLanguageCode } from "../src/services/normalizer.js";
import { resolveCity } from "../src/services/location-mapper.js";
import { deterministicDedupe } from "../src/services/deduplicator.js";
import { validateRecord, validateBatch } from "../src/services/validator.js";
import {
  isBlockedIp,
  isRedirectStatus,
  resolveRedirectTarget,
  capChunks,
} from "../src/services/scraper.js";
import { BilimOnExportRecordZ } from "../src/schemas/bilimon-export.zod.js";
import { runWithConcurrency } from "../src/services/concurrency.js";
import {
  getTokenUsage,
  resetTokenUsage,
  recordUsage,
  coerceToResultArray,
  coerceToArray,
  getProvider,
  getModel,
  hasApiKey,
  classifyProviderError,
  handleProviderError,
  isFatalProviderError,
} from "../src/services/llm-client.js";
import { resolveBriefHeuristic, loadDefaultScope, resolveBrief } from "../src/services/brief-parser.js";
import { discoverMock, mapSearchResultToCandidate, mapKursi24ListingToCandidate } from "../src/agents/discovery.js";
import { parseKursi24DetailPage, inferCategoriesFromLabels, inferTypesFromLabels } from "../src/services/kursi24.js";
import { buildScopeInstruction } from "../src/services/search.js";
import { assessContentMaterial } from "../src/agents/content-manager.js";
import { classifySourceUrl, normalizeResearchFields, scoreEvidenceItems } from "../src/agents/researcher.js";
import {
  computeDataCompleteness,
  computeEvidenceConfidence,
  computeSourceConfidence,
  countCorroboratedFields,
  scoreInstitution,
} from "../src/services/scoring.js";
import type { EvidenceItem, RawExtractedFields } from "../src/types/index.js";
import { buildExportRecord, exportFinalArtifacts } from "../src/agents/bilimon-exporter.js";
import { detectNonEducationalOrg } from "../src/services/relevance-filter.js";
import { resolveExportIdentity, dedupeCandidates, maxTotalRaw, buildResultRow, runPipeline } from "../src/agents/orchestrator.js";
import { selectResearchEvidenceSource } from "../src/agents/researcher.js";
import { parseRunRequest } from "../src/server.js";
import type { BilimOnExportRecord, StateRecord } from "../src/types/index.js";
import type { DiscoveryCandidate } from "../src/agents/discovery.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_STATE_DIR = join(__dirname, "..", "data", "state");
const DATA_PROCESSED_DIR = join(__dirname, "..", "data", "processed");
const DATA_REVIEW_DIR = join(__dirname, "..", "data", "review");

const REAL_TASHKENT_CITY_ID = "cmrfw8t3y000fn3og703hdh1a";
const REAL_TASHKENT_REGION_ID = "cmrfw8t2z0000n3ogoka95589";

let pass = 0;
let fail = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    pass++;
    console.log(`  ok - ${message}`);
  } else {
    fail++;
    console.error(`  FAIL - ${message}`);
  }
}

console.log("1. Slug generation is deterministic");
{
  const a = slugify("Cambridge Learning Center", "Tashkent");
  const b = slugify("Cambridge Learning Center", "Tashkent");
  assert(a === b, "slugify() returns the same slug for the same input across calls");
  assert(a === "cambridge-learning-center-tashkent", `slug matches expected form (got "${a}")`);
  const id1 = generateId(normalizeNameKey("Cambridge Learning Center"), "Tashkent");
  const id2 = generateId(normalizeNameKey("Cambridge Learning Center"), "Tashkent");
  assert(id1 === id2, "generateId() is deterministic given the same name+city");
  assert(
    id1.startsWith("pipeline-") && !/^c[a-z0-9]{24}$/.test(id1),
    "generateId() uses a clearly-prefixed pipeline-internal scheme, never a cuid-lookalike"
  );

  // Two real examples from data/reference/bilimon-institutions-reference.json:
  // confirm our slug generator matches BilimOn's own real slug convention.
  const kingsSlug = slugify("King's Academy");
  assert(kingsSlug === "kings-academy", `"King's Academy" slugifies to the real convention (got "${kingsSlug}")`);
  const najotSlug = slugify("Najot Ta'lim");
  assert(najotSlug === "najot-talim", `"Najot Ta'lim" slugifies to the real convention (got "${najotSlug}")`);
}

console.log("2. Phone normalization rejects malformed numbers");
{
  const good = normalizePhone("+998 90 123 45 67");
  assert(good.valid && good.normalized === "+998901234567", "valid UZ number normalizes to +998XXXXXXXXX");
  const bareNational = normalizePhone("901234567");
  assert(bareNational.valid && bareNational.normalized === "+998901234567", "bare 9-digit number is accepted and prefixed");
  const tooShort = normalizePhone("+99890123");
  assert(!tooShort.valid, "too-short number is rejected");
  const leadingZero = normalizePhone("0901234567");
  assert(!leadingZero.valid, "leading-0 local format without country code is rejected");
  const garbage = normalizePhone("call us maybe");
  assert(!garbage.valid, "non-numeric garbage is rejected");
  const empty = normalizePhone("");
  assert(!empty.valid, "empty string is rejected");
}

console.log("3. Dedupe collapses the known Cambridge duplicate pair");
{
  const groups = deterministicDedupe([
    {
      id: "cambridge-lc",
      name: "Cambridge Learning Center Tashkent",
      city: "Tashkent",
      phone: "+998 90 123 45 67",
      website: "https://cambridge-lc-example.uz",
    },
    {
      id: "cambridge-lc-dup",
      name: "Cambridge LC",
      city: "Toshkent",
      phone: "+998901234567",
      website: "https://cambridge-lc-example.uz/",
    },
    {
      id: "unrelated",
      name: "Orient IELTS Academy",
      city: "Tashkent",
      phone: "+998902221133",
      website: "https://orient-ielts-example.uz",
    },
  ]);
  assert(groups.length === 1, `exactly one dedupe group formed (got ${groups.length})`);
  const group = groups[0];
  assert(
    new Set([group.keptId, ...group.mergedIds]).size === 2 &&
      [group.keptId, ...group.mergedIds].includes("cambridge-lc") &&
      [group.keptId, ...group.mergedIds].includes("cambridge-lc-dup"),
    "the Cambridge Learning Center / Cambridge LC pair is grouped together"
  );
  assert(
    !([group.keptId, ...group.mergedIds].includes("unrelated")),
    "the unrelated institution is not merged into the Cambridge group"
  );
}

console.log("4. Validator rejects an unknown enum value");
{
  const base: BilimOnExportRecord = {
    id: "test-inst",
    nameUz: "Test Instituti",
    nameRu: "Тест Институт",
    nameKey: "test institute",
    slug: "test-inst",
    type: "LANGUAGE_CENTER",
    additionalTypes: [],
    status: "PENDING",
    phone: "+998901234567",
    phone2: null,
    email: null,
    website: null,
    telegram: null,
    instagram: null,
    cityId: REAL_TASHKENT_CITY_ID,
    regionId: REAL_TASHKENT_REGION_ID,
    address: "Test address",
    lat: null,
    lng: null,
    isVerified: false,
    trialLessonEnabled: false,
    deliveryMode: "OFFLINE",
    details: {
      descriptionUz: "Bu yerda test tavsifi bor.",
      descriptionRu: null,
      foundedYear: null,
      studentCount: null,
      teacherCount: null,
      languages: ["uz"],
      programs: [],
      shifts: [],
      specializations: [],
      achievements: null,
      categories: ["LANGUAGES"],
    },
    pricing: null,
    media: [],
    branches: [],
  };
  const validResult = validateRecord(base);
  assert(validResult.valid, `a well-formed record validates cleanly (reasons: ${validResult.reasons.join(", ")})`);

  const badEnum = { ...base, type: "NOT_A_REAL_TYPE" as any };
  const badResult = validateRecord(badEnum);
  assert(!badResult.valid, "a record with an unrecognized `type` enum value is rejected");
  assert(
    badResult.reasons.some((r) => r.toLowerCase().includes("type")),
    "rejection reasons mention the offending `type` field"
  );

  const badCity = { ...base, cityId: "not-a-real-cuid" };
  const badCityResult = validateRecord(badCity);
  assert(!badCityResult.valid, "a record with an unknown cityId is rejected");

  // Real schema case: cityId:null AND regionId:null is legal (3/302 real
  // records — "fully unknown location"), not a validation failure.
  const fullyUnknownLocation = { ...base, cityId: null, regionId: null };
  const fullyUnknownResult = validateRecord(fullyUnknownLocation);
  assert(
    fullyUnknownResult.valid,
    `cityId:null + regionId:null is accepted as legal per the real schema (reasons: ${fullyUnknownResult.reasons.join(", ")})`
  );

  // Real pricing shape (monthlyMin/monthlyMax/paymentMethods) is accepted...
  const realPricing = {
    ...base,
    pricing: { monthlyMin: 500000, monthlyMax: 1200000, paymentMethods: ["Payme", "Click"] },
  };
  const realPricingParsed = BilimOnExportRecordZ.safeParse(realPricing);
  assert(realPricingParsed.success, "the real pricing shape {monthlyMin, monthlyMax, paymentMethods} parses successfully");

  // ...while the OLD placeholder pricing shape ({min,max,currency,notes}) is rejected.
  const placeholderPricing = {
    ...base,
    pricing: { min: 500000, max: 1200000, currency: "UZS", notes: null },
  };
  const placeholderPricingParsed = BilimOnExportRecordZ.safeParse(placeholderPricing);
  assert(!placeholderPricingParsed.success, "the old placeholder pricing shape {min,max,currency,notes} is rejected");
}

console.log("5. Location-mapper resolves Tashkent/Toshkent/Ташкент to the same cityId");
{
  const a = resolveCity("Tashkent");
  const b = resolveCity("Toshkent");
  const c = resolveCity("Ташкент");
  assert(!!a && !!b && !!c, "all three spellings resolve to a known city");
  assert(
    a!.cityId === b!.cityId && b!.cityId === c!.cityId,
    `all three spellings resolve to the same cityId (got ${a?.cityId}, ${b?.cityId}, ${c?.cityId})`
  );
  const unknown = resolveCity("Nonexistentburg");
  assert(unknown === null, "an unrecognized city name resolves to null rather than guessing");

  // Real coverage gap: the 302-record reference export has zero institutions
  // in Nukus/Qoraqalpog'iston (and Navoiy, Termez, Guliston, Urganch) — these
  // must NOT resolve to a fabricated id; the exporter routes them to
  // NEEDS_REVIEW instead (see agents/bilimon-exporter.ts).
  const nukus = resolveCity("Nukus");
  assert(nukus === null, "Nukus/Qoraqalpog'iston (not in the real reference export) resolves to null, not a fabricated id");
  const termez = resolveCity("Termez");
  assert(termez === null, "Termez/Surxondaryo (not in the real reference export) resolves to null, not a fabricated id");
}

console.log("6. runWithConcurrency caps in-flight work and preserves per-item results");
{
  await (async () => {
    const limit = 3;
    let inFlight = 0;
    let maxObservedInFlight = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    const results = await runWithConcurrency({
      items,
      limit,
      worker: async (item) => {
        inFlight++;
        maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
        // Yield control so other queued workers actually get a chance to
        // start concurrently (otherwise a synchronous worker would never
        // let concurrency exceed 1 regardless of `limit`).
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return item * 2;
      },
    });
    assert(maxObservedInFlight <= limit, `never more than ${limit} items in flight (observed ${maxObservedInFlight})`);
    assert(maxObservedInFlight === limit, `concurrency actually reaches the configured limit (observed ${maxObservedInFlight})`);
    assert(
      results.every((r, i) => r === items[i] * 2),
      "results[i] corresponds to items[i] regardless of completion order"
    );

    let settledCount = 0;
    await runWithConcurrency({
      items: [1, 2, 3],
      limit: 10, // limit larger than items.length should not throw or hang
      worker: async (item) => item,
      onSettled: () => settledCount++,
    });
    assert(settledCount === 3, "onSettled fires once per item even when limit exceeds item count");

    const emptyResults = await runWithConcurrency({ items: [], limit: 5, worker: async (x) => x });
    assert(emptyResults.length === 0, "an empty items array resolves immediately with an empty result array");

    // shouldStop: used by discoverLive to bound wall-clock time/cost once
    // enough live-search candidates are found, instead of exhausting the
    // full category x city search space sequentially (real production
    // slowness observed on Railway, fixed alongside this test).
    let started = 0;
    let foundEnough = 0;
    await runWithConcurrency({
      items: Array.from({ length: 50 }, (_, i) => i),
      limit: 4,
      shouldStop: () => foundEnough >= 3,
      worker: async (item) => {
        started++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        foundEnough++;
        return item;
      },
    });
    assert(
      started < 50 && started >= 3,
      `shouldStop halts new work once satisfied instead of exhausting all items (started ${started}/50)`
    );
    assert(started <= 3 + 4, `overshoot past the stop condition is bounded by \`limit\` (started ${started})`);
  })();
}

console.log("7. llm-client token usage accumulator sums input/output tokens across calls");
{
  resetTokenUsage();
  assert(
    JSON.stringify(getTokenUsage()) === JSON.stringify({ inputTokens: 0, outputTokens: 0, calls: 0 }),
    "resetTokenUsage() zeroes the running total"
  );
  recordUsage({ input_tokens: 120, output_tokens: 40 });
  recordUsage({ input_tokens: 80, output_tokens: 20 });
  const usage = getTokenUsage();
  assert(usage.inputTokens === 200, `input tokens accumulate across calls (got ${usage.inputTokens})`);
  assert(usage.outputTokens === 60, `output tokens accumulate across calls (got ${usage.outputTokens})`);
  assert(usage.calls === 2, `call count increments once per recorded response (got ${usage.calls})`);
  recordUsage(null); // a response with no usage info (e.g. an error path) must not throw or double-count
  recordUsage(undefined);
  const afterMissing = getTokenUsage();
  assert(
    afterMissing.inputTokens === 200 && afterMissing.outputTokens === 60 && afterMissing.calls === 2,
    "recordUsage(null/undefined) is a safe no-op"
  );
  resetTokenUsage(); // leave global state clean for anything that runs after this test file
}

console.log("8. brief-parser: heuristic keyword mapping (Uzbek/Russian/English) to real enum values");
{
  const uzSchool = resolveBriefHeuristic("O'zbekistondagi barcha maktablar");
  assert(
    uzSchool.types !== "all" && (uzSchool.types as string[]).includes("SCHOOL"),
    `"maktablar" (Uzbek: schools) maps to type SCHOOL (got ${JSON.stringify(uzSchool.types)})`
  );

  const enLyceum = resolveBriefHeuristic("looking for lyceums in Uzbekistan");
  assert(
    enLyceum.types !== "all" && (enLyceum.types as string[]).includes("LYCEUM"),
    `"lyceums" (English) maps to type LYCEUM (got ${JSON.stringify(enLyceum.types)})`
  );

  const ruLanguageCenter = resolveBriefHeuristic("топ языковой центр в Ташкенте");
  assert(
    ruLanguageCenter.types !== "all" && (ruLanguageCenter.types as string[]).includes("LANGUAGE_CENTER"),
    `"языковой центр" (Russian: language center) maps to type LANGUAGE_CENTER (got ${JSON.stringify(ruLanguageCenter.types)})`
  );

  const uzIelts = resolveBriefHeuristic("top IELTS markazlari");
  assert(
    uzIelts.categories !== "all" && (uzIelts.categories as string[]).includes("IELTS"),
    `"IELTS markazlari" maps to category IELTS (got ${JSON.stringify(uzIelts.categories)})`
  );
  assert(uzIelts.types === "all", `"top IELTS markazlari" names no institution type, so types stays "all" (got ${JSON.stringify(uzIelts.types)})`);

  const uzUniPrep = resolveBriefHeuristic("universitetga tayyorlov kurslari");
  assert(
    uzUniPrep.categories !== "all" && (uzUniPrep.categories as string[]).includes("UNIVERSITY_PREP"),
    `"universitetga tayyorlov" maps to category UNIVERSITY_PREP (got ${JSON.stringify(uzUniPrep.categories)})`
  );
  assert(
    uzUniPrep.types !== "all" && (uzUniPrep.types as string[]).includes("COURSE_CENTER"),
    `"kurslari" (courses) also maps to type COURSE_CENTER (got ${JSON.stringify(uzUniPrep.types)})`
  );

  const enKids = resolveBriefHeuristic("kids development centers");
  assert(
    enKids.categories !== "all" && (enKids.categories as string[]).includes("KIDS_EDUCATION"),
    `"kids development" maps to category KIDS_EDUCATION (got ${JSON.stringify(enKids.categories)})`
  );

  const tutoring = resolveBriefHeuristic("repetitorlar kerak");
  assert(
    tutoring.types !== "all" && (tutoring.types as string[]).includes("TUTORING"),
    `"repetitor" (Uzbek: tutor) maps to type TUTORING (got ${JSON.stringify(tutoring.types)})`
  );

  // Broad/unspecific brief -> no keyword hit on either dimension -> "all"/"all"
  // (the broadest possible scope), matching the "prepare data about ALL
  // institutions" intent for an unscoped ask.
  const broad = resolveBriefHeuristic("top o'quv markazlari haqida ma'lumot tayyorla");
  assert(broad.types === "all", `an unscoped/unmatched brief resolves types to "all" (got ${JSON.stringify(broad.types)})`);
  assert(broad.categories === "all", `an unscoped/unmatched brief resolves categories to "all" (got ${JSON.stringify(broad.categories)})`);

  // Empty brief -> the pre-existing config/priority-categories.json default,
  // unchanged from before this feature existed.
  const empty = await resolveBrief(undefined);
  const defaultScope = loadDefaultScope();
  assert(empty.source === "default", `resolveBrief(undefined) uses the config-file default (got source=${empty.source})`);
  assert(
    JSON.stringify(empty.categories) === JSON.stringify(defaultScope.categories),
    "a brief-less run resolves to the exact same categories as config/priority-categories.json (unchanged pre-brief-feature behavior)"
  );
  assert(empty.types === "all", "a brief-less run leaves types unrestricted (\"all\"), matching pre-brief-feature behavior (type was never filtered before)");
}

console.log("9a. resolveBriefHeuristic recognizes a named city as a hard regions filter (cost-control feature)");
{
  const tashkentOnly = resolveBriefHeuristic("Toshkentda IELTS markazlari");
  assert(
    JSON.stringify(tashkentOnly.regions) === JSON.stringify(["Tashkent"]),
    `a brief naming Tashkent (Uzbek spelling) resolves regions to just Tashkent (got ${JSON.stringify(tashkentOnly.regions)})`
  );
  assert(
    JSON.stringify(tashkentOnly.categories) === JSON.stringify(["IELTS"]),
    "the same brief still resolves its IELTS category correctly alongside the city filter"
  );

  const noCityNamed = resolveBriefHeuristic("IELTS markazlari");
  assert(noCityNamed.regions === "all", 'a brief with no city named leaves regions "all" (searches every seed city)');

  const englishSpelling = resolveBriefHeuristic("schools in Tashkent");
  assert(
    JSON.stringify(englishSpelling.regions) === JSON.stringify(["Tashkent"]),
    "the English spelling \"Tashkent\" also resolves to the same city"
  );
}

console.log("9b. resolveBrief() applies city-name detection unconditionally, not just inside resolveBriefHeuristic");
{
  // Real production bug: with OPENAI_API_KEY set, resolveBrief took the LLM
  // path, whose schema never asked for/returned `regions` at all — a brief
  // naming a city silently searched every seed city anyway. The fix moved
  // city detection to run once in resolveBrief() itself, after either path
  // returns, rather than only inside resolveBriefHeuristic. This exercises
  // resolveBrief() (not resolveBriefHeuristic() directly) with no API key
  // set — the only path safely exercisable without a real network call —
  // to pin that the override is wired at the resolveBrief() level.
  const savedKey = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    const scope = await resolveBrief("Toshkentda IELTS markazlari");
    assert(
      JSON.stringify(scope.regions) === JSON.stringify(["Tashkent"]),
      `resolveBrief() resolves regions to Tashkent (got ${JSON.stringify(scope.regions)})`
    );
  } finally {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  }
}

console.log("9e. SEARCH_PROVIDER switch: openai (default) vs openrouter, and hasApiKey() is provider-aware");
{
  const saved = {
    SEARCH_PROVIDER: process.env.SEARCH_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
  };
  try {
    delete process.env.SEARCH_PROVIDER;
    assert(getProvider() === "openai", 'getProvider() defaults to "openai" when SEARCH_PROVIDER is unset');

    process.env.SEARCH_PROVIDER = "openrouter";
    assert(getProvider() === "openrouter", "getProvider() respects SEARCH_PROVIDER=openrouter");

    delete process.env.OPENROUTER_MODEL;
    let threw = false;
    try {
      getModel();
    } catch {
      threw = true;
    }
    assert(threw, "getModel() throws a clear error when SEARCH_PROVIDER=openrouter but OPENROUTER_MODEL is unset (no silent fallback to an OpenAI model id)");

    process.env.OPENROUTER_MODEL = "openai/gpt-4o-mini";
    assert(getModel() === "openai/gpt-4o-mini", "getModel() returns OPENROUTER_MODEL verbatim once set");

    delete process.env.OPENROUTER_API_KEY;
    assert(hasApiKey() === false, "hasApiKey() checks OPENROUTER_API_KEY (not OPENAI_API_KEY) when the provider is openrouter");
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    assert(hasApiKey() === true, "hasApiKey() becomes true once OPENROUTER_API_KEY is set for the openrouter provider");

    process.env.SEARCH_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    assert(hasApiKey() === false, "switching back to openai, hasApiKey() checks OPENAI_API_KEY again, ignoring any OPENROUTER_API_KEY");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

console.log("9c. buildExportRecord: a genuinely missing phone is legal (real data: 86% of records have phone:null), not a build error");
{
  // Real production bug: normalizePhone(undefined) returned invalid, and
  // buildExportRecord treated that as a hard failure — rejecting the
  // overwhelming majority of real-shaped candidates, since most real
  // BilimOn institutions have no phone on file at all.
  const baseFields = { nameLatin: "Star Kids International", city: "Tashkent" };
  const baseContent = { descriptionUz: null, descriptionRu: null, needsContentReview: false };

  const noPhone = buildExportRecord("id1", "star-kids-international", "star kids international", baseFields, baseContent);
  assert(noPhone.record !== null, `a candidate with no phone at all still builds successfully (errors: ${JSON.stringify(noPhone.buildErrors)})`);
  assert(noPhone.record?.phone === null, "the resulting record has phone: null, matching real BilimOn data's common case");

  const badPhone = buildExportRecord("id2", "slug", "namekey", { ...baseFields, phone: "not-a-real-number" }, baseContent);
  assert(badPhone.record === null, "a phone that WAS supplied but doesn't parse as real is still a build error (unlike a missing one)");

  const goodPhone = buildExportRecord("id3", "slug", "namekey", { ...baseFields, phone: "+998712000004" }, baseContent);
  assert(goodPhone.record?.phone === "+998712000004", "a valid supplied phone is still normalized and kept");
}

console.log("9i. discovery scope excludes full universities/schools by default (MVP: learning centers only)");
{
  // Real production issue: a UNIVERSITY_PREP-facet search (type left
  // unset, i.e. the default case for every current facet) returned "INHA
  // University Tashkent" and "Tashkent Metropolitan University" — full
  // degree-granting universities — because their own English-prep programs
  // matched the facet wording. User decision (2026-09-02): universities/
  // institutes and K-12 schools/lyceums are a separate later product
  // phase; this pipeline's current MVP scope is learning centers only.
  const defaultScope = buildScopeInstruction(undefined);
  assert(/degree-granting universit/i.test(defaultScope), "the default (no explicit type) instruction excludes degree-granting universities");
  assert(/K-12 schools and lyceums/i.test(defaultScope), "the default instruction also excludes K-12 schools/lyceums");
  assert(/humanitarian aid/i.test(defaultScope), "the non-educational-activity exclusion (successor to the earlier charity/NGO fix) is still present in the default case");
  assert(
    /include it even if it happens to be run by a foundation or ngo/i.test(defaultScope),
    "the exclusion is activity-based, not legal-form-based — a foundation/NGO that actually runs real courses must stay in scope (many genuine Uzbekistan learning centers are legally structured that way)"
  );

  const schoolScope = buildScopeInstruction("SCHOOL");
  assert(/schools, lyceums/i.test(schoolScope), 'an explicit type="SCHOOL" request (a future, brief-narrowed case) is schools-inclusive');
  assert(!/degree-granting universit/i.test(schoolScope), "the schools-inclusive branch doesn't carry the university exclusion wording (it's a different scope, not a superset)");
}

console.log("9j. relevance-filter catches a medical clinic even though the search prompt already excludes them");
{
  // Real production failure: the search prompt explicitly excludes
  // hospitals/clinics, but a live run still approved "Neo Clinic Tashkent"
  // (neurology, pediatrics, EEG diagnostics, ABA therapy) as a
  // KIDS_EDUCATION learning center — the model didn't reliably follow the
  // prompt's own exclusion for a borderline case. This is the deterministic
  // backstop.
  const clinicFields = {
    nameUz: "Neo Clinic Tashkent",
    nameRu: "NEO clinic",
    programs: ["Детский невролог-эпилептолог", "ЭЭГ (Электроэнцефалография)", "Реабилитация"],
    specializations: ["АВА терапия"],
  } as any;
  const reason = detectNonEducationalOrg(clinicFields);
  assert(reason !== null, "the exact real-world clinic fields are flagged as non-educational");

  const clinicBuilt = buildExportRecord(
    "idclinic", "slug", "namekey", clinicFields,
    { descriptionUz: "tavsif", descriptionRu: "описание", needsContentReview: false }
  );
  assert(clinicBuilt.record === null, "buildExportRecord refuses to build a record for the clinic (routes to NEEDS_REVIEW, not silently exported)");

  // False-positive guard: a legitimate kids' development center offering
  // speech therapy / sensory work must NOT be flagged just because
  // "therapy"-adjacent Uzbek/Russian words appear — only strong,
  // unambiguous medical-organization terms (clinic, hospital, EEG, named
  // medical specialties like nevrolog/pediatr) trigger this filter.
  const legitKidsCenter = {
    nameUz: "Kids Development Center",
    programs: ["Nutq terapiyasi", "Sensor integratsiya", "Logopedik mashg'ulotlar"],
    specializations: ["Erta rivojlanish"],
  } as any;
  assert(detectNonEducationalOrg(legitKidsCenter) === null, "a legitimate kids' development/speech-therapy center is NOT flagged");
}

console.log("9h. bilimon-import.json is wrapped {version, exportedAt, institutions: [...]}, not a bare array");
{
  // Real production bug: the user pasted back the actual reference file's
  // shape ({version, exportedAt, institutions: [...]}) after our export
  // produced a bare top-level array instead — every record inside matched
  // the real schema, but the file itself didn't look like a real BilimOn
  // export/import file at all.
  const { importPath } = exportFinalArtifacts();
  const written = JSON.parse(readFileSync(importPath, "utf-8"));
  assert(!Array.isArray(written), "bilimon-import.json's top level is an object, not a bare array");
  assert(typeof written.version === "number", `"version" is present and numeric (got ${JSON.stringify(written.version)})`);
  assert(typeof written.exportedAt === "string" && !Number.isNaN(Date.parse(written.exportedAt)), `"exportedAt" is a valid ISO timestamp string (got ${JSON.stringify(written.exportedAt)})`);
  assert(Array.isArray(written.institutions), '"institutions" holds the actual records array');
}

console.log("9g. exported nameKey/slug come from the resolved name, not the raw discovery-time name");
{
  // Real production bug (Railway, 2026-09-02): a live search result's
  // "name" was the generic facet label "til markazi" ("language center")
  // rather than the real institution name, and nameKey/slug were computed
  // from it once at discovery time and never revisited. Every institution
  // matching that generic label would have exported the identical
  // "til-markazi-tashkent" slug, colliding on import.
  const generic = resolveExportIdentity(
    { nameUz: "Til ta\u2019limi va konsalting markazi", city: "Tashkent" } as any,
    { rawName: "Til markazi", city: "Tashkent" }
  );
  assert(generic.nameKey !== "til markazi", `nameKey is NOT the generic facet label once a real name is known (got "${generic.nameKey}")`);
  assert(generic.slug !== "til-markazi-tashkent", `slug is NOT the generic collision-prone value once a real name is known (got "${generic.slug}")`);
  assert(generic.slug.startsWith("til-ta"), `slug is derived from the actual resolved institution name (got "${generic.slug}")`);

  // When research found no better name at all, the raw discovery name is
  // still the correct fallback (matches the existing nameUz/nameLatin
  // fallback behavior already in the orchestrator).
  const noResearchName = resolveExportIdentity({ city: "Tashkent" } as any, { rawName: "Cambridge Learning Center", city: "Tashkent" });
  assert(noResearchName.slug === "cambridge-learning-center-tashkent", `falls back to the raw discovery name when research found none better (got "${noResearchName.slug}")`);
}

console.log("9f. languages are normalized to BilimOn ISO codes, not passed through as source-language names");
{
  // Real production failure (Railway, 2026-09-02): a candidate that had
  // ALREADY passed the quality gate (confidence 93, completeness 73) was
  // dropped to NEEDS_REVIEW solely because live extraction returned
  // details.languages as ["Узбекский", "Русский", "Английский"] — the names
  // as the source page writes them — instead of the uz/ru/en codes the real
  // BilimOn export uses.
  assert(
    JSON.stringify(normalizeLanguages(["Узбекский", "Русский", "Английский"])) === JSON.stringify(["uz", "ru", "en"]),
    `the exact real-world failing value normalizes to ISO codes (got ${JSON.stringify(normalizeLanguages(["Узбекский", "Русский", "Английский"]))})`
  );
  assert(
    JSON.stringify(normalizeLanguages(["O'zbek tili", "Ingliz tili", "Nemis tili"])) === JSON.stringify(["uz", "en", "de"]),
    "Uzbek-language names normalize too"
  );
  assert(
    JSON.stringify(normalizeLanguages(["uz", "ru", "uz"])) === JSON.stringify(["uz", "ru"]),
    "already-correct codes pass through and duplicates collapse"
  );
  assert(JSON.stringify(normalizeLanguages(null)) === "[]", "null/absent languages become an empty array");
  assert(
    JSON.stringify(normalizeLanguages(["Klingon"])) === JSON.stringify(["klingon"]),
    "an unrecognized language is lowercased and kept for the validator to soft-flag, not silently dropped"
  );

  // Real production failure (Railway, 2026-09-02, second occurrence): a
  // Turkish-language center's extraction returned details.languages as
  // ["турецкий"] — not covered by the first fix's uz/ru/en/de map — which
  // failed the export schema's HARD "lowercase 2-3 letter code" format
  // check (not just the validator's soft "unconfirmed code" flag) and
  // blocked export outright. Common languages taught in Uzbekistan beyond
  // the four in the real reference sample.
  assert(normalizeLanguageCode("турецкий") === "tr", `Turkish normalizes to "tr" (got "${normalizeLanguageCode("турецкий")}")`);
  assert(
    JSON.stringify(normalizeLanguages(["Arab tili", "xitoy tili", "koreys tili", "yapon tili", "fransuz tili"])) ===
      JSON.stringify(["ar", "zh", "ko", "ja", "fr"]),
    "Arabic/Chinese/Korean/Japanese/French names (Uzbek spelling) all normalize"
  );

  // Mirrors the real failing record: everything else valid, languages in
  // source-language names — so this isolates the language format as the
  // single reason the real run was rejected.
  const langContent = {
    descriptionUz: "Toshkentdagi maktab, ingliz tili va maktab fanlari bo'yicha darslar mavjud.",
    descriptionRu: "Школа в Ташкенте с занятиями по английскому языку и школьным предметам.",
    needsContentReview: false,
  };
  const built = buildExportRecord(
    "idlang", "slug", "namekey",
    {
      nameLatin: "Bunker School 2",
      city: "Tashkent",
      type: "SCHOOL",
      categories: ["SCHOOL_SUBJECTS"],
      languages: ["Узбекский", "Русский", "Английский"],
    } as any,
    langContent
  );
  assert(
    JSON.stringify(built.record?.details.languages) === JSON.stringify(["uz", "ru", "en"]),
    "buildExportRecord applies the normalization end-to-end, so the record now passes validation"
  );
  const validation = validateRecord(built.record!);
  assert(validation.valid, `the rebuilt record validates cleanly (reasons: ${JSON.stringify(validation.reasons)})`);
}

console.log("9d. buildExportRecord normalizes a bare-domain website instead of rejecting it downstream");
{
  // Real production bug: a website like "mathuz.uz" (no scheme, exactly
  // what an extraction from a search snippet commonly yields) was passed
  // straight through un-normalized and failed the export schema's strict
  // https?:// URL check later — even though normalizeUrl() (already used
  // elsewhere for dedupe) exists specifically to add the missing scheme.
  const baseFields = { nameLatin: "MathUz", city: "Tashkent" };
  const baseContent = { descriptionUz: null, descriptionRu: null, needsContentReview: false };

  const bareDomain = buildExportRecord("id4", "slug", "namekey", { ...baseFields, website: "mathuz.uz" }, baseContent);
  assert(bareDomain.record !== null, `a bare-domain website still builds successfully (errors: ${JSON.stringify(bareDomain.buildErrors)})`);
  assert(bareDomain.record?.website === "https://mathuz.uz", `the website is normalized to a full URL (got ${bareDomain.record?.website})`);

  const alreadyFull = buildExportRecord("id5", "slug", "namekey", { ...baseFields, website: "https://mathuz.uz/" }, baseContent);
  assert(alreadyFull.record?.website === "https://mathuz.uz", "an already-full URL is kept (trailing slash stripped) rather than double-prefixed");
}

console.log("9. --mock discovery filters/prioritizes fixtures by the resolved DiscoveryScope");
{
  const all40 = discoverMock(40, loadDefaultScope());
  assert(all40.length === 40, `the default (brief-less) scope still returns all 40 fixtures (got ${all40.length})`);

  const schoolsScope = resolveBriefHeuristic("maktablar");
  const schoolsOnly = discoverMock(40, schoolsScope);
  assert(schoolsOnly.length > 0 && schoolsOnly.length < 40, `a "maktablar" brief visibly narrows the fixture set (got ${schoolsOnly.length}/40)`);
  assert(
    schoolsOnly.every((c) => c.type === "SCHOOL" || c.type === "LYCEUM"),
    "every fixture returned for a schools-scoped brief is tagged SCHOOL or LYCEUM"
  );

  const broadScope = resolveBriefHeuristic("top o'quv markazlari haqida ma'lumot tayyorla");
  const broadResult = discoverMock(40, broadScope);
  assert(broadResult.length === 40, `an unscoped/broad brief resolves to "all" and returns all 40 fixtures (got ${broadResult.length})`);
}

console.log("10. coerceToResultArray never lets a malformed LLM response crash the caller with .map()");
{
  // Real production crash (Railway, 2026-08-31): "TypeError: results.map is
  // not a function" when the model wrapped its array in an object instead
  // of returning a bare JSON array. These assertions pin the fix.
  assert(
    JSON.stringify(coerceToResultArray([{ title: "a", url: "b" }])) === JSON.stringify([{ title: "a", url: "b" }]),
    "a bare array passes through unchanged"
  );
  assert(
    JSON.stringify(coerceToResultArray({ results: [{ title: "a", url: "b" }] })) ===
      JSON.stringify([{ title: "a", url: "b" }]),
    'unwraps a {"results": [...]} wrapper'
  );
  assert(
    JSON.stringify(coerceToResultArray({ institutions: [{ title: "a", url: "b" }] })) ===
      JSON.stringify([{ title: "a", url: "b" }]),
    'unwraps a {"institutions": [...]} wrapper'
  );
  assert(JSON.stringify(coerceToResultArray({})) === "[]", "an empty object coerces to [] instead of crashing");
  assert(JSON.stringify(coerceToResultArray(null)) === "[]", "null coerces to []");
  assert(JSON.stringify(coerceToResultArray("not json-shaped")) === "[]", "a bare string coerces to []");
}


console.log("11. Real-mode evidence confidence reflects the evidence (the 'confidence=52 forever' bug)");
{
  // Real production bug: agents/researcher.ts hardcoded confidence: 0.6 on
  // every real-mode evidence item, and the evidence array was never longer
  // than 1 (one URL, scrape-only). computeSourceConfidence(1, 0.6) is
  // exactly 52 — which is what every single one of the user's real run logs
  // showed — and with ~55 completeness and the 50/50 weights in
  // config/thresholds.json, qualityScore landed ~54 against an APPROVED
  // threshold of 85. APPROVED was mathematically unreachable in real mode.
  assert(
    computeSourceConfidence(1, 0.6) === 52,
    `the old constant really did pin sourceConfidence at 52 (got ${computeSourceConfidence(1, 0.6)})`
  );

  const richFields: Partial<RawExtractedFields> = {
    phone: "+998901234567",
    address: "Amir Temur ko'chasi 15",
    website: "https://example-lc.uz",
    email: "info@example-lc.uz",
    programs: ["General English", "IELTS Preparation"],
    foundedYear: 2015,
  };
  const thinFields: Partial<RawExtractedFields> = { website: "https://example-lc.uz" };

  const richConf = computeEvidenceConfidence({ sourceType: "website", fields: richFields });
  const thinConf = computeEvidenceConfidence({ sourceType: "website", fields: thinFields });
  assert(richConf > thinConf, `a source that yielded real detail outranks one that yielded a bare link (${richConf} > ${thinConf})`);
  assert(richConf !== 0.6 && thinConf !== 0.6, "confidence is no longer the constant 0.6");

  const socialConf = computeEvidenceConfidence({ sourceType: "social", fields: richFields });
  const directoryConf = computeEvidenceConfidence({ sourceType: "directory", fields: richFields });
  assert(
    richConf > directoryConf && directoryConf > socialConf,
    `source kind is ranked website > directory > social (${richConf} > ${directoryConf} > ${socialConf})`
  );

  const corroborated = computeEvidenceConfidence({ sourceType: "website", fields: richFields, corroboratedFieldCount: 2 });
  assert(corroborated > richConf, `corroboration by another source raises confidence (${corroborated} > ${richConf})`);
  assert(corroborated <= 0.95, `confidence is capped below certainty — nothing here is human-verified (got ${corroborated})`);

  // countCorroboratedFields compares identifying facts, tolerating the
  // formatting differences real sources actually have.
  const agree = countCorroboratedFields(
    { phone: "+998 90 123 45 67", website: "https://example-lc.uz/", address: "Amir Temur 15" },
    [{ phone: "901234567", website: "http://www.example-lc.uz", address: "Chilonzor 4" }]
  );
  assert(agree === 2, `phone and website corroborate across formatting differences, the differing address does not (got ${agree})`);
  assert(
    countCorroboratedFields({ phone: "+998901234567" }, []) === 0,
    "a single source corroborates nothing on its own"
  );

  // scoreEvidenceItems wires the two together over a whole evidence array.
  const items: Omit<EvidenceItem, "confidence">[] = [
    { fetchedAt: "t", sourceUrl: "research://x", sourceType: "search", extractedFields: richFields },
    { fetchedAt: "t", sourceUrl: "https://example-lc.uz", sourceType: "website", extractedFields: richFields },
  ];
  const scored = scoreEvidenceItems(items);
  assert(scored.length === 2 && scored.every((e) => e.confidence > 0.6), "every item in a corroborating pair scores above the old constant");
  assert(
    scored[1].confidence > scored[0].confidence,
    "within the same fact set, the institution's own website outranks the search summary"
  );
}

console.log("11b. A well-researched institution can now actually reach APPROVED, a thin one lands in NEEDS_REVIEW");
{
  const wellResearched: RawExtractedFields = {
    nameUz: "Example Learning Center",
    city: "Tashkent",
    address: "Amir Temur ko'chasi 15",
    phone: "+998901234567",
    email: "info@example-lc.uz",
    website: "https://example-lc.uz",
    telegram: "https://t.me/example_lc",
    instagram: "https://instagram.com/example.lc",
    type: "LANGUAGE_CENTER",
    categories: ["LANGUAGES"],
    deliveryMode: "OFFLINE",
    programs: ["General English", "IELTS Preparation"],
    specializations: ["IELTS"],
    foundedYear: 2015,
    descriptionSourceText: "x".repeat(120),
  };
  const evidence = scoreEvidenceItems([
    { fetchedAt: "t", sourceUrl: "research://x", sourceType: "search", extractedFields: wellResearched },
    { fetchedAt: "t", sourceUrl: "https://example-lc.uz", sourceType: "website", extractedFields: wellResearched },
    {
      fetchedAt: "t",
      sourceUrl: "https://yellowpages.uz/example-lc",
      sourceType: "directory",
      extractedFields: { phone: wellResearched.phone, address: wellResearched.address, website: wellResearched.website },
    },
  ]);
  const best = Math.max(...evidence.map((e) => e.confidence));
  const richScore = scoreInstitution({
    id: "rich",
    nameKey: "example learning center",
    slug: "example-learning-center",
    fields: wellResearched,
    evidenceCount: evidence.length,
    bestSourceConfidence: best,
  });
  assert(
    richScore.status === "APPROVED",
    `a website+socials+phone+address+programs institution reaches APPROVED (quality=${richScore.qualityScore} confidence=${richScore.sourceConfidence} completeness=${richScore.dataCompleteness})`
  );

  const thinFields: RawExtractedFields = {
    nameLatin: "Thin Center",
    city: "Tashkent",
    phone: "+998907654321",
    website: "https://thin-center.uz",
    type: "COURSE_CENTER",
    categories: ["LANGUAGES"],
  };
  const thinEvidence = scoreEvidenceItems([
    { fetchedAt: "t", sourceUrl: "research://thin", sourceType: "search", extractedFields: thinFields },
  ]);
  const thinScore = scoreInstitution({
    id: "thin",
    nameKey: "thin center",
    slug: "thin-center",
    fields: thinFields,
    evidenceCount: thinEvidence.length,
    bestSourceConfidence: thinEvidence[0].confidence,
  });
  assert(
    thinScore.status === "NEEDS_REVIEW",
    `a single-source, contact-only institution still lands in NEEDS_REVIEW, not APPROVED (quality=${thinScore.qualityScore})`
  );
  assert(
    computeDataCompleteness(wellResearched) > computeDataCompleteness(thinFields),
    "completeness still separates the two on data, independently of confidence"
  );
}

console.log("12. Discovery maps a full search profile onto the candidate (website/socials/phone/address)");
{
  // Real production bug: live discovery mapped only {title,url,snippet} onto
  // a candidate, so website/telegram/instagram/phone stayed empty in real
  // mode (only mock fixtures ever set them) and the orchestrator's
  // "fill in from discovery" fallback had nothing to fall back on.
  const candidate = mapSearchResultToCandidate(
    {
      title: "Example LC",
      name: "Example Learning Center",
      url: "https://yellowpages.uz/example-lc",
      snippet: "Til markazi",
      website: "https://example-lc.uz",
      instagram: "https://instagram.com/example.lc",
      telegram: "@example_lc",
      facebook: null,
      phone: "+998901234567",
      address: "Amir Temur ko'chasi 15",
      city: "Toshkent",
      category: "LANGUAGES",
      type: "LANGUAGE_CENTER",
    },
    "Tashkent",
    "2026-01-01T00:00:00.000Z"
  );
  assert(candidate.website === "https://example-lc.uz", "website from the search profile reaches the candidate");
  assert(candidate.instagram === "https://instagram.com/example.lc", "instagram reaches the candidate");
  assert(candidate.telegram === "@example_lc", "telegram reaches the candidate (handle form is kept as-is)");
  assert(candidate.phone === "+998901234567", "phone reaches the candidate");
  assert(candidate.address === "Amir Temur ko'chasi 15", "address reaches the candidate");
  assert(candidate.rawName === "Example Learning Center", "the institution's own name wins over the search-result title");
  assert(candidate.city === "Toshkent", "a city stated by the source wins over the city the search was run for");
  assert(candidate.category === "LANGUAGES" && candidate.type === "LANGUAGE_CENTER", "the search facet is carried through");

  const sparse = mapSearchResultToCandidate(
    { title: "Bare Result", url: "https://example.uz", website: "   ", instagram: null },
    "Samarkand"
  );
  assert(sparse.rawName === "Bare Result", "title is used when no separate name field came back");
  assert(sparse.city === "Samarkand", "the searched city is the fallback when the source states none");
  assert(sparse.website === null, "a blank string field is normalized to null, never a fake empty value");
  assert(sparse.instagram === null && sparse.phone === null, "absent fields stay null rather than undefined-ish junk");
}

console.log("13. Content manager generates from any real fact set, not descriptionSourceText alone");
{
  // Real production bug: the live path returned null descriptions unless
  // descriptionSourceText was >= 40 chars, and that field only ever came
  // from the extractor running on scraped text — which was empty for most
  // real institutions. Content was therefore almost always null, which also
  // flagged the record for review.
  const noSourceTextButRealFacts: RawExtractedFields = {
    nameUz: "Example Learning Center",
    city: "Tashkent",
    type: "LANGUAGE_CENTER",
    programs: ["General English", "IELTS Preparation"],
    foundedYear: 2015,
  };
  const ok = assessContentMaterial(noSourceTextButRealFacts);
  assert(ok.sufficient, `name + city + type + programs + foundedYear is enough material (reason: ${ok.reason ?? "-"})`);
  assert(ok.facts.includes("programs") && ok.facts.includes("foundedYear"), "the assessment names the facts it found");

  const sourceTextOnly = assessContentMaterial({
    nameLatin: "Example LC",
    city: "Tashkent",
    categories: ["LANGUAGES"],
    descriptionSourceText: "Ushbu markaz 2015-yildan beri ingliz tili kurslarini olib boradi.",
  });
  assert(sourceTextOnly.sufficient, "real source text alone still qualifies, exactly as before");

  const tooThin = assessContentMaterial({ nameLatin: "Example LC", city: "Tashkent", categories: ["LANGUAGES"] });
  assert(!tooThin.sufficient, "a name and a city alone are still too thin to write from");
  assert(!!tooThin.reason && tooThin.reason.includes("substantive"), `the reason says what was missing (got "${tooThin.reason}")`);

  const noIdentity = assessContentMaterial({ city: "Tashkent", programs: ["A"], foundedYear: 2015 });
  assert(!noIdentity.sufficient, "facts with no institution name are not writable material");
  assert(!!noIdentity.reason && noIdentity.reason.includes("a name"), "the reason names the missing identity");

  const noPlace = assessContentMaterial({ nameUz: "X", type: "SCHOOL", programs: ["A"], foundedYear: 2015 });
  assert(!noPlace.sufficient, "facts with no city or address are not writable material");
}

console.log("14. Provider errors are classified into one actionable line instead of a stack trace");
{
  // Real production crash: the user's last real run died on an unhandled
  // OpenRouter "APIError: 402 This request would exceed your available
  // credits" thrown by ONE discovery search, printing a giant stack trace
  // and killing the whole batch mid-discovery.
  const saved = { SEARCH_PROVIDER: process.env.SEARCH_PROVIDER, OPENROUTER_MODEL: process.env.OPENROUTER_MODEL };
  try {
    process.env.SEARCH_PROVIDER = "openrouter";

    const credits = classifyProviderError(
      Object.assign(new Error("402 This request would exceed your available credits"), { status: 402 })
    );
    assert(credits.kind === "credits" && credits.fatal, "a 402 is classified as fatal 'credits'");
    assert(
      credits.message.includes("OpenRouter") && credits.message.includes("402") && credits.message.includes("openrouter.ai/credits"),
      `the 402 message names the provider, the status and the top-up URL (got "${credits.message}")`
    );
    assert(
      credits.message.includes("SEARCH_PROVIDER"),
      "the 402 message also points at switching SEARCH_PROVIDER as the alternative"
    );

    // Not every SDK surfaces the status as a field — the classifier reads it
    // back out of the message text too.
    const creditsFromText = classifyProviderError(new Error("Error code: 402 - insufficient credits"));
    assert(creditsFromText.kind === "credits" && creditsFromText.status === 402, "a 402 is recognized from the message text alone");

    const auth = classifyProviderError(Object.assign(new Error("401 Unauthorized"), { status: 401 }));
    assert(auth.kind === "auth" && auth.fatal, "a 401 is classified as fatal 'auth'");
    assert(auth.message.includes("OPENROUTER_API_KEY"), "the auth message names the env var to check for the active provider");

    const forbidden = classifyProviderError(Object.assign(new Error("forbidden"), { status: 403 }));
    assert(forbidden.kind === "auth" && forbidden.fatal, "a 403 is also fatal auth");

    const rate = classifyProviderError(Object.assign(new Error("429 Too Many Requests"), { status: 429 }));
    assert(rate.kind === "rate_limit" && !rate.fatal, "a 429 is rate_limit and NOT fatal — the run continues without that unit of work");

    const other = classifyProviderError(new Error("socket hang up"));
    assert(other.kind === "other" && !other.fatal, "an ordinary network error is non-fatal");
    assert(other.message.includes("socket hang up"), "the ordinary-error message keeps the underlying cause");

    // handleProviderError is the boundary helper callers actually use.
    let threw: unknown = null;
    try {
      handleProviderError(Object.assign(new Error("402 credits"), { status: 402 }));
    } catch (err) {
      threw = err;
    }
    assert(isFatalProviderError(threw), "handleProviderError throws FatalProviderError for a fatal failure so the run can stop cleanly");
    assert(
      (threw as Error).message.includes("out of credits"),
      "the thrown error carries the already-formatted human-readable line"
    );

    const survived = handleProviderError(new Error("ECONNRESET"));
    assert(survived.kind === "other", "handleProviderError returns (does not throw) for a recoverable failure, so one unit of work fails alone");

    process.env.SEARCH_PROVIDER = "openai";
    const openaiCredits = classifyProviderError(Object.assign(new Error("402"), { status: 402 }));
    assert(
      openaiCredits.message.includes("OpenAI") && !openaiCredits.message.includes("openrouter.ai/credits"),
      "the message names whichever provider is actually configured"
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

console.log("15. Researcher normalizes model output and classifies sources without inventing anything");
{
  const normalized = normalizeResearchFields({
    nameUz: "  Example Learning Center  ",
    phone: null,
    website: "",
    foundedYear: "2015",
    studentCount: 0,
    programs: ["General English", "", "  IELTS  "],
    specializations: [],
    achievements: null,
    pricingNote: "oyiga 500 000 so'mdan",
    notAField: "ignored",
  });
  assert(normalized.nameUz === "Example Learning Center", "string fields are trimmed");
  assert(!("phone" in normalized) && !("website" in normalized), "null and empty-string fields are dropped, never stored as fake values");
  assert(normalized.foundedYear === 2015, "a numeric field returned as a string is coerced");
  assert(!("studentCount" in normalized), "a zero count is dropped rather than exported as a real 0");
  assert(JSON.stringify(normalized.programs) === JSON.stringify(["General English", "IELTS"]), "array entries are trimmed and blanks removed");
  assert(!("specializations" in normalized), "an empty array is dropped rather than looking like a checked-and-empty answer");
  assert(normalized.pricingNote === "oyiga 500 000 so'mdan", "a free-text price hint is kept verbatim (never converted to numbers)");
  assert(!("notAField" in normalized), "unknown keys from the model are discarded");
  assert(JSON.stringify(normalizeResearchFields(null)) === "{}", "a null research result normalizes to no fields at all");

  assert(classifySourceUrl("https://instagram.com/example.lc") === "social", "instagram is classified as a social source");
  assert(classifySourceUrl("https://t.me/example_lc") === "social", "telegram is classified as a social source");
  assert(classifySourceUrl("https://yellowpages.uz/example") === "directory", "yellowpages.uz is classified as a directory");
  assert(classifySourceUrl("https://goldenpages.uz/example") === "directory", "goldenpages.uz is classified as a directory");
  assert(classifySourceUrl("https://kursi24.uz/uz/example-lc") === "directory", "kursi24.uz is classified as a directory (a real user-suggested source with many learning centers)");
  assert(classifySourceUrl("https://example-lc.uz/about") === "website", "an ordinary site is classified as a website");

  // The generalized array coercion still protects every structured search
  // call, not just the old {title,url,snippet} one.
  assert(JSON.stringify(coerceToArray<{ name: string }>({ institutions: [{ name: "a" }] })) === JSON.stringify([{ name: "a" }]), "coerceToArray unwraps a wrapper object for any element shape");
  assert(JSON.stringify(coerceToArray({})) === "[]", "coerceToArray degrades to [] rather than throwing");
}

console.log("16. Duplicate-bookkeeping id can never collide with a real survivor's pipeline id");
{
  // Real production bug (Railway): the duplicate-bookkeeping state entry
  // written for every discovery result dedupe merged away used to be keyed
  // by generateId(normalizeNameKey(rawName), city) — the EXACT SAME id
  // function processCandidate() uses for the SURVIVING candidate. Two
  // candidates with identical rawName+city (e.g. found via a directory
  // listing and a separate search-result snippet, matched into one dedupe
  // group) therefore produced the SAME id for both the merged-away duplicate
  // and the kept survivor. Whichever ran first wrote REJECTED under that
  // shared id; the survivor's later processCandidate() call then saw an
  // already-terminal REJECTED state and skipped it — silently dropping a
  // real institution from every export.
  const rawName = "Cambridge Learning Center";
  const city = "Tashkent";
  const survivor: DiscoveryCandidate = {
    discoveryId: "survivor-source-1",
    rawName,
    city,
    sourceType: "web_search",
    discoveredAt: new Date().toISOString(),
    phone: "+998901112233",
  };
  // A second, independently-discovered result for the SAME institution
  // (identical rawName+city — e.g. the same title text scraped from a
  // directory listing AND a search snippet) that only matches via phone,
  // not via a distinguishing name difference.
  const duplicate: DiscoveryCandidate = {
    discoveryId: "duplicate-source-2",
    rawName,
    city,
    sourceType: "web_search",
    discoveredAt: new Date().toISOString(),
    phone: "+998901112233",
  };

  const { survivors, mergedAwayIds } = dedupeCandidates([survivor, duplicate]);
  assert(mergedAwayIds.size === 1, `dedupe merges the collision-prone pair into one group (got ${mergedAwayIds.size} merged-away id(s))`);
  assert(survivors.length === 1, "exactly one candidate survives dedupe");

  const dupId = [...mergedAwayIds][0];
  const dupCand = [survivor, duplicate].find((c) => c.discoveryId === dupId)!;
  const survivorCand = survivors[0];

  // Prove the OLD scheme really did collide (this is the bug, reproduced).
  const oldStyleProvisionalId = generateId(normalizeNameKey(dupCand.rawName), dupCand.city ?? "");
  const survivorPipelineId = generateId(normalizeNameKey(survivorCand.rawName), survivorCand.city ?? "");
  assert(
    oldStyleProvisionalId === survivorPipelineId,
    `sanity check: the old id scheme DID collide for this scenario (dup="${oldStyleProvisionalId}", survivor="${survivorPipelineId}")`
  );

  // Prove the FIX: the new bookkeeping id can never equal the survivor's real id.
  const newProvisionalId = generateDuplicateBookkeepingId(dupCand.discoveryId);
  assert(
    newProvisionalId !== survivorPipelineId,
    `fixed duplicate-bookkeeping id does NOT collide with the survivor's pipeline id (dup-bookkeeping="${newProvisionalId}", survivor="${survivorPipelineId}")`
  );
  assert(newProvisionalId.startsWith("dup-"), `duplicate-bookkeeping id is structurally distinct from a "pipeline-" id (got "${newProvisionalId}")`);
  assert(!newProvisionalId.startsWith("pipeline-"), "duplicate-bookkeeping id never looks like a real pipeline id");

  // Two different duplicate discoveryIds never collide with each other either.
  const otherDupId = generateDuplicateBookkeepingId("some-other-discovery-id");
  assert(otherDupId !== newProvisionalId, "different discoveryIds produce different bookkeeping ids");
}

console.log("17. exportFinalArtifacts() re-validates the approved batch before writing — a colliding slug is pulled into NEEDS_REVIEW, not shipped");
{
  // Real production bug: exportFinalArtifacts() used to write every
  // APPROVED-state record straight into bilimon-import.json with no final
  // batch-level re-check, even though validateBatch() (slug uniqueness /
  // duplicate name+city detection) already existed as a manual `pipeline
  // validate` command. State files persist across reruns BY DESIGN, so two
  // separately-approved records could collide on slug and both ship.
  const now = new Date().toISOString();
  const idA = "test-fix2-collision-a";
  const idB = "test-fix2-collision-b";
  const collidingSlug = "test-fix2-collision-slug";

  function makeState(id: string): StateRecord {
    return { id, state: "APPROVED", createdAt: now, updatedAt: now, retryCount: 0, history: [{ state: "APPROVED", at: now }] };
  }
  function makeRecord(id: string, nameUz: string): BilimOnExportRecord {
    return {
      id,
      nameUz,
      nameRu: nameUz,
      nameKey: normalizeNameKey(nameUz),
      slug: collidingSlug,
      type: "COURSE_CENTER",
      additionalTypes: [],
      status: "PENDING",
      phone: null,
      phone2: null,
      email: null,
      website: null,
      telegram: null,
      instagram: null,
      cityId: REAL_TASHKENT_CITY_ID,
      regionId: REAL_TASHKENT_REGION_ID,
      address: null,
      lat: null,
      lng: null,
      isVerified: false,
      trialLessonEnabled: false,
      deliveryMode: "OFFLINE",
      details: {
        descriptionUz: "Test tavsif",
        descriptionRu: "Тестовое описание",
        foundedYear: null,
        studentCount: null,
        teacherCount: null,
        languages: ["uz"],
        programs: [],
        shifts: [],
        specializations: [],
        achievements: null,
        categories: ["IT_COURSES"],
      },
      pricing: null,
      media: [],
      branches: [],
    };
  }

  const recA = makeRecord(idA, "Fix2 Collision Test A");
  const recB = makeRecord(idB, "Fix2 Collision Test B");

  // Sanity check: these two records, considered alone, are each individually
  // valid — the ONLY thing wrong with them is the batch-level slug collision.
  assert(validateRecord(recA).valid, "colliding record A is individually valid on its own");
  assert(validateRecord(recB).valid, "colliding record B is individually valid on its own");
  const batchCheck = validateBatch([recA, recB]);
  assert(!batchCheck.get(collidingSlug)?.valid, "validateBatch() itself already flags the slug collision (this is the pre-existing check exportFinalArtifacts never ran)");

  const paths = [
    join(DATA_STATE_DIR, `${idA}.json`),
    join(DATA_STATE_DIR, `${idB}.json`),
    join(DATA_PROCESSED_DIR, `${idA}.json`),
    join(DATA_PROCESSED_DIR, `${idB}.json`),
    join(DATA_REVIEW_DIR, `${idA}.json`),
    join(DATA_REVIEW_DIR, `${idB}.json`),
  ];

  try {
    for (const d of [DATA_STATE_DIR, DATA_PROCESSED_DIR, DATA_REVIEW_DIR]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(DATA_STATE_DIR, `${idA}.json`), JSON.stringify(makeState(idA), null, 2), "utf-8");
    writeFileSync(join(DATA_STATE_DIR, `${idB}.json`), JSON.stringify(makeState(idB), null, 2), "utf-8");
    writeFileSync(join(DATA_PROCESSED_DIR, `${idA}.json`), JSON.stringify(recA, null, 2), "utf-8");
    writeFileSync(join(DATA_PROCESSED_DIR, `${idB}.json`), JSON.stringify(recB, null, 2), "utf-8");

    const { importPath, report } = exportFinalArtifacts();
    const written = JSON.parse(readFileSync(importPath, "utf-8"));
    const shippedCollisionCount = written.institutions.filter((r: BilimOnExportRecord) => r.slug === collidingSlug).length;
    // validateBatch() (already-existing logic, reused as-is) flags EVERY
    // record sharing a non-unique slug, not just the "extra" ones past the
    // first — so neither colliding record ships; both route to human
    // review rather than the pipeline silently guessing which one is real.
    assert(shippedCollisionCount === 0, `neither colliding-slug record ships in bilimon-import.json — validateBatch flags all of them, not just the extras (got ${shippedCollisionCount} shipped)`);

    const reviewA = existsSync(join(DATA_REVIEW_DIR, `${idA}.json`));
    const reviewB = existsSync(join(DATA_REVIEW_DIR, `${idB}.json`));
    assert(reviewA && reviewB, "both colliding records are pulled out to data/review/ with their failure reasons");

    const demotedA = JSON.parse(readFileSync(join(DATA_STATE_DIR, `${idA}.json`), "utf-8")) as StateRecord;
    const demotedB = JSON.parse(readFileSync(join(DATA_STATE_DIR, `${idB}.json`), "utf-8")) as StateRecord;
    assert(demotedA.state === "NEEDS_REVIEW" && demotedB.state === "NEEDS_REVIEW", "both pulled-out records' on-disk state is demoted to NEEDS_REVIEW, not left claiming APPROVED");

    assert(
      written.institutions.length === report.approved,
      `report.json's "approved" count matches the actual number of institutions written to bilimon-import.json (institutions=${written.institutions.length}, report.approved=${report.approved})`
    );
    assert(report.needsReview >= 2, `report.json's "needsReview" count reflects both demoted records (got ${report.needsReview})`);
  } finally {
    for (const p of paths) {
      if (existsSync(p)) unlinkSync(p);
    }
    // Regenerate the real bilimon-import.json/report.json from the actual
    // (non-test) state on disk, so later tests/manual runs never see this
    // test's synthetic records.
    exportFinalArtifacts();
  }
}

console.log("18. SSRF hardening: private/loopback/link-local addresses are blocked, public ones are not");
{
  assert(isBlockedIp("127.0.0.1"), "127.0.0.1 (loopback) is blocked");
  assert(isBlockedIp("localhost") === true, "a non-IP string is blocked (conservative default)");
  assert(isBlockedIp("169.254.169.254"), "169.254.169.254 (cloud metadata) is blocked");
  assert(isBlockedIp("10.0.0.5"), "10.0.0.5 (RFC1918) is blocked");
  assert(isBlockedIp("172.16.0.1"), "172.16.0.1 (RFC1918) is blocked");
  assert(isBlockedIp("172.31.255.255"), "172.31.255.255 (top of 172.16.0.0/12) is blocked");
  assert(!isBlockedIp("172.32.0.1"), "172.32.0.1 (just outside 172.16.0.0/12) is NOT blocked");
  assert(isBlockedIp("192.168.1.1"), "192.168.1.1 (RFC1918) is blocked");
  assert(isBlockedIp("0.0.0.0"), "0.0.0.0 is blocked");
  assert(isBlockedIp("::1"), "::1 (IPv6 loopback) is blocked");
  assert(isBlockedIp("fe80::1"), "fe80::1 (IPv6 link-local) is blocked");
  assert(isBlockedIp("fc00::1"), "fc00::1 (IPv6 unique local) is blocked");
  assert(isBlockedIp("::ffff:127.0.0.1"), "IPv4-mapped IPv6 loopback is blocked (classified via the embedded IPv4 address)");
  assert(!isBlockedIp("8.8.8.8"), "8.8.8.8 (public) is NOT blocked");
  assert(!isBlockedIp("93.184.216.34"), "an ordinary public IP is NOT blocked");
  assert(!isBlockedIp("2606:4700:4700::1111"), "a public IPv6 address is NOT blocked");

  // Redirect-hop validation: every hop must be re-resolved relative to the
  // URL it came from, and an unparseable Location header must fail closed.
  assert(isRedirectStatus(301) && isRedirectStatus(302) && isRedirectStatus(307) && isRedirectStatus(308), "3xx codes are recognized as redirects");
  assert(!isRedirectStatus(200) && !isRedirectStatus(404), "non-3xx codes are not treated as redirects");
  assert(
    resolveRedirectTarget("/next", "https://example.uz/a/b") === "https://example.uz/next",
    "a relative redirect Location is resolved against the URL it was returned for"
  );
  assert(
    resolveRedirectTarget("http://169.254.169.254/latest/meta-data/", "https://example.uz/") === "http://169.254.169.254/latest/meta-data/",
    "an absolute redirect Location resolves to itself (still subject to the same classifyUrlForFetch check on the next hop)"
  );
  assert(resolveRedirectTarget("http://[::not-a-valid-host", "https://example.uz/") === null, "an unparseable redirect Location resolves to null (fails closed, never fetched)");

  // Byte-cap logic: truncates at maxBytes rather than reading everything.
  const enc = new TextEncoder();
  const chunks = [enc.encode("aaaaa"), enc.encode("bbbbb"), enc.encode("ccccc")]; // 15 bytes total
  const capped = capChunks(chunks, 8);
  assert(capped.length === 8, `capChunks stops at the byte cap rather than reading the full body (got length ${capped.length})`);
  assert(capped.toString("utf-8") === "aaaaabbb", `capChunks keeps bytes in order up to the cap (got "${capped.toString("utf-8")}")`);
  const underCap = capChunks([enc.encode("short")], 100);
  assert(underCap.toString("utf-8") === "short", "capChunks passes small bodies through unchanged when under the cap");
}

console.log("19. Research evidence carries the real cited source URL, not the synthetic placeholder");
{
  // Real production bug: the primary web-search evidence item — where most
  // extracted fields (phone, address, programs, etc.) actually come from —
  // was ALWAYS recorded under a synthetic research://web-search/... URI,
  // even when the same research call returned real https:// cited URLs. A
  // human reviewer opening data/research/<id>.json to check provenance saw
  // a fake URI instead of the real page(s) the model actually cited.
  const nameKey = "example-learning-center";

  const withRealUrls = selectResearchEvidenceSource(nameKey, [
    "https://example-lc.uz/about",
    "https://t.me/example_lc",
  ]);
  assert(withRealUrls.sourceUrl === "https://example-lc.uz/about", `the primary real cited URL becomes the evidence item's sourceUrl (got "${withRealUrls.sourceUrl}")`);
  assert(!withRealUrls.sourceUrl.startsWith("research://"), "the sourceUrl is never the synthetic placeholder when real URLs exist");
  assert(
    JSON.stringify(withRealUrls.additionalSourceUrls) === JSON.stringify(["https://t.me/example_lc"]),
    `further real cited URLs are preserved in additionalSourceUrls rather than discarded (got ${JSON.stringify(withRealUrls.additionalSourceUrls)})`
  );

  const withOneUrl = selectResearchEvidenceSource(nameKey, ["https://example-lc.uz/about"]);
  assert(withOneUrl.sourceUrl === "https://example-lc.uz/about", "a single real cited URL becomes the sourceUrl");
  assert(withOneUrl.additionalSourceUrls === undefined, "additionalSourceUrls is omitted when there is only one real cited URL");

  const withNoUrls = selectResearchEvidenceSource(nameKey, []);
  assert(withNoUrls.sourceUrl === `research://web-search/${encodeURIComponent(nameKey)}`, `the synthetic placeholder is still used as a fallback when the model cited zero real URLs (got "${withNoUrls.sourceUrl}")`);
  assert(withNoUrls.additionalSourceUrls === undefined, "no additionalSourceUrls when falling back to the placeholder");

  // Non-http(s) junk (e.g. a bare handle) must never leak through as if it
  // were a real cited URL.
  const withJunk = selectResearchEvidenceSource(nameKey, ["@example_lc", "not-a-url"]);
  assert(withJunk.sourceUrl === `research://web-search/${encodeURIComponent(nameKey)}`, "non-URL-shaped cited values are filtered out, falling back to the placeholder");
}

console.log("20. Web frontend request validation (src/server.ts::parseRunRequest)");
{
  const ok = parseRunRequest(JSON.stringify({ brief: "ingliz tili bo'yicha", count: 3 }));
  assert(!("error" in ok), "a well-formed {brief, count} request parses without error");
  if (!("error" in ok)) {
    assert(ok.brief === "ingliz tili bo'yicha", `brief is passed through trimmed (got "${ok.brief}")`);
    assert(ok.count === 3, `count is passed through as a number (got ${ok.count})`);
  }

  const defaulted = parseRunRequest(JSON.stringify({}));
  assert(!("error" in defaulted) && defaulted.count === 5, "count defaults to 5 when omitted");
  assert(!("error" in defaulted) && defaulted.brief === undefined, "brief is undefined when omitted");

  const emptyBrief = parseRunRequest(JSON.stringify({ brief: "   ", count: 1 }));
  assert(!("error" in emptyBrief) && emptyBrief.brief === undefined, "a whitespace-only brief normalizes to undefined rather than an empty string");

  const zero = parseRunRequest(JSON.stringify({ count: 0 }));
  assert("error" in zero, "count=0 is rejected");
  const negative = parseRunRequest(JSON.stringify({ count: -5 }));
  assert("error" in negative, "a negative count is rejected");
  const fractional = parseRunRequest(JSON.stringify({ count: 2.5 }));
  assert("error" in fractional, "a non-integer count is rejected");
  const tooBig = parseRunRequest(JSON.stringify({ count: 10000 }));
  assert("error" in tooBig, "a count above the MAX_COUNT ceiling is rejected — an open web form must not let one click request an unbounded batch");

  const nonStringBrief = parseRunRequest(JSON.stringify({ brief: 12345, count: 1 }));
  assert("error" in nonStringBrief, "a non-string brief is rejected");

  const badJson = parseRunRequest("{not json");
  assert("error" in badJson, "malformed JSON body is rejected with a clear error rather than throwing");

  const longBrief = "a".repeat(1000);
  const truncated = parseRunRequest(JSON.stringify({ brief: longBrief, count: 1 }));
  assert(!("error" in truncated) && truncated.brief!.length === 300, `an overlong brief is truncated to the MAX_BRIEF_LENGTH cap rather than rejected or passed through unbounded (got length ${!("error" in truncated) ? truncated.brief!.length : "n/a"})`);

  // City dropdown (added alongside the soha/talab text field): its value is
  // folded straight into the free-text brief string, since resolveBrief()
  // already runs matchCityNames() unconditionally over whatever brief text
  // it's given (see brief-parser.ts) — no separate RunOptions field needed.
  const withCity = parseRunRequest(JSON.stringify({ brief: "ingliz tili", city: "Bukhara", count: 2 }));
  assert(!("error" in withCity) && withCity.brief === "ingliz tili Bukhara", `city is appended to the brief text so resolveBrief()'s existing city detection picks it up (got "${!("error" in withCity) ? withCity.brief : "n/a"}")`);

  const cityOnly = parseRunRequest(JSON.stringify({ city: "Tashkent", count: 1 }));
  assert(!("error" in cityOnly) && cityOnly.brief === "Tashkent", `a city with no free-text brief still produces a usable brief (got "${!("error" in cityOnly) ? cityOnly.brief : "n/a"}")`);

  const noCity = parseRunRequest(JSON.stringify({ brief: "IT sohasi", city: "", count: 1 }));
  assert(!("error" in noCity) && noCity.brief === "IT sohasi", `an empty city string ("Barcha shaharlar") leaves the brief unchanged (got "${!("error" in noCity) ? noCity.brief : "n/a"}")`);

  const nonStringCity = parseRunRequest(JSON.stringify({ city: 123, count: 1 }));
  assert("error" in nonStringCity, "a non-string city is rejected");

  // "Top sifatli" mode checkbox.
  const topOnlyRequested = parseRunRequest(JSON.stringify({ count: 5, topOnly: true }));
  assert(!("error" in topOnlyRequested) && topOnlyRequested.topOnly === true, "topOnly:true is passed through");
  const topOnlyDefault = parseRunRequest(JSON.stringify({ count: 5 }));
  assert(!("error" in topOnlyDefault) && topOnlyDefault.topOnly === false, "topOnly defaults to false when omitted");
  const topOnlyTruthyJunk = parseRunRequest(JSON.stringify({ count: 5, topOnly: "yes" }));
  assert(!("error" in topOnlyTruthyJunk) && topOnlyTruthyJunk.topOnly === false, "a non-boolean-true topOnly value (e.g. a stray string) is treated as false, never truthy-coerced");

  // "Look up by name" mode.
  const withName = parseRunRequest(JSON.stringify({ institutionName: "Najot Ta'lim", count: 5 }));
  assert(!("error" in withName) && withName.institutionName === "Najot Ta'lim", `institutionName is passed through trimmed (got "${!("error" in withName) ? withName.institutionName : "n/a"}")`);
  const noName = parseRunRequest(JSON.stringify({ count: 5 }));
  assert(!("error" in noName) && noName.institutionName === undefined, "institutionName is undefined when omitted");
  const blankName = parseRunRequest(JSON.stringify({ institutionName: "   ", count: 5 }));
  assert(!("error" in blankName) && blankName.institutionName === undefined, "a whitespace-only institutionName normalizes to undefined, falling back to broad-discovery mode");
  const nonStringName = parseRunRequest(JSON.stringify({ institutionName: 42, count: 5 }));
  assert("error" in nonStringName, "a non-string institutionName is rejected");

  // "Faqat kursi24.uz orqali qidirish" checkbox.
  const kursi24OnlyRequested = parseRunRequest(JSON.stringify({ count: 5, kursi24Only: true }));
  assert(!("error" in kursi24OnlyRequested) && kursi24OnlyRequested.kursi24Only === true, "kursi24Only:true is passed through");
  const kursi24OnlyDefault = parseRunRequest(JSON.stringify({ count: 5 }));
  assert(!("error" in kursi24OnlyDefault) && kursi24OnlyDefault.kursi24Only === false, "kursi24Only defaults to false when omitted");
  const kursi24OnlyTruthyJunk = parseRunRequest(JSON.stringify({ count: 5, kursi24Only: "yes" }));
  assert(!("error" in kursi24OnlyTruthyJunk) && kursi24OnlyTruthyJunk.kursi24Only === false, "a non-boolean-true kursi24Only value is treated as false, never truthy-coerced");
}

console.log("21. Retry-until-target discovery ceiling (src/agents/orchestrator.ts::maxTotalRaw)");
{
  // The platform's whole point is delivering as many APPROVED institutions
  // as were asked for, not just running one raw discovery batch through the
  // quality gate once — runPipeline() now keeps discovering additional
  // batches until the target is met, bounded by maxTotalRaw(count) so one
  // request can't fetch an unbounded amount of real API spend.
  assert(maxTotalRaw(1) === 21, `a small count gets a generous floor so a single-institution request still gets real retry room (got ${maxTotalRaw(1)})`);
  assert(maxTotalRaw(10) === 40, `count*4 dominates once count is large enough (got ${maxTotalRaw(10)})`);
  assert(maxTotalRaw(50) === 200, `the ceiling caps out at 200 rather than scaling unboundedly with count (got ${maxTotalRaw(50)})`);
  assert(maxTotalRaw(1000) === 200, `an oversized count is still capped at 200 (got ${maxTotalRaw(1000)})`);
}

console.log("22. Exported records carry a real id — BilimOn's import endpoint rejects id:null (src/services/normalizer.ts::generateBilimonRecordId)");
{
  // Real production bug: a user uploaded a downloaded bilimon-import.json
  // straight to BilimOn's actual production import endpoint (POST
  // /api/v1/super-admin/import/institutions) and got back a 400:
  // {"code":"invalid_type","expected":"string","received":"null",
  // "path":["institutions",0,"id"]} — disproving the earlier assumption
  // that BilimOn assigns the id itself. Every exported record must now
  // carry a non-null id string.
  const id1 = generateBilimonRecordId();
  const id2 = generateBilimonRecordId();
  assert(/^c[a-z0-9]{24}$/.test(id1), `generateBilimonRecordId() produces a 25-char cuid-shaped id matching the real reference export's format (got "${id1}", length ${id1.length})`);
  assert(id1 !== id2, "two calls produce different ids");

  const baseFields = { nameLatin: "Star Kids International", city: "Tashkent" };
  const baseContent = { descriptionUz: null, descriptionRu: null, needsContentReview: false };
  const built = buildExportRecord("id-idcheck", "star-kids-international", "star kids international", baseFields, baseContent);
  assert(built.record !== null, "sanity: this candidate builds successfully");
  assert(typeof built.record?.id === "string" && built.record.id.length > 0, `buildExportRecord() no longer leaves id:null — it's a real generated string (got ${JSON.stringify(built.record?.id)})`);
  assert(BilimOnExportRecordZ.safeParse(built.record).success, "the built record (with its generated id) validates against the real zod schema, which now requires id to be a non-null string");
}

console.log("23. kursi24.uz scraper parses a real captured page correctly (src/services/kursi24.ts)");
{
  // Real user-supplied page source of
  // https://kursi24.uz/uz/centre/result-english-school — every assertion
  // below is checked against ACTUAL site content, not a guessed shape.
  const fixturePath = join(__dirname, "..", "data", "reference", "kursi24-sample-detail.html");
  const html = readFileSync(fixturePath, "utf-8");
  const url = "https://kursi24.uz/uz/centre/result-english-school";
  const listing = parseKursi24DetailPage(html, url);

  assert(listing.name === "RESULT ENGLISH SCHOOL", `name is parsed from the real page (got "${listing.name}")`);
  assert(listing.address === "Ташкент, ул. Мирзо Улугбека, 54/2", `address is parsed verbatim, including that this source gives it in Russian even on the /uz/ page (got "${listing.address}")`);
  assert(listing.city === "Ташкент", `city is derived from the address's first comma-separated segment (got "${listing.city}")`);
  assert(listing.phone === "+998555145252", `phone is parsed from the numbers-popup's real tel: link, not the masked "+9989 ..." display text (got "${listing.phone}")`);
  assert(listing.website === "https://result-school.uz/", `website is parsed from the social-links block (got "${listing.website}")`);
  assert(listing.instagram?.includes("instagram.com/result_school_uz"), `instagram is parsed (got "${listing.instagram}")`);
  assert(listing.facebook === "https://www.facebook.com/ResultUz", `facebook is parsed (got "${listing.facebook}")`);
  assert(listing.telegram === "https://t.me/result_school_uz", `telegram is parsed (got "${listing.telegram}")`);
  assert(JSON.stringify(listing.categoryLabels) === JSON.stringify(["Ingliz tili"]), `category labels are parsed (got ${JSON.stringify(listing.categoryLabels)})`);
  assert(listing.lat !== null && Math.abs(listing.lat - 41.324558275933) < 1e-6, `lat is parsed from the embedded map coordinates (got ${listing.lat})`);
  assert(listing.lng !== null && Math.abs(listing.lng - 69.324966491335) < 1e-6, `lng is parsed from the embedded map coordinates (got ${listing.lng})`);
  assert(!!listing.descriptionSourceText?.includes("Result o'quv markazi 2017 yildan beri"), `descriptionSourceText is parsed as real prose from the page (got "${listing.descriptionSourceText?.slice(0, 60)}...")`);
  assert(!listing.descriptionSourceText?.includes("<"), "descriptionSourceText has no leftover HTML tags");
  assert(
    JSON.stringify(listing.nearbyUrls) ===
      JSON.stringify([
        "https://kursi24.uz/uz/centre/cambridge-learning-centre-naprotiv-gostinitsy-radisson",
        "https://kursi24.uz/uz/centre/level-promotion",
        "https://kursi24.uz/uz/centre/unlock-language-studio",
      ]),
    `nearby-centers links are parsed as the crawl frontier (got ${JSON.stringify(listing.nearbyUrls)})`
  );

  // A page with none of these blocks (e.g. a 404 or an unrelated page)
  // degrades to all-null/empty rather than throwing.
  const empty = parseKursi24DetailPage("<html><body>not a listing page</body></html>", "https://kursi24.uz/uz/nothing");
  assert(empty.name === null && empty.phone === null && empty.nearbyUrls.length === 0, "a non-listing page degrades to null/empty fields rather than throwing");

  assert(JSON.stringify(inferCategoriesFromLabels(["Ingliz tili"])) === JSON.stringify(["LANGUAGES"]), `"Ingliz tili" maps to the LANGUAGES category via the same keyword table brief-parser.ts uses (got ${JSON.stringify(inferCategoriesFromLabels(["Ingliz tili"]))})`);
  assert(inferCategoriesFromLabels(["Something Unrecognized"]).length === 0, "an unrecognized label maps to no category rather than a guess");
  assert(inferTypesFromLabels(["Ingliz tili"]).length === 0, "a category-only label infers no institution type (expected — kursi24's category links don't distinguish institution type)");

  const cand = mapKursi24ListingToCandidate(listing);
  assert(cand.sourceType === "kursi24_scrape", "the mapped candidate is tagged with the kursi24_scrape source type");
  assert(cand.rawName === "RESULT ENGLISH SCHOOL", "the mapped candidate carries the real name");
  assert(cand.phone === "+998555145252" && cand.website === "https://result-school.uz/", "the mapped candidate carries the real contact fields");
  assert(cand.category === "LANGUAGES", "the mapped candidate carries the inferred category");
  assert(cand.descriptionSourceText?.includes("Result o'quv markazi"), "the mapped candidate carries the real description text");
}

console.log("24. Results table shows which discovery source found each institution (src/agents/orchestrator.ts::buildResultRow)");
{
  // Real user complaint: the kursi24.uz scraper (services/kursi24.ts) runs
  // silently alongside the LLM-search facets inside discoverLive() — there
  // was no way to see which source actually found a given result in the
  // web frontend's results table.
  const kursiCand: DiscoveryCandidate = {
    discoveryId: "https://kursi24.uz/uz/centre/never-persisted",
    rawName: "Never Persisted Institute",
    sourceType: "kursi24_scrape",
    discoveredAt: new Date().toISOString(),
  };
  const kursiRow = buildResultRow("test-never-persisted-kursi24", kursiCand);
  assert(kursiRow.source === "kursi24.uz", `a kursi24_scrape candidate's row is labeled "kursi24.uz" (got "${kursiRow.source}")`);

  const searchCand: DiscoveryCandidate = {
    discoveryId: "https://example.uz/some-listing",
    rawName: "Never Persisted Institute 2",
    sourceType: "web_search",
    discoveredAt: new Date().toISOString(),
  };
  const searchRow = buildResultRow("test-never-persisted-search", searchCand);
  assert(searchRow.source === "LLM qidiruv", `a web_search candidate's row is labeled "LLM qidiruv" (got "${searchRow.source}")`);
}

console.log("25. \"Look up by name\" mode bypasses discovery entirely and processes exactly one candidate (src/agents/orchestrator.ts::runPipeline)");
{
  // Real user request: type one specific institution's name and have it
  // researched directly, instead of the broad discovery machinery.
  const rawName = "Test Lookup Institute Never A Real Fixture Match";
  const id = generateId(normalizeNameKey(rawName), "");
  const cleanupPaths = [
    join(DATA_STATE_DIR, `${id}.json`),
    join(DATA_PROCESSED_DIR, `${id}.json`),
    join(DATA_REVIEW_DIR, `${id}.json`),
  ];
  for (const p of cleanupPaths) if (existsSync(p)) unlinkSync(p);

  try {
    const summary = await runPipeline({ count: 5, mock: true, institutionName: rawName });
    assert(summary.processedIds.length === 1, `exactly one candidate is processed regardless of count=5 (got ${summary.processedIds.length})`);
    assert(summary.results.length === 1, `results carries exactly one row (got ${summary.results.length})`);
    assert(summary.results[0].name === rawName, `the result row carries the looked-up name (got "${summary.results[0].name}")`);
    assert(summary.results[0].source === "qo'lda", `the result row is labeled as a manual lookup (got "${summary.results[0].source}")`);
    assert(summary.searchExhausted === true, "a named lookup always reports searchExhausted (no broader search space to expand)");
    assert(summary.duplicateIds.length === 0, "a named lookup never merges duplicates (there's only ever one candidate)");
    // This name matches no mock-research fixture, so it should NOT be
    // approved — confirming the mode doesn't fabricate a pass.
    assert(summary.approved === 0 && summary.shortfall === 1, `an unmatched name in mock mode ends up needsReview/rejected, not falsely approved (approved=${summary.approved}, shortfall=${summary.shortfall})`);
  } finally {
    for (const p of cleanupPaths) if (existsSync(p)) unlinkSync(p);
  }
}

console.log("26. \"Look up by name\" mode no longer fabricates a listing for a non-institution entity (src/services/relevance-filter.ts, src/services/llm-client.ts, src/agents/researcher.ts)");
{
  // Real production bug: the user tested "look up by name" mode with
  // "Registon" — the Registan, a famous Samarkand historical monument, not
  // a learning center — and the per-institution research call happily
  // researched and exported it as one, since nothing verified the named
  // entity actually IS a currently-operating education institution.
  const landmarkFields = {
    nameUz: "Registon majmuasi",
    achievements: "Jahon merosi ro'yxatiga kiritilgan tarixiy yodgorlik",
  } as any;
  const reason = detectNonEducationalOrg(landmarkFields);
  assert(reason !== null, "a historical monument/landmark's fields are flagged as non-educational");
  assert(reason!.includes("monument"), `the reason names it a monument/landmark, not a generic rejection (got "${reason}")`);

  const landmarkBuilt = buildExportRecord(
    "idlandmark", "slug", "namekey", landmarkFields,
    { descriptionUz: "tavsif", descriptionRu: "описание", needsContentReview: false }
  );
  assert(landmarkBuilt.record === null, "buildExportRecord refuses to build a record for the landmark (routes to NEEDS_REVIEW, not silently exported)");

  // False-positive guard: a real education institution's curriculum
  // mentioning history topics in passing must not be flagged just because
  // it discusses history — only strong, unambiguous heritage-SITE phrases
  // (describing the subject itself as a monument/museum) trigger this.
  const legitHistoryCenter = {
    nameUz: "Tarix va Til Markazi",
    programs: ["Jahon tarixi", "O'zbekiston tarixi", "Ingliz tili"],
  } as any;
  assert(detectNonEducationalOrg(legitHistoryCenter) === null, "a legitimate history-tutoring center is NOT flagged just for teaching history");

  // End-to-end: "look up by name" mode with the exact real-world failing
  // name must not fabricate an APPROVED listing.
  const rawName = "Registon";
  const id = generateId(normalizeNameKey(rawName), "");
  const cleanupPaths = [
    join(DATA_STATE_DIR, `${id}.json`),
    join(DATA_PROCESSED_DIR, `${id}.json`),
    join(DATA_REVIEW_DIR, `${id}.json`),
  ];
  for (const p of cleanupPaths) if (existsSync(p)) unlinkSync(p);
  try {
    const summary = await runPipeline({ count: 5, mock: true, institutionName: rawName });
    assert(summary.approved === 0, `looking up "Registon" by name never results in an approved learning-center listing (approved=${summary.approved})`);
  } finally {
    for (const p of cleanupPaths) if (existsSync(p)) unlinkSync(p);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
