import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  postmile: 'at the highway postmiles in its description',
  crossing: 'where roads or waterways named in its description cross',
  landmark: 'at a place named in its description',
  street: 'along a street or waterway it names',
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

/** The project's stage and since when, under its location. */
function StatusChip({ project: p, mode }: { project: PublishedProject; mode: 'light' | 'dark' }) {
  const status = STATUS_BY_ID[p.status];
  return (
    <p className="status-chip" style={{ ['--chip' as string]: status[mode] }}>
      <span className="dot" style={{ background: status[mode] }} aria-hidden="true" />
      {status.label}
      <span className="muted"> · {formatDate(p.statusDate)}</span>
    </p>
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
  const [copied, setCopied] = useState(false);
  const today = todayInCalifornia();
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
      {p.status === 'in_review' && p.reviewEnd && (
        <p className="review-callout">
          <span className="live-dot" aria-hidden="true" />
          {reviewCountdown(p.reviewEnd, today)}
        </p>
      )}
      <h2 id="drawer-title" className="drawer-title" tabIndex={-1} ref={headingRef}>
        {p.title}
      </h2>
      <p className="drawer-agency">{p.leadAgency}</p>

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
              {p.location.postmile && ` (${p.location.postmile})`}
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
      <StatusChip project={p} mode={mode} />

      {p.description && (
        <section className="drawer-section">
          <Description key={p.sch} text={p.description} />
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

/** Cancel running height animations (and any held end height). */
function stopAnimations(el: HTMLElement) {
  el.getAnimations().forEach((a) => a.cancel());
}

/** Ease an element's height, like the map key's open/close; skipped with reduced motion. */
function animateHeight(el: HTMLElement, start: number, end: number, done?: () => void) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || start === end) return done?.();
  const ease = getComputedStyle(el).getPropertyValue('--ease').trim() || 'ease';
  const run = el.animate(
    [
      { height: `${start}px`, overflow: 'hidden' },
      { height: `${end}px`, overflow: 'hidden' },
    ],
    // Hold the end height until the text swap (closing) has rendered.
    { duration: 320, easing: ease, fill: done ? 'forwards' : 'none' },
  );
  if (done) run.onfinish = done;
}

/**
 * The project description, cut to a preview when long. "Read full
 * description" grows the text open; "Show less" eases it shut, then swaps
 * back to the preview. Same duration and curve as the map key's open/close.
 */
function Description({ text }: { text: string }) {
  const long = text.length > DESCRIPTION_PREVIEW;
  const preview = `${text.slice(0, DESCRIPTION_PREVIEW).trimEnd()}…`;
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState(false); // full text rendered (stays on while closing)
  const box = useRef<HTMLDivElement>(null);
  const from = useRef<number | null>(null); // height to animate from after the next render
  const collapsedHeight = useRef(0);

  // After the full text renders, grow from the preview's height; after the
  // preview renders, release the held height (same height, so no jump).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (from.current === null) return stopAnimations(el);
    const start = from.current;
    from.current = null;
    stopAnimations(el);
    animateHeight(el, start, el.offsetHeight);
  }, [full]);

  function toggle() {
    const el = box.current;
    if (!el) return;
    const current = el.offsetHeight;
    if (!expanded) {
      setExpanded(true);
      if (full) {
        // Reopening mid-close: the full text is still there; grow back from here.
        stopAnimations(el);
        animateHeight(el, current, el.offsetHeight);
      } else {
        collapsedHeight.current = current;
        from.current = current;
        setFull(true);
      }
    } else {
      setExpanded(false);
      stopAnimations(el);
      // Ease shut with the full text, then swap in the preview.
      animateHeight(el, current, collapsedHeight.current, () => setFull(false));
    }
  }

  return (
    <>
      <div ref={box}>
        <p className="drawer-description">{long && !full ? preview : text}</p>
      </div>
      {long && (
        <button className="text-button" aria-expanded={expanded} onClick={toggle}>
          {expanded ? 'Show less' : 'Read full description'}
        </button>
      )}
    </>
  );
}
