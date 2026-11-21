/**
 * Prototype: how many approximate projects can be placed at the
 * intersection of their listed cross streets? Runs the matcher over every
 * project in storage and prints a report with examples. Saves results to
 * state/intersections.json for review; nothing public changes.
 *
 *   node scripts/match-intersections.ts
 *
 * Downloads Census TIGER/Line road files (one per county, public domain) into
 * $TIGER_DIR (default /tmp/tiger), reusing files already there.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { groupBySch } from '../src/lib/aggregate.ts';
import { type Area, type Boundaries, normalizePlaceName } from '../src/lib/boundaries.ts';
import type { CeqaDocument } from '../src/lib/document.ts';
import { pointInShape } from '../src/lib/geometry.ts';
import { buildRoadIndex, findIntersection, type IntersectionResult } from '../src/lib/intersections.ts';
import { haversineKm, resolveLocation } from '../src/lib/location.ts';
import { listPartitionMonths, readPartition } from '../src/lib/partitions.ts';
import { seededRandom } from '../src/lib/random.ts';
import { readShapefile } from '../src/lib/shapefile.ts';
import { storageFromEnv } from '../src/lib/storage.ts';
import { parseCrossStreets, streetKeys } from '../src/lib/streets.ts';

const TIGER_VINTAGE = '2024';
const TIGER_DIR = process.env.TIGER_DIR ?? '/tmp/tiger';
const storage = storageFromEnv();
const boundaries = JSON.parse(
  await readFile(new URL('../data/boundaries.json', import.meta.url), 'utf8'),
) as Boundaries;

// California county FIPS codes are the odd numbers 001-115, assigned in alphabetical order.
const countyNames = Object.keys(boundaries.counties).sort((a, b) =>
  boundaries.counties[a].name.localeCompare(boundaries.counties[b].name),
);
if (countyNames.length !== 58) throw new Error(`Expected 58 counties, got ${countyNames.length}`);
const fipsOf = new Map(countyNames.map((k, i) => [k, String(2 * i + 1).padStart(3, '0')]));

interface Request {
  sch: string;
  text: string;
  names: string[];
  city: Area | null;
  counties: string[]; // normalized county keys to search
  prev: { lon: number; lat: number; precision: string } | null;
}

// ---- 1. Collect requests --------------------------------------------------
const docs: CeqaDocument[] = [];
for (const m of await listPartitionMonths(storage)) docs.push(...(await readPartition(storage, m)));
const groups = groupBySch(docs);

const stats = {
  projects: groups.size,
  exact: 0,
  approximateOrUnmapped: 0,
  withCrossStreets: 0,
  parsedTwoNames: 0,
  noCounty: 0,
};
const requests: Request[] = [];
const countyAreaOf = (key: string) => boundaries.counties[key];

for (const [sch, list] of groups) {
  const newestFirst = [...list].sort((a, b) => (a.received < b.received ? 1 : -1));
  const loc = resolveLocation(sch, newestFirst, boundaries);
  if (loc?.precision === 'exact') {
    stats.exact++;
    continue;
  }
  stats.approximateOrUnmapped++;
  const withText = newestFirst.find((d) => d.crossStreets.trim());
  if (!withText) continue;
  stats.withCrossStreets++;
  const names = parseCrossStreets(withText.crossStreets);
  if (names.length < 2) continue;
  stats.parsedTwoNames++;

  const placeDoc = newestFirst.find((d) => d.cities.length || d.counties.length) ?? withText;
  const cityKeys = placeDoc.cities.map(normalizePlaceName).filter((k) => boundaries.places[k]);
  const city = cityKeys.length === 1 ? boundaries.places[cityKeys[0]] : null;
  let counties = placeDoc.counties.map(normalizePlaceName).filter((k) => fipsOf.has(k));
  if (counties.length === 0 && city) {
    const c = { lon: (city.bbox[0] + city.bbox[2]) / 2, lat: (city.bbox[1] + city.bbox[3]) / 2 };
    counties = countyNames.filter((k) => pointInShape(c.lon, c.lat, countyAreaOf(k).shape));
  }
  if (counties.length === 0 || counties.length > 3) {
    stats.noCounty++;
    continue;
  }
  requests.push({
    sch,
    text: withText.crossStreets.replace(/\s+/g, ' ').trim(),
    names,
    city,
    counties,
    prev: loc ? { lon: loc.lon, lat: loc.lat, precision: loc.precision } : null,
  });
}
console.log('Collected', JSON.stringify(stats), 'requests:', requests.length);

// ---- 2. Match county by county --------------------------------------------
/** Download (or reuse) one county's TIGER roads file; null if unavailable. */
async function tryVintage(fips: string, vintage: string) {
  const name = `tl_${vintage}_06${fips}_roads`;
  const dir = join(TIGER_DIR, name);
  if (!existsSync(join(dir, `${name}.shp`))) {
    await mkdir(dir, { recursive: true });
    const zip = join(dir, `${name}.zip`);
    // census.gov occasionally cuts a download short; verify the zip and retry.
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const res = await fetch(`https://www2.census.gov/geo/tiger/TIGER${vintage}/ROADS/${name}.zip`);
      if (res.status === 404) return null;
      if (res.ok) {
        await writeFile(zip, new Uint8Array(await res.arrayBuffer()));
        try {
          execFileSync('unzip', ['-t', '-q', zip], { stdio: 'pipe' });
          ok = true;
        } catch {
          console.log(`Bad zip for ${name} (attempt ${attempt})`);
          await new Promise((r) => setTimeout(r, attempt * 5000));
        }
      }
    }
    if (!ok) return null;
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  }
  return readShapefile(
    new Uint8Array(await readFile(join(dir, `${name}.shp`))),
    new Uint8Array(await readFile(join(dir, `${name}.dbf`))),
  );
}

/** Prefer the 2024 roads; fall back to neighboring vintages if a file is broken. */
async function countyRoads(fips: string) {
  for (const vintage of [TIGER_VINTAGE, '2025', '2023']) {
    const roads = await tryVintage(fips, vintage);
    if (roads) {
      if (vintage !== TIGER_VINTAGE) console.log(`Using ${vintage} roads for county ${fips}`);
      return roads;
    }
  }
  console.log(`WARNING: no usable roads file for county ${fips}; skipping it`);
  return null;
}

const results = new Map<string, IntersectionResult>();
const byCounty = new Map<string, Request[]>();
for (const r of requests) for (const c of r.counties) (byCounty.get(c) ?? byCounty.set(c, []).get(c)!).push(r);

for (const [county, reqs] of byCounty) {
  const pending = reqs.filter((r) => !results.get(r.sch)?.ok);
  if (pending.length === 0) continue;
  const wanted = new Set<string>();
  for (const r of pending)
    for (const n of r.names) {
      const k = streetKeys(n);
      if (k) wanted.add(k.full).add(k.base);
    }
  const roads = await countyRoads(fipsOf.get(county)!);
  if (!roads) continue;
  const index = buildRoadIndex(roads, wanted);
  for (const r of pending) {
    const res = findIntersection(index, r.names, { city: r.city, county: countyAreaOf(county) });
    const prior = results.get(r.sch);
    // Keep the most informative failure across counties; any success wins.
    if (res.ok || !prior) results.set(r.sch, res);
  }
  console.log(`County ${boundaries.counties[county].name}: ${pending.length} requests`);
}

// ---- 3. Report --------------------------------------------------------------
const reasons: Record<string, number> = {};
const upgradedFrom: Record<string, number> = {};
const moved: number[] = [];
const matched: Request[] = [];
const failed: (Request & { reason: string })[] = [];
for (const r of requests) {
  const res = results.get(r.sch)!;
  if (res.ok) {
    reasons.matched = (reasons.matched ?? 0) + 1;
    const p = r.prev?.precision ?? 'unmapped';
    upgradedFrom[p] = (upgradedFrom[p] ?? 0) + 1;
    if (r.prev) moved.push(haversineKm(r.prev, res));
    matched.push(r);
  } else {
    reasons[res.reason] = (reasons[res.reason] ?? 0) + 1;
    failed.push({ ...r, reason: res.reason });
  }
}
moved.sort((a, b) => a - b);
const pct = (n: number) => `${((100 * n) / requests.length).toFixed(1)}%`;
console.log('\n=== Intersection matching report ===');
console.log(JSON.stringify(stats));
console.log(`Requests (approximate projects with 2+ parsed street names): ${requests.length}`);
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v} (${pct(v)})`);
console.log('Matched projects previously placed at:', JSON.stringify(upgradedFrom));
if (moved.length)
  console.log(
    `Distance moved (km): median ${moved[Math.floor(moved.length / 2)].toFixed(1)}, 90th pct ${moved[Math.floor(moved.length * 0.9)].toFixed(1)}`,
  );

const rand = seededRandom('report');
const sample = <T>(xs: T[], n: number) => [...xs].sort(() => rand() - 0.5).slice(0, n);
console.log('\n--- Sample matches ---');
for (const r of sample(matched, 30)) {
  const res = results.get(r.sch) as Extract<IntersectionResult, { ok: true }>;
  console.log(`${r.sch} | ${r.text.slice(0, 70)} | ${r.city?.name ?? '-'} | ${res.lat.toFixed(5)},${res.lon.toFixed(5)}`);
}
for (const reason of ['street-not-found', 'no-crossing', 'ambiguous', 'outside-area']) {
  console.log(`\n--- Sample failures: ${reason} ---`);
  for (const r of sample(failed.filter((f) => f.reason === reason), 12))
    console.log(`${r.sch} | ${r.text.slice(0, 70)} | parsed: ${r.names.join(' + ')} | ${r.city?.name ?? '-'}`);
}

const out: Record<string, { lon: number; lat: number; streets: [string, string] }> = {};
for (const [sch, res] of results) if (res.ok) out[sch] = { lon: res.lon, lat: res.lat, streets: res.streets };
await storage.put('state/intersections-prototype.json', JSON.stringify(out), { contentType: 'application/json' });
console.log(`\nSaved ${Object.keys(out).length} matches to state/intersections-prototype.json`);
