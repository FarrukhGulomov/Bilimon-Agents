/**
 * Minimal plain-node/tsx test runner (no test framework). Asserts:
 *  - slug generation is deterministic
 *  - phone normalization rejects malformed numbers
 *  - dedupe collapses the known Cambridge duplicate pair
 *  - validator rejects an unknown enum value
 *  - location-mapper resolves Tashkent/Toshkent/Ташкент to the same cityId
 *
 * Run with: npm test  (== tsx test/run-all.ts)
 */
import { slugify, normalizePhone, generateId, normalizeNameKey } from "../src/services/normalizer.js";
import { resolveCity } from "../src/services/location-mapper.js";
import { deterministicDedupe } from "../src/services/deduplicator.js";
import { validateRecord } from "../src/services/validator.js";
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
