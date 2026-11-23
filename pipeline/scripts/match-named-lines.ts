/**
 * Report: what highway postmiles and the roads and waterways named in project
 * text do for approximately placed projects (see lib/postmiles.ts and
 * lib/namedLines.ts): outcomes, how placements change, and a random sample to
 * check by hand. Nothing public changes.
 *
 *   node scripts/fetch-gnis.ts && node scripts/fetch-postmiles.ts && node scripts/match-named-lines.ts
 */
import { readFile } from 'node:fs/promises';
import { groupBySch } from '../src/lib/aggregate.ts';
import type { Boundaries } from '../src/lib/boundaries.ts';
import { crossStreetRequest, placeAtCrossStreets, type CrossStreetRequest } from '../src/lib/crossStreets.ts';
import type { CeqaDocument } from '../src/lib/document.ts';
import { type Gazetteer, landmarkFor, placeNameTest } from '../src/lib/landmarks.ts';
import { haversineKm, listedPlaces, type LocationHints, resolveLocation } from '../src/lib/location.ts';
import { lineRequest, type LineRequest } from '../src/lib/namedLines.ts';
import { listPartitionMonths, readPartition } from '../src/lib/partitions.ts';
import { placeAtPostmiles, type PostmileTable } from '../src/lib/postmiles.ts';
import { seededRandom } from '../src/lib/random.ts';
import { storageFromEnv } from '../src/lib/storage.ts';
import { countyFips, countyRoads, countyWater } from '../src/lib/tiger.ts';

const SAMPLE = Number(process.env.SAMPLE ?? 25);
const EXPLAIN = new Set((process.env.EXPLAIN ?? '').split(',').filter(Boolean));
const out = (o: unknown) => console.log(JSON.stringify(o));
const storage = storageFromEnv();
const b = JSON.parse(await readFile(new URL('../data/boundaries.json', import.meta.url), 'utf8')) as Boundaries;
const gnis = JSON.parse(await readFile(new URL('../data/gnis.json', import.meta.url), 'utf8')) as Gazetteer;
const pmTable = JSON.parse(await readFile(new URL('../data/postmiles.json', import.meta.url), 'utf8')) as PostmileTable;
const isPlaceName = placeNameTest(b);
const fips = countyFips(b);
const tigerDir = process.env.TIGER_DIR ?? new URL('../../.tiger/', import.meta.url).pathname;

const docs: CeqaDocument[] = [];
for (const m of await listPartitionMonths(storage)) docs.push(...(await readPartition(storage, m)));

const groups = new Map<string, CeqaDocument[]>();
const csRequests: CrossStreetRequest[] = [];
const lineRequests: LineRequest[] = [];
const landmarks = new Map<string, NonNullable<LocationHints['landmark']>>();
const postmiles = new Map<string, NonNullable<LocationHints['postmile']>>();
const pmStats: Record<string, number> = {};
for (const [sch, list] of groupBySch(docs)) {
  const newestFirst = [...list].sort((a, c) => (a.received < c.received ? 1 : -1));
  if (resolveLocation(sch, newestFirst, b)?.precision === 'exact') continue;
  groups.set(sch, newestFirst);
  const lm = landmarkFor(newestFirst, b, gnis, isPlaceName);
  if (lm.kind === 'placed') landmarks.set(sch, lm.placement);
  const d = newestFirst[0];
  const pm = placeAtPostmiles(
    `${d.projectTitle}\n${d.description}\n${d.crossStreets}`,
    listedPlaces(newestFirst, b).counties,
    pmTable,
  );
  pmStats[pm.kind] = (pmStats[pm.kind] ?? 0) + 1;
  if (pm.kind === 'placed') postmiles.set(sch, { lon: pm.lon, lat: pm.lat, label: pm.label });
  const req = crossStreetRequest(sch, newestFirst, b, (k) => fips.has(k));
  if (req) csRequests.push(req);
  const lreq = lineRequest(sch, newestFirst, b, (k) => fips.has(k), isPlaceName, req?.names, lm.ambiguous);
  if (lreq) lineRequests.push(lreq);
}
out({ approximate: groups.size, postmiles: pmStats, lineRequests: lineRequests.length });

const { placements, linePlacements, lineStats } = await placeAtCrossStreets(
  csRequests,
  b,
  (c) => countyRoads(tigerDir, fips.get(c)!),
  { requests: lineRequests, loadWater: (c) => countyWater(tigerDir, fips.get(c)!) },
);
out({ namedLines: lineStats });

// Before (as on main) vs after, per project.
const before: Record<string, number> = {};
const after: Record<string, number> = {};
const changes: Record<string, number> = {};
const moved: Record<string, number[]> = {};
const candidates: Record<string, string[]> = {};
for (const [sch, newestFirst] of groups) {
  const hints: LocationHints = { crossStreets: placements.get(sch), landmark: landmarks.get(sch) };
  const old = resolveLocation(sch, newestFirst, b, hints);
  const lp = linePlacements.get(sch);
  const next = resolveLocation(sch, newestFirst, b, {
    ...hints,
    postmile: postmiles.get(sch),
    landmark: hints.landmark ?? (lp?.kind === 'place' ? { ...lp } : undefined),
    lines: lp && lp.kind !== 'place' ? { lon: lp.lon, lat: lp.lat, kind: lp.kind, names: [...lp.names] } : undefined,
  });
  const o = old?.precision ?? 'unmapped';
  const n = next?.precision ?? 'unmapped';
  before[o] = (before[o] ?? 0) + 1;
  after[n] = (after[n] ?? 0) + 1;
  const changed = o !== n || (old && next && haversineKm(old, next) > 0.01);
  if (!changed) continue;
  const key = `${o} -> ${n}${n === 'landmark' && lp?.kind === 'place' && !landmarks.has(sch) ? ' (settled by road)' : ''}`;
  changes[key] = (changes[key] ?? 0) + 1;
  if (old && next) (moved[key] ??= []).push(haversineKm(old, next));
  const d = newestFirst[0];
  (candidates[key] ??= []).push(
    JSON.stringify({
      sch,
      counties: d.counties.join('/'),
      cities: d.cities.join('/'),
      to: { lon: next?.lon, lat: next?.lat, how: next?.streets ?? next?.postmile ?? next?.landmark },
      title: d.projectTitle.slice(0, 140),
      text: d.description.slice(0, 400),
      cross: d.crossStreets,
    }),
  );
  if (EXPLAIN.has(sch)) out({ explain: sch, old, next });
}
const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0;
out({ before, after });
out({
  changes,
  medianMovedKm: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, Math.round(median(v) * 10) / 10])),
});
const rand = seededRandom('named-lines');
for (const [key, list] of Object.entries(candidates)) {
  const pick = [...list].sort(() => rand() - 0.5).slice(0, SAMPLE);
  for (const p of pick) out({ sample: key, ...JSON.parse(p) });
}
