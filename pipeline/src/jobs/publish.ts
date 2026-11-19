/**
 * Upload ./out to the public data bucket, safely:
 *
 *   1. Tileset goes up under a new immutable name (projects-<buildId>.pmtiles),
 *      so browsers and the CDN can cache it forever and nobody ever reads a
 *      half-written file.
 *   2. Only project files whose content changed are uploaded.
 *   3. meta.json is written LAST. Until then, every client keeps using the
 *      previous, complete build.
 *   4. Old tilesets are pruned, keeping a few for clients mid-session.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PublishedMeta, PublishedProject } from '../../../packages/shared/src/index.ts';
import { log } from '../lib/log.ts';
import { mapLimit, storageFromEnv } from '../lib/storage.ts';

const OUT = new URL('../../out/', import.meta.url).pathname;
const MANIFEST = 'state/manifest.json';
const KEEP_TILESETS = 3;
const storage = storageFromEnv();

const meta = JSON.parse(await readFile(join(OUT, 'meta.json'), 'utf8')) as PublishedMeta;
const tilesKey = `data/tiles/projects-${meta.buildId}.pmtiles`;

// 1. Tiles.
await storage.put(tilesKey, await readFile(join(OUT, 'projects.pmtiles')), {
  contentType: 'application/vnd.pmtiles',
  cacheControl: 'public, max-age=31536000, immutable',
});
log.info('Uploaded tiles', { tilesKey });

// 2. Project files, diffed against the last manifest.
const prevBytes = await storage.get(MANIFEST);
const prev: Record<string, string> = prevBytes ? JSON.parse(new TextDecoder().decode(prevBytes)) : {};
const next: Record<string, string> = {};
const toUpload: string[] = [];
for (const file of await readdir(join(OUT, 'projects'))) {
  const sch = file.replace('.json', '');
  const body = await readFile(join(OUT, 'projects', file), 'utf8');
  const { builtAt: _ignored, ...stable } = JSON.parse(body) as PublishedProject;
  const hash = createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
  next[sch] = hash;
  if (prev[sch] !== hash) toUpload.push(sch);
}
await mapLimit(toUpload, 48, async (sch) => {
  await storage.put(`data/projects/${sch}.json`, await readFile(join(OUT, 'projects', `${sch}.json`)), {
    contentType: 'application/json; charset=utf-8',
    cacheControl: 'public, max-age=300, stale-while-revalidate=86400',
  });
});
const removed = Object.keys(prev).filter((sch) => !(sch in next));
await mapLimit(removed, 48, (sch) => storage.delete(`data/projects/${sch}.json`));
await storage.put(MANIFEST, JSON.stringify(next), { contentType: 'application/json' });
log.info('Uploaded projects', { changed: toUpload.length, removed: removed.length, total: Object.keys(next).length });

// 3. Flip clients to the new build.
meta.tiles = tilesKey.replace(/^data\//, '');
await storage.put('data/meta.json', JSON.stringify(meta), {
  contentType: 'application/json; charset=utf-8',
  cacheControl: 'public, max-age=60, must-revalidate',
});
log.info('Published meta', { buildId: meta.buildId });

// 4. Prune.
const tilesets = (await storage.list('data/tiles/')).filter((k) => k.endsWith('.pmtiles')).sort();
for (const old of tilesets.slice(0, Math.max(0, tilesets.length - KEEP_TILESETS))) {
  if (old !== tilesKey) await storage.delete(old);
}
