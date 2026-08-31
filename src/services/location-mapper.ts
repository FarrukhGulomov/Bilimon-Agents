/**
 * Resolves free-text city names (Latin/Cyrillic/transliteration variants)
 * to the PLACEHOLDER Uzbekistan city/region seed table in
 * src/schemas/locations.ts. See that file's header comment — cityId /
 * regionId here are placeholder ids, not real BilimOn ids.
 */
import { CITIES, REGIONS, type CitySeed } from "../schemas/locations.js";

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
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
  cityId: number;
  regionId: number;
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

export function isKnownCityId(cityId: number): boolean {
  return CITIES.some((c) => c.cityId === cityId);
}

export function isKnownRegionId(regionId: number): boolean {
  return REGIONS.some((r) => r.regionId === regionId);
}

export function listCities(): CitySeed[] {
  return CITIES;
}
