/**
 * Finding where two named roads meet, using Census TIGER/Line road files.
 *
 * TIGER roads are topologically integrated: where two roads meet they share
 * an identical vertex. So the intersection of "Olive Mill Rd" and "Hot
 * Springs Rd" is simply a vertex that appears on both. For each county we
 * index only the road names that some project actually asks about, which
 * keeps memory small even for Los Angeles County.
 */
import type { Area } from './boundaries.ts';
import { distanceToShapeKm } from './geometry.ts';
import { haversineKm } from './location.ts';
import type { ShapefileFeature } from './shapefile.ts';
import { streetKeys } from './streets.ts';

export interface RoadIndex {
  /** Street key ("full" or "base") -> vertex keys ("lon,lat" at 1e-6). */
  byKey: Map<string, Set<string>>;
}

const vertexKey = (lon: number, lat: number) => `${lon.toFixed(6)},${lat.toFixed(6)}`;

/** Build an index of the roads whose names are in `wanted` (street keys). */
export function buildRoadIndex(features: Iterable<ShapefileFeature>, wanted: Set<string>): RoadIndex {
  const byKey = new Map<string, Set<string>>();
  for (const f of features) {
    if (!f.shape || !f.properties.FULLNAME) continue;
    const k = streetKeys(f.properties.FULLNAME);
    if (!k) continue;
    const keys = [k.full, k.base].filter((x) => wanted.has(x));
    if (keys.length === 0) continue;
    for (const key of new Set(keys)) {
      let set = byKey.get(key);
      if (!set) byKey.set(key, (set = new Set()));
      for (const line of f.shape) for (const [lon, lat] of line) set.add(vertexKey(lon, lat));
    }
  }
  return { byKey };
}

/** The vertices of every road matching this name, preferring an exact key. */
function verticesFor(index: RoadIndex, name: string): Set<string> | null {
  const k = streetKeys(name);
  if (!k) return null;
  return index.byKey.get(k.full) ?? index.byKey.get(k.base) ?? null;
}

export type IntersectionResult =
  | { ok: true; lon: number; lat: number; streets: [string, string] }
  | { ok: false; reason: 'no-names' | 'street-not-found' | 'no-crossing' | 'ambiguous' | 'outside-area' };

/** How far outside the listed city a matched intersection may be. */
const CITY_SLACK_KM = 2;
/** Crossings within this distance are treated as one place. */
const SAME_PLACE_KM = 1.5;

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
  const verts = names.map((n) => verticesFor(index, n));
  if (verts.filter(Boolean).length < 2) return { ok: false, reason: 'street-not-found' };

  let sawCrossing = false;
  let sawOutside = false;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = verts[i];
      const b = verts[j];
      if (!a || !b) continue;
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      let points: { lon: number; lat: number }[] = [];
      for (const v of small) {
        if (!big.has(v)) continue;
        const [lon, lat] = v.split(',').map(Number);
        points.push({ lon, lat });
      }
      if (points.length === 0) continue;
      sawCrossing = true;
      if (area.city) points = points.filter((p) => distanceToShapeKm(p.lon, p.lat, area.city!.shape) <= CITY_SLACK_KM);
      else if (area.county) points = points.filter((p) => distanceToShapeKm(p.lon, p.lat, area.county!.shape) <= 0.5);
      if (points.length === 0) {
        sawOutside = true;
        continue;
      }
      // All crossings must be one place (a road can meet another at a few nearby vertices).
      const first = points[0];
      if (points.every((p) => haversineKm(p, first) <= SAME_PLACE_KM)) {
        const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
        const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
        return { ok: true, lon, lat, streets: [names[i], names[j]] };
      }
      return { ok: false, reason: 'ambiguous' };
    }
  }
  if (sawOutside) return { ok: false, reason: 'outside-area' };
  return { ok: false, reason: sawCrossing ? 'ambiguous' : 'no-crossing' };
}
