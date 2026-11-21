import { useEffect, useState } from 'react';
import {
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
  onScope: (scope: TimeScope) => void;
  onShowArrivals: (places: { lon: number; lat: number }[]) => void;
}

/** Start the live dot's ping in step with the map's arrival pings (see lib/motion.ts). */
function syncPing(el: HTMLElement | null) {
  if (el && !el.dataset.synced) {
    el.style.setProperty('--ping-delay', pingDelay(performance.now()));
    el.dataset.synced = '1';
  }
}

export function Header({ meta, status, scope, stages, onScope, onShowArrivals }: Props) {
  // Re-render every minute so "updated N minutes ago" stays honest.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const arrivals = meta?.arrivals;
  const places = arrivals?.items.flatMap((i) => (i.lon !== null && i.lat !== null ? [{ lon: i.lon, lat: i.lat }] : []));

  return (
    <header className="header card">
      <h1 className="wordmark">CEQA Map</h1>
      <p className="header-sub">Every project filed with California’s State Clearinghouse, on one map.</p>
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
              <span>Updated {timeAgo(meta.builtAt)}</span>
              {arrivals && places && places.length > 0 && (
                <>
                  <span aria-hidden="true"> · </span>
                  <button
                    type="button"
                    className="arrivals-link"
                    onClick={() => onShowArrivals(places)}
                    title={arrivalsTitle(arrivals)}
                  >
                    {formatNumber(arrivals.items.length)} new
                  </button>
                </>
              )}
              <span aria-hidden="true"> · </span>
              <span>{formatNumber(shownCount(meta, scope, stages))} projects</span>
              {meta.scopes && (
                <>
                  <span aria-hidden="true"> · </span>
                  <label className="scope-select">
                    <span className="visually-hidden">Show projects with filings in</span>
                    <select value={scope} onChange={(e) => onScope(e.target.value as TimeScope)}>
                      {TIME_SCOPES.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <span className="scope-chevron" aria-hidden="true">
                      ▾
                    </span>
                  </label>
                </>
              )}
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
  return `${parts.join(' and ')}, first seen ${timeAgo(a.at)}. Show them on the map.`;
}
