/**
 * Report: how well does cross-street placement work on the stored data?
 * Prints outcome counts and sample matches/failures. Nothing public changes.
 *
 *   node scripts/match-intersections.ts
 */
import { readFile } from 'node:fs/promises';
import { groupBySch } from '../src/lib/aggregate.ts';
import type { Boundaries } from '../src/lib/boundaries.ts';
import { crossStreetRequest, placeAtCrossStreets, type CrossStreetRequest } from '../src/lib/crossStreets.ts';
import type { CeqaDocument } from '../src/lib/document.ts';
import { haversineKm, resolveLocation } from '../src/lib/location.ts';
import { listPartitionMonths, readPartition } from '../src/lib/partitions.ts';
import { seededRandom } from '../src/lib/random.ts';
import { storageFromEnv } from '../src/lib/storage.ts';
import { countyFips, countyRoads } from '../src/lib/tiger.ts';

const storage = storageFromEnv();
const boundaries = JSON.parse(
  await readFile(new URL('../data/boundaries.json', import.meta.url), 'utf8'),
) as Boundaries;
const fips = countyFips(boundaries);
const tigerDir = process.env.TIGER_DIR ?? '/tmp/tiger';

const docs: CeqaDocument[] = [];
for (const m of await listPartitionMonths(storage)) docs.push(...(await readPartition(storage, m)));

const requests: CrossStreetRequest[] = [];
const before = new Map<string, { lon: number; lat: number; precision: string }>();
const text = new Map<string, string>();
for (const [sch, list] of groupBySch(docs)) {
  const newestFirst = [...list].sort((a, b) => (a.received < b.received ? 1 : -1));
  const loc = resolveLocation(sch, newestFirst, boundaries);
  if (loc?.precision === 'exact') continue;
  const req = crossStreetRequest(sch, newestFirst, boundaries, (k) => fips.has(k));
  if (!req) continue;
  requests.push(req);
  if (loc) before.set(sch, loc);
  text.set(sch, newestFirst.find((d) => d.crossStreets.trim())!.crossStreets.replace(/\s+/g, ' ').trim());
}

const { placements, stats } = await placeAtCrossStreets(requests, boundaries, (c) => countyRoads(tigerDir, fips.get(c)!));
console.log('\n=== Cross-street placement report ===');
console.log(JSON.stringify(stats));
const moved = [...placements].filter(([s]) => before.has(s)).map(([s, p]) => haversineKm(before.get(s)!, p));
moved.sort((a, b) => a - b);
if (moved.length) console.log(`Distance moved (km): median ${moved[moved.length >> 1].toFixed(1)}`);
const rand = seededRandom('report');
const sample = <T>(xs: T[], n: number) => [...xs].sort(() => rand() - 0.5).slice(0, n);
console.log('\n--- Sample matches ---');
for (const [sch, p] of sample([...placements], 30))
  console.log(`${sch} | ${text.get(sch)!.slice(0, 70)} | ${p.lat.toFixed(5)},${p.lon.toFixed(5)}`);
console.log('\n--- Sample unmatched ---');
for (const r of sample(requests.filter((r) => !placements.has(r.sch)), 30))
  console.log(`${r.sch} | ${text.get(r.sch)!.slice(0, 70)} | parsed: ${r.names.join(' + ')} | ${r.city?.name ?? '-'}`);
