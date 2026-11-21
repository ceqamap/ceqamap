/**
 * Finding where two named roads meet, using Census TIGER/Line road files.
 *
 * Two roads "meet" where they share a vertex (TIGER is topologically
 * integrated at grade) or where their lines cross in plan view, which also
 * catches overpasses and interchanges, where a highway and a local road
 * share no vertex. For each county we index only the road names some
 * project asks about, which keeps memory small even for Los Angeles.
 */
import type { Area } from './boundaries.ts';
import { type BBox, distanceToShapeKm, inBBox, pointInShape } from './geometry.ts';
import { haversineKm } from './location.ts';
import { seededRandom } from './random.ts';
import type { ShapefileFeature } from './shapefile.ts';
import { streetKeys } from './streets.ts';

interface Line {
  coords: [number, number][];
  bbox: BBox;
}

export interface RoadIndex {
  /** Street key ("full" or "base") -> road lines with that name. */
  byKey: Map<string, Line[]>;
}

function lineBBox(coords: [number, number][]): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

const overlaps = (a: BBox, b: BBox) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** Build an index of the roads whose names are in `wanted` (street keys). */
export function buildRoadIndex(features: Iterable<ShapefileFeature>, wanted: Set<string>): RoadIndex {
  const byKey = new Map<string, Line[]>();
  for (const f of features) {
    if (!f.shape || !f.properties.FULLNAME) continue;
    const k = streetKeys(f.properties.FULLNAME);
    if (!k) continue;
    const keys = new Set([k.full, k.nodir, k.base].filter((x) => wanted.has(x)));
    if (keys.size === 0) continue;
    const lines = f.shape.filter((l) => l.length >= 2).map((coords) => ({ coords, bbox: lineBBox(coords) }));
    for (const key of keys) {
      const list = byKey.get(key);
      if (list) list.push(...lines);
      else byKey.set(key, [...lines]);
    }
  }
  return { byKey };
}

/**
 * Roads that could be this name.
 *   strict: the same name, ignoring only a leading direction
 *           ("Olive Ave" finds "W Olive Ave", not "Olive St")
 *   loose:  also the bare name ("Olive" finds Olive Ave and Olive St);
 *           used only when the strict pass finds nothing
 */
function linesFor(index: RoadIndex, name: string, loose: boolean): Line[] | null {
  const k = streetKeys(name);
  if (!k) return null;
  // Index keys are the roads' own full/nodir/base names; match ours against them.
  const keys = loose ? [k.nodir, k.base] : [k.nodir];
  const all = [...new Set(keys.flatMap((key) => index.byKey.get(key) ?? []))];
  return all.length ? all : null;
}

/** Where segment p1-p2 crosses q1-q2, if it does. */
function segmentCrossing(
  p1: [number, number],
  p2: [number, number],
  q1: [number, number],
  q2: [number, number],
): [number, number] | null {
  const d = (p2[0] - p1[0]) * (q2[1] - q1[1]) - (p2[1] - p1[1]) * (q2[0] - q1[0]);
  if (d === 0) return null;
  const t = ((q1[0] - p1[0]) * (q2[1] - q1[1]) - (q1[1] - p1[1]) * (q2[0] - q1[0])) / d;
  const u = ((q1[0] - p1[0]) * (p2[1] - p1[1]) - (q1[1] - p1[1]) * (p2[0] - p1[0])) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

/** All points where any line in A meets any line in B. */
export function crossings(a: Line[], b: Line[]): { lon: number; lat: number }[] {
  const out: { lon: number; lat: number }[] = [];
  for (const la of a) {
    for (const lb of b) {
      if (!overlaps(la.bbox, lb.bbox)) continue;
      for (let i = 1; i < la.coords.length; i++) {
        const p1 = la.coords[i - 1];
        const p2 = la.coords[i];
        const sb: BBox = [
          Math.min(p1[0], p2[0]),
          Math.min(p1[1], p2[1]),
          Math.max(p1[0], p2[0]),
          Math.max(p1[1], p2[1]),
        ];
        if (!overlaps(sb, lb.bbox)) continue;
        for (let j = 1; j < lb.coords.length; j++) {
          const x = segmentCrossing(p1, p2, lb.coords[j - 1], lb.coords[j]);
          if (x) out.push({ lon: x[0], lat: x[1] });
        }
      }
    }
  }
  return out;
}

/** Roads that end this close to another named road are treated as meeting it. */
export const NEAR_MEET_KM = 0.06;

/** Shortest distance (km) from a point to segment q1-q2, in a local flat projection. */
function pointSegmentKm(p: [number, number], q1: [number, number], q2: [number, number]): number {
  const kx = 111.32 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 111.32;
  const ax = (q1[0] - p[0]) * kx;
  const ay = (q1[1] - p[1]) * ky;
  const bx = (q2[0] - p[0]) * kx;
  const by = (q2[1] - p[1]) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * Where a line of one road ends within NEAR_MEET_KM of the other road: gaps
 * at roundabouts, interchanges and slightly misaligned geometry.
 */
export function nearMeetings(a: Line[], b: Line[]): { lon: number; lat: number }[] {
  const pad = NEAR_MEET_KM / 80;
  const out: { lon: number; lat: number }[] = [];
  const check = (from: Line[], to: Line[]) => {
    for (const l of from) {
      for (const end of [l.coords[0], l.coords[l.coords.length - 1]]) {
        for (const m of to) {
          const bb = m.bbox;
          if (end[0] < bb[0] - pad || end[0] > bb[2] + pad || end[1] < bb[1] - pad || end[1] > bb[3] + pad) continue;
          for (let j = 1; j < m.coords.length; j++) {
            if (pointSegmentKm(end, m.coords[j - 1], m.coords[j]) <= NEAR_MEET_KM) {
              out.push({ lon: end[0], lat: end[1] });
              break;
            }
          }
        }
      }
    }
  };
  check(a, b);
  check(b, a);
  return out;
}

export type IntersectionResult =
  | { ok: true; lon: number; lat: number; streets: [string, string] }
  | { ok: false; reason: 'no-names' | 'street-not-found' | 'no-crossing' | 'ambiguous' | 'outside-area' };

/** Crossings within this distance of the listed city's limits count as "in" it. */
const CITY_SLACK_KM = 2;
/** Agencies often list the nearest city for projects just outside it. */
const CITY_NEARBY_KM = 15;
/** Crossings within this distance of each other are treated as one place. */
const SAME_PLACE_KM = 1.5;

function onePlace(points: { lon: number; lat: number }[]): { lon: number; lat: number } | null {
  const first = points[0];
  if (!points.every((p) => haversineKm(p, first) <= SAME_PLACE_KM)) return null;
  return {
    lon: points.reduce((s, p) => s + p.lon, 0) / points.length,
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
  };
}

/**
 * Find where any two of `names` meet, inside (or near) the listed city when
 * one is given, otherwise anywhere in the county. Gives up rather than guess
 * when the same pair of names crosses in several far-apart places.
 */
export function findIntersection(
  index: RoadIndex,
  names: string[],
  area: { city?: Area | null; county?: Area | null },
): IntersectionResult {
  if (names.length < 2) return { ok: false, reason: 'no-names' };
  const strict = match(index, names, area, false);
  if (strict.ok) return strict;
  const loose = match(index, names, area, true);
  // Report the strict pass's reason unless the loose pass got further.
  return loose.ok || strict.reason === 'street-not-found' ? loose : strict;
}

function match(
  index: RoadIndex,
  names: string[],
  area: { city?: Area | null; county?: Area | null },
  loose: boolean,
): IntersectionResult {
  const lines = names.map((n) => linesFor(index, n, loose));
  if (lines.filter(Boolean).length < 2) return { ok: false, reason: 'street-not-found' };

  let sawCrossing = false;
  let sawOutside = false;
  let sawAmbiguous = false;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (!lines[i] || !lines[j]) continue;
      let points = crossings(lines[i]!, lines[j]!);
      if (points.length === 0) points = nearMeetings(lines[i]!, lines[j]!);
      if (points.length === 0) continue;
      sawCrossing = true;
      if (area.county) points = points.filter((p) => distanceToShapeKm(p.lon, p.lat, area.county!.shape) <= 0.5);
      let candidates = points;
      if (area.city) {
        candidates = points.filter((p) => distanceToShapeKm(p.lon, p.lat, area.city!.shape) <= CITY_SLACK_KM);
        if (candidates.length === 0) {
          // The listed city may just be the nearest one: accept a single nearby crossing.
          candidates = points.filter((p) => distanceToShapeKm(p.lon, p.lat, area.city!.shape) <= CITY_NEARBY_KM);
        }
      }
      if (candidates.length === 0) {
        sawOutside = true;
        continue;
      }
      const place = onePlace(candidates);
      if (place) return { ok: true, ...place, streets: [names[i], names[j]] };
      sawAmbiguous = true;
    }
  }
  if (sawAmbiguous) return { ok: false, reason: 'ambiguous' };
  if (sawOutside) return { ok: false, reason: 'outside-area' };
  return { ok: false, reason: sawCrossing ? 'outside-area' : 'no-crossing' };
}

/** A single listed street is only useful if it is short within the area. */
export const MAX_STREET_SPREAD_KM = 15;

export type StreetResult =
  | { ok: true; lon: number; lat: number; lengthKm: number }
  | { ok: false; reason: 'street-not-found' | 'outside-area' | 'too-long' };

/**
 * A seeded random spot along the one street a project lists, on the part of
 * it inside the listed city (or, with no city, the listed county). Gives up
 * when that part spreads over more than MAX_STREET_SPREAD_KM, where "along
 * the street" would say little more than "in the county".
 */
export function placeAlongStreet(
  index: RoadIndex,
  name: string,
  area: { city?: Area | null; county?: Area | null },
  seed: string,
): StreetResult {
  const lines = linesFor(index, name, false) ?? linesFor(index, name, true);
  if (!lines) return { ok: false, reason: 'street-not-found' };
  const within = area.city ?? area.county;
  const segs: { a: [number, number]; b: [number, number]; km: number }[] = [];
  for (const l of lines) {
    for (let i = 1; i < l.coords.length; i++) {
      const p = l.coords[i - 1];
      const q = l.coords[i];
      // Long straight segments (rural roads) are cut into ~100 m pieces, so
      // the part inside the area is kept even if the segment crosses its edge.
      const km = haversineKm({ lon: p[0], lat: p[1] }, { lon: q[0], lat: q[1] });
      const pieces = Math.max(1, Math.ceil(km / 0.1));
      for (let k = 0; k < pieces; k++) {
        const a: [number, number] = [p[0] + ((q[0] - p[0]) * k) / pieces, p[1] + ((q[1] - p[1]) * k) / pieces];
        const b: [number, number] = [
          p[0] + ((q[0] - p[0]) * (k + 1)) / pieces,
          p[1] + ((q[1] - p[1]) * (k + 1)) / pieces,
        ];
        const mx = (a[0] + b[0]) / 2;
        const my = (a[1] + b[1]) / 2;
        if (within && !(inBBox(mx, my, within.bbox) && pointInShape(mx, my, within.shape))) continue;
        segs.push({ a, b, km: km / pieces });
      }
    }
  }
  if (segs.length === 0) return { ok: false, reason: 'outside-area' };
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const g of segs)
    for (const [x, y] of [g.a, g.b]) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
  if (haversineKm({ lon: w, lat: s }, { lon: e, lat: n }) > MAX_STREET_SPREAD_KM)
    return { ok: false, reason: 'too-long' };
  const total = segs.reduce((t, g) => t + g.km, 0);
  let pick = seededRandom(`${seed}:street`)() * total;
  for (const g of segs) {
    if (pick <= g.km || g === segs[segs.length - 1]) {
      const t = g.km === 0 ? 0 : Math.min(1, pick / g.km);
      return {
        ok: true,
        lon: g.a[0] + t * (g.b[0] - g.a[0]),
        lat: g.a[1] + t * (g.b[1] - g.a[1]),
        lengthKm: Math.round(total * 10) / 10,
      };
    }
    pick -= g.km;
  }
  return { ok: false, reason: 'street-not-found' }; // unreachable
}
