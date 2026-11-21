import { useState } from 'react';
import {
  type ProjectStatus,
  type PublishedMeta,
  STATUSES,
  type TimeScope,
} from '../../../packages/shared/src/index.ts';
import { ALL_STAGES, allStagesShown, nextStages, scopeCounts } from '../lib/filters.ts';
import { formatNumber } from '../lib/format.ts';

interface Props {
  meta: PublishedMeta | null;
  mode: 'light' | 'dark';
  scope: TimeScope;
  stages: readonly ProjectStatus[];
  onStages: (stages: ProjectStatus[]) => void;
}

/**
 * Key to the map, and its stage filter: click a stage to hide or show it,
 * Alt/Option-click to show only that stage. Counts follow the time window.
 */
export function Legend({ meta, mode, scope, stages, onStages }: Props) {
  const [open, setOpen] = useState(() => window.innerWidth >= 720 && window.innerHeight >= 680);
  const counts = meta ? scopeCounts(meta, scope) : null;
  const filtered = !allStagesShown(stages);

  return (
    <section className={`legend card ${open ? 'open' : 'collapsed'}`} aria-labelledby="legend-title">
      <div className="legend-head">
        {/* The title toggles too (a bigger target); the button is the accessible control. */}
        <span id="legend-title" className="eyebrow" onClick={() => setOpen((o) => !o)}>
          Stage of review
        </span>
        <button
          type="button"
          className="map-button"
          aria-expanded={open}
          aria-controls="legend-body"
          aria-label={open ? 'Collapse the map key' : 'Expand the map key'}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '−' : '+'}
        </button>
      </div>
      {open && (
        <div id="legend-body" className="legend-body">
          <ul className="legend-list stages" aria-label="Stages shown on the map">
            {STATUSES.map((s) => {
              const on = stages.includes(s.id);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`stage-toggle ${on ? '' : 'off'}`}
                    aria-pressed={on}
                    title={`${s.description} Click to ${on ? 'hide' : 'show'}; Alt-click to show only this stage.`}
                    onClick={(e) => onStages(nextStages(stages, s.id, e.altKey))}
                  >
                    <span
                      className={`dot ${mode}`}
                      style={
                        on
                          ? { background: s[mode] }
                          : { background: 'transparent', boxShadow: `inset 0 0 0 1.5px ${s[mode]}` }
                      }
                      aria-hidden="true"
                    />
                    <span className="legend-label">{s.label}</span>
                    <span className="legend-count">{counts ? formatNumber(counts.byStatus[s.id]) : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {filtered && (
            <button type="button" className="legend-reset" onClick={() => onStages([...ALL_STAGES])}>
              Show all stages
            </button>
          )}
          <hr />
          <ul className="legend-list precision">
            <li>
              <span className="dot solid" aria-hidden="true" />
              <span className="legend-label">Exact location or street address</span>
              <span className="legend-count">{counts ? formatNumber(counts.byMark.exact) : ''}</span>
            </li>
            <li>
              <span className="dot cross" aria-hidden="true" />
              <span className="legend-label">Near the listed cross streets or a named place</span>
              <span className="legend-count">{counts ? formatNumber(counts.byMark.intersection) : ''}</span>
            </li>
            <li>
              <span className="dot ring" aria-hidden="true" />
              <span className="legend-label">Approximate location</span>
              <span className="legend-count">{counts ? formatNumber(counts.byMark.approx) : ''}</span>
            </li>
          </ul>
          {meta && meta.counts.unmapped > 0 && (
            <p className="legend-note">
              {formatNumber(meta.counts.unmapped)} statewide or multi‑region projects have no single location and are
              not shown.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
