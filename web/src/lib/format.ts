/** Formatting helpers. Pure functions; unit-tested in format.test.ts. */

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const NUMBER = new Intl.NumberFormat('en-US');

/** "2026-11-03" -> "Nov 3, 2026" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : DATE.format(d);
}

export function formatNumber(n: number): string {
  return NUMBER.format(n);
}

/** Whole days from `today` to `iso` (both YYYY-MM-DD). */
export function daysUntil(iso: string, today: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export function reviewCountdown(reviewEnd: string, today: string): string {
  const d = daysUntil(reviewEnd, today);
  if (d < 0) return 'Comment period has closed';
  if (d === 0) return 'Comments due today';
  if (d === 1) return 'Comments due tomorrow';
  return `Comments due ${formatDate(reviewEnd)} · ${d} days left`;
}

/** "3 minutes ago", "2 hours ago", "yesterday". */
export function timeAgo(isoTimestamp: string, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(isoTimestamp)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const days = Math.round(h / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function todayInCalifornia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
}

/** "Redding, Anderson" / "Shasta County" / "Kern and Tulare counties" */
export function placeLine(cities: string[], counties: string[]): string {
  if (cities.length > 0 && cities.length <= 3) return cities.join(', ');
  if (counties.length === 1) return `${counties[0]} County`;
  if (counties.length === 2) return `${counties[0]} and ${counties[1]} counties`;
  if (counties.length > 2) return `${counties.length} counties`;
  return '';
}

/** CEQAnet lists are comma-joined; present them as readable lists. */
export function splitFacts(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/,(?![^(]*\))/) // split on commas not inside parentheses
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface FactTag {
  /** The category, e.g. "Residential". */
  label: string;
  /** Compact detail, e.g. "2,750 units · 424 acres", or "" if none. */
  detail: string;
  /** The original text, for the tooltip and the expanded view. */
  full: string;
}

/** CEQAnet's "Key Number" pairs inside development types, and how to say them. */
const MEASURES: [RegExp, string][] = [
  [/^units?$/i, 'units'],
  [/^acres?$/i, 'acres'],
  [/^sq\.?\s*ft\.?$|^square feet$/i, 'sq ft'],
  [/^employees?$/i, 'employees'],
  [/^(megawatts?|mw)$/i, 'MW'],
  [/^lots?$/i, 'lots'],
  [/^rooms?$/i, 'rooms'],
  [/^beds?$/i, 'beds'],
  [/^students?$/i, 'students'],
  [/^seats?$/i, 'seats'],
  [/^miles?$/i, 'miles'],
];

/**
 * Split a development-type entry into a short tag: "Residential (Units 2750,
 * Acres 424)" -> label "Residential", detail "2,750 units · 424 acres".
 * Free text in parentheses becomes the detail when there are no measures.
 */
export function factTag(raw: string): FactTag {
  const full = raw.replace(/\s+/g, ' ').trim();
  const open = full.indexOf('(');
  if (open < 0) return { label: full, detail: '', full };
  const label = full.slice(0, open).trim() || full;
  const groups = [...full.slice(open).matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim()).filter(Boolean);
  const measures: string[] = [];
  const notes: string[] = [];
  const kinds: string[] = [];
  for (const g of groups) {
    const found: string[] = [];
    for (const part of g.split(/,\s*/)) {
      const m = /^(.+?)\s+([\d,]*\.?\d+)$/.exec(part.trim());
      const unit = m && MEASURES.find(([re]) => re.test(m[1].trim()));
      if (m && unit) {
        const n = Number(m[2].replace(/,/g, ''));
        found.push(`${Number.isInteger(n) ? formatNumber(n) : String(n)} ${unit[1]}`);
      } else {
        // "Type Solar" in power and waste entries: keep the kind, first.
        const kind = /^type\s+(.+)$/i.exec(part.trim());
        if (kind) kinds.push(kind[1]);
      }
    }
    if (found.length) measures.push(...found);
    else notes.push(g);
  }
  const detail = measures.length ? [...kinds, ...measures].join(' · ') : notes.join('; ');
  return { label, detail, full };
}
