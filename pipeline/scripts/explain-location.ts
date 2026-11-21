/**
 * Explain how specific projects are placed, step by step: what each method
 * (coordinates, street address, cross streets, named places, ZIP) finds for
 * them. For investigating a misplaced project. Nothing public changes.
 *
 *   EXPLAIN=2026060142,2026110686 node scripts/explain-location.ts
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { addressRequest, placeAtAddresses } from '../src/lib/addresses.ts';
import { groupBySch } from '../src/lib/aggregate.ts';
import type { Boundaries } from '../src/lib/boundaries.ts';
import { crossStreetRequest, placeAtCrossStreets } from '../src/lib/crossStreets.ts';
import type { CeqaDocument } from '../src/lib/document.ts';
import { loadGeocodeCache } from '../src/lib/geocode.ts';
import { type Gazetteer, landmarkFor, nameMentions, landmarkTexts, placeNameTest } from '../src/lib/landmarks.ts';
import { resolveLocation } from '../src/lib/location.ts';
import { listPartitionMonths, readPartition } from '../src/lib/partitions.ts';
import { parseCrossStreets, parseSingleStreet } from '../src/lib/streets.ts';
import { storageFromEnv } from '../src/lib/storage.ts';
import { countyFips, countyRoads } from '../src/lib/tiger.ts';

const wanted = new Set((process.env.EXPLAIN ?? '').split(',').filter((s) => /^\d{10}$/.test(s.trim())));
if (wanted.size === 0) throw new Error('Set EXPLAIN to one or more SCH numbers, comma-separated');
const storage = storageFromEnv();
const b = JSON.parse(await readFile(new URL('../data/boundaries.json', import.meta.url), 'utf8')) as Boundaries;
const gnisPath = new URL('../data/gnis.json', import.meta.url);
const gnis = existsSync(gnisPath) ? (JSON.parse(await readFile(gnisPath, 'utf8')) as Gazetteer) : null;
const fips = countyFips(b);
const tigerDir = process.env.TIGER_DIR ?? new URL('../../.tiger/', import.meta.url).pathname;
const out = (o: unknown) => console.log(JSON.stringify(o));

const docs: CeqaDocument[] = [];
for (const m of await listPartitionMonths(storage))
  docs.push(...(await readPartition(storage, m)).filter((d) => wanted.has(d.sch)));

for (const [sch, list] of groupBySch(docs)) {
  const newestFirst = [...list].sort((a, c) => (a.received < c.received ? 1 : -1));
  const d = newestFirst[0];
  out({ sch, title: d.projectTitle, cities: d.cities, counties: d.counties, zip: d.zip, coordinates: d.coordinates });
  out({
    sch,
    step: 'cross streets text',
    text: d.crossStreets,
    parsed: parseCrossStreets(d.crossStreets),
    single: parseSingleStreet(d.crossStreets),
  });
  const req = crossStreetRequest(sch, newestFirst, b, (k) => fips.has(k));
  let crossStreets;
  if (req) {
    const r = await placeAtCrossStreets([req], b, (c) => countyRoads(tigerDir, fips.get(c)!));
    crossStreets = r.placements.get(sch);
    out({
      sch,
      step: 'cross streets',
      request: { names: req.names, counties: req.counties },
      outcomes: r.stats.outcomes,
      placement: crossStreets ?? null,
    });
  } else out({ sch, step: 'cross streets', request: null });
  const areq = addressRequest(sch, newestFirst, b);
  let address;
  if (areq) {
    const r = await placeAtAddresses([areq], b, await loadGeocodeCache(storage), new Date().toISOString().slice(0, 10));
    address = r.placements.get(sch);
    out({ sch, step: 'address', query: areq.query, stats: r.stats, placement: address ?? null });
  } else out({ sch, step: 'address', request: null });
  let landmark;
  if (gnis) {
    const isPlaceName = placeNameTest(b);
    const r = landmarkFor(newestFirst, b, gnis, isPlaceName);
    if (r.kind === 'placed') landmark = r.placement;
    const hits = nameMentions(landmarkTexts(newestFirst))
      .filter((m) => gnis.names[m.key])
      .map((m) => ({ text: m.text, hits: gnis.names[m.key] }));
    out({ sch, step: 'named places', outcome: r, mentionsInGnis: hits });
  }
  out({ sch, step: 'result', location: resolveLocation(sch, newestFirst, b, { crossStreets, address, landmark }) });
}
