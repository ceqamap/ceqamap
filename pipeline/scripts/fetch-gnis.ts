/**
 * Download the USGS GNIS names for California and write the compact gazetteer
 * of point-like named places to pipeline/data/gnis.json (see lib/landmarks.ts).
 * Public domain. USGS refreshes the file every other month; the data workflow
 * caches the output and refetches when this script changes.
 *
 *   node scripts/fetch-gnis.ts
 *
 * Requires the `unzip` command (present on macOS, Linux, and GitHub runners).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGnis } from '../src/lib/landmarks.ts';

const URL_CA =
  process.env.GNIS_URL ??
  'https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_CA_Text.zip';

const dir = await mkdtemp(join(tmpdir(), 'gnis-'));
const res = await fetch(URL_CA);
if (!res.ok) throw new Error(`Download failed: ${URL_CA} -> ${res.status}`);
const zip = join(dir, 'gnis.zip');
await writeFile(zip, new Uint8Array(await res.arrayBuffer()));
execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
const txt = await findText(dir);
const g = parseGnis(await readFile(txt, 'utf8'), `USGS GNIS DomesticNames (${new Date().toISOString().slice(0, 10)})`);
const nNames = Object.keys(g.names).length;
if (nNames < 5000) throw new Error(`Unexpected count: ${nNames} names`);
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/gnis.json', import.meta.url), JSON.stringify(g));
console.log(JSON.stringify({ msg: 'Wrote gnis.json', names: nNames, file: txt }));

async function findText(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const t = entries.find((e) => /DomesticNames.*\.txt$/i.test(e)) ?? entries.find((e) => e.endsWith('.txt'));
  if (!t) throw new Error(`No .txt in GNIS zip: ${entries.join(', ')}`);
  return join(root, t);
}
