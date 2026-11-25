import {
  DOCUMENT_TYPES,
  type PublishedArrival,
  type PublishedArrivals,
  type PublishedProject,
} from '../../../packages/shared/src/index.ts';
import type { CeqaDocument } from './document.ts';
import type { Storage } from './storage.ts';

/**
 * Arrivals: documents our pipeline sees for the first time.
 *
 * The ingest job knows which document keys are new on each run. It saves the
 * latest *non-empty* batch to state/arrivals.json, replacing the previous one.
 * Empty runs leave it alone, so the map keeps showing the last batch through
 * nights and weekends, when CEQAnet posts nothing. The build turns the saved
 * keys into per-project flags for the map and a summary for the header.
 */

export const ARRIVALS_KEY = 'state/arrivals.json';

/**
 * More than this in one run is not a batch of filings but a bulk change (the
 * first run on an empty bucket, a re-keying, a CEQAnet re-export). Pinging
 * hundreds of projects would be noise, so such a run clears the pings.
 */
export const MAX_ARRIVALS = 500;

/**
 * A batch older than this stops pinging. Normally a newer batch replaces it
 * within a day; this only matters if the pipeline or CEQAnet stalls, when
 * "just arrived" would otherwise stay up indefinitely. Two weeks covers the
 * longest holiday gap in CEQAnet posting.
 */
export const ARRIVALS_MAX_AGE_DAYS = 14;

export interface StoredArrivals {
  /** ISO timestamp of the ingest run. */
  at: string;
  docs: { key: string; sch: string; type: string }[];
  /** Set when a bulk change cleared the batch (see MAX_ARRIVALS). */
  skipped?: number;
  /** Built from CEQAnet's Posted dates because no ingest has saved a batch yet. */
  approximate?: boolean;
}

/** What ingest should write for this run's new documents, or null to keep the previous batch. */
export function nextArrivals(added: CeqaDocument[], at: string): StoredArrivals | null {
  if (added.length === 0) return null;
  if (added.length > MAX_ARRIVALS) return { at, docs: [], skipped: added.length };
  return { at, docs: added.map((d) => ({ key: d.key, sch: d.sch, type: d.type })) };
}

/**
 * Stand-in batch for when no ingest has saved one yet (a fresh bucket, or a
 * preview build before the arrivals code reached production): the documents
 * CEQAnet posted on its most recent posting day. Replaced by the real batch on
 * the first ingest run that sees new documents.
 */
export function approximateArrivals(docs: Iterable<CeqaDocument>, today: string): StoredArrivals | null {
  let latest = '';
  for (const d of docs) if (d.posted && d.posted <= today && d.posted > latest) latest = d.posted;
  if (!latest) return null;
  const batch: StoredArrivals['docs'] = [];
  for (const d of docs) if (d.posted === latest) batch.push({ key: d.key, sch: d.sch, type: d.type });
  if (batch.length === 0 || batch.length > MAX_ARRIVALS) return null;
  // Noon Pacific on the posting day; only the date is meaningful.
  return { at: `${latest}T20:00:00.000Z`, docs: batch, approximate: true };
}

export async function loadArrivals(storage: Storage): Promise<StoredArrivals | null> {
  const bytes = await storage.get(ARRIVALS_KEY);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as StoredArrivals;
    return typeof parsed.at === 'string' && Array.isArray(parsed.docs) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveArrivals(storage: Storage, arrivals: StoredArrivals): Promise<void> {
  await storage.put(ARRIVALS_KEY, JSON.stringify(arrivals), { contentType: 'application/json' });
}

export interface ArrivalSummary {
  /** Per project that arrived: 2 = new project, 1 = new filing on an existing project. */
  flags: Map<string, 1 | 2>;
  published: PublishedArrivals | null;
}

/**
 * Match the saved batch against the current documents and projects.
 *
 * - Keys that no longer exist (CEQAnet withdrew or re-keyed the document) are ignored.
 * - A project is "new" when every one of its documents arrived in this batch;
 *   otherwise it is an existing project with a new filing.
 */
export function summarizeArrivals(
  stored: StoredArrivals | null,
  groups: ReadonlyMap<string, CeqaDocument[]>,
  projects: ReadonlyMap<string, PublishedProject>,
  now: Date = new Date(),
): ArrivalSummary {
  const flags = new Map<string, 1 | 2>();
  if (!stored || stored.docs.length === 0) return { flags, published: null };
  const ageDays = (now.getTime() - Date.parse(stored.at)) / 86_400_000;
  if (!(ageDays <= ARRIVALS_MAX_AGE_DAYS)) return { flags, published: null };

  const arrivedKeys = new Set(stored.docs.map((d) => d.key));
  const items: PublishedArrival[] = [];
  /** When comments close, for arrivals still taking comments. */
  const commentsDue = new Map<string, string>();
  for (const sch of new Set(stored.docs.map((d) => d.sch))) {
    const docs = groups.get(sch);
    const project = projects.get(sch);
    if (!docs || !project) continue;
    const arrived = docs.filter((d) => arrivedKeys.has(d.key));
    if (arrived.length === 0) continue;
    const kind = arrived.length === docs.length ? 'project' : 'filing';
    const newest = arrived.reduce((a, b) => (b.received > a.received ? b : a));
    flags.set(sch, kind === 'project' ? 2 : 1);
    if (project.status === 'in_review' && project.reviewEnd) commentsDue.set(sch, project.reviewEnd);
    items.push({
      id: sch,
      kind,
      type: newest.type,
      typeLabel: DOCUMENT_TYPES[newest.type] ?? newest.type,
      lon: project.location?.lon ?? null,
      lat: project.location?.lat ?? null,
    });
  }
  if (items.length === 0) return { flags, published: null };
  // The header's "N new" steps through these in order. Projects taking
  // comments come first, soonest deadline first: they are the ones a reader
  // can still act on. The rest follow by SCH number.
  items.sort((a, b) => {
    const da = commentsDue.get(a.id);
    const db = commentsDue.get(b.id);
    if (da !== db) {
      if (da === undefined) return 1;
      if (db === undefined) return -1;
      return da < db ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });
  return {
    flags,
    published: {
      at: stored.at,
      projects: items.filter((i) => i.kind === 'project').length,
      filings: items.filter((i) => i.kind === 'filing').length,
      items,
    },
  };
}
