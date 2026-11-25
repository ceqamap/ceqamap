import { useState } from 'react';
import {
  type MapMark,
  type ProjectStatus,
  type PublishedMeta,
  STATUSES,
  type TimeScope,
} from '../../../packages/shared/src/index.ts';
import {
  ALL_MARKS,
  ALL_STAGES,
  allMarksShown,
  allStagesShown,
  nextMarks,
  nextStages,
  scopeCounts,
} from '../lib/filters.ts';
import { formatNumber } from '../lib/format.ts';

interface Props {
  meta: PublishedMeta | null;
  mode: 'light' | 'dark';
  scope: TimeScope;
  stages: readonly ProjectStatus[];
  marks: readonly MapMark[];
  /** Whether the data supports the location filter (see marksSupported). */
  canFilterMarks: boolean;
  onStages: (stages: ProjectStatus[]) => void;
  onMarks: (marks: MapMark[]) => void;
}

const LOCATIONS: { id: MapMark; dot: string; label: string; title: string }[] = [
  {
    id: 'exact',
    dot: 'solid',
    label: 'Exact location',
    title: 'Coordinates from the lead agency, or the street address in the project description',
  },
  {
    id: 'intersection',
    dot: 'cross',
    label: 'Near a named location',
    title:
      'Where the listed cross streets meet, at the highway postmiles, or at a place, road crossing or stream crossing named in the project description',
  },
  {
    id: 'approx',
    dot: 'ring',
    label: 'Approximate location',
    title: 'Along a named street or waterway, or somewhere in the listed community, city, ZIP code or county',
  },
];

const tap = window.matchMedia('(pointer: coarse)').matches ? 'Tap' : 'Click';

/**
 * Key to the map, and its filters: click a stage or a location to hide or
 * show it, Alt/Option-click to show only that one. Counts follow the time
 * window, and each list counts within what the other list shows.
 *
 * Each list opens with one row: a hint while everything shows, "Show all …"
 * once something is hidden. The row is always there, so the list never moves
 * under the pointer as rows are toggled.
 */
export function Legend({ meta, mode, scope, stages, marks, canFilterMarks, onStages, onMarks }: Props) {
  const [open, setOpen] = useState(() => window.innerWidth >= 720 && window.innerHeight >= 680);
  const counts = meta ? scopeCounts(meta, scope, stages, marks) : null;
  const stagesFiltered = !allStagesShown(stages);
  const marksFiltered = !allMarksShown(marks);

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
      {/* Always rendered, so opening and closing can animate; inert while closed. */}
      <div id="legend-body" className="legend-reveal" inert={!open}>
        <div className="legend-clip">
          <div className="legend-body">
            <FilterRow
              filtered={stagesFiltered}
              hint={`${tap} a stage to hide it`}
              reset="Show all stages"
              onReset={() => onStages([...ALL_STAGES])}
            />
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
            <hr />
            {canFilterMarks && (
              <FilterRow
                filtered={marksFiltered}
                hint={`${tap} a location type to hide it`}
                reset="Show all locations"
                onReset={() => onMarks([...ALL_MARKS])}
              />
            )}
            <ul
              className={`legend-list precision ${canFilterMarks ? 'stages' : ''}`}
              aria-label="Locations shown on the map"
            >
              {LOCATIONS.map((l) => {
                const on = marks.includes(l.id);
                const count = <span className="legend-count">{counts ? formatNumber(counts.byMark[l.id]) : ''}</span>;
                const dot = <span className={`dot ${l.dot}`} aria-hidden="true" />;
                const label = <span className="legend-label">{l.label}</span>;
                return (
                  <li key={l.id}>
                    {canFilterMarks ? (
                      <button
                        type="button"
                        className={`stage-toggle ${on ? '' : 'off'}`}
                        aria-pressed={on}
                        title={`${l.title}. Click to ${on ? 'hide' : 'show'}; Alt-click to show only these.`}
                        onClick={(e) => onMarks(nextMarks(marks, l.id, e.altKey))}
                      >
                        {dot}
                        {label}
                        {count}
                      </button>
                    ) : (
                      <span className="legend-static" title={l.title}>
                        {dot}
                        {label}
                        {count}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {meta && meta.counts.unmapped > 0 && (
              <p className="legend-note">
                {formatNumber(meta.counts.unmapped)} statewide or multi‑region projects have no single location and are
                not shown.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** First row of a legend list: a hint, or "Show all …" once something is hidden. */
function FilterRow({
  filtered,
  hint,
  reset,
  onReset,
}: {
  filtered: boolean;
  hint: string;
  reset: string;
  onReset: () => void;
}) {
  return (
    <div className="legend-filter-row">
      {filtered ? (
        <button type="button" className="legend-reset" onClick={onReset}>
          {reset}
        </button>
      ) : (
        <span className="legend-hint">{hint}</span>
      )}
    </div>
  );
}
