/**
 * Rebuild all published artifacts from stored documents into ./out:
 *   out/points.ndjson        input for tippecanoe
 *   out/projects.pmtiles     clustered vector tiles
 *   out/projects/<sch>.json  drawer details
 *   out/meta.json            counts and build id (tiles path set at publish)
 *
 * Status depends on today's date (comment periods open and close), so this
 * must run at least daily even when no new documents arrived.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PublishedMeta } from '../../../packages/shared/src/index.ts';
import { aggregate } from '../lib/aggregate.ts';
import { todayInCalifornia } from '../lib/ceqanet.ts';
import type { CeqaDocument } from '../lib/document.ts';
import type { Boundaries } from '../lib/boundaries.ts';
import { log } from '../lib/log.ts';
import { listPartitionMonths, readPartition } from '../lib/partitions.ts';
import { storageFromEnv } from '../lib/storage.ts';

const OUT = new URL('../../out/', import.meta.url).pathname;
const storage = storageFromEnv();

const boundariesPath =
  process.env.BOUNDARIES_PATH ?? new URL('../../data/boundaries.json', import.meta.url).pathname;
const boundaries = JSON.parse(await readFile(boundariesPath, 'utf8')) as Boundaries;

const docs: CeqaDocument[] = [];
for (const month of await listPartitionMonths(storage)) docs.push(...(await readPartition(storage, month)));
if (docs.length === 0) throw new Error('No documents in storage. Run backfill first.');

const builtAt = new Date().toISOString();
const today = todayInCalifornia();
const result = aggregate(docs, boundaries, today, builtAt);

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'projects'), { recursive: true });

await writeFile(join(OUT, 'points.ndjson'), result.points.map((f) => JSON.stringify(f)).join('\n') + '\n');
for (const p of result.projects) {
  // builtAt is excluded from hashing at publish time, so unchanged projects are not re-uploaded.
  await writeFile(join(OUT, 'projects', `${p.sch}.json`), JSON.stringify(p));
}

const buildId = builtAt.replace(/[-:TZ.]/g, '').slice(0, 14);
const meta: PublishedMeta = {
  buildId,
  builtAt,
  tiles: '', // filled in by publish
  latestReceived: result.latestReceived,
  counts: result.counts,
};
await writeFile(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
log.info('Aggregated', { ...result.counts, today });

// Tippecanoe: cluster overlapping points below z13, keep every point (no
// dropping) so the map is a complete census, and sum `r` so clusters know how
// many in-review projects they contain.
const tippecanoe = spawnSync(
  process.env.TIPPECANOE ?? 'tippecanoe',
  [
    '--output',
    join(OUT, 'projects.pmtiles'),
    '--force',
    '--layer',
    'projects',
    '--name',
    'CEQA projects',
    '--attribution',
    'Data: California State Clearinghouse (CEQAnet)',
    '--minimum-zoom',
    '3',
    '--maximum-zoom',
    '14',
    '--drop-rate',
    '1',
    '--cluster-distance',
    '28',
    '--cluster-maxzoom',
    '12',
    '--accumulate-attribute',
    'r:sum',
    '--no-feature-limit',
    '--no-tile-size-limit',
    '--read-parallel',
    '--quiet',
    join(OUT, 'points.ndjson'),
  ],
  { stdio: 'inherit' },
);
if (tippecanoe.error) throw new Error(`tippecanoe could not start: ${tippecanoe.error.message}`);
if (tippecanoe.status !== 0) throw new Error(`tippecanoe exited with ${tippecanoe.status}`);
log.info('Build finished', { buildId });
