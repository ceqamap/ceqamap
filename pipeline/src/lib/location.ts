import type { LocationPrecision } from '../../../packages/shared/src/index.ts';
import { type Area, type Boundaries, normalizePlaceName } from './boundaries.ts';
import { caZip } from './address.ts';
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
 *   2. A street address written in the project's text, geocoded by the
 *      Census and checked against the listed places (see geocode.ts).
 *   3. Where the listed cross streets meet (see crossStreets.ts), if found.
 *   4. A random spot inside the listed ZIP code, where it overlaps the
 *      listed city (or county), when the ZIP area is smaller than the city.
 *   5. A random spot inside the listed city (or 2–3 nearby cities).
 *   6. A random spot inside the listed county (or 2–3 nearby counties).
 *   7. Nothing: statewide and multi-region projects are not mapped.
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
  /** For `address`: the address geocoded. */
  address?: string;
}

export interface AddressPlacement {
  lon: number;
  lat: number;
  /** "1234 Main St, Fresno" */
  address: string;
}

export interface LocationHints {
  crossStreets?: { lon: number; lat: number; streets: [string, string] };
  /** Already checked against the listed places. */
  address?: AddressPlacement;
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

export interface ListedPlaces {
  placeDoc: CeqaDocument | undefined;
  cities: string[];
  counties: string[];
  cityAreas: Area[] | null;
  countyAreas: Area[] | null;
}

/** The cities and counties a project lists (newest document that lists any). */
export function listedPlaces(docsNewestFirst: readonly CeqaDocument[], b: Boundaries): ListedPlaces {
  const placeDoc = docsNewestFirst.find((d) => d.cities.length > 0 || d.counties.length > 0);
  const cities = (placeDoc?.cities ?? []).filter((c) => !/unincorporated|various|statewide|countywide/i.test(c));
  const counties = (placeDoc?.counties ?? []).filter((c) => !/various|statewide/i.test(c));
  const countyAreas = counties.length > 0 && counties.length <= 10 ? lookup(counties, b.counties) : null;
  const cityAreas = cities.length > 0 && cities.length <= MAX_LISTED_CITIES ? lookup(cities, b.places) : null;
  return { placeDoc, cities, counties, cityAreas, countyAreas };
}

/**
 * Does a point agree with the places the project lists? Within 10 km of a
 * listed city, else within 5 km of a listed county, else within 25 km of
 * California.
 */
export function agreesWithPlaces(p: { lon: number; lat: number }, places: ListedPlaces, b: Boundaries): boolean {
  // The tolerances let points sit in the ocean off a coastal county, but not
  // across a land border: SCH 2011081008 (Poway Road, filed as 32°30′N
  // instead of about 32°57′N) landed 1 km inside Tijuana, within 5 km of San
  // Diego County.
  if (inMexico(p.lon, p.lat) || inNeighborState(p.lon, p.lat, b)) return false;
  return places.cityAreas
    ? nearAny(p.lon, p.lat, places.cityAreas, CITY_TOLERANCE_KM)
    : places.countyAreas
      ? nearAny(p.lon, p.lat, places.countyAreas, COORDINATE_TOLERANCE_KM)
      : nearAny(p.lon, p.lat, Object.values(b.counties), STATE_TOLERANCE_KM);
}

export function resolveLocation(
  sch: string,
  docsNewestFirst: readonly CeqaDocument[],
  b: Boundaries,
  hints: LocationHints = {},
): ResolvedLocation | null {
  const places = listedPlaces(docsNewestFirst, b);
  const { placeDoc, counties, cityAreas, countyAreas } = places;

  let coordinatesRejected = false;
  for (const d of docsNewestFirst) {
    const p = parseCoordinates(d.coordinates);
    if (!p) continue;
    if (agreesWithPlaces(p, places, b)) return { ...p, precision: 'exact', coordinatesRejected: false };
    coordinatesRejected = true;
  }

  if (hints.address) {
    const { lon, lat, address } = hints.address;
    return { lon, lat, precision: 'address', coordinatesRejected, address };
  }

  if (hints.crossStreets) {
    const { lon, lat, streets } = hints.crossStreets;
    return { lon, lat, precision: 'intersection', coordinatesRejected, streets };
  }

  const zipPoint = placeInZip(sch, docsNewestFirst, places, b);
  if (zipPoint) return { ...zipPoint, precision: 'zip', coordinatesRejected };

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

const ZIP_TRIES = 200;

/**
 * A seeded random spot in the project's ZIP code, inside the listed city (or
 * county) too, so a mistyped ZIP can't move a project away from its own
 * places. Used only when the ZIP area is smaller than the listed city.
 * Its own random stream, so city placements don't shift when it gives up.
 */
function placeInZip(
  sch: string,
  docsNewestFirst: readonly CeqaDocument[],
  places: ListedPlaces,
  b: Boundaries,
): { lon: number; lat: number } | null {
  if (!b.zips) return null;
  const zip = docsNewestFirst.map((d) => caZip(d.zip)).find((z) => z !== null);
  const area = zip ? b.zips[zip] : undefined;
  if (!area) return null;
  const within = places.cityAreas ?? places.countyAreas;
  if (places.cityAreas && area.areaKm2 >= places.cityAreas.reduce((s, a) => s + a.areaKm2, 0)) return null;
  const target = samplingArea(area);
  const rand = seededRandom(`${sch}:zip`);
  for (let i = 0; i < ZIP_TRIES; i++) {
    const p = samplePointInShape(target.shape, target.bbox, rand, 200);
    if (!p) return null;
    if (!within || within.some((a) => inBBox(p.lon, p.lat, a.bbox) && pointInShape(p.lon, p.lat, a.shape))) return p;
  }
  return null;
}

// The California-Mexico border is a straight line from the Pacific, just south
// of San Diego Bay, to the Colorado River.
const BORDER_WEST = { lon: -117.1240, lat: 32.5343 };
const BORDER_EAST = { lon: -114.7196, lat: 32.7187 };

/** South of the international border (land or Mexican coastal waters) and west of Arizona. */
export function inMexico(lon: number, lat: number): boolean {
  if (lon < -118 || lon > BORDER_EAST.lon) return false;
  const t = (lon - BORDER_WEST.lon) / (BORDER_EAST.lon - BORDER_WEST.lon);
  return lat < BORDER_WEST.lat + t * (BORDER_EAST.lat - BORDER_WEST.lat);
}

function inNeighborState(lon: number, lat: number, b: Boundaries): boolean {
  return (b.neighbors ?? []).some((a) => inBBox(lon, lat, a.bbox) && pointInShape(lon, lat, a.shape));
}
