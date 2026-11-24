/**
 * Placing state highway projects at the postmiles in their text.
 *
 * Caltrans locates everything on a state highway by county, route and
 * postmile: "in San Diego County along SR 76 from PM R16.4 to R16.9", "11-SD-76
 * PM 16.4/16.9", "State Route 3 at post mile 27.09". Postmiles restart at 0 at
 * each county line, and a letter prefix marks a realigned stretch ("R16.4").
 * Caltrans publishes a point every 0.1 mile (SHN Postmiles Tenth), which
 * scripts/fetch-postmiles.ts compacts into pipeline/data/postmiles.json.
 *
 * Deliberately strict, like the other text placements:
 *   - A postmile only counts next to a route the text names (or in a
 *     district-county-route code like "11-SD-76"); "PM 89-24" alone is a
 *     parcel map number.
 *   - The county is a listed county (or the one in the code), so the point is
 *     inside the project's own county by construction.
 *   - A range longer than MAX_RANGE_MILES says little about where the work
 *     is; the middle of a short range stands for it.
 *   - Different routes or counties giving different places: skipped.
 */
import { normalizePlaceName } from './boundaries.ts';
import { haversineKm } from './location.ts';

export interface PostmileTable {
  source: string;
  /**
   * "<county code>|<route>" (e.g. "SD|76") -> points sorted by postmile:
   * [prefix ("" or a letter), postmile, lon, lat].
   */
  routes: Record<string, [string, number, number, number][]>;
}

/** Caltrans county abbreviations, by normalized county name. */
export const COUNTY_CODE: Readonly<Record<string, string>> = {
  alameda: 'ALA',
  alpine: 'ALP',
  amador: 'AMA',
  butte: 'BUT',
  calaveras: 'CAL',
  colusa: 'COL',
  'contra costa': 'CC',
  'del norte': 'DN',
  'el dorado': 'ED',
  fresno: 'FRE',
  glenn: 'GLE',
  humboldt: 'HUM',
  imperial: 'IMP',
  inyo: 'INY',
  kern: 'KER',
  kings: 'KIN',
  lake: 'LAK',
  lassen: 'LAS',
  'los angeles': 'LA',
  madera: 'MAD',
  marin: 'MRN',
  mariposa: 'MPA',
  mendocino: 'MEN',
  merced: 'MER',
  modoc: 'MOD',
  mono: 'MNO',
  monterey: 'MON',
  napa: 'NAP',
  nevada: 'NEV',
  orange: 'ORA',
  placer: 'PLA',
  plumas: 'PLU',
  riverside: 'RIV',
  sacramento: 'SAC',
  'san benito': 'SBT',
  'san bernardino': 'SBD',
  'san diego': 'SD',
  'san francisco': 'SF',
  'san joaquin': 'SJ',
  'san luis obispo': 'SLO',
  'san mateo': 'SM',
  'santa barbara': 'SB',
  'santa clara': 'SCL',
  'santa cruz': 'SCR',
  shasta: 'SHA',
  sierra: 'SIE',
  siskiyou: 'SIS',
  solano: 'SOL',
  sonoma: 'SON',
  stanislaus: 'STA',
  sutter: 'SUT',
  tehama: 'TEH',
  trinity: 'TRI',
  tulare: 'TUL',
  tuolumne: 'TUO',
  ventura: 'VEN',
  yolo: 'YOL',
  yuba: 'YUB',
};
const CODES = new Set(Object.values(COUNTY_CODE));

/** Longest postmile range (miles) placed at its middle. */
export const MAX_RANGE_MILES = 5;
/** Places from different readings farther apart than this disagree. */
const AGREE_KM = 2;
/** A postmile with no published point within this many miles is not on the route. */
const MAX_GAP_MILES = 0.3;

export interface PostmileMention {
  route: number;
  /** County code from a "11-SD-76" style code, if any. */
  county?: string;
  from: { prefix: string; pm: number };
  to?: { prefix: string; pm: number };
  /** As written, for the drawer. */
  text: string;
}

// "SR 76", "SR-76", "State Route 3", "Route 99", "Highway 1", "Hwy 46", "US 101",
// "U.S. 50", "I-5", "Interstate 15". A trailing "-007"/"/9" means a number, not a route.
const ROUTE_RE =
  /\b(?:State\s+(?:Route|Highway|Hwy|Rte)|S\.?R\.?|Route|Rte|Highway|Hwy|U\.?S\.?(?:\s+(?:Highway|Hwy|Route))?|Interstate|I)[\s-]*(\d{1,3})(?![\d.]|-\d|\/\d)[A-Z]?\b/gi;
// "11-SD-76", "10-CAL-4", "06-FRE-99": district, county, route.
const CODE_RE = /\b(\d{1,2})[\s-]+([A-Z]{2,3})[\s-]+(\d{1,3})\b/g;
// "PM R16.4 to R16.9", "PM 12.5/13.0", "post mile 54.8", "Post Miles 45.0 and 45.2", "PM 6.9".
const PM_NUM = String.raw`([A-Z]?)\s?(\d{1,3}(?:\.\d{1,3})?)[A-Z]?`;
const PARTICULATE = /emission|particulate|exhaust|dust|attainment|µg|ug\/m|standard|ozone|NOx|ROG/i;
const PM_RE = new RegExp(
  String.raw`\b(?:post\s?-?miles?|P\.?M\.?s?)\s*[:#]?\s*` +
    PM_NUM +
    String.raw`(?:\s*(?:to|-|–|—|\/|and|through|thru)\s*(?:PM\s*)?` +
    PM_NUM +
    ')?',
  'gi',
);

/**
 * Postmile mentions tied to a route: each postmile goes with the nearest route
 * named before it (or a district-county-route code), within 200 characters.
 */
export function postmileMentions(text: string): PostmileMention[] {
  const routes: { at: number; route: number; county?: string }[] = [];
  for (const m of text.matchAll(ROUTE_RE)) {
    // "I" alone must be capital and directly followed by "-" or a space and digits: "I-5", "I 80".
    if (/^I[\s-]/.test(m[0]) || !/^i[\s-]/i.test(m[0])) routes.push({ at: m.index!, route: Number(m[1]) });
  }
  for (const m of text.matchAll(CODE_RE)) {
    if (CODES.has(m[2]) && Number(m[1]) >= 1 && Number(m[1]) <= 12)
      routes.push({ at: m.index!, route: Number(m[3]), county: m[2] });
  }
  routes.sort((a, b) => a.at - b.at);
  const out: PostmileMention[] = [];
  for (const m of text.matchAll(PM_RE)) {
    const at = m.index!;
    // Particulate matter, not postmiles: "PM10", "PM2.5", "PM 10 emissions".
    if (
      /^PM\s?(?:10|2\.5)\b/i.test(m[0]) &&
      (/^PM(?:10|2\.5)/i.test(m[0]) || PARTICULATE.test(text.slice(at, at + 80)))
    )
      continue;
    // Kilometer posts ("KP 1.6/11.4 (PM 1.0/7.1)") are fine: we only read PM.
    // "PM 89-24", "PM21884": parcel map numbers have no decimal point and no route nearby.
    const before = routes.filter((r) => r.at < at && at - r.at <= 200).at(-1);
    const after = routes.find((r) => r.at > at && r.at - at <= 60);
    const r = before ?? after;
    if (!r || r.route === 0) continue;
    const from = { prefix: m[1].toUpperCase(), pm: Number(m[2]) };
    const to = m[4] !== undefined ? { prefix: m[3].toUpperCase(), pm: Number(m[4]) } : undefined;
    // A hyphenated pair of whole numbers ("89-24") is an identifier, not a range.
    if (to && /^\d+-\d+$/.test(`${m[2]}-${m[4]}`) && !m[0].includes('.')) continue;
    out.push({
      route: r.route,
      ...(r.county ? { county: r.county } : {}),
      from,
      ...(to ? { to } : {}),
      text: m[0].trim(),
    });
  }
  return out;
}

export type PostmileOutcome =
  | { kind: 'placed'; lon: number; lat: number; label: string }
  | { kind: 'none' | 'not-found' | 'long-range' | 'disagree' };

/** Points of one route in one county, at the postmile (prefix must match when given). */
function pointAt(
  pts: [string, number, number, number][],
  prefix: string,
  pm: number,
): { lon: number; lat: number; pm: number } | null {
  let best: [string, number, number, number] | null = null;
  for (const p of pts) {
    if (prefix && p[0] !== prefix) continue;
    if (!best || Math.abs(p[1] - pm) < Math.abs(best[1] - pm)) best = p;
  }
  if (!best || Math.abs(best[1] - pm) > MAX_GAP_MILES) return null;
  // Without a prefix in the text, the same number can exist both with and without one.
  if (!prefix) {
    const same = pts.filter((p) => Math.abs(p[1] - best![1]) < 1e-9);
    if (same.some((p) => haversineKm({ lon: p[2], lat: p[3] }, { lon: best![2], lat: best![3] }) > AGREE_KM))
      return null;
  }
  return { lon: best[2], lat: best[3], pm: best[1] };
}

const fmt = (x: { prefix: string; pm: number }) => `${x.prefix}${x.pm}`;

/** Where the postmiles in a project's text are, in one of its listed counties. */
export function placeAtPostmiles(text: string, counties: readonly string[], t: PostmileTable): PostmileOutcome {
  const mentions = postmileMentions(text);
  if (mentions.length === 0) return { kind: 'none' };
  const listed = counties.map((c) => COUNTY_CODE[normalizePlaceName(c)]).filter((c): c is string => !!c);
  const found: { lon: number; lat: number; label: string }[] = [];
  let sawLong = false;
  for (const m of mentions) {
    const codes = m.county ? [m.county] : listed;
    for (const code of codes) {
      const pts = t.routes[`${code}|${m.route}`];
      if (!pts) continue;
      const a = pointAt(pts, m.from.prefix, m.from.pm);
      if (!a) continue;
      let p: { lon: number; lat: number } = a;
      let label = `${routeName(m.route)}, PM ${fmt(m.from)}`;
      if (m.to) {
        const b = pointAt(pts, m.to.prefix || m.from.prefix, m.to.pm);
        if (!b) continue;
        if (Math.abs(b.pm - a.pm) > MAX_RANGE_MILES) {
          sawLong = true;
          continue;
        }
        // The published point nearest the middle of the range, so the dot sits on the road.
        const mid = pointAt(pts, m.from.prefix, (a.pm + b.pm) / 2) ?? a;
        p = mid;
        label += `–${fmt({ prefix: m.to.prefix, pm: m.to.pm })}`;
      }
      found.push({ ...p, label });
    }
  }
  if (found.length === 0) return { kind: sawLong ? 'long-range' : 'not-found' };
  // Several postmiles (a list of sites, both ends written twice) must be one place.
  if (found.some((f) => haversineKm(f, found[0]) > AGREE_KM * 4)) return { kind: 'disagree' };
  return { kind: 'placed', lon: found[0].lon, lat: found[0].lat, label: found[0].label };
}

function routeName(route: number): string {
  return [
    5, 8, 10, 15, 40, 80, 105, 110, 205, 210, 215, 238, 280, 380, 405, 505, 580, 605, 680, 710, 780, 805, 880, 980,
  ].includes(route)
    ? `I-${route}`
    : [6, 50, 95, 97, 101, 199, 395].includes(route)
      ? `US ${route}`
      : `SR ${route}`;
}
