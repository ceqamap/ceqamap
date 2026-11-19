import type { CsvRecord } from './csv.ts';

/**
 * One CEQAnet document, normalized. This is the unit we store: raw enough
 * that any derived output (status, location, tiles) can be rebuilt from it.
 */
export interface CeqaDocument {
  /** Stable identity: the CEQAnet document URL, or a synthetic key. */
  key: string;
  sch: string;
  type: string;
  /** ISO date. */
  received: string;
  posted: string | null;
  leadAgency: string;
  documentTitle: string;
  projectTitle: string;
  description: string;
  url: string | null;
  coordinates: string;
  cities: string[];
  counties: string[];
  crossStreets: string;
  zip: string;
  totalAcres: number | null;
  reviewStart: string | null;
  reviewEnd: string | null;
  developmentType: string;
  localAction: string;
  projectIssues: string;
  exemptStatus: string;
  nodApprovedDate: string | null;
}

/** "10/14/2025" or "10/14/2025 12:00:00 AM" -> "2025-10-14". */
export function toIsoDate(value: string | undefined): string | null {
  if (!value) return null;
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [, mo, d, y] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(/[,;]/)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter((s) => s !== ''),
    ),
  ];
}

function num(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.replace(/[, ]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const DOC_URL = /^https?:\/\/ceqanet\.(?:lci|opr)\.ca\.gov\/(\d{10})(?:\/(\d+))?\/?$/i;

export function normalizeRecord(r: CsvRecord): CeqaDocument | null {
  const sch = r['SCH Number'];
  const received = toIsoDate(r['Received']);
  if (!sch || !received) return null;

  const rawUrl = (r['Document Portal URL'] ?? '').trim();
  const urlMatch = rawUrl.match(DOC_URL);
  const url = urlMatch && urlMatch[1] === sch ? rawUrl.replace('ceqanet.opr.ca.gov', 'ceqanet.lci.ca.gov') : null;
  const type = r['Document Type'];
  const key = url ?? `${sch}|${type}|${received}|${(r['Document Title'] ?? '').slice(0, 80)}`;

  return {
    key,
    sch,
    type,
    received,
    posted: toIsoDate(r['Posted']),
    leadAgency: r['Lead Agency Name'] ?? '',
    documentTitle: r['Document Title'] ?? '',
    projectTitle: r['Project Title'] ?? '',
    description: r['Document Description'] ?? '',
    url,
    coordinates: r['Location Coordinates'] ?? '',
    cities: splitList(r['Cities']),
    counties: splitList(r['Counties']),
    crossStreets: r['Location Cross Streets'] ?? '',
    zip: r['Location Zip Code'] ?? '',
    totalAcres: num(r['Location Total Acres']),
    // Public review is what residents care about; fall back to state review.
    reviewStart: toIsoDate(r['NOC Public Review Start Date']) ?? toIsoDate(r['NOC State Review Start Date']),
    reviewEnd: toIsoDate(r['NOC Public Review End Date']) ?? toIsoDate(r['NOC State Review End Date']),
    developmentType: r['NOC Development Type'] ?? '',
    localAction: r['NOC Local Action'] ?? '',
    projectIssues: r['NOC Project Issues'] ?? '',
    exemptStatus: r['NOE Exempt Status'] ?? '',
    nodApprovedDate: toIsoDate(r['NOD Approved Date']),
  };
}
