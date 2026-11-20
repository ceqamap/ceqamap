/**
 * Download the Census Gazetteer place and county files and write the
 * compact lookup to pipeline/data/gazetteer.json. Run once, commit the
 * output, and rerun when the Census publishes a new vintage.
 *
 *   pnpm --filter @ceqa-atlas/pipeline gazetteer
 *
 * Requires the `unzip` command (present on macOS, Linux, and GitHub runners).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGazetteer, parseGazetteerFile } from '../src/lib/gazetteer.ts';

const VINTAGE = process.env.GAZETTEER_VINTAGE ?? '2024';
const BASE = `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${VINTAGE}_Gazetteer`;
const FILES = {
  places: `${VINTAGE}_Gaz_place_national.zip`,
  counties: `${VINTAGE}_Gaz_counties_national.zip`,
};

const dir = await mkdtemp(join(tmpdir(), 'gaz-'));

async function load(file: string): Promise<string> {
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) throw new Error(`Download failed: ${BASE}/${file} -> ${res.status}`);
  const zip = join(dir, file);
  await writeFile(zip, new Uint8Array(await res.arrayBuffer()));
  const listing = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
  const txt = listing.find((n) => n.endsWith('.txt'));
  if (!txt) throw new Error(`No .txt inside ${file}`);
  execFileSync('unzip', ['-o', '-q', zip, txt, '-d', dir]);
  // Census files are Latin-1 in older vintages and UTF-8 in newer ones.
  const bytes = await readFile(join(dir, txt));
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return utf8.includes('�') ? new TextDecoder('latin1').decode(bytes) : utf8;
}

const places = parseGazetteerFile(await load(FILES.places));
const counties = parseGazetteerFile(await load(FILES.counties));
if (places.length < 1000 || counties.length !== 58) {
  throw new Error(`Unexpected counts: ${places.length} places, ${counties.length} counties`);
}
const gaz = buildGazetteer(places, counties);
const out = new URL('../data/gazetteer.json', import.meta.url);
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(out, JSON.stringify({ vintage: VINTAGE, ...gaz }));
console.log(`Wrote ${Object.keys(gaz.places).length} places and ${Object.keys(gaz.counties).length} counties`);
