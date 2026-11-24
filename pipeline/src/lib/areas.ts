/**
 * Projects known only to a city, ZIP code or county, grouped by that area.
 *
 * A random spot inside the area (what the map did before) reads as a real
 * site: on the live map 59% of projects were scattered that way. Instead, each
 * area gets an anchor and the map shows, by zoom:
 *
 *   z3–7    one badge per county, counting every such project in it
 *   z8–10   one badge per city, ZIP code or county area
 *   z11+    each project as a dot, laid out in a sunflower spiral around the
 *           area's anchor (newest filing in the middle), so every project is
 *           visible and clickable but plainly arranged, not located
 *
 * All three go in one tileset per time window (areas-<scope>.pmtiles), using
 * tippecanoe's per-feature zoom ranges and no clustering. Selecting a project
 * highlights its area's outline from the boundaries tileset.
 *
 * Anchors: a city's own GNIS "Populated Place" point (its downtown; else its
 * "Civil" point), else the
 * point deepest inside its outline; a ZIP code's deepest point; a county's
 * deepest point, except that county badges sit at the county seat, where most
 * of what they count is.
 */
import type { PublishedArea, TilePointProperties } from '../../../packages/shared/src/index.ts';
import { STATUSES, stageCountKey } from '../../../packages/shared/src/index.ts';
import type { PointFeature } from './aggregate.ts';
import type { Area, Boundaries } from './boundaries.ts';
import { type BBox, inBBox, pointInShape, type Shape } from './geometry.ts';
import type { Gazetteer } from './landmarks.ts';
import type { PlacementArea } from './location.ts';

/** Minimum zooms (see the file comment). */
export const AREA_BADGE_MINZOOM = 8;
export const AREA_DOT_MINZOOM = 11;

/**
 * Spiral step: dot i sits STEP·√i from the anchor at i golden angles. Neighbors
 * end up about 1.8·STEP apart: ~12 px at zoom 11, where dots first show.
 */
export const SPIRAL_STEP_M = 210;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** County seats, for county badges (normalized county key -> seat). */
export const COUNTY_SEAT: Readonly<Record<string, string>> = {
  alameda: 'Oakland',
  alpine: 'Markleeville',
  amador: 'Jackson',
  butte: 'Oroville',
  calaveras: 'San Andreas',
  colusa: 'Colusa',
  'contra costa': 'Martinez',
  'del norte': 'Crescent City',
  'el dorado': 'Placerville',
  fresno: 'Fresno',
  glenn: 'Willows',
  humboldt: 'Eureka',
  imperial: 'El Centro',
  inyo: 'Independence',
  kern: 'Bakersfield',
  kings: 'Hanford',
  lake: 'Lakeport',
  lassen: 'Susanville',
  'los angeles': 'Los Angeles',
  madera: 'Madera',
  marin: 'San Rafael',
  mariposa: 'Mariposa',
  mendocino: 'Ukiah',
  merced: 'Merced',
  modoc: 'Alturas',
  mono: 'Bridgeport',
  monterey: 'Salinas',
  napa: 'Napa',
  nevada: 'Nevada City',
  orange: 'Santa Ana',
  placer: 'Auburn',
  plumas: 'Quincy',
  riverside: 'Riverside',
  sacramento: 'Sacramento',
  'san benito': 'Hollister',
  'san bernardino': 'San Bernardino',
  'san diego': 'San Diego',
  'san francisco': 'San Francisco',
  'san joaquin': 'Stockton',
  'san luis obispo': 'San Luis Obispo',
  'san mateo': 'Redwood City',
  'santa barbara': 'Santa Barbara',
  'santa clara': 'San Jose',
  'santa cruz': 'Santa Cruz',
  shasta: 'Redding',
  sierra: 'Downieville',
  siskiyou: 'Yreka',
  solano: 'Fairfield',
  sonoma: 'Santa Rosa',
  stanislaus: 'Modesto',
  sutter: 'Yuba City',
  tehama: 'Red Bluff',
  trinity: 'Weaverville',
  tulare: 'Visalia',
  tuolumne: 'Sonora',
  ventura: 'Ventura',
  yolo: 'Woodland',
  yuba: 'Marysville',
};

type LonLat = { lon: number; lat: number };

/** The key for an area group, also its boundary feature ids: "city:fresno", "zip:95660", "county:inyo|mono". */
export function groupKey(a: PlacementArea): string {
  return `${a.kind}:${a.keys.join('|')}`;
}

/** Boundary feature ids for an area: one per key. */
export function boundaryIds(a: PlacementArea): string[] {
  return a.keys.map((k) => `${a.kind}:${k}`);
}

function table(b: Boundaries, kind: PlacementArea['kind']): Record<string, Area> {
  return kind === 'zip' ? (b.zips ?? {}) : kind === 'city' ? b.places : b.counties;
}

export function areaBBox(a: PlacementArea, b: Boundaries): BBox | null {
  const areas = a.keys.map((k) => table(b, a.kind)[k]).filter((x): x is Area => !!x);
  if (areas.length === 0) return null;
  return [
    Math.min(...areas.map((x) => x.bbox[0])),
    Math.min(...areas.map((x) => x.bbox[1])),
    Math.max(...areas.map((x) => x.bbox[2])),
    Math.max(...areas.map((x) => x.bbox[3])),
  ];
}

export function publishedArea(a: PlacementArea, b: Boundaries): PublishedArea | null {
  const bbox = areaBBox(a, b);
  if (!bbox) return null;
  const r = (x: number) => Math.round(x * 1e5) / 1e5;
  return { kind: a.kind, name: a.name, keys: boundaryIds(a), bbox: bbox.map(r) as PublishedArea['bbox'] };
}

/**
 * The point deepest inside a shape (farthest from its edges), by a coarse grid
 * search refined three times. Good to ~1% of the shape's size, plenty for an
 * anchor. Uses the largest piece's box, so an outlying island can't win.
 */
export function interiorPoint(shape: Shape, bbox: BBox): LonLat {
  const kx = Math.cos((((bbox[1] + bbox[3]) / 2) * Math.PI) / 180);
  const edgeDist = (lon: number, lat: number) => {
    let best = Infinity;
    for (const ring of shape)
      for (let i = 1; i < ring.length; i++) {
        const [ax, ay] = ring[i - 1];
        const [bx, by] = ring[i];
        const dx = (bx - ax) * kx;
        const dy = by - ay;
        const px = (lon - ax) * kx;
        const py = lat - ay;
        const len = dx * dx + dy * dy;
        const t = len === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len));
        best = Math.min(best, Math.hypot(px - t * dx, py - t * dy));
      }
    return best;
  };
  let [w, s, e, n] = bbox;
  let best: LonLat | null = null;
  let bestD = -1;
  for (let pass = 0; pass < 4; pass++) {
    const steps = 24;
    for (let i = 0; i <= steps; i++)
      for (let j = 0; j <= steps; j++) {
        const lon = w + ((e - w) * i) / steps;
        const lat = s + ((n - s) * j) / steps;
        if (!pointInShape(lon, lat, shape)) continue;
        const d = edgeDist(lon, lat);
        if (d > bestD) {
          bestD = d;
          best = { lon, lat };
        }
      }
    if (!best) break;
    const hw = (e - w) / 8;
    const hh = (n - s) / 8;
    [w, s, e, n] = [best.lon - hw, best.lat - hh, best.lon + hw, best.lat + hh];
  }
  return best ?? { lon: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
}

/** Anchors, computed once per area. */
export class Anchors {
  private cache = new Map<string, LonLat>();
  private b: Boundaries;
  private gnis: Gazetteer | null;
  constructor(b: Boundaries, gnis: Gazetteer | null) {
    this.b = b;
    this.gnis = gnis;
  }

  /** A city's downtown (its GNIS populated place, else civil point, inside it), else its deepest point. */
  city(key: string): LonLat | null {
    return this.memo(`city:${key}`, () => {
      const a = this.b.places[key];
      if (!a) return null;
      const pad = 0.01;
      const candidates = [...(this.gnis?.towns?.[key] ?? []), ...(this.gnis?.names[key] ?? [])].filter(
        (f) =>
          (f.c === 'Populated Place' || f.c === 'Civil') &&
          inBBox(f.lon, f.lat, [a.bbox[0] - pad, a.bbox[1] - pad, a.bbox[2] + pad, a.bbox[3] + pad]) &&
          pointInShape(f.lon, f.lat, a.shape),
      );
      // The populated place is the downtown; the civil (incorporated city) point is the fallback.
      const named = candidates.find((f) => f.c === 'Populated Place') ?? candidates[0];
      return named ? { lon: named.lon, lat: named.lat } : interiorPoint(a.shape, a.bbox);
    });
  }

  zip(key: string): LonLat | null {
    return this.memo(`zip:${key}`, () => {
      const a = this.b.zips?.[key];
      return a ? interiorPoint(a.shape, a.bbox) : null;
    });
  }

  county(key: string): LonLat | null {
    return this.memo(`county:${key}`, () => {
      const a = this.b.counties[key];
      return a ? interiorPoint(a.shape, a.bbox) : null;
    });
  }

  /** Where a county's badge goes: its seat's downtown, else its deepest point. */
  countyBadge(key: string): LonLat | null {
    return this.memo(`seat:${key}`, () => {
      const seat = COUNTY_SEAT[key]?.toLowerCase();
      if (seat && this.b.places[seat]) return this.city(seat);
      const g = seat
        ? [...(this.gnis?.towns?.[seat] ?? []), ...(this.gnis?.names[seat] ?? [])].find(
            (f) => f.c === 'Populated Place' && f.k === key,
          )
        : null;
      return g ? { lon: g.lon, lat: g.lat } : this.county(key);
    });
  }

  /** The anchor of an area group: of its first key. */
  of(a: PlacementArea): LonLat | null {
    const k = a.keys[0];
    return a.kind === 'city' ? this.city(k) : a.kind === 'zip' ? this.zip(k) : this.county(k);
  }

  /** The county an area group's anchor lies in (for county badges). */
  countyOf(a: PlacementArea): string | null {
    if (a.kind === 'county') return a.keys[0];
    return this.memoKey(`in:${groupKey(a)}`, () => {
      const p = this.of(a);
      if (!p) return null;
      for (const [k, c] of Object.entries(this.b.counties))
        if (inBBox(p.lon, p.lat, c.bbox) && pointInShape(p.lon, p.lat, c.shape)) return k;
      return null;
    });
  }

  private memo(k: string, f: () => LonLat | null): LonLat | null {
    if (!this.cache.has(k)) {
      const v = f();
      if (v) this.cache.set(k, v);
      else return null;
    }
    return this.cache.get(k)!;
  }

  private keys = new Map<string, string | null>();
  private memoKey(k: string, f: () => string | null): string | null {
    if (!this.keys.has(k)) this.keys.set(k, f());
    return this.keys.get(k)!;
  }
}

/** Position i of a sunflower spiral around the anchor (i = 0 is the middle). */
export function spiralPosition(anchor: LonLat, i: number, stepM = SPIRAL_STEP_M): LonLat {
  const r = stepM * Math.sqrt(i + 0.5);
  const a = i * GOLDEN_ANGLE;
  const dLat = (r * Math.sin(a)) / 111_320;
  const dLon = (r * Math.cos(a)) / (111_320 * Math.cos((anchor.lat * Math.PI) / 180));
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return { lon: round(anchor.lon + dLon), lat: round(anchor.lat + dLat) };
}

export interface AreaMember {
  point: PointFeature;
  area: PlacementArea;
  /** Latest filing date, for ordering (newest in the middle). */
  latest: string;
}

/** A feature for tippecanoe, with its own zoom range. */
export interface AreaTileFeature {
  type: 'Feature';
  tippecanoe: { minzoom?: number; maxzoom?: number };
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, string | number>;
}

function countsFor(members: AreaMember[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const s of STATUSES) c[stageCountKey(s.id)] = 0;
  let r = 0;
  let n = 0;
  for (const m of members) {
    c[stageCountKey(m.point.properties.s)]++;
    if (m.point.properties.r) r++;
    if (m.point.properties.n) n++;
  }
  return { ...c, r, n, total: members.length };
}

const bboxProps = (bb: BBox) => ({ w: bb[0], s: bb[1], e: bb[2], nb: bb[3] });

/**
 * Tile features for one time window: county badges, area badges and dots.
 * `f` says which: "c" county badge, "b" area badge, "d" dot.
 */
export function areaTileFeatures(members: AreaMember[], b: Boundaries, anchors: Anchors): AreaTileFeature[] {
  const groups = new Map<string, AreaMember[]>();
  for (const m of members) {
    const k = groupKey(m.area);
    const list = groups.get(k);
    if (list) list.push(m);
    else groups.set(k, [m]);
  }
  const out: AreaTileFeature[] = [];
  const byCounty = new Map<string, AreaMember[]>();
  for (const [key, list] of groups) {
    const area = list[0].area;
    const anchor = anchors.of(area);
    const bbox = areaBBox(area, b);
    if (!anchor || !bbox) continue;
    // Newest filing in the middle; SCH number breaks ties so layouts are stable.
    list.sort((x, y) =>
      x.latest < y.latest ? 1 : x.latest > y.latest ? -1 : x.point.properties.id < y.point.properties.id ? -1 : 1,
    );
    list.forEach((m, i) => {
      const p = spiralPosition(anchor, i);
      const props: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(m.point.properties as TilePointProperties)) if (v !== undefined) props[k] = v;
      out.push({
        type: 'Feature',
        tippecanoe: { minzoom: AREA_DOT_MINZOOM },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { ...props, f: 'd', an: area.name },
      });
    });
    out.push({
      type: 'Feature',
      tippecanoe: { minzoom: AREA_BADGE_MINZOOM, maxzoom: AREA_DOT_MINZOOM - 1 },
      geometry: { type: 'Point', coordinates: [anchor.lon, anchor.lat] },
      properties: { f: 'b', id: key, an: area.name, ...bboxProps(bbox), ...countsFor(list) },
    });
    const county = anchors.countyOf(area);
    if (county) {
      const l = byCounty.get(county);
      if (l) l.push(...list);
      else byCounty.set(county, [...list]);
    }
  }
  for (const [county, list] of byCounty) {
    const at = anchors.countyBadge(county);
    const c = b.counties[county];
    if (!at || !c) continue;
    out.push({
      type: 'Feature',
      tippecanoe: { maxzoom: AREA_BADGE_MINZOOM - 1 },
      geometry: { type: 'Point', coordinates: [at.lon, at.lat] },
      properties: {
        f: 'c',
        id: `county-badge:${county}`,
        an: `${c.name} County`,
        ...bboxProps(c.bbox),
        ...countsFor(list),
      },
    });
  }
  return out;
}

/** City, ZIP code and county outlines as GeoJSON lines for tippecanoe (layer `areas`, property `k`). */
export function* boundaryFeatures(b: Boundaries): Generator<string> {
  const emit = (kind: string, key: string, a: Area) =>
    JSON.stringify({
      type: 'Feature',
      properties: { k: `${kind}:${key}`, nm: a.name },
      geometry: { type: 'MultiPolygon', coordinates: a.shape.map((ring) => [ring]) },
    });
  for (const [k, a] of Object.entries(b.counties)) yield emit('county', k, a);
  for (const [k, a] of Object.entries(b.places)) yield emit('city', k, a);
  for (const [k, a] of Object.entries(b.zips ?? {})) yield emit('zip', k, a);
}
