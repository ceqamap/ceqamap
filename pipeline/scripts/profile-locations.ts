/**
 * Report: how many approximate projects could be placed better by a ZIP code
 * or a street address written in their text, and how well a sample of those
 * addresses geocodes with the Census batch geocoder. Nothing public changes;
 * nothing is saved.
 *
 *   node scripts/profile-locations.ts
 */
import { readFile } from 'node:fs/promises';
import { caZip, extractAddress } from '../src/lib/address.ts';
import { groupBySch } from '../src/lib/aggregate.ts';
import type { Boundaries } from '../src/lib/boundaries.ts';
import type { CeqaDocument } from '../src/lib/document.ts';
import { type AddressQuery, geocodeAll, queryKey } from '../src/lib/geocode.ts';
import { agreesWithPlaces, haversineKm, listedPlaces, resolveLocation } from '../src/lib/location.ts';
import { listPartitionMonths, readPartition } from '../src/lib/partitions.ts';
import { seededRandom } from '../src/lib/random.ts';
import { storageFromEnv } from '../src/lib/storage.ts';

const SAMPLE = Number(process.env.SAMPLE ?? 3000);
const storage = storageFromEnv();
const boundaries = JSON.parse(
  await readFile(new URL('../data/boundaries.json', import.meta.url), 'utf8'),
) as Boundaries;
const docs: CeqaDocument[] = [];
for (const m of await listPartitionMonths(storage)) docs.push(...(await readPartition(storage, m)));

const count: Record<string, number> = {};
const inc = (k: string) => (count[k] = (count[k] ?? 0) + 1);
const FIELDS = ['crossStreets', 'projectTitle', 'documentTitle', 'description'] as const;

interface Candidate {
  sch: string;
  q: AddressQuery;
  field: string;
  text: string;
  places: ReturnType<typeof listedPlaces>;
  before: { lon: number; lat: number; precision: string };
}
const candidates: Candidate[] = [];

for (const [sch, list] of groupBySch(docs)) {
  const newestFirst = [...list].sort((a, b) => (a.received < b.received ? 1 : -1));
  const loc = resolveLocation(sch, newestFirst, boundaries);
  inc(`precision:${loc?.precision ?? 'unmapped'}`);
  if (loc?.precision === 'exact') continue;
  inc('approximate');
  const zip = newestFirst.map((d) => caZip(d.zip)).find((z) => z) ?? null;
  if (zip) inc('approximate:withZip');
  else if (newestFirst.some((d) => d.zip.trim())) inc('approximate:invalidZip');

  let found: { field: string; text: string; street: string } | null = null;
  for (const field of FIELDS) {
    for (const d of newestFirst) {
      const a = extractAddress(d[field]);
      if (a) {
        found = { field, text: d[field], street: a.street };
        break;
      }
    }
    if (found) break;
  }
  if (!found) continue;
  inc('approximate:withAddress');
  inc(`address:from:${found.field}`);
  const places = listedPlaces(newestFirst, boundaries);
  const city = places.cityAreas?.length === 1 ? places.cityAreas[0].name : '';
  if (!city && !zip) {
    inc('address:noCityOrZip');
    continue;
  }
  if (loc)
    candidates.push({
      sch,
      q: { street: found.street, city, zip: zip ?? '' },
      field: found.field,
      text: found.text,
      places,
      before: loc,
    });
}

console.log('\n=== Location profile ===');
console.log(JSON.stringify(count, null, 1));

const rand = seededRandom('profile');
const sample = [...candidates].sort(() => rand() - 0.5).slice(0, SAMPLE);
const today = new Date().toISOString().slice(0, 10);
const t0 = Date.now();
const { results, stats } = await geocodeAll(
  sample.map((c) => c.q),
  {},
  today,
);
console.log(`\nGeocoded ${sample.length} sample addresses in ${((Date.now() - t0) / 1000).toFixed(0)} s`, stats);

const g: Record<string, number> = {};
const gi = (k: string) => (g[k] = (g[k] ?? 0) + 1);
const moved: number[] = [];
const good: string[] = [];
const rejected: string[] = [];
const missed: string[] = [];
for (const c of sample) {
  const p = results.get(queryKey(c.q));
  const line = `${c.sch} | ${c.field} | ${c.text.replace(/\s+/g, ' ').slice(0, 70)} -> ${c.q.street}, ${c.q.city || '-'} ${c.q.zip}`;
  if (!p) {
    gi(`miss:${c.field}`);
    missed.push(line);
    continue;
  }
  if (!agreesWithPlaces(p, c.places, boundaries)) {
    gi(`rejected:${c.field}`);
    rejected.push(`${line} @ ${p.lat.toFixed(5)},${p.lon.toFixed(5)}`);
    continue;
  }
  gi(`ok:${c.field}`);
  moved.push(haversineKm(p, c.before));
  good.push(`${line} @ ${p.lat.toFixed(5)},${p.lon.toFixed(5)}`);
}
moved.sort((a, b) => a - b);
console.log('\n=== Sample geocoding outcomes ===');
console.log(JSON.stringify(g, null, 1));
if (moved.length) console.log(`Median move from current spot: ${moved[moved.length >> 1].toFixed(1)} km`);
console.log(`Eligible for geocoding (have address + city or ZIP): ${candidates.length}`);
for (const [title, rows] of [
  ['Good', good],
  ['Rejected (disagrees with listed places)', rejected],
  ['Missed', missed],
] as const) {
  console.log(`\n--- ${title} (sample) ---`);
  for (const r of rows.slice(0, 40)) console.log(r);
}
