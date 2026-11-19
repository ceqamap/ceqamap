import type { CeqaDocument } from '../src/lib/document.ts';

/** The 55 columns CEQAnet's CSV export returned on 2026-11-18, in order. */
export const CEQA_HEADER = [
  'SCH Number', 'Lead Agency Name', 'Lead Agency Title', 'Lead Agency Acronym', 'Document Title',
  'Document Type', 'Received', 'Posted', 'Document Description', 'Document Portal URL', 'Project Title',
  'Contact Full Name', 'Contact Authority', 'Contact Job Title', 'Contact Email Address',
  'Contact Address  1', 'Contact Address  2', 'Contact City', 'Contact State', 'Contact Zip Code',
  'Contact Phone Number', 'Location Coordinates', 'Cities', 'Counties', 'County Clerks',
  'Location Cross Streets', 'Location Zip Code', 'Location Total Acres', 'Location Parcel Number',
  'Location State Highways', 'Location Waterways', 'Location Airports', 'NOC Has Non Late Comment',
  'NOC State Review Start Date', 'NOC State Review End Date', 'NOC Development Type', 'NOC Local Action',
  'NOC Project Issues', 'NOC Public Review Start Date', 'NOC Public Review End Date', 'NOE Exempt Status',
  'NOE Exempt Citation', 'NOE Reasons for Exemption', 'NOD Agency', 'NOD Approved By Lead Agency',
  'NOD Approved Date', 'NOD Significant Environmental Impact', 'NOD Environmental Impact Report Prepared',
  'NOD Negative Declaration Prepared', 'NOD Other Document Type', 'NOD Mitigation Measures',
  'NOD Mitigation Reporting Or Monitoring Plan', 'NOD Statement Of Overriding Considerations Adopted',
  'NOD Findings Made Pursuant', 'NOD Final EIR Available Location',
];

/**
 * Build one CSV line the way CEQAnet does: fields are quoted only when they
 * contain a comma or line break, and inner quotes are NOT escaped when the
 * field is unquoted (that is the bug we tolerate).
 */
export function ceqaLine(values: Partial<Record<string, string>>): string {
  return CEQA_HEADER.map((h) => {
    const v = values[h] ?? '';
    return /[,\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',');
}

export function ceqaCsv(rows: Partial<Record<string, string>>[]): string {
  return [CEQA_HEADER.join(','), ...rows.map(ceqaLine)].join('\r\n') + '\r\n';
}

export function doc(overrides: Partial<CeqaDocument>): CeqaDocument {
  return {
    key: `k-${Math.random()}`,
    sch: '2025100575',
    type: 'NOP',
    received: '2025-10-14',
    posted: null,
    leadAgency: 'Shasta County',
    documentTitle: 'Doc',
    projectTitle: 'Project',
    description: '',
    url: null,
    coordinates: '',
    cities: [],
    counties: [],
    crossStreets: '',
    zip: '',
    totalAcres: null,
    reviewStart: null,
    reviewEnd: null,
    developmentType: '',
    localAction: '',
    projectIssues: '',
    exemptStatus: '',
    nodApprovedDate: null,
    ...overrides,
  };
}
