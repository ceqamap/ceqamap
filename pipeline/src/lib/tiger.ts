/**
 * Census TIGER/Line road and linear water (streams, rivers, canals) files for
 * California, one per county (public domain). Downloaded on demand into a cache directory (kept between runs by
 * the GitHub Actions cache) and verified, since census.gov occasionally
 * serves truncated or corrupt zips.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Boundaries } from './boundaries.ts';
import { log } from './log.ts';
import { readShapefile, type ShapefileFeature } from './shapefile.ts';

export const TIGER_VINTAGE = '2024';
/** Tried in order when a county's file is missing or corrupt (San Luis Obispo's 2024 zip is). */
const FALLBACK_VINTAGES = ['2025', '2023'];

/**
 * County FIPS codes by normalized county key. California's are the odd
 * numbers 001–115, assigned in alphabetical order.
 */
export function countyFips(b: Boundaries): Map<string, string> {
  const keys = Object.keys(b.counties).sort((x, y) => b.counties[x].name.localeCompare(b.counties[y].name));
  if (keys.length !== 58) throw new Error(`Expected 58 counties, got ${keys.length}`);
  return new Map(keys.map((k, i) => [k, String(2 * i + 1).padStart(3, '0')]));
}

export type TigerLayer = 'roads' | 'linearwater';

async function tryVintage(
  dirRoot: string,
  fips: string,
  vintage: string,
  layer: TigerLayer,
): Promise<ShapefileFeature[] | null> {
  const name = `tl_${vintage}_06${fips}_${layer}`;
  const dir = join(dirRoot, name);
  if (!existsSync(join(dir, `${name}.shp`))) {
    await mkdir(dir, { recursive: true });
    const zip = join(dir, `${name}.zip`);
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const res = await fetch(`https://www2.census.gov/geo/tiger/TIGER${vintage}/${layer.toUpperCase()}/${name}.zip`);
      if (res.status === 404) return null;
      if (res.ok) {
        await writeFile(zip, new Uint8Array(await res.arrayBuffer()));
        try {
          execFileSync('unzip', ['-t', '-q', zip], { stdio: 'pipe' });
          ok = true;
        } catch {
          log.warn('Corrupt Census file; retrying', { name, attempt });
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

/** One county's roads, or null (with a warning) if no vintage is usable. */
export function countyRoads(dirRoot: string, fips: string): Promise<ShapefileFeature[] | null> {
  return countyLayer(dirRoot, fips, 'roads');
}

/** One county's named and unnamed streams, rivers, canals and ditches (lines). */
export function countyWater(dirRoot: string, fips: string): Promise<ShapefileFeature[] | null> {
  return countyLayer(dirRoot, fips, 'linearwater');
}

async function countyLayer(dirRoot: string, fips: string, layer: TigerLayer): Promise<ShapefileFeature[] | null> {
  for (const vintage of [TIGER_VINTAGE, ...FALLBACK_VINTAGES]) {
    const features = await tryVintage(dirRoot, fips, vintage, layer);
    if (features) {
      if (vintage !== TIGER_VINTAGE) log.warn('Using fallback Census vintage', { fips, layer, vintage });
      return features;
    }
  }
  log.warn('No usable Census file; skipping county', { fips, layer });
  return null;
}
