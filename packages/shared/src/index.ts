/**
 * Shared types and constants used by both the data pipeline and the web app.
 * Anything that defines the *shape* of published data lives here, so the two
 * halves of the project can never silently disagree.
 */

// ---------------------------------------------------------------------------
// Project status (CEQA process stage)
// ---------------------------------------------------------------------------

/**
 * CEQAnet does not publish a "status" field. We derive the stage of the CEQA
 * process from the documents a project has filed. See pipeline/src/lib/status.ts
 * for the rules and docs/DATA.md for the caveats.
 */
export type ProjectStatus =
  | 'in_review' // a public/state comment period is open right now
  | 'scoping' // Notice of Preparation / Intent filed; environmental review starting
  | 'review_closed' // draft or final document circulated; no determination filed with SCH
  | 'approved' // Notice of Determination (or equivalent) filed
  | 'exempt' // Notice of Exemption filed; no further CEQA review
  | 'other';

export interface StatusDefinition {
  id: ProjectStatus;
  label: string;
  description: string;
  /** Validated against the paper surface (#f4f2ee); see docs/DESIGN.md. */
  light: string;
  /** Validated against the night surface (#121212). */
  dark: string;
  /** Draw order: higher values render on top. */
  z: number;
}

export const STATUSES: readonly StatusDefinition[] = [
  {
    id: 'in_review',
    label: 'In review',
    description: 'A public comment period is open now.',
    light: '#1f9d55',
    dark: '#1e9a56',
    z: 6,
  },
  {
    id: 'scoping',
    label: 'Scoping',
    description: 'Environmental review is starting (Notice of Preparation or Intent).',
    light: '#2a6fd6',
    dark: '#4b82e8',
    z: 5,
  },
  {
    id: 'review_closed',
    label: 'Review closed',
    description:
      'An environmental document was circulated and its comment period has ended. No determination has been filed with the State Clearinghouse yet.',
    light: '#e8590c',
    dark: '#e8621a',
    z: 4,
  },
  {
    id: 'approved',
    label: 'Approved',
    description: 'The lead agency filed a Notice of Determination.',
    light: '#151515',
    dark: '#efede8',
    z: 3,
  },
  {
    id: 'exempt',
    label: 'Exempt',
    description: 'The lead agency filed a Notice of Exemption.',
    light: '#a39f97',
    dark: '#6f6c67',
    z: 2,
  },
  {
    id: 'other',
    label: 'Other',
    description: 'Federal, administrative, or other notices.',
    light: '#cfcbc3',
    dark: '#3b3a38',
    z: 1,
  },
] as const;

export const STATUS_BY_ID: Readonly<Record<ProjectStatus, StatusDefinition>> = Object.fromEntries(
  STATUSES.map((s) => [s.id, s]),
) as Record<ProjectStatus, StatusDefinition>;

// ---------------------------------------------------------------------------
// Location precision
// ---------------------------------------------------------------------------

/**
 * How we know where a project is. Only `exact` comes from coordinates the
 * lead agency entered; everything else is a best-effort placement.
 */
export type LocationPrecision = 'exact' | 'address' | 'intersection' | 'street' | 'zip' | 'city' | 'county' | 'region';

export const PRECISION_LABEL: Readonly<Record<LocationPrecision, string>> = {
  exact: 'Coordinates provided by the lead agency',
  address: 'At the street address in the project description',
  intersection: 'Near the listed cross streets',
  street: 'Approximate: placed along the listed street',
  zip: 'Approximate: placed within the listed ZIP code',
  city: 'Approximate: placed within the listed city',
  county: 'Approximate: placed within the listed county',
  region: 'Approximate: placed between the listed counties',
};

/** How each precision is drawn: 1 solid dot, 2 dot with a lighter center, 0 hollow ring. */
export const PRECISION_MARK: Readonly<Record<LocationPrecision, 0 | 1 | 2>> = {
  exact: 1,
  address: 1,
  intersection: 2,
  street: 0,
  zip: 0,
  city: 0,
  county: 0,
  region: 0,
};

// ---------------------------------------------------------------------------
// CEQA document types
// ---------------------------------------------------------------------------

/** Labels as CEQAnet uses them on its Advanced Search page. */
export const DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  ADM: 'Addendum',
  BIA: 'Tribal Notice',
  BLA: 'Notice of Availability',
  CON: 'Early Consultation',
  EA: 'Environmental Assessment',
  EIR: 'Draft EIR',
  EIS: 'Draft Environmental Impact Statement',
  FED: 'Federal Consistency Determination',
  FIN: 'Final Document',
  FIS: 'Final Environmental Impact Statement',
  FON: 'Finding of No Significant Impact',
  FOT: 'Federal Other',
  FYI: 'For Your Information',
  JD: 'Joint Document',
  MEA: 'Master EIR',
  MND: 'Mitigated Negative Declaration',
  NDE: 'Notice of Decision',
  NEG: 'Negative Declaration',
  NOC: 'Notice of Completion',
  NOD: 'Notice of Determination',
  NOE: 'Notice of Exemption',
  NOI: 'Notice of Intent',
  NOP: 'Notice of Preparation',
  OTH: 'Other',
  RAN: 'Notice of Availability',
  RC: 'Response to Comments',
  REV: 'Revised Document',
  RIR: 'Revised EIR',
  ROD: 'Record of Decision',
  SBE: 'Subsequent EIR',
  SCA: 'Sustainable Communities Environmental Assessment',
  SEA: 'Supplemental Environmental Assessment',
  SIR: 'Supplemental EIR',
  SIS: 'Supplemental Environmental Impact Statement',
  TRI: 'Tribal Notice',
};

// ---------------------------------------------------------------------------
// Published data contracts
// ---------------------------------------------------------------------------

/** One filed document, as shown in the project drawer's timeline. */
export interface PublishedDocument {
  type: string;
  typeLabel: string;
  /** ISO date (YYYY-MM-DD). */
  received: string;
  title: string;
  url: string | null;
  reviewStart: string | null;
  reviewEnd: string | null;
}

/** Everything the drawer needs, served as data/projects/{sch}.json. */
export interface PublishedProject {
  sch: string;
  title: string;
  leadAgency: string;
  description: string;
  status: ProjectStatus;
  /** ISO date of the document that determined the status. */
  statusDate: string;
  /** For `in_review`: when comments close. */
  reviewEnd: string | null;
  location: {
    lon: number;
    lat: number;
    precision: LocationPrecision;
    cities: string[];
    counties: string[];
    crossStreets: string | null;
    zip: string | null;
    /** The agency's coordinates contradicted the listed county and were not used. */
    coordinatesRejected: boolean;
    /** For `intersection`: the two listed streets whose meeting point was used; for `street`, the one street. */
    streets?: string[];
    /** For `address`: the address that was geocoded, e.g. "1234 Main St, Fresno". */
    address?: string;
  } | null;
  facts: {
    totalAcres: number | null;
    developmentTypes: string | null;
    localActions: string | null;
    projectIssues: string | null;
    exemptStatus: string | null;
  };
  documents: PublishedDocument[];
  ceqanetUrl: string;
  /** ISO timestamp this record was built. */
  builtAt: string;
}

/** Served as data/meta.json with a short cache lifetime; the app polls it. */
export interface PublishedMeta {
  /** Changes on every rebuild; used to bust tile caches. */
  buildId: string;
  /** Git branch the data was built from (preview data only checks this). */
  ref?: string;
  builtAt: string;
  /** Path (relative to the data origin) of the current tileset. */
  tiles: string;
  /** Latest `Received` date seen in CEQAnet. */
  latestReceived: string;
  counts: {
    documents: number;
    projects: number;
    mapped: number;
    unmapped: number;
    byStatus: Record<ProjectStatus, number>;
    byPrecision: Record<LocationPrecision, number>;
    /** Projects whose agency coordinates were discarded as inconsistent. */
    coordinatesRejected?: number;
  };
}

/**
 * Attributes stored on each point in the vector tiles. Kept deliberately
 * tiny: everything else is fetched on click.
 */
export interface TilePointProperties {
  /** SCH number. */
  id: string;
  /** Title, truncated for hover. */
  t: string;
  /** Status id. */
  s: ProjectStatus;
  /** Mark: 1 = exact, 2 = near the listed cross streets, 0 = approximate (see PRECISION_MARK). */
  x: 0 | 1 | 2;
  /** 1 if in review (summed by clustering). */
  r: 0 | 1;
}
