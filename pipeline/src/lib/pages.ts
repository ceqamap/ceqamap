/**
 * The "Other Location Info" field from CEQAnet project pages.
 *
 * CEQAnet's CSV export leaves this free-text field out, yet agencies often put
 * the real location there and nowhere else: SCH 2026040250 has empty
 * Coordinates and Cross Streets, and on its page "located where Quiota Creek
 * crosses through Alisal Ranch, just west of North Refugio Road ...; Latitude
 * 34.581478, Longitude -120.108033". In a sample of 200 recent projects we
 * could not place exactly, 55% had the field: street addresses (~17%),
 * relative descriptions (~9%), postmiles (~3%), parcel numbers, and a few
 * coordinates.
 *
 * jobs/pages.ts fetches pages for projects with a filing in the past 12 months
 * that the CSV can't place exactly, at CEQAnet's polite pace, and keeps the
 * field in storage (PAGES_KEY). The build attaches it to each project's newest
 * document as `otherLocation`, where address, postmile, road and place
 * matching read it like the rest of the project's text, and coordinates in it
 * fill an empty Coordinates field.
 */
import { CEQANET_ORIGIN } from './ceqanet.ts';
import { parseCoordinates, type LonLat } from './coordinates.ts';
import type { CeqaDocument } from './document.ts';
import type { Storage } from './storage.ts';

export const PAGES_KEY = 'state/pages.json';

export interface PageEntry {
  /** The field's text, or null if the page has none. */
  info: string | null;
  /** When the page was fetched (ISO timestamp). */
  at: string;
  /** Received date of the project's newest document then; a newer filing means fetch again. */
  latest: string;
}

export interface StoredPages {
  version: 1;
  pages: Record<string, PageEntry>;
}

export async function loadPages(storage: Storage): Promise<StoredPages> {
  const bytes = await storage.get(PAGES_KEY);
  if (bytes) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as StoredPages;
      if (parsed.version === 1 && parsed.pages && typeof parsed.pages === 'object') return parsed;
    } catch {
      // A damaged file is refetched over time.
    }
  }
  return { version: 1, pages: {} };
}

export async function savePages(storage: Storage, pages: StoredPages): Promise<void> {
  await storage.put(PAGES_KEY, JSON.stringify(pages), { contentType: 'application/json' });
}

export const pageUrl = (sch: string) => `${CEQANET_ORIGIN}/${sch}`;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * The field's value from a project page. The page lays each field out as a
 * label cell (`<strong>Other Location Info</strong>`) followed by a value
 * cell; we take the text of the first element after the label's cell.
 */
export function otherLocationInfo(html: string): string | null {
  const at = html.search(/<strong>\s*Other Location Info\s*<\/strong>/i);
  if (at < 0) return null;
  const rest = html.slice(at);
  // Close the label cell, then read the next <div ...>...</div>.
  const m = rest.match(/<\/strong>\s*<\/div>\s*<div\b[^>]*>([\s\S]*?)<\/div>/i);
  if (!m) return null;
  const text = decodeEntities(
    m[1]
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();
  return text || null;
}

// "Latitude 34.581478, Longitude -120.108033", "(33.528784, -117.610603)",
// "34.5815 N, 120.1080 W", "Lat: 38.12 Long: -121.4".
const LABELED =
  /\bLat(?:itude)?\.?\s*[:=]?\s*(\d{2}\.\d{3,})\s*°?\s*N?[\s,;/]+(?:and\s+)?Lon(?:g(?:itude)?)?\.?\s*[:=]?\s*(-?\s?1\d{2}\.\d{3,})\s*°?\s*(W)?/i;
const PAIR =
  /(?<![\d.])(3[2-9]|4[0-2])\.(\d{3,})\s*°?\s*(N)?\s*[,;/ ]\s*(-\s?)?(1[12]\d)\.(\d{3,})\s*°?\s*(W)?(?![\d.])/i;
// Degrees, minutes, seconds: 34°34'53.3"N 120°06'29.0"W
const DMS = /\d{2}\s*°[^NSEW\n]{0,20}?[NS][\s,;/]*1\d{2}\s*°[^NSEW\n]{0,20}?[EW]/i;

/** Coordinates written in free text, if any (validated to be in California). */
export function coordinatesInText(text: string): LonLat | null {
  const labeled = text.match(LABELED);
  if (labeled) {
    const lat = Number(labeled[1]);
    const lon = -Math.abs(Number(labeled[2].replace(/\s/g, '')));
    return parseCoordinates(`${lat}, ${lon}`);
  }
  const pair = text.match(PAIR);
  // A negative longitude or N/W letters: a bare "38.5, 121.2" could be anything.
  if (pair && (pair[4] || (pair[3] && pair[7]))) {
    return parseCoordinates(`${pair[1]}.${pair[2]}, -${pair[5]}.${pair[6]}`);
  }
  const dms = text.match(DMS);
  if (dms) return parseCoordinates(dms[0]);
  return null;
}

/**
 * Attach stored page text to each project's newest document (in memory only),
 * and fill an empty Coordinates field from coordinates written in it. Returns
 * how many documents got text and coordinates.
 */
export function attachPageInfo(
  groups: Iterable<readonly CeqaDocument[]>,
  pages: StoredPages,
): { withInfo: number; withCoordinates: number } {
  let withInfo = 0;
  let withCoordinates = 0;
  for (const list of groups) {
    if (list.length === 0) continue;
    const entry = pages.pages[list[0].sch];
    if (!entry?.info) continue;
    let newest = list[0];
    for (const d of list) if (d.received > newest.received) newest = d;
    newest.otherLocation = entry.info;
    withInfo++;
    if (!list.some((d) => parseCoordinates(d.coordinates))) {
      const c = coordinatesInText(entry.info);
      if (c) {
        newest.coordinates = `${c.lat}, ${c.lon}`;
        withCoordinates++;
      }
    }
  }
  return { withInfo, withCoordinates };
}
