import {
  inScope,
  type ProjectStatus,
  type PublishedProject,
  type PublishedScope,
  TIME_SCOPES,
  type TimeScope,
} from '../../../packages/shared/src/index.ts';
import type { PointFeature } from './aggregate.ts';

/**
 * Split the map points into one set per time window (see TIME_SCOPES).
 *
 * Each window gets its own clustered tileset. Clusters are computed when tiles
 * are built, so filtering points in the browser would leave cluster counts
 * wrong; a tileset per window keeps them exact. Stage filtering does not need
 * this, because clusters carry per-stage counts (see TilePointProperties).
 */

export interface ScopeSplit {
  points: PointFeature[];
  counts: Omit<PublishedScope, 'tiles'>;
}

/** Latest Received date per project (documents are stored newest first). */
export function lastFilingDates(projects: Iterable<PublishedProject>): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of projects) out.set(p.sch, p.documents[0]?.received ?? p.statusDate);
  return out;
}

export function splitByScope(
  points: readonly PointFeature[],
  lastFiling: ReadonlyMap<string, string>,
  today: string,
): Record<TimeScope, ScopeSplit> {
  const out = {} as Record<TimeScope, ScopeSplit>;
  for (const scope of TIME_SCOPES) {
    const byStatus = { in_review: 0, scoping: 0, review_closed: 0, approved: 0, exempt: 0, other: 0 } satisfies Record<
      ProjectStatus,
      number
    >;
    const byMark = { exact: 0, intersection: 0, approx: 0 };
    const selected: PointFeature[] = [];
    for (const f of points) {
      const p = f.properties;
      const keep = inScope(scope.id, today, {
        lastFiling: lastFiling.get(p.id) ?? '',
        status: p.s,
        arrived: (p.n ?? 0) > 0,
      });
      if (!keep) continue;
      selected.push(f);
      byStatus[p.s]++;
      if (p.x === 1) byMark.exact++;
      else if (p.x === 2) byMark.intersection++;
      else byMark.approx++;
    }
    out[scope.id] = { points: selected, counts: { mapped: selected.length, byStatus, byMark } };
  }
  return out;
}
