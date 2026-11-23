import {
  DEFAULT_TIME_SCOPE,
  isTimeScope,
  type MapMark,
  MARKS,
  type ProjectStatus,
  type PublishedMeta,
  STATUSES,
  type TimeScope,
} from '../../../packages/shared/src/index.ts';

/**
 * The map's filters, kept in the URL so a filtered view can be shared:
 *   ?t=30d                       time window (default 12m, omitted)
 *   ?stages=in_review,scoping    stages shown (default all, omitted)
 *   ?marks=exact,intersection    locations shown (default all, omitted)
 * Pure functions; unit-tested in filters.test.ts.
 */

export const ALL_STAGES: readonly ProjectStatus[] = STATUSES.map((s) => s.id);
export const ALL_MARKS: readonly MapMark[] = MARKS.map((m) => m.id);

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

export function readMarks(params: URLSearchParams): MapMark[] {
  const raw = params.get('marks');
  if (raw === null) return [...ALL_MARKS];
  const wanted = new Set(raw.split(','));
  return ALL_MARKS.filter((m) => wanted.has(m));
}

export function allStagesShown(stages: readonly ProjectStatus[]): boolean {
  return ALL_STAGES.every((s) => stages.includes(s));
}

export function allMarksShown(marks: readonly MapMark[]): boolean {
  return ALL_MARKS.every((m) => marks.includes(m));
}

/** Query values to write for the filters (null removes the parameter). */
export function filterParams(
  scope: TimeScope,
  stages: readonly ProjectStatus[],
  marks: readonly MapMark[] = ALL_MARKS,
): { t: string | null; stages: string | null; marks: string | null } {
  return {
    t: scope === DEFAULT_TIME_SCOPE ? null : scope,
    stages: allStagesShown(stages) ? null : ALL_STAGES.filter((s) => stages.includes(s)).join(','),
    marks: allMarksShown(marks) ? null : ALL_MARKS.filter((m) => marks.includes(m)).join(','),
  };
}

/** Legend click: toggle one item. Alt/Option-click: show only that item, or everything if it already was alone. */
function nextShown<T>(all: readonly T[], current: readonly T[], clicked: T, solo: boolean): T[] {
  if (solo) {
    const alone = current.length === 1 && current[0] === clicked;
    return alone ? [...all] : [clicked];
  }
  return current.includes(clicked)
    ? current.filter((s) => s !== clicked)
    : all.filter((s) => s === clicked || current.includes(s));
}

export function nextStages(current: readonly ProjectStatus[], clicked: ProjectStatus, solo: boolean): ProjectStatus[] {
  return nextShown(ALL_STAGES, current, clicked, solo);
}

export function nextMarks(current: readonly MapMark[], clicked: MapMark, solo: boolean): MapMark[] {
  return nextShown(ALL_MARKS, current, clicked, solo);
}

/** Whether this window's data can filter by location (see PublishedScope.byStageMark). */
export function marksSupported(meta: PublishedMeta | null, scope: TimeScope): boolean {
  return Boolean(meta?.scopes?.[scope]?.byStageMark);
}

/**
 * Counts for the active window, or the all-time counts for data built before
 * windows existed. With per stage-and-mark counts, each list counts what the
 * other list shows: stage counts within the shown locations, location counts
 * within the shown stages.
 */
export function scopeCounts(
  meta: PublishedMeta,
  scope: TimeScope,
  stages: readonly ProjectStatus[] = ALL_STAGES,
  marks: readonly MapMark[] = ALL_MARKS,
) {
  const s = meta.scopes?.[scope];
  const joint = s?.byStageMark;
  if (s && joint) {
    const byStatus = Object.fromEntries(
      ALL_STAGES.map((st) => [st, marks.reduce((n, m) => n + joint[st][m], 0)]),
    ) as Record<ProjectStatus, number>;
    const byMark = Object.fromEntries(
      ALL_MARKS.map((m) => [m, stages.reduce((n, st) => n + joint[st][m], 0)]),
    ) as Record<MapMark, number>;
    return { byStatus, byMark, windowed: true };
  }
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

/** Projects on the map for this window, these stages and these locations. */
export function shownCount(
  meta: PublishedMeta,
  scope: TimeScope,
  stages: readonly ProjectStatus[],
  marks: readonly MapMark[] = ALL_MARKS,
): number {
  const s = meta.scopes?.[scope];
  const joint = s?.byStageMark;
  if (joint) return stages.reduce((n, st) => n + marks.reduce((k, m) => k + joint[st][m], 0), 0);
  if (!s)
    return allStagesShown(stages) ? meta.counts.mapped : stages.reduce((n, id) => n + meta.counts.byStatus[id], 0);
  return stages.reduce((n, id) => n + s.byStatus[id], 0);
}
