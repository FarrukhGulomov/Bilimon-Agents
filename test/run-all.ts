/**
 * Minimal plain-node/tsx test runner (no test framework). Asserts:
 *  - slug generation is deterministic
 *  - phone normalization rejects malformed numbers
 *  - dedupe collapses the known Cambridge duplicate pair
 *  - validator rejects an unknown enum value
 *  - location-mapper resolves Tashkent/Toshkent/Ташкент to the same cityId
 *  - runWithConcurrency caps in-flight work at `limit` and preserves order
 *  - llm-client's token usage accumulator sums input/output tokens per call
 *
 * Run with: npm test  (== tsx test/run-all.ts)
 */
import { slugify, normalizePhone, generateId, normalizeNameKey } from "../src/services/normalizer.js";
import { resolveCity } from "../src/services/location-mapper.js";
import { deterministicDedupe } from "../src/services/deduplicator.js";
import { validateRecord } from "../src/services/validator.js";
import { runWithConcurrency } from "../src/services/concurrency.js";
import { getTokenUsage, resetTokenUsage, recordUsage } from "../src/services/llm-client.js";
import type { BilimOnExportRecord } from "../src/types/index.js";

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
    cityId: 1,
    regionId: 1,
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
      languages: ["UZ"],
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

  const badCity = { ...base, cityId: 99999 };
  const badCityResult = validateRecord(badCity);
  assert(!badCityResult.valid, "a record with an unknown cityId is rejected");
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
