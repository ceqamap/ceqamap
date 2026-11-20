import type { ProjectStatus } from '../../../packages/shared/src/index.ts';
import type { CeqaDocument } from './document.ts';

/**
 * Deriving a project's CEQA stage from its filed documents.
 *
 * CEQAnet has no status field, so this is an interpretation. The rules, in
 * order:
 *   1. If any document has a comment period open on `today`, the project is
 *      `in_review`. An open window is the most actionable fact we can show.
 *   2. Otherwise the most recent *decisive* document wins:
 *        NOD / NDE / ROD                 -> approved
 *        NOE                             -> exempt
 *        NOP / NOI                       -> scoping
 *        any circulated environmental doc -> review_closed
 *   3. Projects with only administrative or federal notices are `other`.
 *
 * Known limits (also in docs/DATA.md):
 *   - Many local agencies file their Notice of Determination only with the
 *     county clerk, not the State Clearinghouse. Those projects stay
 *     `review_closed` forever even though they were approved.
 *   - CEQAnet does not record withdrawals, denials, construction, or
 *     completion. "Approved" means a determination was filed, not that
 *     anything was built.
 */

const DETERMINATION = new Set(['NOD', 'NDE', 'ROD']);
const EXEMPTION = new Set(['NOE']);
const SCOPING = new Set(['NOP', 'NOI']);
/** Documents that circulate for review or finalize review. */
const ENVIRONMENTAL = new Set([
  'EIR',
  'MND',
  'NEG',
  'FIN',
  'SIR',
  'SBE',
  'RIR',
  'REV',
  'MEA',
  'SCA',
  'EA',
  'EIS',
  'FIS',
  'SEA',
  'SIS',
  'JD',
  'FON',
  'RC',
  'ADM',
  'NOC',
  'BLA',
  'RAN',
]);

export interface StatusResult {
  status: ProjectStatus;
  /** ISO date of the deciding document. */
  date: string;
  /** For in_review: the latest open review end date. */
  reviewEnd: string | null;
}

function classify(type: string): ProjectStatus | null {
  if (DETERMINATION.has(type)) return 'approved';
  if (EXEMPTION.has(type)) return 'exempt';
  if (SCOPING.has(type)) return 'scoping';
  if (ENVIRONMENTAL.has(type)) return 'review_closed';
  return null;
}

/** Same-day tie-break: the later stage in the process wins. */
const STAGE_ORDER: Record<ProjectStatus, number> = {
  other: 0,
  scoping: 1,
  review_closed: 2,
  in_review: 2,
  exempt: 3,
  approved: 4,
};

export function deriveStatus(docs: readonly CeqaDocument[], today: string): StatusResult {
  if (docs.length === 0) throw new Error('deriveStatus called with no documents');

  // Rule 1: an open comment period.
  let openUntil: string | null = null;
  let openDoc: CeqaDocument | null = null;
  for (const d of docs) {
    if (d.reviewStart && d.reviewEnd && d.reviewStart <= today && today <= d.reviewEnd) {
      if (openUntil === null || d.reviewEnd > openUntil) {
        openUntil = d.reviewEnd;
        openDoc = d;
      }
    }
  }
  if (openDoc && openUntil) return { status: 'in_review', date: openDoc.received, reviewEnd: openUntil };

  // Rule 2: the most recent decisive document.
  let best: { status: ProjectStatus; date: string } | null = null;
  for (const d of docs) {
    const s = classify(d.type);
    if (s === null) continue;
    if (
      best === null ||
      d.received > best.date ||
      (d.received === best.date && STAGE_ORDER[s] > STAGE_ORDER[best.status])
    ) {
      best = { status: s, date: d.received };
    }
  }
  if (best) return { ...best, reviewEnd: null };

  // Rule 3.
  const latest = docs.reduce((a, b) => (b.received > a.received ? b : a));
  return { status: 'other', date: latest.received, reviewEnd: null };
}
