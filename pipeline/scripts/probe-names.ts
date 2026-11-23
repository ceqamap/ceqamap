/**
 * Probe: the full text of some projects, Census road and water names matching
 * patterns, and how often approximately placed projects mention highways,
 * waterways and postmiles. For designing placement rules. Nothing public
 * changes.
 *
 *   EXPLAIN=2026040250 PROBE='083:linearwater:quiota;027:roads:trona|wildrose' node scripts/probe-names.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { groupBySch } from '../src/lib/aggregate.ts';
import type { Boundaries } from '../src/lib/boundaries.ts';
import type { CeqaDocument } from '../src/lib/document.ts';
import { resolveLocation } from '../src/lib/location.ts';
import { listPartitionMonths, readPartition } from '../src/lib/partitions.ts';
import { seededRandom } from '../src/lib/random.ts';
import { readShapefile } from '../src/lib/shapefile.ts';
import { storageFromEnv } from '../src/lib/storage.ts';

const out = (o: unknown) => console.log(JSON.stringify(o));
const tigerDir = process.env.TIGER_DIR ?? '/tmp/tiger';

for (const spec of (process.env.PROBE ?? '').split(';').filter(Boolean)) {
  const [fips, layer, pattern] = spec.split(':');
  const name = `tl_2024_06${fips}_${layer}`;
  const dir = join(tigerDir, name);
  if (!existsSync(join(dir, `${name}.shp`))) {
    await mkdir(dir, { recursive: true });
    const res = await fetch(`https://www2.census.gov/geo/tiger/TIGER2024/${layer.toUpperCase()}/${name}.zip`);
    await writeFile(join(dir, `${name}.zip`), new Uint8Array(await res.arrayBuffer()));
    execFileSync('unzip', ['-o', '-q', join(dir, `${name}.zip`), '-d', dir]);
  }
  const feats = readShapefile(
    new Uint8Array(await readFile(join(dir, `${name}.shp`))),
    new Uint8Array(await readFile(join(dir, `${name}.dbf`))),
  );
  const re = new RegExp(pattern, 'i');
  const names = new Map<string, { n: number; props: Record<string, string>; first: number[] }>();
  for (const f of feats) {
    const fn = f.properties.FULLNAME ?? '';
    if (!re.test(fn)) continue;
    const e = names.get(fn);
    if (e) e.n++;
    else names.set(fn, { n: 1, props: f.properties, first: f.shape?.[0]?.[0] ?? [] });
  }
  out({ probe: spec, features: feats.length, fields: Object.keys(feats[0]?.properties ?? {}), matches: [...names] });
}

const wanted = new Set((process.env.EXPLAIN ?? '').split(',').filter(Boolean));
const storage = storageFromEnv();
const b = JSON.parse(await readFile(new URL('../data/boundaries.json', import.meta.url), 'utf8')) as Boundaries;
const docs: CeqaDocument[] = [];
for (const m of await listPartitionMonths(storage)) docs.push(...(await readPartition(storage, m)));

const PATTERNS: Record<string, RegExp> = {
  route: /\b(?:SR|State Route|State Highway|Highway|Hwy|Route|US|U\.S\.|Interstate|I)[\s-]?\d{1,3}\b/,
  postmile: /\b(?:post ?miles?|PM|P\.M\.)\s*[A-Z]?\d+(?:\.\d+)?/i,
  water: /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\s(?:Creek|River|Slough|Canal|Wash|Arroyo|Channel|Drain)\b/,
  crossing: /\b(?:crossing|bridge|culvert)\b/i,
};
const count: Record<string, number> = {};
const inc = (k: string) => (count[k] = (count[k] ?? 0) + 1);
const rand = seededRandom('probe');
const samples: Record<string, string[]> = {};

for (const [sch, list] of groupBySch(docs)) {
  const newestFirst = [...list].sort((a, c) => (a.received < c.received ? 1 : -1));
  const d = newestFirst[0];
  if (wanted.has(sch))
    out({
      sch,
      title: d.projectTitle,
      docTitle: d.documentTitle,
      description: d.description,
      crossStreets: d.crossStreets,
    });
  const loc = resolveLocation(sch, newestFirst, b);
  if (!loc || loc.precision === 'exact') continue;
  inc('approx');
  const text = `${d.projectTitle} ${d.description}`;
  const hits = Object.entries(PATTERNS)
    .filter(([, re]) => re.test(text))
    .map(([k]) => k);
  for (const h of hits) inc(h);
  if (hits.includes('water') && hits.includes('crossing')) inc('water+crossing');
  if (hits.includes('route') && hits.includes('postmile')) inc('route+postmile');
  if (hits.includes('route') && !d.crossStreets.trim()) inc('route, no cross streets');
  for (const h of hits) {
    const s = (samples[h] ??= []);
    if (s.length < 12 && rand() < 0.01) s.push(`${sch} | ${d.counties.join('/')} | ${text.slice(0, 300)}`);
  }
}
out({ count });
for (const [k, s] of Object.entries(samples)) out({ sample: k, s });
