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
