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
 *
 * Run with: npm test  (== tsx test/run-all.ts)
 */
import { slugify, normalizePhone, generateId, normalizeNameKey } from "../src/services/normalizer.js";
import { resolveCity } from "../src/services/location-mapper.js";
import { deterministicDedupe } from "../src/services/deduplicator.js";
import { validateRecord } from "../src/services/validator.js";
import { BilimOnExportRecordZ } from "../src/schemas/bilimon-export.zod.js";
import { runWithConcurrency } from "../src/services/concurrency.js";
import { getTokenUsage, resetTokenUsage, recordUsage, coerceToResultArray } from "../src/services/llm-client.js";
import { resolveBriefHeuristic, loadDefaultScope, resolveBrief } from "../src/services/brief-parser.js";
import { discoverMock } from "../src/agents/discovery.js";
import { buildExportRecord } from "../src/agents/bilimon-exporter.js";
import type { BilimOnExportRecord } from "../src/types/index.js";

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
