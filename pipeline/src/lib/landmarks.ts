import { type Boundaries, normalizePlaceName } from './boundaries.ts';
import type { CeqaDocument } from './document.ts';
import { distanceToShapeKm } from './geometry.ts';
import { haversineKm, listedPlaces } from './location.ts';

/**
 * Named places in a project's own words: "dredging at Southwestern Yacht Club
 * ... beach nourishment at La Playa Beach, Shelter Island". Many projects
 * without coordinates, an address or cross streets still name a beach, park,
 * dam, airport, school or community. We look those names up in the USGS
 * Geographic Names Information System (GNIS, public domain) and place the
 * project there.
 *
 * Deliberately strict, because a wrong confident point is worse than an
 * honest approximate one:
 *   - Only names written in Title Case in the text, of two words or more
 *     ("Shelter Island", not "island" or "Alpine").
 *   - Only point-like feature classes. Streams, valleys, ranges, lakes and
 *     bays are too big to stand for a project site.
 *   - The feature must be in a county the project lists, and near a city it
 *     lists (if any).
 *   - Names of cities and counties are skipped: they add nothing.
 *   - Same name, several places in the county (more than 3 km apart): skipped.
 *   - Several different named places more than 15 km apart (a pipeline from
 *     one to the other, a countywide program): skipped.
 *   - A name followed by a street type or an organization word is a street or
 *     an agency, not the place: "San Pedro Street", "El Toro Road", "San
 *     Joaquin Hills Transportation Corridor Agency".
 *
 * Measured on all approximately placed projects (2026-11-21): about 14,000 of
 * 286,000 name a place GNIS can locate; a hand check of 70 looked right in
 * roughly 8 of 10, and most misses were the street and agency names above.
 * Since GNIS dropped buildings, schools, parks and dams in 2022, what's left
 * is natural features (islands, beaches, points, summits, springs, passes),
 * military sites, and communities.
 */

export interface Gazetteer {
  /** Source and vintage, for the record. */
  source: string;
  /** Normalized name -> features with that name. */
  names: Record<string, GazetteerFeature[]>;
}

export interface GazetteerFeature {
  /** Name as published. */
  n: string;
  /** Feature class (GNIS), e.g. "Beach". */
  c: string;
  /** County, normalized like boundary keys ("san diego"). */
  k: string;
  lon: number;
  lat: number;
}

/**
 * Feature classes we place projects at, best first. Rank 1: a specific site.
 * Rank 2: a place with some extent (a park, a summit, a locale). Rank 3: a
 * community, which can cover a few square miles.
 */
export const CLASS_RANK: Readonly<Record<string, 1 | 2 | 3>> = {
  Airport: 1,
  Arch: 1,
  Beach: 1,
  Bridge: 1,
  Building: 1,
  Cape: 1,
  Cemetery: 1,
  Church: 1,
  Crossing: 1,
  Dam: 1,
  Falls: 1,
  Harbor: 1,
  Hospital: 1,
  Island: 1,
  Isthmus: 1,
  Military: 1,
  Mine: 1,
  Pillar: 1,
  'Post Office': 1,
  School: 1,
  Spring: 1,
  Tower: 1,
  Tunnel: 1,
  Well: 1,
  Bar: 2,
  Bench: 2,
  Bend: 2,
  Cliff: 2,
  Crater: 2,
  Gap: 2,
  Locale: 2,
  Oilfield: 2,
  Park: 2,
  Summit: 2,
  'Populated Place': 3,
};

const CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'of', 'the', 'and', 'y', 'at', 'on', 'by', 'du']);
const MAX_WORDS = 6;
/** A name followed by one of these is a street or an organization, not a place. */
const NOT_A_PLACE_AFTER = new Set([
  'street',
  'st',
  'road',
  'rd',
  'avenue',
  'ave',
  'boulevard',
  'blvd',
  'drive',
  'dr',
  'way',
  'lane',
  'ln',
  'parkway',
  'pkwy',
  'highway',
  'hwy',
  'court',
  'ct',
  'place',
  'pl',
  'circle',
  'terrace',
  'trail',
  'expressway',
  'freeway',
  'agency',
  'authority',
  'district',
  'unified',
  'corridor',
  'commission',
  'council',
  'conservancy',
  'corporation',
  'inc',
  'llc',
]);
/** Same-name features farther apart than this are different places. */
const SAME_NAME_SPREAD_KM = 3;
/** Different named places farther apart than this mean a multi-site project. */
const MULTI_SITE_KM = 15;
/** A named place must be this close to a city the project lists. */
const CITY_TOLERANCE_KM = 10;

/** Normalize a name for lookup. Shares the boundary normalization ("St." -> "saint", accents). */
export function normalizeName(name: string): string {
  return normalizePlaceName(name.replace(/[’‘]/g, "'").replace(/'/g, ''));
}

/** Parse a GNIS pipe-delimited DomesticNames file into a compact gazetteer. */
export function parseGnis(text: string, source: string, keepClasses = CLASS_RANK): Gazetteer {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = lines[0].split('|').map((h) => h.trim().toLowerCase());
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`GNIS file has no "${name}" column (got: ${header.join(', ')})`);
    return i;
  };
  const iName = col('feature_name');
  const iClass = col('feature_class');
  const iCounty = col('county_name');
  const iLat = col('prim_lat_dec');
  const iLon = col('prim_long_dec');
  const iState = header.indexOf('state_name');

  const names: Record<string, GazetteerFeature[]> = {};
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = lines[i].split('|');
    if (iState >= 0 && f[iState] && f[iState] !== 'California') continue;
    const c = f[iClass];
    if (!(c in keepClasses)) continue;
    const lat = Number(f[iLat]);
    const lon = Number(f[iLon]);
    if (!lat || !lon) continue; // GNIS uses 0 for unknown
    const n = f[iName].trim();
    if (n.split(/\s+/).length < 2) continue; // see "Deliberately strict" above
    const key = normalizeName(n);
    (names[key] ??= []).push({ n, c, k: normalizePlaceName(f[iCounty] ?? ''), lon, lat });
  }
  return { source, names };
}

export interface NameMention {
  /** Normalized name. */
  key: string;
  /** As written. */
  text: string;
  /** Which text it came from (0 = first, usually the title). */
  field: number;
}

const WORD = /[A-Za-z0-9][A-Za-z0-9'’.-]*/g;

/**
 * Candidate place names: runs of 2–6 Title Case words (connectors like "de",
 * "of" allowed inside), not crossing punctuation. Every sub-run is returned so
 * "La Playa Beach" also yields "Playa Beach" and "La Playa".
 */
export function nameMentions(texts: readonly string[]): NameMention[] {
  const out: NameMention[] = [];
  const seen = new Set<string>();
  texts.forEach((text, field) => {
    // Split into clauses at punctuation that ends a name.
    for (const clause of text.split(/[,;:()[\]{}"“”/]|\.\s|\s[-–—]\s/)) {
      const words = [...clause.matchAll(WORD)].map((m) => m[0].replace(/\.$/, ''));
      for (let i = 0; i < words.length; i++) {
        if (!isCapitalized(words[i])) continue;
        for (let j = i + 1; j < Math.min(words.length, i + MAX_WORDS); j++) {
          const w = words[j];
          if (!isCapitalized(w) && !CONNECTORS.has(w.toLowerCase())) break;
          if (!isCapitalized(w)) continue; // a name can't end on a connector
          if (NOT_A_PLACE_AFTER.has(words[j + 1]?.toLowerCase() ?? '')) continue;
          const raw = words.slice(i, j + 1).join(' ');
          const key = normalizeName(raw);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ key, text: raw, field });
        }
      }
    }
  });
  return out;
}

function isCapitalized(w: string): boolean {
  // "Shelter", "McKinley", "O'Neill"; not "island", not "USA" alone matters little.
  return /^[A-Z][a-zA-Z'’.-]*$/.test(w) || /^[A-Z]{2,}$/.test(w);
}

export interface LandmarkPlacement {
  lon: number;
  lat: number;
  /** Name as published by GNIS. */
  name: string;
  /** GNIS feature class. */
  featureClass: string;
  /** 1 site, 2 place with extent, 3 community. */
  rank: 1 | 2 | 3;
}

/**
 * A name with several same-class places in the listed counties. A road or
 * waterway the project names can tell which one is meant (see namedLines.ts).
 */
export interface AmbiguousPlace {
  name: string;
  featureClass: string;
  rank: 1 | 2 | 3;
  candidates: { lon: number; lat: number }[];
}

export type LandmarkOutcome = (
  { kind: 'placed'; placement: LandmarkPlacement } | { kind: 'none' | 'ambiguous' | 'multi-site' | 'far-from-city' }
) & { ambiguous?: AmbiguousPlace[] };

export interface LandmarkContext {
  /** Normalized county names the project lists. */
  counties: readonly string[];
  /** Points to stay near (centers are not enough; callers pass a distance function). */
  distanceToCityKm?: (p: { lon: number; lat: number }) => number;
  /** Normalized names of cities and counties, which are never landmarks. */
  isPlaceName: (key: string) => boolean;
}

export function findLandmark(texts: readonly string[], g: Gazetteer, ctx: LandmarkContext): LandmarkOutcome {
  if (ctx.counties.length === 0) return { kind: 'none' };
  const counties = new Set(ctx.counties);
  const ambiguous: AmbiguousPlace[] = [];
  let sawFar = false;
  const found: (LandmarkPlacement & { field: number; words: number })[] = [];

  for (const m of nameMentions(texts)) {
    if (ctx.isPlaceName(m.key)) continue;
    let features = (g.names[m.key] ?? []).filter((f) => counties.has(f.k));
    if (features.length === 0) continue;
    if (ctx.distanceToCityKm) {
      const near = features.filter((f) => ctx.distanceToCityKm!(f) <= CITY_TOLERANCE_KM);
      if (near.length === 0) {
        sawFar = true;
        continue;
      }
      features = near;
    }
    // Keep the best class among same-name features, then require they agree.
    const best = Math.min(...features.map((f) => CLASS_RANK[f.c] ?? 9));
    features = features.filter((f) => CLASS_RANK[f.c] === best);
    if (spreadKm(features) > SAME_NAME_SPREAD_KM) {
      // Sub-runs of a longer name ("Pass" of "Emigrant Pass") repeat the same features: keep the longest.
      if (!ambiguous.some((a) => a.name.includes(features[0].n)))
        ambiguous.push({
          name: features[0].n,
          featureClass: features[0].c,
          rank: CLASS_RANK[features[0].c],
          candidates: features.map((f) => ({ lon: f.lon, lat: f.lat })),
        });
      continue;
    }
    const f = features[0];
    found.push({
      lon: f.lon,
      lat: f.lat,
      name: f.n,
      featureClass: f.c,
      rank: CLASS_RANK[f.c],
      field: m.field,
      words: m.key.split(' ').length,
    });
  }

  const extra = ambiguous.length > 0 ? { ambiguous } : {};
  if (found.length === 0) return { kind: ambiguous.length ? 'ambiguous' : sawFar ? 'far-from-city' : 'none', ...extra };
  // Communities only count when nothing more specific was named.
  const specific = found.filter((f) => f.rank < 3);
  const pool = specific.length > 0 ? specific : found;
  if (spreadKm(pool) > MULTI_SITE_KM) return { kind: 'multi-site' };
  pool.sort((a, b) => a.rank - b.rank || b.words - a.words || a.field - b.field);
  const { field: _f, words: _w, ...placement } = pool[0];
  return { kind: 'placed', placement, ...extra };
}

function spreadKm(points: readonly { lon: number; lat: number }[]): number {
  let m = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) m = Math.max(m, haversineKm(points[i], points[j]));
  return m;
}

/** Names of California cities and counties, which are never landmarks. */
export function placeNameTest(b: Boundaries): (key: string) => boolean {
  const names = new Set([...Object.keys(b.places), ...Object.keys(b.counties)]);
  return (k) => names.has(k) || names.has(k.replace(/ county$/, '')) || /^(city|county|state) of /.test(k);
}

/** The texts a project names places in: newest titles, description and cross streets. */
export function landmarkTexts(docsNewestFirst: readonly CeqaDocument[]): string[] {
  const d = docsNewestFirst[0];
  if (!d) return [];
  const texts = [d.projectTitle, d.documentTitle, d.description, d.crossStreets].map((t) => t?.trim());
  return [...new Set(texts.filter((t): t is string => !!t))];
}

/** Find the named place for one project, checked against the places it lists. */
export function landmarkFor(
  docsNewestFirst: readonly CeqaDocument[],
  b: Boundaries,
  g: Gazetteer,
  isPlaceName: (key: string) => boolean,
): LandmarkOutcome {
  const places = listedPlaces(docsNewestFirst, b);
  const cityAreas = places.cityAreas;
  return findLandmark(landmarkTexts(docsNewestFirst), g, {
    counties: places.counties.map(normalizePlaceName),
    isPlaceName,
    distanceToCityKm: cityAreas
      ? (p) => Math.min(...cityAreas.map((a) => distanceToShapeKm(p.lon, p.lat, a.shape)))
      : undefined,
  });
}
