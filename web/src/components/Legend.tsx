import { useState } from 'react';
import { type PublishedMeta, STATUSES } from '../../../packages/shared/src/index.ts';
import { formatNumber } from '../lib/format.ts';

export function Legend({ meta, mode }: { meta: PublishedMeta | null; mode: 'light' | 'dark' }) {
  const [open, setOpen] = useState(() => window.innerWidth >= 720 && window.innerHeight >= 680);
  const approx = meta
    ? meta.counts.byPrecision.city + meta.counts.byPrecision.county + meta.counts.byPrecision.region
    : 0;

  return (
    <section className="legend card" aria-labelledby="legend-title">
      <button className="legend-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span id="legend-title" className="eyebrow">
          Stage of review
        </span>
        <span className="chevron" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <>
          <ul className="legend-list">
            {STATUSES.map((s) => (
              <li key={s.id} title={s.description}>
                <span className={`dot ${mode}`} style={{ background: s[mode] }} aria-hidden="true" />
                <span className="legend-label">{s.label}</span>
                <span className="legend-count">{meta ? formatNumber(meta.counts.byStatus[s.id]) : ''}</span>
              </li>
            ))}
          </ul>
          <hr />
          <ul className="legend-list precision">
            <li>
              <span className="dot solid" aria-hidden="true" />
              <span className="legend-label">Exact location</span>
              <span className="legend-count">{meta ? formatNumber(meta.counts.byPrecision.exact) : ''}</span>
            </li>
            <li>
              <span className="dot cross" aria-hidden="true" />
              <span className="legend-label">Near the listed cross streets</span>
              <span className="legend-count">
                {meta ? formatNumber(meta.counts.byPrecision.intersection ?? 0) : ''}
              </span>
            </li>
            <li>
              <span className="dot ring" aria-hidden="true" />
              <span className="legend-label">Approximate location</span>
              <span className="legend-count">{meta ? formatNumber(approx) : ''}</span>
            </li>
          </ul>
          {meta && meta.counts.unmapped > 0 && (
            <p className="legend-note">
              {formatNumber(meta.counts.unmapped)} statewide or multi‑region projects have no single location and are
              not shown.
            </p>
          )}
        </>
      )}
    </section>
  );
}
