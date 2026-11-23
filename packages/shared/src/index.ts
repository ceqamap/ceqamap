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
export type LocationPrecision =
  'exact' | 'address' | 'intersection' | 'landmark' | 'street' | 'community' | 'zip' | 'city' | 'county' | 'region';

export const PRECISION_LABEL: Readonly<Record<LocationPrecision, string>> = {
  exact: 'Coordinates provided by the lead agency',
  address: 'At the street address in the project description',
  intersection: 'Near the listed cross streets',
  landmark: 'Near a place named in the project description',
  street: 'Approximate: placed along the listed street',
  community: 'Approximate: placed at the community named in the project description',
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
  landmark: 2,
  street: 0,
  community: 0,
  zip: 0,
  city: 0,
  county: 0,
  region: 0,
};

/** The three map marks, as the legend names and filters them. */
export type MapMark = 'exact' | 'intersection' | 'approx';

export interface MarkDefinition {
  id: MapMark;
  /** Value of the tile point's `x` (see PRECISION_MARK). */
  x: 0 | 1 | 2;
  /** Suffix of the cluster count attributes (see markCountKey). */
  code: 'e' | 'n' | 'a';
}

/** In legend order. */
export const MARKS: readonly MarkDefinition[] = [
  { id: 'exact', x: 1, code: 'e' },
  { id: 'intersection', x: 2, code: 'n' },
  { id: 'approx', x: 0, code: 'a' },
];

export function markOf(x: 0 | 1 | 2): MapMark {
  return x === 1 ? 'exact' : x === 2 ? 'intersection' : 'approx';
}

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
    /** For `landmark` and `community`: the named place used (USGS GNIS), e.g. "Shelter Island". */
    landmark?: string;
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
  /**
   * One clustered tileset per time window (see TIME_SCOPES). Absent in data
   * built before 2026-11-21; the app then falls back to `tiles`.
   */
  scopes?: Record<TimeScope, PublishedScope>;
  /** Projects with filings first seen in the most recent batch that brought any. */
  arrivals?: PublishedArrivals;
}

/** A time window's tileset and the counts of what it shows (mapped projects only). */
export interface PublishedScope {
  /** Path (relative to the data origin) of this window's tileset. */
  tiles: string;
  mapped: number;
  byStatus: Record<ProjectStatus, number>;
  /** By map mark: exact (solid), intersection (lighter center), approx (ring). */
  byMark: { exact: number; intersection: number; approx: number };
  /**
   * By stage and map mark, so the legend's two filters can count each other.
   * Present when the tiles carry per stage-and-mark cluster counts
   * (markCountKey); the location filter is offered only then.
   */
  byStageMark?: Record<ProjectStatus, Record<MapMark, number>>;
}

/**
 * The latest batch of arrivals. "Arrived" means first seen by our pipeline,
 * not CEQAnet's Received date (documents are often posted days later).
 */
export interface PublishedArrivals {
  /** ISO timestamp of the ingest run that first saw these documents. */
  at: string;
  /** Projects whose first filing arrived in this batch. */
  projects: number;
  /** Existing projects that received a new filing in this batch. */
  filings: number;
  items: PublishedArrival[];
}

export interface PublishedArrival {
  /** SCH number. */
  id: string;
  /** 'project': a brand-new SCH number. 'filing': a new document on an existing project. */
  kind: 'project' | 'filing';
  /** Document type code of the newest arriving document (e.g. NOD). */
  type: string;
  typeLabel: string;
  /** Map position, or null for projects without a single location. */
  lon: number | null;
  lat: number | null;
}

/** Tile property `n`: 1 if the project arrived in the latest batch (details in meta.arrivals). */
export type ArrivalFlag = 0 | 1;

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
  /** Mark: 1 = exact, 2 = near the listed cross streets or a named place, 0 = approximate (see PRECISION_MARK). */
  x: 0 | 1 | 2;
  /** 1 if in review (summed by clustering). */
  r: 0 | 1;
  /** Arrived in the latest batch (summed by clustering, so clusters know). */
  n?: ArrivalFlag;
  /**
   * One flag per stage (`c_in_review`, `c_scoping`, ...), 1 for this project's
   * stage. Summed by clustering, so a cluster's count can follow the legend's
   * stage filter without rebuilding tiles. Also one flag for this project's
   * stage and mark (`c_scoping_e`, see markCountKey), set only when 1, so
   * clusters can follow the location filter too.
   */
  [stageCount: `c_${string}`]: 0 | 1 | undefined;
}

/** Tile attribute holding a stage's count (see TilePointProperties). */
export function stageCountKey(status: ProjectStatus): `c_${ProjectStatus}` {
  return `c_${status}`;
}

/**
 * Tile attribute holding a cluster's count for one stage and mark, e.g.
 * `c_scoping_e`. Points carry only their own (value 1); clustering sums them,
 * and a cluster without one has none of that kind.
 */
export function markCountKey(status: ProjectStatus, mark: MapMark): `c_${ProjectStatus}_${'e' | 'n' | 'a'}` {
  return `c_${status}_${MARKS.find((m) => m.id === mark)!.code}`;
}

/** A project's one stage-and-mark flag for its tile point (see markCountKey). */
export function markFlag(status: ProjectStatus, mark: MapMark): Record<`c_${string}`, 1> {
  return { [markCountKey(status, mark)]: 1 } as Record<`c_${string}`, 1>;
}

/** Every stage-and-mark count key, for tippecanoe's --accumulate-attribute. */
export function allMarkCountKeys(): string[] {
  return STATUSES.flatMap((s) => MARKS.map((m) => markCountKey(s.id, m.id)));
}

/** The per-stage flags for one project's tile point. */
export function stageFlags(status: ProjectStatus): Record<`c_${ProjectStatus}`, 0 | 1> {
  const out = {} as Record<`c_${ProjectStatus}`, 0 | 1>;
  for (const s of STATUSES) out[stageCountKey(s.id)] = s.id === status ? 1 : 0;
  return out;
}

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

export type TimeScope = '30d' | '12m' | '5y' | 'all';

export interface TimeScopeDefinition {
  id: TimeScope;
  label: string;
  /** Window length in days, or null for all time. */
  days: number | null;
}

/**
 * A project is in a window if its latest filing was received within it. Projects
 * in public review, and projects that just arrived, are in every window: an
 * open comment period is the most useful thing on the map, and a document
 * CEQAnet posts late (older Received date) is still news to us.
 */
export const TIME_SCOPES: readonly TimeScopeDefinition[] = [
  { id: '30d', label: 'Past 30 days', days: 30 },
  { id: '12m', label: 'Past 12 months', days: 365 },
  { id: '5y', label: 'Past 5 years', days: 5 * 365 + 1 },
  { id: 'all', label: 'All time', days: null },
] as const;

export const DEFAULT_TIME_SCOPE: TimeScope = '12m';

export function isTimeScope(v: unknown): v is TimeScope {
  return TIME_SCOPES.some((s) => s.id === v);
}

/** First day (YYYY-MM-DD) inside the window, or null for all time. */
export function scopeStart(scope: TimeScope, today: string): string | null {
  const days = TIME_SCOPES.find((s) => s.id === scope)?.days ?? null;
  if (days === null) return null;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days + 1);
  return d.toISOString().slice(0, 10);
}

export function inScope(
  scope: TimeScope,
  today: string,
  project: { lastFiling: string; status: ProjectStatus; arrived?: boolean },
): boolean {
  if (project.status === 'in_review' || project.arrived) return true;
  const start = scopeStart(scope, today);
  return start === null || project.lastFiling >= start;
}

/** The narrowest window that shows this project (for links to older projects). */
export function narrowestScopeFor(
  today: string,
  project: { lastFiling: string; status: ProjectStatus; arrived?: boolean },
): TimeScope {
  return TIME_SCOPES.find((s) => inScope(s.id, today, project))?.id ?? 'all';
}
