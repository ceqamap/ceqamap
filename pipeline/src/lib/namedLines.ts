/**
 * Roads, highways and waterways named in a project's own words, and what they
 * say about where it is:
 *
 *   "Remove and Replace Concrete Median Barriers, Install Signs on SR-76"
 *   "routine maintenance of aggraded sediments within Quiota Creek under ...
 *    the bottomless arch culvert-bridge known as Quiota Crossing 0A"
 *   "widen State Route 76 from Melrose Drive to Interstate 15"
 *
 * The lines come from Census TIGER/Line: roads (as for cross streets) and
 * linear water (streams, rivers, canals). For each project, in order:
 *
 *   1. crossing   Two named lines that meet in one place inside the listed
 *                 city or county ("State Route 76" and "Melrose Drive";
 *                 "Eel River" and "Dyerville Loop Road").
 *   2. place      A place name with several same-name places in the county
 *                 (two "Emigrant Pass" in Inyo County) settled by a named
 *                 road: the one place within NEAR_LINE_KM of it.
 *   3. crossing   A named waterway and the words crossing, bridge or culvert,
 *                 with no road named: where the waterway crosses a public
 *                 road, if every such crossing in the area is one place.
 *   4. along      Exactly one named line, short inside the area (see
 *                 placeAlongLines): a spot along it. Still approximate.
 *
 * Text names are strict: Title Case (or all-caps text) words ending in a
 * street or water type ("Melrose Drive", "Quiota Creek"), numbered routes
 * ("SR-76", "I-5", "Highway 1"), and nothing that names a city.
 */
import { type Area, type Boundaries, normalizePlaceName } from './boundaries.ts';
import type { CeqaDocument } from './document.ts';
import { pointInShape } from './geometry.ts';
import {
  crossings,
  firstMeeting,
  type Line,
  lineBBox,
  linesFor,
  placeAlongLines,
  pointSegmentKm,
  type RoadIndex,
  withinArea,
} from './intersections.ts';
import type { AmbiguousPlace } from './landmarks.ts';
import { haversineKm } from './location.ts';
import type { ShapefileFeature } from './shapefile.ts';
import { streetKeys } from './streets.ts';

const STREET_TYPE = new Set([
  'road',
  'rd',
  'street',
  'st',
  'avenue',
  'ave',
  'boulevard',
  'blvd',
  'drive',
  'dr',
  'lane',
  'ln',
  'way',
  'parkway',
  'pkwy',
  'highway',
  'hwy',
  'expressway',
  'expy',
  'circle',
  'court',
  'ct',
  'terrace',
  'loop',
]);
const WATER_TYPE = new Set(['creek', 'river', 'slough', 'canal', 'wash', 'drain', 'channel', 'ditch', 'brook']);
/** Words that end a name when walking back from its type ("between Horner St" -> "Horner St"). */
const STOP = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'at',
  'on',
  'in',
  'to',
  'from',
  'between',
  'along',
  'near',
  'via',
  'off',
  'onto',
  'into',
  'across',
  'under',
  'over',
  'with',
  'within',
  'adjacent',
  'located',
  'including',
  'includes',
  'project',
  'proposed',
  'existing',
  'new',
  'private',
  'public',
  'access',
  'ranch',
  'haul',
  'frontage',
  'service',
  'county',
  'city',
  'state',
  'unnamed',
  'local',
  'this',
  'that',
  'its',
  'their',
  'said',
  'both',
  'each',
  'per',
  'is',
  'are',
  'was',
  'will',
  'be',
]);
const MAX_NAME_WORDS = 3;
const MAX_NAMES = 6;
/** A named road settles a same-name place within this distance... */
export const NEAR_LINE_KM = 15;
/** ...when every other same-name place is at least this far from the named roads. */
const OTHERS_FAR_KM = 40;
/** Road crossings of a named waterway within this spread count as one place (its middle crossing is used). */
export const WATER_CROSSING_SPREAD_KM = 3;
/** Road classes a stream "crossing" can be on: primary, secondary and local roads (not trails, driveways, ramps). */
const PUBLIC_ROAD = new Set(['S1100', 'S1200', 'S1400']);
const CROSSING_WORDS = /\b(?:crossings?|bridges?|culverts?|ford)\b/i;

/** Numbered routes as written: "SR-76", "State Route 3", "Highway 1", "US 101", "I-5", "Interstate 15". */
const ROUTE_RE =
  /\b(?:State\s+(?:Route|Highway|Hwy|Rte)|S\.?R\.?|Route|Rte|Highway|Hwy|U\.?S\.?(?:\s+(?:Highway|Hwy|Route))?|Interstate|I)[\s-]*(\d{1,3})(?![\d.]|-\d|\/\d)\b/gi;

export function routeNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ROUTE_RE)) {
    if (/^i[\s-]?\d/i.test(m[0]) && !/^I/.test(m[0])) continue; // "i 5" in lowercase prose
    if (/^(?:route|rte|highway|hwy)\b/i.test(m[0]) && Number(m[1]) === 0) continue;
    out.push(m[0].replace(/\s+/g, ' '));
  }
  return out;
}

const WORD = /[A-Za-z0-9][A-Za-z0-9'’.]*/g;
const capitalized = (w: string) => /^[A-Z][a-zA-Z'’.]*$/.test(w) || /^\d+(?:st|nd|rd|th)$/i.test(w);

export interface TextLines {
  /** Streets and numbered routes, as written. */
  roads: string[];
  /** Streams, rivers, canals, as written ("Quiota Creek", "Arroyo Seco"). */
  waters: string[];
  /** The text speaks of a crossing, bridge or culvert. */
  crossingWord: boolean;
}

/**
 * Street, route and waterway names in a project's title and description.
 * `isPlaceName` (normalized) rejects names that are a city ("Walnut Creek").
 */
export function textLines(texts: readonly string[], isPlaceName: (key: string) => boolean = () => false): TextLines {
  const roads: string[] = [];
  const waters: string[] = [];
  const seenRoad = new Set<string>();
  const seenWater = new Set<string>();
  const addRoad = (n: string) => {
    const k = streetKeys(n);
    if (!k || seenRoad.has(k.full)) return;
    seenRoad.add(k.full);
    roads.push(n);
  };
  const addWater = (n: string) => {
    const k = waterKey(n);
    if (!k || seenWater.has(k) || isPlaceName(normalizePlaceName(n))) return;
    seenWater.add(k);
    waters.push(n);
  };
  for (const text of texts) {
    for (const r of routeNames(text)) addRoad(r);
    for (const clause of text.split(/[,;:()[\]{}"“”/]|\.\s|\s[-–—]\s|\n/)) {
      const words = [...clause.matchAll(WORD)].map((m) => m[0].replace(/\.$/, ''));
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const lower = w.toLowerCase();
        const next = words[i + 1]?.toLowerCase() ?? '';
        if (!/^[A-Z]/.test(w)) continue;
        if (STREET_TYPE.has(lower)) {
          const name = nameBefore(words, i);
          if (name) addRoad(`${name} ${w}`);
        } else if (WATER_TYPE.has(lower) && !STREET_TYPE.has(next)) {
          // "Lewis Creek Road" is a road, found by the branch above.
          const name = nameBefore(words, i);
          if (name) addWater(`${name} ${w}`);
        } else if (lower === 'arroyo' && words[i + 1] && capitalized(words[i + 1]) && !STREET_TYPE.has(next)) {
          const after = words[i + 2]?.toLowerCase() ?? '';
          if (!STREET_TYPE.has(after)) addWater(`${w} ${words[i + 1]}`);
        }
      }
    }
  }
  const all = texts.join(' ');
  return {
    roads: roads.slice(0, MAX_NAMES),
    waters: waters.slice(0, MAX_NAMES),
    crossingWord: CROSSING_WORDS.test(all),
  };
}

/** Up to MAX_NAME_WORDS capitalized words before position `end`, stopping at STOP words. */
function nameBefore(words: string[], end: number): string | null {
  const out: string[] = [];
  for (let i = end - 1; i >= 0 && out.length < MAX_NAME_WORDS; i--) {
    const w = words[i];
    const lower = w.toLowerCase();
    if (!capitalized(w)) break;
    if (STOP.has(lower)) break;
    if (STREET_TYPE.has(lower)) break; // "Olive Ave Bridge Road": not one name
    out.unshift(w);
  }
  if (out.length === 0) return null;
  return out.join(' ');
}

/** Normalized waterway name, matching TIGER's "Quiota Crk" to "Quiota Creek". */
export function waterKey(name: string): string | null {
  const k = streetKeys(name);
  return k ? k.full : null;
}

export interface LineRequest {
  sch: string;
  /** Streets and routes: listed cross streets first, then names from the text. */
  roads: string[];
  waters: string[];
  crossingWord: boolean;
  /** Same-name places a named road may settle. */
  places: AmbiguousPlace[];
  city: Area | null;
  /** Normalized county keys to search, in order. */
  counties: string[];
}

export function lineRequest(
  sch: string,
  newestFirst: readonly CeqaDocument[],
  b: Boundaries,
  isCounty: (key: string) => boolean,
  isPlaceName: (key: string) => boolean,
  crossStreetNames: readonly string[] = [],
  places: readonly AmbiguousPlace[] = [],
): LineRequest | null {
  const d = newestFirst[0];
  if (!d) return null;
  const t = textLines([d.projectTitle, d.description], isPlaceName);
  const seen = new Set<string>();
  const roads = [...crossStreetNames, ...t.roads].filter((n) => {
    const k = streetKeys(n)?.full;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (roads.length === 0 && t.waters.length === 0) return null;
  const placeDoc = newestFirst.find((x) => x.cities.length || x.counties.length) ?? d;
  const cityKeys = placeDoc.cities.map(normalizePlaceName).filter((k) => b.places[k]);
  const city = cityKeys.length === 1 ? b.places[cityKeys[0]] : null;
  let counties = placeDoc.counties.map(normalizePlaceName).filter(isCounty);
  if (counties.length === 0 && city) {
    const c = { lon: (city.bbox[0] + city.bbox[2]) / 2, lat: (city.bbox[1] + city.bbox[3]) / 2 };
    counties = Object.keys(b.counties).filter((k) => pointInShape(c.lon, c.lat, b.counties[k].shape));
  }
  if (counties.length === 0 || counties.length > 3) return null;
  return {
    sch,
    roads: roads.slice(0, MAX_NAMES),
    waters: t.waters,
    crossingWord: t.crossingWord,
    places: [...places],
    city,
    counties,
  };
}

export type LinePlacement =
  | { kind: 'crossing'; lon: number; lat: number; names: [string, string] }
  | { kind: 'place'; lon: number; lat: number; name: string; rank: 1 | 2 | 3 }
  | { kind: 'along'; lon: number; lat: number; names: [string] };

export type LineOutcome = { ok: true; placement: LinePlacement } | { ok: false; reason: string };

/** All public roads of a county on a grid, for finding where a stream crosses any road. */
export interface RoadGrid {
  cells: Map<string, { line: Line; name: string }[]>;
}
const CELL_DEG = 0.05;
const cellKey = (x: number, y: number) => `${Math.floor(x / CELL_DEG)}:${Math.floor(y / CELL_DEG)}`;

export function buildRoadGrid(features: Iterable<ShapefileFeature>): RoadGrid {
  const cells = new Map<string, { line: Line; name: string }[]>();
  for (const f of features) {
    if (!f.shape || !PUBLIC_ROAD.has(f.properties.MTFCC)) continue;
    for (const coords of f.shape) {
      if (coords.length < 2) continue;
      const line = { coords, bbox: lineBBox(coords) };
      const entry = { line, name: f.properties.FULLNAME ?? '' };
      for (let x = Math.floor(line.bbox[0] / CELL_DEG); x <= Math.floor(line.bbox[2] / CELL_DEG); x++)
        for (let y = Math.floor(line.bbox[1] / CELL_DEG); y <= Math.floor(line.bbox[3] / CELL_DEG); y++) {
          const k = `${x}:${y}`;
          const list = cells.get(k);
          if (list) list.push(entry);
          else cells.set(k, [entry]);
        }
    }
  }
  return { cells };
}

function roadsNear(grid: RoadGrid, lines: Line[]): { line: Line; name: string }[] {
  const out = new Set<{ line: Line; name: string }>();
  for (const l of lines)
    for (let x = Math.floor(l.bbox[0] / CELL_DEG); x <= Math.floor(l.bbox[2] / CELL_DEG); x++)
      for (let y = Math.floor(l.bbox[1] / CELL_DEG); y <= Math.floor(l.bbox[3] / CELL_DEG); y++)
        for (const e of grid.cells.get(`${x}:${y}`) ?? []) out.add(e);
  return [...out];
}

export function distanceToLinesKm(p: { lon: number; lat: number }, lines: Line[]): number {
  let best = Infinity;
  const pt: [number, number] = [p.lon, p.lat];
  for (const l of lines) {
    // Quick reject by bbox: farther than the current best from the box.
    const dx = Math.max(l.bbox[0] - p.lon, 0, p.lon - l.bbox[2]) * 111.32 * Math.cos((p.lat * Math.PI) / 180);
    const dy = Math.max(l.bbox[1] - p.lat, 0, p.lat - l.bbox[3]) * 111.32;
    if (Math.hypot(dx, dy) >= best) continue;
    for (let i = 1; i < l.coords.length; i++) best = Math.min(best, pointSegmentKm(pt, l.coords[i - 1], l.coords[i]));
  }
  return best;
}

/**
 * Resolve one request in one county. `roads` and `water` index the names some
 * request asks for; `grid` (all public roads) is only needed for waterway
 * crossings with no road named.
 */
export function resolveLines(
  r: LineRequest,
  area: { city: Area | null; county: Area },
  roads: RoadIndex,
  water: RoadIndex | null,
  grid: () => RoadGrid,
): LineOutcome {
  const named: { name: string; lines: Line[] | null }[] = [
    ...r.roads.map((name) => ({ name, lines: linesFor(roads, name, false) })),
    ...r.waters.map((name) => {
      const k = waterKey(name);
      return { name, lines: (k && water?.byKey.get(k)) || null };
    }),
  ];
  // Keep only the parts of each line in (or near) the area, so a creek or
  // road of the same name elsewhere in the county doesn't count.
  for (const n of named) if (n.lines) n.lines = clipToArea(n.lines, area);
  const found = named.filter((n) => n.lines && n.lines.length > 0);

  // 1. Two named lines that meet.
  if (found.length >= 2) {
    const m = firstMeeting(
      found.map((n) => n.lines),
      area,
    );
    if (m.ok)
      return {
        ok: true,
        placement: { kind: 'crossing', lon: m.lon, lat: m.lat, names: [found[m.i].name, found[m.j].name] },
      };
  }

  // 2. Same-name places settled by a named road or waterway.
  if (found.length > 0) {
    const all = found.flatMap((n) => n.lines!);
    for (const p of r.places) {
      const d = p.candidates.map((c) => ({ c, km: distanceToLinesKm(c, all) }));
      const near = d.filter((x) => x.km <= NEAR_LINE_KM);
      if (near.length === 0) continue;
      const first = near[0].c;
      if (!near.every((x) => haversineKm(x.c, first) <= 3)) continue;
      if (d.some((x) => x.km > NEAR_LINE_KM && x.km < OTHERS_FAR_KM)) continue;
      return { ok: true, placement: { kind: 'place', lon: first.lon, lat: first.lat, name: p.name, rank: p.rank } };
    }
  }

  // 3. A named waterway with a crossing, bridge or culvert, and no road named or found.
  const waters = found.filter((n) => r.waters.includes(n.name));
  if (r.crossingWord && waters.length === 1 && found.length === 1) {
    const w = waters[0];
    const near = roadsNear(grid(), w.lines!);
    const points: { lon: number; lat: number; road: string }[] = [];
    for (const e of near) for (const p of crossings(w.lines!, [e.line])) points.push({ ...p, road: e.name });
    const inArea = withinArea(points, area);
    if (inArea.length > 0) {
      const spread = Math.max(...inArea.map((p) => Math.max(...inArea.map((q) => haversineKm(p, q)))));
      // Spread-out crossings (a creek under the same road again and again) fall through to step 4.
      if (spread <= WATER_CROSSING_SPREAD_KM) {
        // The crossing nearest the middle of them all, so the dot sits on a real crossing.
        const mid = {
          lon: inArea.reduce((s, p) => s + p.lon, 0) / inArea.length,
          lat: inArea.reduce((s, p) => s + p.lat, 0) / inArea.length,
        };
        const best = inArea.reduce((a, p) => (haversineKm(p, mid) < haversineKm(a, mid) ? p : a));
        const roadsNamed = [...new Set(inArea.map((p) => p.road).filter(Boolean))];
        const road = roadsNamed.length === 1 ? roadsNamed[0] : best.road || 'a road';
        return { ok: true, placement: { kind: 'crossing', lon: best.lon, lat: best.lat, names: [w.name, road] } };
      }
    }
  }

  // 4. Exactly one named line: a spot along it, if it's short in the area.
  if (found.length === 1) {
    const res = placeAlongLines(found[0].lines!, area, r.sch);
    if (res.ok) return { ok: true, placement: { kind: 'along', lon: res.lon, lat: res.lat, names: [found[0].name] } };
    return { ok: false, reason: `one-line:${res.reason}` };
  }
  return { ok: false, reason: found.length === 0 ? 'not-found' : 'no-meeting' };
}

/** The lines (whole features) that come within the area: the city (15 km slack) or the county. */
function clipToArea(lines: Line[], area: { city: Area | null; county: Area }): Line[] {
  return lines.filter((l) => {
    const mid = l.coords[Math.floor(l.coords.length / 2)];
    return withinArea([{ lon: mid[0], lat: mid[1] }], area).length > 0;
  });
}
