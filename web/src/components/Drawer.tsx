import { useEffect, useRef, useState } from 'react';
import {
  type LocationPrecision,
  PRECISION_LABEL,
  type PublishedProject,
  STATUS_BY_ID,
} from '../../../packages/shared/src/index.ts';
import { fetchProject } from '../lib/data.ts';
import {
  factTag,
  formatDate,
  formatNumber,
  placeLine,
  reviewCountdown,
  splitFacts,
  todayInCalifornia,
} from '../lib/format.ts';

interface Props {
  sch: string | null;
  mode: 'light' | 'dark';
  onClose: () => void;
  onLoaded: (p: PublishedProject) => void;
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; project: PublishedProject };

const DESCRIPTION_PREVIEW = 420;

const FALLBACK_PHRASE: Record<LocationPrecision, string> = {
  exact: 'at its coordinates',
  address: 'at the street address in its description',
  intersection: 'near its listed cross streets',
  landmark: 'at a place named in its description',
  street: 'along its listed street',
  community: 'at a community named in its description',
  zip: 'within its listed ZIP code',
  city: 'within its listed city',
  county: 'within its listed county',
  region: 'between its listed counties',
};

export function Drawer({ sch, mode, onClose, onLoaded }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const heading = useRef<HTMLHeadingElement>(null);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  // Keep showing the last project while the drawer slides closed, instead of
  // emptying it first.
  const [shownSch, setShownSch] = useState(sch);
  useEffect(() => {
    if (!sch) return;
    setShownSch(sch);
    let live = true;
    setState({ kind: 'loading' });
    fetchProject(sch).then(
      (project) => {
        if (!live) return;
        setState({ kind: 'ready', project });
        onLoadedRef.current(project);
      },
      (e: Error) => live && setState({ kind: 'error', message: e.message }),
    );
    return () => {
      live = false;
    };
  }, [sch]);

  useEffect(() => {
    if (state.kind === 'ready') heading.current?.focus();
  }, [state]);

  useEffect(() => {
    if (!sch) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sch, onClose]);

  const open = sch !== null;
  return (
    <aside
      className={`drawer card ${open ? 'open' : ''}`}
      aria-hidden={!open}
      inert={!open}
      aria-labelledby="drawer-title"
      role="dialog"
    >
      {shownSch && (
        <>
          <div className="drawer-bar">
            <span className="eyebrow">SCH {shownSch}</span>
            <button className="icon-button" onClick={onClose} aria-label="Close project details">
              ✕
            </button>
          </div>
          <div className="drawer-body">
            {state.kind === 'loading' && <DrawerSkeleton />}
            {state.kind === 'error' && <p className="muted">{state.message}. Try again in a moment.</p>}
            {state.kind === 'ready' && <ProjectDetail project={state.project} mode={mode} headingRef={heading} />}
          </div>
        </>
      )}
    </aside>
  );
}

function ProjectDetail({
  project: p,
  mode,
  headingRef,
}: {
  project: PublishedProject;
  mode: 'light' | 'dark';
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const status = STATUS_BY_ID[p.status];
  const today = todayInCalifornia();
  const longDescription = p.description.length > DESCRIPTION_PREVIEW;
  const description =
    longDescription && !expanded ? `${p.description.slice(0, DESCRIPTION_PREVIEW).trimEnd()}…` : p.description;
  const place = p.location ? placeLine(p.location.cities, p.location.counties) : '';

  const facts: [string, string][] = [];
  if (p.facts.totalAcres !== null) facts.push(['Area', `${formatNumber(p.facts.totalAcres)} acres`]);
  if (p.location?.crossStreets) facts.push(['Cross streets', p.location.crossStreets]);
  if (p.facts.exemptStatus) facts.push(['Exemption', p.facts.exemptStatus]);
  const lists: [string, string[]][] = [
    ['Development', splitFacts(p.facts.developmentTypes)],
    ['Local actions', splitFacts(p.facts.localActions)],
    ['Issues studied', splitFacts(p.facts.projectIssues)],
  ];

  async function copyLink() {
    await navigator.clipboard.writeText(location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <article>
      <p className="status-chip" style={{ ['--chip' as string]: status[mode] }}>
        <span className="dot" style={{ background: status[mode] }} aria-hidden="true" />
        {status.label}
        <span className="muted"> · {formatDate(p.statusDate)}</span>
      </p>
      <h2 id="drawer-title" className="drawer-title" tabIndex={-1} ref={headingRef}>
        {p.title}
      </h2>
      <p className="drawer-agency">{p.leadAgency}</p>

      {p.status === 'in_review' && p.reviewEnd && (
        <p className="review-callout">
          <span className="live-dot" aria-hidden="true" />
          {reviewCountdown(p.reviewEnd, today)}
        </p>
      )}

      {(place || p.location) && (
        <p className="drawer-place">
          {place}
          {p.location && (
            <span className="muted">
              {' · '}
              {PRECISION_LABEL[p.location.precision]}
              {p.location.streets && ` (${p.location.streets.join(' and ')})`}
              {p.location.address && ` (${p.location.address})`}
              {p.location.landmark && ` (${p.location.landmark})`}
              {p.location.precision === 'zip' && p.location.zip && ` (${p.location.zip})`}
            </span>
          )}
        </p>
      )}
      {p.location?.coordinatesRejected && (
        <p className="drawer-note muted">
          The coordinates filed with CEQAnet don’t match the city or county listed for this project, so it is placed{' '}
          {FALLBACK_PHRASE[p.location.precision]} instead.
        </p>
      )}

      {description && (
        <section className="drawer-section">
          <p className="drawer-description">{description}</p>
          {longDescription && (
            <button className="text-button" onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'Show less' : 'Read full description'}
            </button>
          )}
        </section>
      )}

      {(facts.length > 0 || lists.some(([, v]) => v.length)) && (
        <section className="drawer-section">
          <dl className="facts">
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
            {lists
              .filter(([, v]) => v.length > 0)
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>
                    <ul className="tags">
                      {v.map((t) => (
                        <Tag key={t} text={t} />
                      ))}
                    </ul>
                  </dd>
                </div>
              ))}
          </dl>
        </section>
      )}

      <section className="drawer-section">
        <h3 className="eyebrow">Filings</h3>
        <ol className="timeline">
          {p.documents.map((d, i) => (
            <li key={`${d.type}-${d.received}-${i}`}>
              <span className="timeline-node" aria-hidden="true" />
              <div>
                <p className="timeline-type">
                  {d.url ? (
                    <a href={d.url} target="_blank" rel="noopener">
                      {d.typeLabel}
                    </a>
                  ) : (
                    d.typeLabel
                  )}
                  <span className="muted"> · {formatDate(d.received)}</span>
                </p>
                {d.reviewStart && d.reviewEnd && (
                  <p className="timeline-meta muted">
                    Review {formatDate(d.reviewStart)} to {formatDate(d.reviewEnd)}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="drawer-actions">
        <a className="pill pill-solid" href={p.ceqanetUrl} target="_blank" rel="noopener">
          Open on CEQAnet <span aria-hidden="true">→</span>
        </a>
        <button className="pill pill-outline" onClick={copyLink}>
          {copied ? 'Link copied' : 'Copy link'}
        </button>
      </div>
      <p className="drawer-footnote muted">
        Stage is inferred from filings with the State Clearinghouse. Some agencies file approvals only with the county
        clerk, so “Review closed” projects may already be approved.
      </p>
    </article>
  );
}

/**
 * One fact as a tag. Long CEQAnet entries ("Commercial (Commercial Uses and
 * Employees not defined at this time)(Sq. Ft. 27000, Acres 0.62, Employees
 * 25)") show the category plus its numbers on one line, cut with an ellipsis
 * if still too long; click to read the whole entry.
 */
function Tag({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { label, detail, full } = factTag(text);
  if (!detail) return <li className="tag">{label}</li>;
  return (
    <li className={`tag has-detail ${open ? 'open' : ''}`}>
      <button type="button" aria-expanded={open} title={open ? undefined : full} onClick={() => setOpen((o) => !o)}>
        <span className="tag-label">{label}</span>
        <span className="tag-detail">{open ? full.slice(label.length).trim() : detail}</span>
      </button>
    </li>
  );
}

function DrawerSkeleton() {
  return (
    <div className="skeleton" aria-label="Loading project">
      <span style={{ width: '30%' }} />
      <span style={{ width: '90%', height: 28 }} />
      <span style={{ width: '70%', height: 28 }} />
      <span style={{ width: '50%' }} />
      <span style={{ width: '100%', height: 96 }} />
    </div>
  );
}
