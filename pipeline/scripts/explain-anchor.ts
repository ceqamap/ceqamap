/**
 * Report: how an area's anchor is chosen (see lib/areas.ts), for some cities.
 *
 *   EXPLAIN=sacramento,san diego node scripts/explain-anchor.ts
 */
import { readFile } from 'node:fs/promises';
import { Anchors, interiorPoint } from '../src/lib/areas.ts';
import type { Boundaries } from '../src/lib/boundaries.ts';
import { pointInShape } from '../src/lib/geometry.ts';
import type { Gazetteer } from '../src/lib/landmarks.ts';

const b = JSON.parse(await readFile(new URL('../data/boundaries.json', import.meta.url), 'utf8')) as Boundaries;
const g = JSON.parse(await readFile(new URL('../data/gnis.json', import.meta.url), 'utf8')) as Gazetteer;
const anchors = new Anchors(b, g);
for (const key of (process.env.EXPLAIN ?? '').split(',').filter(Boolean)) {
  const a = b.places[key];
  console.log(
    JSON.stringify({
      key,
      inBoundaries: !!a,
      bbox: a?.bbox,
      gnis: (g.names[key] ?? []).map((f) => ({ ...f, inside: a ? pointInShape(f.lon, f.lat, a.shape) : null })),
      interior: a ? interiorPoint(a.shape, a.bbox) : null,
      anchor: anchors.city(key),
    }),
  );
}
