/**
 * Rebuild all published artifacts from stored documents into ./out:
 *   out/points-<scope>.ndjson     input for tippecanoe, one per time window
 *   out/projects-<scope>.pmtiles  clustered vector tiles, one per time window
 *   out/projects/<sch>.json       drawer details
 *   out/meta.json                 counts, arrivals and build id (tile paths set at publish)
 *
 * Status depends on today's date (comment periods open and close), so this
 * must run at least daily even when no new documents arrived.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  allMarkCountKeys,
  type PublishedMeta,
  type PublishedScope,
  STATUSES,
  stageCountKey,
  TIME_SCOPES,
  type TimeScope,
} from '../../../packages/shared/src/index.ts';
import { aggregate, groupBySch } from '../lib/aggregate.ts';
import { approximateArrivals, loadArrivals, summarizeArrivals } from '../lib/arrivals.ts';
import { lastFilingDates, splitByScope } from '../lib/scopes.ts';
import { todayInCalifornia } from '../lib/ceqanet.ts';
import type { CeqaDocument } from '../lib/document.ts';
import type { Boundaries } from '../lib/boundaries.ts';
import { addressRequest, placeAtAddresses, type AddressRequest } from '../lib/addresses.ts';
import { loadGeocodeCache, saveGeocodeCache } from '../lib/geocode.ts';
import { crossStreetRequest, placeAtCrossStreets, type CrossStreetRequest } from '../lib/crossStreets.ts';
import { type Gazetteer, landmarkFor, placeNameTest } from '../lib/landmarks.ts';
import {
  type AddressPlacement,
  type LocationHints,
  listedPlaces,
  type PlacementArea,
  resolveLocation,
} from '../lib/location.ts';
import { log } from '../lib/log.ts';
import { lineRequest, type LineRequest } from '../lib/namedLines.ts';
import { attachPageInfo, loadPages } from '../lib/pages.ts';
import { placeAtPostmiles, type PostmileTable } from '../lib/postmiles.ts';
import { countyFips, countyRoads, countyWater } from '../lib/tiger.ts';
import { Anchors, type AreaMember, areaTileFeatures, boundaryFeatures } from '../lib/areas.ts';
import { listPartitionMonths, readPartition } from '../lib/partitions.ts';
import { storageFromEnv } from '../lib/storage.ts';

const OUT = new URL('../../out/', import.meta.url).pathname;
const STAGE_KEYS = STATUSES.map((s) => stageCountKey(s.id));
const storage = storageFromEnv();

const boundariesPath = process.env.BOUNDARIES_PATH ?? new URL('../../data/boundaries.json', import.meta.url).pathname;
const boundaries = JSON.parse(await readFile(boundariesPath, 'utf8')) as Boundaries;
// Named places (USGS GNIS), fetched by scripts/fetch-gnis.ts. Optional: without
// the file, projects that name a place fall back to the next-best placement.
const gnisPath = process.env.GNIS_PATH ?? new URL('../../data/gnis.json', import.meta.url).pathname;
const gnis = existsSync(gnisPath) ? (JSON.parse(await readFile(gnisPath, 'utf8')) as Gazetteer) : null;
if (!gnis) log.warn('No gnis.json; skipping named-place placement', { gnisPath });
const isPlaceName = placeNameTest(boundaries);
// State highway postmiles (Caltrans), fetched by scripts/fetch-postmiles.ts. Optional like GNIS.
const postmilesPath = process.env.POSTMILES_PATH ?? new URL('../../data/postmiles.json', import.meta.url).pathname;
const postmileTable = existsSync(postmilesPath)
  ? (JSON.parse(await readFile(postmilesPath, 'utf8')) as PostmileTable)
  : null;
if (!postmileTable) log.warn('No postmiles.json; skipping postmile placement', { postmilesPath });

const docs: CeqaDocument[] = [];
for (const month of await listPartitionMonths(storage)) docs.push(...(await readPartition(storage, month)));
if (docs.length === 0) throw new Error('No documents in storage. Run backfill first.');
// "Other Location Info" from project pages (the CSV leaves it out), attached
// to each project's newest document before anything reads them (see pages.ts).
const pageStats = attachPageInfo(groupBySch(docs).values(), await loadPages(storage));
log.info('Page location info', pageStats);

const builtAt = new Date().toISOString();
const today = todayInCalifornia();
// Cross streets: for projects without usable agency coordinates, find where
// their listed streets meet. Census road files are cached in $TIGER_DIR.
const fips = countyFips(boundaries);
const tigerDir = process.env.TIGER_DIR ?? new URL('../../.tiger/', import.meta.url).pathname;
const requests: CrossStreetRequest[] = [];
const addressRequests: AddressRequest[] = [];
const landmarks = new Map<string, NonNullable<LocationHints['landmark']>>();
const landmarkStats: Record<string, number> = {};
const lineRequests: LineRequest[] = [];
const postmiles = new Map<string, NonNullable<LocationHints['postmile']>>();
const postmileStats: Record<string, number> = {};
for (const [sch, list] of groupBySch(docs)) {
  const newestFirst = [...list].sort((a, b) => (a.received < b.received ? 1 : a.received > b.received ? -1 : 0));
  if (resolveLocation(sch, newestFirst, boundaries)?.precision === 'exact') continue;
  let ambiguous;
  if (gnis) {
    const r = landmarkFor(newestFirst, boundaries, gnis, isPlaceName);
    landmarkStats[r.kind] = (landmarkStats[r.kind] ?? 0) + 1;
    if (r.kind === 'placed') landmarks.set(sch, r.placement);
    ambiguous = r.ambiguous;
  }
  if (postmileTable) {
    const d = newestFirst[0];
    const r = placeAtPostmiles(
      `${d.projectTitle}\n${d.description}\n${d.crossStreets}\n${d.otherLocation ?? ''}`,
      listedPlaces(newestFirst, boundaries).counties,
      postmileTable,
    );
    postmileStats[r.kind] = (postmileStats[r.kind] ?? 0) + 1;
    if (r.kind === 'placed') postmiles.set(sch, { lon: r.lon, lat: r.lat, label: r.label });
  }
  const req = crossStreetRequest(sch, newestFirst, boundaries, (k) => fips.has(k));
  if (req) requests.push(req);
  const lreq = lineRequest(sch, newestFirst, boundaries, (k) => fips.has(k), isPlaceName, req?.names, ambiguous);
  if (lreq) lineRequests.push(lreq);
  const addr = addressRequest(sch, newestFirst, boundaries);
  if (addr) addressRequests.push(addr);
}

// Street addresses in project text, geocoded by the Census. Results are
// cached in storage, so only new addresses are sent.
let addressPlacements = new Map<string, AddressPlacement>();
let addressStats: Record<string, number> = {};
if (process.env.SKIP_GEOCODING !== '1') {
  const cache = await loadGeocodeCache(storage);
  ({ placements: addressPlacements, stats: addressStats } = await placeAtAddresses(
    addressRequests,
    boundaries,
    cache,
    today,
  ));
  if (addressStats.newlySent > 0) await saveGeocodeCache(storage, cache);
  log.info('Address placement', addressStats);
}
const {
  placements,
  stats: crossStreetStats,
  linePlacements,
  lineStats,
} = process.env.SKIP_CROSS_STREETS === '1'
  ? { placements: new Map(), stats: { requests: 0, outcomes: {} }, linePlacements: new Map(), lineStats: {} }
  : await placeAtCrossStreets(requests, boundaries, (county) => countyRoads(tigerDir, fips.get(county)!), {
      requests: lineRequests,
      loadWater: (county) => countyWater(tigerDir, fips.get(county)!),
    });
// Named roads and waterways: crossings and spots along one line, and same-name
// places a named road settled (these fill in as named places).
const lines = new Map<string, NonNullable<LocationHints['lines']>>();
for (const [sch, p] of linePlacements) {
  if (p.kind === 'place') {
    if (!landmarks.has(sch)) landmarks.set(sch, { lon: p.lon, lat: p.lat, name: p.name, rank: p.rank });
  } else lines.set(sch, { lon: p.lon, lat: p.lat, kind: p.kind, names: [...p.names] });
}

// Projects known only to a city, ZIP code or county are grouped by area (see areas.ts).
const anchors = new Anchors(boundaries, gnis);
const result = aggregate(docs, boundaries, today, builtAt, {
  anchors,
  crossStreets: placements,
  addresses: addressPlacements,
  landmarks,
  postmiles,
  lines,
});

// Arrivals: flag projects with documents first seen in the latest batch.
const arrivals = summarizeArrivals(
  (await loadArrivals(storage)) ?? approximateArrivals(docs, today),
  groupBySch(docs),
  new Map(result.projects.map((p) => [p.sch, p])),
);
for (const f of result.points) f.properties.n = arrivals.flags.has(f.properties.id) ? 1 : 0;

// One set of points per time window.
const scopes = splitByScope(result.points, lastFilingDates(result.projects), today);

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'projects'), { recursive: true });

// Per window: points with a place of their own go to the clustered tileset;
// projects known only to an area go to the area tileset (badges and spirals).
const projectArea = new Map<string, PlacementArea>();
const latestFiling = lastFilingDates(result.projects);
for (const p of result.projects) {
  const a = p.location?.area;
  if (a) projectArea.set(p.sch, { kind: a.kind, keys: a.keys.map((k) => k.slice(a.kind.length + 1)), name: a.name });
}
const areaStats: Record<string, number> = {};
for (const scope of TIME_SCOPES) {
  const own: string[] = [];
  const members: AreaMember[] = [];
  for (const f of scopes[scope.id].points) {
    const area = projectArea.get(f.properties.id);
    if (area) members.push({ point: f, area, latest: latestFiling.get(f.properties.id) ?? '' });
    else own.push(JSON.stringify(f));
  }
  await writeFile(join(OUT, `points-${scope.id}.ndjson`), own.join('\n') + '\n');
  const features = areaTileFeatures(members, boundaries, anchors);
  await writeFile(join(OUT, `areas-${scope.id}.ndjson`), features.map((f) => JSON.stringify(f)).join('\n') + '\n');
  areaStats[scope.id] = members.length;
}
{
  const lines: string[] = [];
  for (const line of boundaryFeatures(boundaries)) lines.push(line);
  await writeFile(join(OUT, 'boundaries.ndjson'), lines.join('\n') + '\n');
}
for (const p of result.projects) {
  // builtAt is excluded from hashing at publish time, so unchanged projects are not re-uploaded.
  await writeFile(join(OUT, 'projects', `${p.sch}.json`), JSON.stringify(p));
}

const buildId = builtAt.replace(/[-:TZ.]/g, '').slice(0, 14);
const meta: PublishedMeta = {
  buildId,
  builtAt,
  tiles: '', // filled in by publish
  latestReceived: result.latestReceived,
  counts: result.counts,
  // Tile paths are filled in by publish.
  scopes: Object.fromEntries(TIME_SCOPES.map((s) => [s.id, { tiles: '', ...scopes[s.id].counts }])) as Record<
    TimeScope,
    PublishedScope
  >,
  ...(arrivals.published ? { arrivals: arrivals.published } : {}),
};
await writeFile(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
log.info('Aggregated', {
  ...result.counts,
  today,
  crossStreets: crossStreetStats,
  addresses: addressStats,
  landmarks: landmarkStats,
  postmiles: postmileStats,
  pages: pageStats,
  namedLines: lineStats,
  areaGrouped: areaStats,
  scopes: Object.fromEntries(TIME_SCOPES.map((s) => [s.id, scopes[s.id].counts.mapped])),
  arrivals: arrivals.published
    ? { at: arrivals.published.at, projects: arrivals.published.projects, filings: arrivals.published.filings }
    : null,
});

// Tippecanoe, once per time window: cluster overlapping points below z13,
// keep every point (no dropping) so the map is a complete census, and sum the
// per-stage flags, the per stage-and-mark flags, `r` (in review) and `n`
// (arrivals) so clusters can follow the legend's stage and location filters
// and show what they contain. A point carries only its own stage-and-mark
// flag; tippecanoe adds a key a cluster lacks when it merges a point that has it.
const accumulate = ['r', 'n', ...STAGE_KEYS, ...allMarkCountKeys()].flatMap((k) => [
  '--accumulate-attribute',
  `${k}:sum`,
]);
for (const scope of TIME_SCOPES) {
  const tippecanoe = spawnSync(
    process.env.TIPPECANOE ?? 'tippecanoe',
    [
      '--output',
      join(OUT, `projects-${scope.id}.pmtiles`),
      '--force',
      '--layer',
      'projects',
      '--name',
      `CEQA projects (${scope.label})`,
      '--attribution',
      'Data: California State Clearinghouse (CEQAnet)',
      '--minimum-zoom',
      '3',
      '--maximum-zoom',
      '14',
      '--drop-rate',
      '1',
      '--cluster-distance',
      '28',
      '--cluster-maxzoom',
      '12',
      ...accumulate,
      '--no-feature-limit',
      '--no-tile-size-limit',
      '--read-parallel',
      '--quiet',
      join(OUT, `points-${scope.id}.ndjson`),
    ],
    { stdio: 'inherit' },
  );
  if (tippecanoe.error) throw new Error(`tippecanoe could not start: ${tippecanoe.error.message}`);
  if (tippecanoe.status !== 0) throw new Error(`tippecanoe exited with ${tippecanoe.status} (${scope.id})`);

  // Area badges and spirals: no clustering (each feature has its own zoom range, see areas.ts).
  runTippecanoe(`areas ${scope.id}`, [
    '--output',
    join(OUT, `areas-${scope.id}.pmtiles`),
    '--force',
    '--layer',
    'areas',
    '--name',
    `CEQA projects by area (${scope.label})`,
    '--minimum-zoom',
    '3',
    '--maximum-zoom',
    '14',
    '--drop-rate',
    '1',
    '--no-feature-limit',
    '--no-tile-size-limit',
    '--quiet',
    join(OUT, `areas-${scope.id}.ndjson`),
  ]);
}

// City, ZIP code and county outlines, for highlighting a selected project's area.
runTippecanoe('boundaries', [
  '--output',
  join(OUT, 'boundaries.pmtiles'),
  '--force',
  '--layer',
  'areas',
  '--name',
  'California cities, ZIP codes and counties',
  '--attribution',
  'Boundaries: U.S. Census Bureau',
  '--minimum-zoom',
  '4',
  '--maximum-zoom',
  '11',
  '--detect-shared-borders',
  '--no-feature-limit',
  '--no-tile-size-limit',
  '--read-parallel',
  '--quiet',
  join(OUT, 'boundaries.ndjson'),
]);
log.info('Build finished', { buildId });

function runTippecanoe(what: string, args: string[]) {
  const r = spawnSync(process.env.TIPPECANOE ?? 'tippecanoe', args, { stdio: 'inherit' });
  if (r.error) throw new Error(`tippecanoe could not start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`tippecanoe exited with ${r.status} (${what})`);
}
