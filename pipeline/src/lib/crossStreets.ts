/**
 * Placing approximate projects at their listed cross streets.
 *
 * For every project without usable agency coordinates whose "Cross Streets"
 * field names two or more streets, find where those streets meet (using
 * Census road files) inside the listed city or county. Run once per build,
 * county by county, indexing only the street names actually requested.
 *
 * On the full dataset (2026-11-20) this placed 33,281 of 57,750 eligible
 * projects (57.6%); see docs/DATA.md.
 */
import { type Area, type Boundaries, normalizePlaceName } from './boundaries.ts';
import type { CeqaDocument } from './document.ts';
import { pointInShape } from './geometry.ts';
import { buildRoadIndex, findIntersection, placeAlongStreet, type StreetResult } from './intersections.ts';
import { log } from './log.ts';
import { parseCrossStreets, parseSingleStreet, streetKeys } from './streets.ts';
import type { ShapefileFeature } from './shapefile.ts';

export interface CrossStreetPlacement {
  lon: number;
  lat: number;
  /** Where two listed streets meet, or a spot along the one listed street. */
  kind: 'intersection' | 'street';
  /** The streets used: two for an intersection, one for a street. */
  streets: string[];
}

export interface CrossStreetRequest {
  sch: string;
  names: string[];
  /** Only one street is listed: place along it rather than at a crossing. */
  single: boolean;
  city: Area | null;
  /** Normalized county keys to search, in order. */
  counties: string[];
}

/** The newest cross-street text and the places to search, or null if not usable. */
export function crossStreetRequest(
  sch: string,
  newestFirst: readonly CeqaDocument[],
  b: Boundaries,
  isCounty: (key: string) => boolean,
): CrossStreetRequest | null {
  const withText = newestFirst.find((d) => d.crossStreets.trim());
  if (!withText) return null;
  let names = parseCrossStreets(withText.crossStreets);
  const single = names.length < 2;
  if (single) {
    const one = parseSingleStreet(withText.crossStreets);
    if (!one) return null;
    names = [one];
  }
  const placeDoc = newestFirst.find((d) => d.cities.length || d.counties.length) ?? withText;
  const cityKeys = placeDoc.cities.map(normalizePlaceName).filter((k) => b.places[k]);
  const city = cityKeys.length === 1 ? b.places[cityKeys[0]] : null;
  let counties = placeDoc.counties.map(normalizePlaceName).filter(isCounty);
  if (counties.length === 0 && city) {
    const c = { lon: (city.bbox[0] + city.bbox[2]) / 2, lat: (city.bbox[1] + city.bbox[3]) / 2 };
    counties = Object.keys(b.counties).filter((k) => pointInShape(c.lon, c.lat, b.counties[k].shape));
  }
  if (counties.length === 0 || counties.length > 3) return null;
  return { sch, names, single, city, counties };
}

export interface CrossStreetStats {
  requests: number;
  outcomes: Record<string, number>;
}

/**
 * Resolve all requests. `loadRoads(countyKey)` supplies that county's Census
 * roads (or null to skip it).
 */
export async function placeAtCrossStreets(
  requests: CrossStreetRequest[],
  b: Boundaries,
  loadRoads: (countyKey: string) => Promise<ShapefileFeature[] | null>,
): Promise<{ placements: Map<string, CrossStreetPlacement>; stats: CrossStreetStats }> {
  type Result =
    | { ok: true; lon: number; lat: number; streets: string[] }
    | { ok: false; reason: string }
    | (StreetResult & { streets?: string[] });
  const results = new Map<string, Result>();
  const byCounty = new Map<string, CrossStreetRequest[]>();
  for (const r of requests) {
    for (const c of r.counties) {
      const list = byCounty.get(c);
      if (list) list.push(r);
      else byCounty.set(c, [r]);
    }
  }

  for (const [county, reqs] of byCounty) {
    const pending = reqs.filter((r) => !results.get(r.sch)?.ok);
    if (pending.length === 0) continue;
    const wanted = new Set<string>();
    for (const r of pending)
      for (const n of r.names) {
        const k = streetKeys(n);
        if (k) wanted.add(k.full).add(k.nodir).add(k.base);
      }
    const roads = await loadRoads(county);
    if (!roads) continue;
    const index = buildRoadIndex(roads, wanted);
    for (const r of pending) {
      const area = { city: r.city, county: b.counties[county] };
      const res: Result = r.single
        ? { ...placeAlongStreet(index, r.names[0], area, r.sch), streets: r.names }
        : findIntersection(index, r.names, area);
      // Any success wins; otherwise keep the first county's reason.
      if (res.ok || !results.has(r.sch)) results.set(r.sch, res);
    }
  }

  const placements = new Map<string, CrossStreetPlacement>();
  const outcomes: Record<string, number> = {};
  for (const r of requests) {
    const res = results.get(r.sch);
    const key = (r.single ? 'street:' : '') + (res ? (res.ok ? 'matched' : res.reason) : 'no-roads');
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    if (res?.ok)
      placements.set(r.sch, {
        lon: res.lon,
        lat: res.lat,
        kind: r.single ? 'street' : 'intersection',
        streets: res.streets ?? r.names,
      });
  }
  log.info('Cross-street placement', { requests: requests.length, outcomes });
  return { placements, stats: { requests: requests.length, outcomes } };
}
