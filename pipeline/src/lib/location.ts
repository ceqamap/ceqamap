import type { LocationPrecision } from '../../../packages/shared/src/index.ts';
import { type Area, type Boundaries, normalizePlaceName } from './boundaries.ts';
import { parseCoordinates } from './coordinates.ts';
import type { CeqaDocument } from './document.ts';
import { bboxOf, distanceToShapeKm, inBBox, pointInShape, samplePointInShape, signedRingArea } from './geometry.ts';
import { seededRandom } from './random.ts';

/**
 * Best-effort placement of a project on the map.
 *
 * Order of preference:
 *   1. Coordinates typed by the lead agency (most recent document first),
 *      but only if they agree with the places the project lists: within
 *      10 km of a listed city, or else within 5 km of a listed county.
 *      Agencies make typos (36° for 39° puts Ukiah in the Pacific; 122.565
 *      for 122.315 puts downtown San Mateo 22 km offshore but still "in" the
 *      county); a point that contradicts the project's own places is wrong.
 *   2. Where the listed cross streets meet (see crossStreets.ts), if found.
 *   3. A random spot inside the listed city (or 2–3 nearby cities).
 *   4. A random spot inside the listed county (or 2–3 nearby counties).
 *   5. Nothing: statewide and multi-region projects are not mapped.
 *
 * "Random" is seeded by the SCH number, so a project lands in the same spot
 * on every rebuild, and spots are drawn inside the real Census outline, which
 * is clipped to the shoreline, so approximate points never land in the ocean.
 * Outlying islands (any piece under 10% of a place's largest piece: the
 * Farallones, Catalina, the Channel Islands) are skipped when placing
 * approximate points; projects there almost always give coordinates.
 */

export interface ResolvedLocation {
  lon: number;
  lat: number;
  precision: LocationPrecision;
  /** True when the agency's coordinates were discarded as inconsistent. */
  coordinatesRejected: boolean;
  /** For `intersection`: the streets used. */
  streets?: [string, string];
}

export interface LocationHints {
  crossStreets?: { lon: number; lat: number; streets: [string, string] };
}

/** Coastal, harbor, and border projects can sit just outside the county line. */
export const COORDINATE_TOLERANCE_KM = 5;
/** Projects often sit just outside the city they list (unincorporated edges). */
export const CITY_TOLERANCE_KM = 10;
/** Pieces smaller than this share of a place's largest piece don't receive approximate points. */
const MIN_PIECE_SHARE = 0.1;
/** With no county to check against: allow state waters and nearshore work. */
const STATE_TOLERANCE_KM = 25;
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

const center = (a: Area) => ({ lon: (a.bbox[0] + a.bbox[2]) / 2, lat: (a.bbox[1] + a.bbox[3]) / 2 });

function maxSpreadKm(areas: Area[]): number {
  let m = 0;
  for (let i = 0; i < areas.length; i++)
    for (let j = i + 1; j < areas.length; j++) m = Math.max(m, haversineKm(center(areas[i]), center(areas[j])));
  return m;
}

function lookup(names: string[], table: Record<string, Area>): Area[] | null {
  const found = names.map((n) => table[normalizePlaceName(n)]).filter((e): e is Area => !!e);
  // Every listed name must resolve, otherwise we would silently drop places.
  return found.length === names.length && found.length > 0 ? found : null;
}

/** Is (lon, lat) within `toleranceKm` of any of the areas? */
function nearAny(lon: number, lat: number, areas: Area[], toleranceKm: number): boolean {
  const padDeg = toleranceKm / 80; // generous: 1° lon is ≥ 80 km in California
  const candidates = areas.filter((a) =>
    inBBox(lon, lat, [a.bbox[0] - padDeg, a.bbox[1] - padDeg, a.bbox[2] + padDeg, a.bbox[3] + padDeg]),
  );
  if (candidates.some((a) => inBBox(lon, lat, a.bbox) && pointInShape(lon, lat, a.shape))) return true;
  return candidates.some((a) => distanceToShapeKm(lon, lat, a.shape) <= toleranceKm);
}

const samplingCache = new WeakMap<Area, Area>();

/**
 * The area without outlying islands, for placing approximate points. Holes
 * (wound opposite to the largest ring) are kept, so points stay out of
 * enclaves; outer pieces under 10% of the largest piece are dropped.
 */
function samplingArea(a: Area): Area {
  let s = samplingCache.get(a);
  if (!s) {
    const signed = a.shape.map(signedRingArea);
    const largest = signed.reduce((m, x, i) => (Math.abs(x) > Math.abs(signed[m]) ? i : m), 0);
    const outerSign = Math.sign(signed[largest]);
    const rings = a.shape.filter(
      (_, i) =>
        Math.sign(signed[i]) !== outerSign || Math.abs(signed[i]) >= Math.abs(signed[largest]) * MIN_PIECE_SHARE,
    );
    const shape = rings.length > 0 ? rings : a.shape;
    s = { ...a, shape, bbox: bboxOf(shape) };
    samplingCache.set(a, s);
  }
  return s;
}

/** A seeded random point inside one of the areas, chosen in proportion to their size. */
function placeWithin(areas: Area[], rand: () => number): { lon: number; lat: number } | null {
  const total = areas.reduce((s, a) => s + a.areaKm2, 0);
  let pick = rand() * total;
  let chosen = areas[areas.length - 1];
  for (const a of areas) {
    pick -= a.areaKm2;
    if (pick <= 0) {
      chosen = a;
      break;
    }
  }
  const target = samplingArea(chosen);
  return samplePointInShape(target.shape, target.bbox, rand);
}

export function resolveLocation(
  sch: string,
  docsNewestFirst: readonly CeqaDocument[],
  b: Boundaries,
  hints: LocationHints = {},
): ResolvedLocation | null {
  const placeDoc = docsNewestFirst.find((d) => d.cities.length > 0 || d.counties.length > 0);
  const cities = (placeDoc?.cities ?? []).filter((c) => !/unincorporated|various|statewide|countywide/i.test(c));
  const counties = (placeDoc?.counties ?? []).filter((c) => !/various|statewide/i.test(c));
  const countyAreas = counties.length > 0 && counties.length <= 10 ? lookup(counties, b.counties) : null;
  const cityAreas = cities.length > 0 && cities.length <= MAX_LISTED_CITIES ? lookup(cities, b.places) : null;

  let coordinatesRejected = false;
  for (const d of docsNewestFirst) {
    const p = parseCoordinates(d.coordinates);
    if (!p) continue;
    const plausible = cityAreas
      ? nearAny(p.lon, p.lat, cityAreas, CITY_TOLERANCE_KM)
      : countyAreas
        ? nearAny(p.lon, p.lat, countyAreas, COORDINATE_TOLERANCE_KM)
        : nearAny(p.lon, p.lat, Object.values(b.counties), STATE_TOLERANCE_KM);
    if (plausible) return { ...p, precision: 'exact', coordinatesRejected: false };
    coordinatesRejected = true;
  }

  if (hints.crossStreets) {
    const { lon, lat, streets } = hints.crossStreets;
    return { lon, lat, precision: 'intersection', coordinatesRejected, streets };
  }

  if (!placeDoc) return null;
  const rand = seededRandom(sch);

  if (cityAreas) {
    const found = cityAreas;
    if (maxSpreadKm(found) <= MAX_CITY_SPREAD_KM) {
      const p = placeWithin(found, rand);
      if (p) return { ...p, precision: 'city', coordinatesRejected };
    }
  }

  if (counties.length > 0 && counties.length <= MAX_LISTED_COUNTIES) {
    const found = countyAreas ?? lookup(counties, b.counties);
    if (found && maxSpreadKm(found) <= MAX_COUNTY_SPREAD_KM) {
      const p = placeWithin(found, rand);
      if (p) return { ...p, precision: found.length === 1 ? 'county' : 'region', coordinatesRejected };
    }
  }

  return null;
}
