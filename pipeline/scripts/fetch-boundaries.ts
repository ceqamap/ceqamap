/**
 * Download the Census cartographic boundary files for California places and
 * all U.S. counties (1:500k, clipped to the shoreline), and write the compact
 * California lookup to pipeline/data/boundaries.json. Run once and commit the
 * output; rerun when the Census publishes a new vintage.
 *
 *   pnpm --filter @ceqa-atlas/pipeline boundaries
 *
 * Requires the `unzip` command (present on macOS, Linux, and GitHub runners).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOUNDARIES_FORMAT, buildBoundaries, buildZips } from '../src/lib/boundaries.ts';
import { readShapefile } from '../src/lib/shapefile.ts';

const VINTAGE = process.env.BOUNDARY_VINTAGE ?? '2024';
const BASE = `https://www2.census.gov/geo/tiger/GENZ${VINTAGE}/shp`;
const dir = await mkdtemp(join(tmpdir(), 'boundaries-'));

async function load(name: string, base = BASE) {
  const res = await fetch(`${base}/${name}.zip`);
  if (!res.ok) throw new Error(`Download failed: ${base}/${name}.zip -> ${res.status}`);
  const zip = join(dir, `${name}.zip`);
  await writeFile(zip, new Uint8Array(await res.arrayBuffer()));
  execFileSync('unzip', ['-o', '-q', zip, `${name}.shp`, `${name}.dbf`, '-d', dir]);
  return readShapefile(
    new Uint8Array(await readFile(join(dir, `${name}.shp`))),
    new Uint8Array(await readFile(join(dir, `${name}.dbf`))),
  );
}

const places = await load(`cb_${VINTAGE}_06_place_500k`);
const counties = await load(`cb_${VINTAGE}_us_county_500k`);
// ZIP Code Tabulation Areas are only redrawn each decennial census; try the
// newest cartographic file first.
let zctas: Awaited<ReturnType<typeof load>> | null = null;
let zctaVintage = '';
for (const v of [VINTAGE, '2023', '2020']) {
  try {
    zctas = await load(`cb_${v}_us_zcta520_500k`, `https://www2.census.gov/geo/tiger/GENZ${v}/shp`);
    zctaVintage = v;
    break;
  } catch (err) {
    console.warn(String(err));
  }
}
if (!zctas) throw new Error('No ZCTA file found');
const b = { ...buildBoundaries(places, counties), zips: buildZips(zctas) };
const nZips = Object.keys(b.zips).length;
if ((b.neighbors?.length ?? 0) < 60) throw new Error(`Unexpected count: ${b.neighbors?.length} neighboring counties`);
if (nZips < 1500) throw new Error(`Unexpected count: ${nZips} ZIP areas`);
const nPlaces = Object.keys(b.places).length;
const nCounties = Object.keys(b.counties).length;
if (nPlaces < 1000 || nCounties !== 58) throw new Error(`Unexpected counts: ${nPlaces} places, ${nCounties} counties`);

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../data/boundaries.json', import.meta.url),
  JSON.stringify({ format: BOUNDARIES_FORMAT, ...b, vintage: VINTAGE, zipVintage: zctaVintage }),
);
console.log(`Wrote ${nPlaces} places, ${nCounties} counties and ${nZips} ZIP areas (ZCTA ${zctaVintage})`);
