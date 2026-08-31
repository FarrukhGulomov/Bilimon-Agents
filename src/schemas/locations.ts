/**
 * REAL Uzbekistan city/region seed table — derived directly from the 302
 * real institution records in
 * data/reference/bilimon-institutions-reference.json. `cityId` / `regionId`
 * below are the actual cuid-style ids BilimOn's production database uses
 * for these 9 (city, region) pairs plus the one "region known, city
 * unspecified" case — not invented integers. They were extracted by
 * counting every distinct (cityId, regionId) pair across the export and
 * confirming which city each address text refers to.
 *
 * KNOWN COVERAGE GAP: the reference export only contains institutions from
 * 8 of Uzbekistan's ~14 regions. The following regions/cities never appear
 * anywhere in the 302 real records, so we have NO real id for them and this
 * table deliberately does not invent one: Navoiy, Termez/Surxondaryo,
 * Guliston/Sirdaryo, Urganch/Xorazm, Nukus/Qoraqalpog'iston. An institution
 * whose city resolves to one of these must route to NEEDS_REVIEW (see
 * services/location-mapper.ts / services/validator.ts) rather than being
 * assigned a fabricated cityId/regionId. This is a known limitation of the
 * current reference export, not a permanent restriction — extend this table
 * the moment BilimOn supplies real ids for the remaining regions.
 *
 * Each city entry lists alias spellings (Latin + Cyrillic + common
 * transliteration variants) so `normalizeCityName` can resolve them all
 * to the same city.
 */

export interface RegionSeed {
  regionId: string;
  nameEn: string;
}

export interface CitySeed {
  /** null only for the "region known, no specific city" case (see TASHKENT_REGION_ONLY below) — real BilimOn schema allows this. */
  cityId: string | null;
  regionId: string;
  nameEn: string;
  aliases: string[]; // includes nameEn's own normalized form implicitly
}

export const REGIONS: RegionSeed[] = [
  { regionId: "cmrfw8t2z0000n3ogoka95589", nameEn: "Tashkent City" },
  { regionId: "cmrfw8t350001n3ogi0e8d2wc", nameEn: "Tashkent Region" },
  { regionId: "cmrfw8t3l0008n3ogkin4zxmr", nameEn: "Samarkand Region" },
  { regionId: "cmrfw8t390003n3ogz58bus4l", nameEn: "Bukhara Region" },
  { regionId: "cmrfw8t370002n3og6th4i14j", nameEn: "Andijan Region" },
  { regionId: "cmrfw8t3s000bn3ogfuw7iz5d", nameEn: "Fergana Region" },
  { regionId: "cmrfw8t3i0007n3og8vo5tly6", nameEn: "Namangan Region" },
  { regionId: "cmrfw8t3d0005n3oggmcfupme", nameEn: "Kashkadarya Region" },
  { regionId: "cmrfw8t3b0004n3ogjoi7q20r", nameEn: "Jizzakh Region" },
];

export const CITIES: CitySeed[] = [
  {
    cityId: "cmrfw8t3y000fn3og703hdh1a",
    regionId: "cmrfw8t2z0000n3ogoka95589",
    nameEn: "Tashkent",
    aliases: ["tashkent", "toshkent", "ташкент", "toshkent shahri", "tashkent city"],
  },
  {
    cityId: "cmrfw8t4w000vn3ogh627i3sh",
    regionId: "cmrfw8t3l0008n3ogkin4zxmr",
    nameEn: "Samarkand",
    aliases: ["samarkand", "samarqand", "самарканд", "самарқанд"],
  },
  {
    cityId: "cmrfw8t4f000ln3ogwe5qmxim",
    regionId: "cmrfw8t390003n3ogz58bus4l",
    nameEn: "Bukhara",
    aliases: ["bukhara", "buxoro", "бухара", "бухоро"],
  },
  {
    cityId: "cmrfw8t4s000tn3ogl0xgaagv",
    regionId: "cmrfw8t3i0007n3og8vo5tly6",
    nameEn: "Namangan",
    aliases: ["namangan", "наманган"],
  },
  {
    cityId: "cmrfw8t550011n3oghyfhzqeu",
    regionId: "cmrfw8t3s000bn3ogfuw7iz5d",
    nameEn: "Fergana",
    aliases: ["fergana", "farg'ona", "fargona", "farghona", "фергана", "фарғона"],
  },
  {
    cityId: "cmrfw8t4b000jn3og6bpxz2ju",
    regionId: "cmrfw8t370002n3og6th4i14j",
    nameEn: "Andijan",
    aliases: ["andijan", "andijon", "андижан"],
  },
  {
    cityId: "cmrfw8t4m000pn3ogzk0v1xj2",
    regionId: "cmrfw8t3d0005n3oggmcfupme",
    nameEn: "Karshi",
    aliases: ["karshi", "qarshi", "карши", "kashkadarya", "qashqadaryo"],
  },
  {
    cityId: "cmrfw8t4j000nn3og8g69mcqv",
    regionId: "cmrfw8t3b0004n3ogjoi7q20r",
    nameEn: "Jizzakh",
    aliases: ["jizzax", "jizzakh", "джизак"],
  },
  // "Tashkent Region, no specific city" — 11 real records have cityId: null
  // with this regionId set, proving the real schema allows a known region
  // with an unresolved city. Resolves only from region-level phrasing, not
  // from "Tashkent" itself (that maps to the Tashkent City entry above).
  {
    cityId: null,
    regionId: "cmrfw8t350001n3ogi0e8d2wc",
    nameEn: "Tashkent Region",
    aliases: ["tashkent region", "toshkent viloyati", "toshkent viloyat", "tashkent oblast"],
  },
];

export function listCities(): CitySeed[] {
  return CITIES;
}
