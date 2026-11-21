import {
  DEFAULT_TIME_SCOPE,
  isTimeScope,
  type ProjectStatus,
  type PublishedMeta,
  STATUSES,
  type TimeScope,
} from '../../../packages/shared/src/index.ts';

/**
 * The map's two filters, kept in the URL so a filtered view can be shared:
 *   ?t=30d                       time window (default 12m, omitted)
 *   ?stages=in_review,scoping    stages shown (default all, omitted)
 * Pure functions; unit-tested in filters.test.ts.
 */

export const ALL_STAGES: readonly ProjectStatus[] = STATUSES.map((s) => s.id);

export function readScope(params: URLSearchParams): TimeScope {
  const t = params.get('t');
  return isTimeScope(t) ? t : DEFAULT_TIME_SCOPE;
}

export function readStages(params: URLSearchParams): ProjectStatus[] {
  const raw = params.get('stages');
  if (raw === null) return [...ALL_STAGES];
  const wanted = new Set(raw.split(','));
  // Keep the legend's order; ignore unknown ids. An empty value means none.
  return ALL_STAGES.filter((s) => wanted.has(s));
}

export function allStagesShown(stages: readonly ProjectStatus[]): boolean {
  return ALL_STAGES.every((s) => stages.includes(s));
}

/** Query values to write for the filters (null removes the parameter). */
export function filterParams(
  scope: TimeScope,
  stages: readonly ProjectStatus[],
): { t: string | null; stages: string | null } {
  return {
    t: scope === DEFAULT_TIME_SCOPE ? null : scope,
    stages: allStagesShown(stages) ? null : ALL_STAGES.filter((s) => stages.includes(s)).join(','),
  };
}

/** Legend click: toggle one stage. Alt/Option-click: show only that stage, or everything if it already was alone. */
export function nextStages(current: readonly ProjectStatus[], clicked: ProjectStatus, solo: boolean): ProjectStatus[] {
  if (solo) {
    const alone = current.length === 1 && current[0] === clicked;
    return alone ? [...ALL_STAGES] : [clicked];
  }
  return current.includes(clicked)
    ? current.filter((s) => s !== clicked)
    : ALL_STAGES.filter((s) => s === clicked || current.includes(s));
}

/** Counts for the active window, or the all-time counts for data built before windows existed. */
export function scopeCounts(meta: PublishedMeta, scope: TimeScope) {
  const s = meta.scopes?.[scope];
  if (s) return { byStatus: s.byStatus, byMark: s.byMark, windowed: true };
  const p = meta.counts.byPrecision;
  return {
    byStatus: meta.counts.byStatus,
    byMark: {
      exact: p.exact + (p.address ?? 0),
      intersection: (p.intersection ?? 0) + (p.landmark ?? 0),
      approx: (p.street ?? 0) + (p.community ?? 0) + (p.zip ?? 0) + p.city + p.county + p.region,
    },
    windowed: false,
  };
}

/** Projects on the map for this window and these stages. */
export function shownCount(meta: PublishedMeta, scope: TimeScope, stages: readonly ProjectStatus[]): number {
  const s = meta.scopes?.[scope];
  if (!s)
    return allStagesShown(stages) ? meta.counts.mapped : stages.reduce((n, id) => n + meta.counts.byStatus[id], 0);
  return stages.reduce((n, id) => n + s.byStatus[id], 0);
}
