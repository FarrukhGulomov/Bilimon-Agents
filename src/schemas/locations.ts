/**
 * PLACEHOLDER Uzbekistan region/city seed table — NOT AUTHORITATIVE.
 *
 * `cityId` / `regionId` below are small sequential placeholder integers
 * invented for this build. They are NOT real BilimOn database ids. Before
 * any real import, replace this table with the actual cityId/regionId
 * values from the real BilimOn reference data (see README.md).
 *
 * Each city entry lists alias spellings (Latin + Cyrillic + common
 * transliteration variants) so `normalizeCityName` can resolve them all
 * to the same city.
 */

export interface RegionSeed {
  regionId: number;
  nameEn: string;
}

export interface CitySeed {
  cityId: number;
  regionId: number;
  nameEn: string;
  aliases: string[]; // includes nameEn's own normalized form implicitly
}

export const REGIONS: RegionSeed[] = [
  { regionId: 1, nameEn: "Tashkent City" },
  { regionId: 2, nameEn: "Tashkent Region" },
  { regionId: 3, nameEn: "Samarkand Region" },
  { regionId: 4, nameEn: "Bukhara Region" },
  { regionId: 5, nameEn: "Andijan Region" },
  { regionId: 6, nameEn: "Fergana Region" },
  { regionId: 7, nameEn: "Namangan Region" },
  { regionId: 8, nameEn: "Republic of Karakalpakstan" },
  { regionId: 9, nameEn: "Navoiy Region" },
  { regionId: 10, nameEn: "Qashqadaryo Region" },
  { regionId: 11, nameEn: "Surxondaryo Region" },
  { regionId: 12, nameEn: "Jizzax Region" },
  { regionId: 13, nameEn: "Sirdaryo Region" },
  { regionId: 14, nameEn: "Xorazm Region" },
];

export const CITIES: CitySeed[] = [
  {
    cityId: 1,
    regionId: 1,
    nameEn: "Tashkent",
    aliases: ["tashkent", "toshkent", "ташкент", "toshkent shahri", "tashkent city"],
  },
  {
    cityId: 2,
    regionId: 2,
    nameEn: "Nurafshon",
    aliases: ["nurafshon", "nurafshan", "нурафшон", "tashkent region", "toshkent viloyati"],
  },
  {
    cityId: 3,
    regionId: 3,
    nameEn: "Samarkand",
    aliases: ["samarkand", "samarqand", "самарканд", "самарқанд"],
  },
  {
    cityId: 4,
    regionId: 4,
    nameEn: "Bukhara",
    aliases: ["bukhara", "buxoro", "бухара", "бухоро"],
  },
  {
    cityId: 5,
    regionId: 5,
    nameEn: "Andijan",
    aliases: ["andijan", "andijon", "андижан"],
  },
  {
    cityId: 6,
    regionId: 6,
    nameEn: "Fergana",
    aliases: ["fergana", "farg'ona", "fargona", "farghona", "фергана", "фарғона"],
  },
  {
    cityId: 7,
    regionId: 7,
    nameEn: "Namangan",
    aliases: ["namangan", "наманган"],
  },
  {
    cityId: 8,
    regionId: 8,
    nameEn: "Nukus",
    aliases: ["nukus", "нукус", "karakalpakstan", "qoraqalpog'iston"],
  },
  {
    cityId: 9,
    regionId: 9,
    nameEn: "Navoiy",
    aliases: ["navoiy", "navoi", "навои", "навоий"],
  },
  {
    cityId: 10,
    regionId: 10,
    nameEn: "Karshi",
    aliases: ["karshi", "qarshi", "карши", "qashqadaryo"],
  },
  {
    cityId: 11,
    regionId: 11,
    nameEn: "Termez",
    aliases: ["termez", "termiz", "термез", "surxondaryo"],
  },
  {
    cityId: 12,
    regionId: 12,
    nameEn: "Jizzax",
    aliases: ["jizzax", "jizzakh", "джизак"],
  },
  {
    cityId: 13,
    regionId: 13,
    nameEn: "Gulistan",
    aliases: ["gulistan", "guliston", "гулистан", "sirdaryo"],
  },
  {
    cityId: 14,
    regionId: 14,
    nameEn: "Urgench",
    aliases: ["urgench", "urganch", "ургенч", "xorazm", "khorezm"],
  },
];
