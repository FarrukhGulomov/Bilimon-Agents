/**
 * Resolves free-text city names (Latin/Cyrillic/transliteration variants)
 * to the REAL Uzbekistan city/region cuid table in src/schemas/locations.ts,
 * derived from the actual BilimOn production export. Cities not present in
 * that export (see locations.ts's coverage-gap comment) deliberately fail
 * to resolve here rather than being assigned an invented id — callers
 * (agents/bilimon-exporter.ts) route those to NEEDS_REVIEW.
 */
import { CITIES, REGIONS, type CitySeed } from "../schemas/locations.js";

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9а-яёʻʼ'\s]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

const aliasIndex = new Map<string, CitySeed>();
for (const city of CITIES) {
  aliasIndex.set(normalize(city.nameEn), city);
  for (const alias of city.aliases) {
    aliasIndex.set(normalize(alias), city);
  }
}

export interface CityResolution {
  /** null only for the "region known, city unspecified" case — see locations.ts. */
  cityId: string | null;
  regionId: string;
  cityName: string;
}

/** Resolve a free-text city name to (cityId, regionId), or null if unknown. */
export function resolveCity(rawCity: string | null | undefined): CityResolution | null {
  if (!rawCity) return null;
  const key = normalize(rawCity);
  const hit = aliasIndex.get(key);
  if (hit) {
    return { cityId: hit.cityId, regionId: hit.regionId, cityName: hit.nameEn };
  }
  // Fallback: substring match against known aliases (handles "Tashkent, Uzbekistan").
  for (const [alias, city] of aliasIndex.entries()) {
    if (key.includes(alias)) {
      return { cityId: city.cityId, regionId: city.regionId, cityName: city.nameEn };
    }
  }
  return null;
}

export function isKnownCityId(cityId: string | null): boolean {
  if (cityId === null) return true; // null cityId is a legal real-schema value
  return CITIES.some((c) => c.cityId === cityId);
}

export function isKnownRegionId(regionId: string | null): boolean {
  if (regionId === null) return true; // null regionId is a legal real-schema value
  return REGIONS.some((r) => r.regionId === regionId);
}

export function listCities(): CitySeed[] {
  return CITIES;
}
