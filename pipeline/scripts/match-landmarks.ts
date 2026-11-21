/**
 * Report: how many approximately placed projects name a place (a beach, park,
 * dam, school, community...) that GNIS can locate, and a sample to eyeball.
 * Nothing public changes; nothing is saved.
 *
 *   node scripts/fetch-gnis.ts && node scripts/match-landmarks.ts
 */
import { readFile } from 'node:fs/promises';
import { groupBySch } from '../src/lib/aggregate.ts';
import type { Boundaries } from '../src/lib/boundaries.ts';
import type { CeqaDocument } from '../src/lib/document.ts';
import { type Gazetteer, landmarkFor, landmarkTexts, nameMentions, placeNameTest } from '../src/lib/landmarks.ts';
import { haversineKm, resolveLocation } from '../src/lib/location.ts';
import { listPartitionMonths, readPartition } from '../src/lib/partitions.ts';
import { seededRandom } from '../src/lib/random.ts';
import { storageFromEnv } from '../src/lib/storage.ts';

const SAMPLE = Number(process.env.SAMPLE ?? 80);
/** Projects to explain in detail (mentions found and their GNIS entries). */
const EXPLAIN = new Set((process.env.EXPLAIN ?? '').split(','));
const storage = storageFromEnv();
const boundaries = JSON.parse(
  await readFile(new URL('../data/boundaries.json', import.meta.url), 'utf8'),
) as Boundaries;
const gnis = JSON.parse(await readFile(new URL('../data/gnis.json', import.meta.url), 'utf8')) as Gazetteer;
const isPlaceName = placeNameTest(boundaries);

const docs: CeqaDocument[] = [];
for (const m of await listPartitionMonths(storage)) docs.push(...(await readPartition(storage, m)));

const count: Record<string, number> = {};
const inc = (k: string) => (count[k] = (count[k] ?? 0) + 1);
const samples: string[] = [];
const rand = seededRandom('landmarks');
const moved: number[] = [];

for (const [sch, list] of groupBySch(docs)) {
  const newestFirst = [...list].sort((a, b) => (a.received < b.received ? 1 : -1));
  const loc = resolveLocation(sch, newestFirst, boundaries);
  if (!loc || loc.precision === 'exact') continue;
  inc(`approximate:${loc.precision}`);
  const r = landmarkFor(newestFirst, boundaries, gnis, isPlaceName);
  inc(`outcome:${r.kind}`);
  if (EXPLAIN.has(sch)) {
    const texts = landmarkTexts(newestFirst);
    console.log(JSON.stringify({ explain: sch, outcome: r, texts }));
    for (const m of nameMentions(texts)) {
      const hits = gnis.names[m.key];
      if (hits || isPlaceName(m.key))
        console.log(JSON.stringify({ mention: m.text, isPlaceName: isPlaceName(m.key), hits }));
    }
    const shelter = Object.entries(gnis.names).filter(([k]) => /shelter island|la playa/.test(k));
    console.log(JSON.stringify({ gnisLike: shelter }));
  }
  if (r.kind !== 'placed') continue;
  inc(`placed:from:${loc.precision}`);
  inc(`placed:class:${r.placement.featureClass}`);
  inc(`placed:rank:${r.placement.rank}`);
  moved.push(haversineKm(loc, r.placement));
  if (rand() < (SAMPLE * 3) / 60000 && samples.length < SAMPLE) {
    const d = newestFirst[0];
    samples.push(
      `${sch} [${loc.precision} -> ${r.placement.featureClass}] "${r.placement.name}" (${r.placement.lat.toFixed(4)}, ${r.placement.lon.toFixed(4)}) | ${d.projectTitle.slice(0, 80)} | ${d.description.replace(/\s+/g, ' ').slice(0, 220)}`,
    );
  }
}

moved.sort((a, b) => a - b);
const q = (p: number) => moved[Math.floor(p * (moved.length - 1))]?.toFixed(1);
console.log(JSON.stringify({ gnis: gnis.source, names: Object.keys(gnis.names).length, ...count }, null, 2));
console.log(`Moved (km) p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)}`);
console.log('--- sample ---');
for (const s of samples) console.log(s);
