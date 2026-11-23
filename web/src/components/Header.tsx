import { useEffect, useState } from 'react';
import {
  type MapMark,
  type ProjectStatus,
  type PublishedMeta,
  TIME_SCOPES,
  type TimeScope,
} from '../../../packages/shared/src/index.ts';
import type { DataStatusError } from '../lib/data.ts';
import { shownCount } from '../lib/filters.ts';
import { formatNumber, timeAgo } from '../lib/format.ts';
import { pingDelay } from '../lib/motion.ts';

interface Props {
  meta: PublishedMeta | null;
  status: DataStatusError | null;
  scope: TimeScope;
  stages: readonly ProjectStatus[];
  marks: readonly MapMark[];
  onScope: (scope: TimeScope) => void;
  /** Position in the tour of arrivals (null before the first click). */
  arrivalIndex: number | null;
  onNextArrival: () => void;
}

/** Start the live dot's ping in step with the map's arrival pings (see lib/motion.ts). */
function syncPing(el: HTMLElement | null) {
  if (el && !el.dataset.synced) {
    el.style.setProperty('--ping-delay', pingDelay(performance.now()));
    el.dataset.synced = '1';
  }
}

export function Header({ meta, status, scope, stages, marks, onScope, arrivalIndex, onNextArrival }: Props) {
  // Re-render every minute so "updated N minutes ago" stays honest.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const arrivals = meta?.arrivals;
  const mapped = arrivals?.items.filter((i) => i.lon !== null && i.lat !== null).length ?? 0;

  return (
    <header className="header card">
      <h1 className="wordmark">CEQA Map</h1>
      <p className="header-sub">
        {/* Two deliberate lines, so the card can shrink to fit them (see .header). */}
        Every project filed with California’s
        <br />
        State Clearinghouse, on one map.
      </p>
      <div className="live" aria-live="polite">
        {status && !meta ? (
          <>
            <span className={`live-dot ${status.kind}`} aria-hidden="true" />
            <span>{status.message}</span>
          </>
        ) : meta ? (
          <>
            <span className="live-dot" ref={syncPing} aria-hidden="true" />
            <span className="live-text">
              <span className="live-line">
                Updated {timeAgo(meta.builtAt)}
                {arrivals && mapped > 0 && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="arrivals-link"
                      onClick={onNextArrival}
                      title={arrivalsTitle(arrivals)}
                    >
                      {arrivalIndex === null
                        ? `${formatNumber(arrivals.items.length)} new`
                        : `${arrivalIndex + 1} of ${formatNumber(mapped)} new ›`}
                    </button>
                  </>
                )}
              </span>
              <span className="live-line">
                {formatNumber(shownCount(meta, scope, stages, marks))} projects
                {meta.scopes && (
                  <>
                    {' · '}
                    <label className="scope-select">
                      <span className="visually-hidden">Show projects with filings in</span>
                      <select value={scope} onChange={(e) => onScope(e.target.value as TimeScope)}>
                        {TIME_SCOPES.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                      <svg className="scope-chevron" width="8" height="5" viewBox="0 0 8 5" aria-hidden="true">
                        <path d="M0.75 0.75 4 4 7.25 0.75" fill="none" stroke="currentColor" strokeWidth="1.25" />
                      </svg>
                    </label>
                  </>
                )}
              </span>
            </span>
          </>
        ) : (
          <span className="muted">Loading the latest filings…</span>
        )}
      </div>
    </header>
  );
}

function arrivalsTitle(a: NonNullable<PublishedMeta['arrivals']>): string {
  const parts = [];
  if (a.projects) parts.push(`${formatNumber(a.projects)} new project${a.projects === 1 ? '' : 's'}`);
  if (a.filings) parts.push(`${formatNumber(a.filings)} new filing${a.filings === 1 ? '' : 's'} on existing projects`);
  return `${parts.join(' and ')}, first seen ${timeAgo(a.at)}. Click to visit them one by one.`;
}
