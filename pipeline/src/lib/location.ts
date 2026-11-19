import type { LocationPrecision } from '../../../packages/shared/src/index.ts';
import { parseCoordinates } from './coordinates.ts';
import type { CeqaDocument } from './document.ts';
import { type Gazetteer, type GazetteerEntry, normalizePlaceName } from './gazetteer.ts';

/**
 * Best-effort placement of a project on the map.
 *
 * Order of preference:
 *   1. Coordinates typed by the lead agency (most recent document first).
 *   2. A single listed city, or a few cities close together.
 *   3. A single listed county, or a few counties close together.
 *   4. Nothing: statewide and multi-region projects are not mapped (we count
 *      them in meta.json instead of pretending they have a location).
 *
 * Approximate points are spread deterministically inside a disk whose size
 * comes from the place's land area, so 4,000 Los Angeles projects do not all
 * stack on City Hall. The spread is stable across rebuilds (seeded by SCH).
 */

export interface ResolvedLocation {
  lon: number;
  lat: number;
  precision: LocationPrecision;
}

const MAX_CITY_SPREAD_KM = 40;
const MAX_COUNTY_SPREAD_KM = 160;
const MAX_LISTED_CITIES = 3;
const MAX_LISTED_COUNTIES = 3;

export function haversineKm(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** FNV-1a; small, fast, deterministic. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic point in a disk of `radiusKm` around `center`. */
export function jitter(center: { lon: number; lat: number }, radiusKm: number, seed: string) {
  const u = hash32(`${seed}:u`) / 0xffffffff;
  const v = hash32(`${seed}:v`) / 0xffffffff;
  const r = radiusKm * Math.sqrt(u); // sqrt for uniform density
  const theta = 2 * Math.PI * v;
  const dLat = (r * Math.cos(theta)) / 111.32;
  const dLon = (r * Math.sin(theta)) / (111.32 * Math.cos((center.lat * Math.PI) / 180));
  return { lon: center.lon + dLon, lat: center.lat + dLat };
}

/** Radius that keeps points inside most of a place: 60% of the equal-area disk. */
export function spreadRadiusKm(entries: GazetteerEntry[], min: number, max: number): number {
  const area = entries.reduce((s, e) => s + e.areaM2, 0) / entries.length;
  const r = (Math.sqrt(area / Math.PI) / 1000) * 0.6;
  return Math.min(max, Math.max(min, r));
}

function centroid(entries: GazetteerEntry[]) {
  return {
    lon: entries.reduce((s, e) => s + e.lon, 0) / entries.length,
    lat: entries.reduce((s, e) => s + e.lat, 0) / entries.length,
  };
}

function maxPairwiseKm(entries: GazetteerEntry[]): number {
  let m = 0;
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) m = Math.max(m, haversineKm(entries[i], entries[j]));
  return m;
}

function lookup(names: string[], table: Record<string, GazetteerEntry>): GazetteerEntry[] | null {
  const found = names.map((n) => table[normalizePlaceName(n)]).filter((e): e is GazetteerEntry => !!e);
  // Every listed name must resolve, otherwise we would silently drop places.
  return found.length === names.length && found.length > 0 ? found : null;
}

export function resolveLocation(
  sch: string,
  docsNewestFirst: readonly CeqaDocument[],
  gaz: Gazetteer,
): ResolvedLocation | null {
  for (const d of docsNewestFirst) {
    const p = parseCoordinates(d.coordinates);
    if (p) return { ...p, precision: 'exact' };
  }

  // Use the newest document that lists any place at all.
  const withPlaces = docsNewestFirst.find((d) => d.cities.length > 0 || d.counties.length > 0);
  if (!withPlaces) return null;
  const cities = withPlaces.cities.filter((c) => !/unincorporated|various|statewide|countywide/i.test(c));
  const counties = withPlaces.counties.filter((c) => !/various|statewide/i.test(c));

  if (cities.length > 0 && cities.length <= MAX_LISTED_CITIES) {
    const found = lookup(cities, gaz.places);
    if (found && maxPairwiseKm(found) <= MAX_CITY_SPREAD_KM) {
      const r = spreadRadiusKm(found, 0.3, 8);
      return { ...jitter(centroid(found), r, sch), precision: 'city' };
    }
  }

  if (counties.length > 0 && counties.length <= MAX_LISTED_COUNTIES) {
    const found = lookup(counties, gaz.counties);
    if (found && maxPairwiseKm(found) <= MAX_COUNTY_SPREAD_KM) {
      const r = spreadRadiusKm(found, 2, 35);
      return { ...jitter(centroid(found), r, sch), precision: found.length === 1 ? 'county' : 'region' };
    }
  }

  return null;
}
