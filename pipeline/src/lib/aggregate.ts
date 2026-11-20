import {
  DOCUMENT_TYPES,
  type LocationPrecision,
  type ProjectStatus,
  type PublishedMeta,
  type PublishedProject,
  type TilePointProperties,
} from '../../../packages/shared/src/index.ts';
import type { CeqaDocument } from './document.ts';
import type { Boundaries } from './boundaries.ts';
import { resolveLocation } from './location.ts';
import { deriveStatus } from './status.ts';

/**
 * Turn the flat list of documents into projects (one per SCH number), plus
 * the two published artifacts: per-project detail records and map points.
 */

export interface PointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: TilePointProperties;
}

export interface AggregateResult {
  projects: PublishedProject[];
  points: PointFeature[];
  counts: PublishedMeta['counts'];
  latestReceived: string;
}

const HOVER_TITLE_MAX = 90;

export function groupBySch(docs: Iterable<CeqaDocument>): Map<string, CeqaDocument[]> {
  const out = new Map<string, CeqaDocument[]>();
  for (const d of docs) {
    const list = out.get(d.sch);
    if (list) list.push(d);
    else out.set(d.sch, [d]);
  }
  return out;
}

function firstNonEmpty(values: (string | null | undefined)[]): string {
  for (const v of values) if (v && v.trim()) return v.trim();
  return '';
}

/** Collapse whitespace and cap length for hover labels. */
export function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Prefer the description from the substantive environmental document. */
const DESCRIPTION_PRIORITY = ['EIR', 'SIR', 'SBE', 'MND', 'NEG', 'NOP', 'FIN', 'NOD', 'NOE'];

function pickDescription(newestFirst: CeqaDocument[]): string {
  for (const t of DESCRIPTION_PRIORITY) {
    const d = newestFirst.find((x) => x.type === t && x.description.trim());
    if (d) return d.description.trim();
  }
  return firstNonEmpty(newestFirst.map((d) => d.description));
}

export function buildProject(
  sch: string,
  docs: CeqaDocument[],
  boundaries: Boundaries,
  today: string,
  builtAt: string,
): PublishedProject {
  const newestFirst = [...docs].sort((a, b) => (a.received < b.received ? 1 : a.received > b.received ? -1 : 0));
  const latest = newestFirst[0];
  const status = deriveStatus(docs, today);
  const loc = resolveLocation(sch, newestFirst, boundaries);
  const placeDoc = newestFirst.find((d) => d.cities.length || d.counties.length) ?? latest;

  return {
    sch,
    title: firstNonEmpty(newestFirst.flatMap((d) => [d.projectTitle, d.documentTitle])) || `SCH ${sch}`,
    leadAgency: firstNonEmpty(newestFirst.map((d) => d.leadAgency)),
    description: pickDescription(newestFirst),
    status: status.status,
    statusDate: status.date,
    reviewEnd: status.reviewEnd,
    location: loc
      ? {
          lon: round6(loc.lon),
          lat: round6(loc.lat),
          precision: loc.precision,
          cities: placeDoc.cities,
          counties: placeDoc.counties,
          crossStreets: firstNonEmpty(newestFirst.map((d) => d.crossStreets)) || null,
          zip: firstNonEmpty(newestFirst.map((d) => d.zip)) || null,
          coordinatesRejected: loc.coordinatesRejected,
        }
      : null,
    facts: {
      totalAcres: newestFirst.find((d) => d.totalAcres !== null)?.totalAcres ?? null,
      developmentTypes: firstNonEmpty(newestFirst.map((d) => d.developmentType)) || null,
      localActions: firstNonEmpty(newestFirst.map((d) => d.localAction)) || null,
      projectIssues: firstNonEmpty(newestFirst.map((d) => d.projectIssues)) || null,
      exemptStatus: firstNonEmpty(newestFirst.map((d) => d.exemptStatus)) || null,
    },
    documents: newestFirst.map((d) => ({
      type: d.type,
      typeLabel: DOCUMENT_TYPES[d.type] ?? d.type,
      received: d.received,
      title: d.documentTitle,
      url: d.url,
      reviewStart: d.reviewStart,
      reviewEnd: d.reviewEnd,
    })),
    ceqanetUrl: `https://ceqanet.lci.ca.gov/Project/${sch}`,
    builtAt,
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function aggregate(
  docs: Iterable<CeqaDocument>,
  boundaries: Boundaries,
  today: string,
  builtAt: string,
): AggregateResult {
  const groups = groupBySch(docs);
  const projects: PublishedProject[] = [];
  const points: PointFeature[] = [];
  const byStatus = { in_review: 0, scoping: 0, review_closed: 0, approved: 0, exempt: 0, other: 0 } satisfies Record<
    ProjectStatus,
    number
  >;
  const byPrecision = { exact: 0, city: 0, county: 0, region: 0 } satisfies Record<LocationPrecision, number>;
  let documents = 0;
  let coordinatesRejected = 0;
  let latestReceived = '';

  for (const [sch, list] of groups) {
    documents += list.length;
    for (const d of list) if (d.received > latestReceived) latestReceived = d.received;
    const p = buildProject(sch, list, boundaries, today, builtAt);
    projects.push(p);
    byStatus[p.status]++;
    if (p.location) {
      byPrecision[p.location.precision]++;
      if (p.location.coordinatesRejected) coordinatesRejected++;
      points.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.location.lon, p.location.lat] },
        properties: {
          id: sch,
          t: truncate(p.title, HOVER_TITLE_MAX),
          s: p.status,
          x: p.location.precision === 'exact' ? 1 : 0,
          r: p.status === 'in_review' ? 1 : 0,
        },
      });
    }
  }

  return {
    projects,
    points,
    latestReceived,
    counts: {
      documents,
      projects: projects.length,
      mapped: points.length,
      unmapped: projects.length - points.length,
      byStatus,
      byPrecision,
      coordinatesRejected,
    },
  };
}
