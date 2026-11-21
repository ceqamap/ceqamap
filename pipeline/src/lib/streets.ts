/**
 * Street names: normalizing them so CEQAnet's free text matches the Census
 * TIGER/Line road names, and pulling street names out of the "Cross
 * Streets" field.
 *
 * CEQAnet examples: "Olive Mill Rd. and Hot Springs Road", "SR-1 / Main St",
 * "Hwy 101 & Old Redwood Highway", "Intersection of N. First St. and Elm Ave"
 * TIGER examples:   "Olive Mill Rd", "State Rte 1", "US Hwy 101", "N 1st St"
 */

const SUFFIX: Record<string, string> = {
  road: 'rd', rd: 'rd',
  street: 'st', str: 'st', st: 'st',
  avenue: 'ave', av: 'ave', ave: 'ave',
  boulevard: 'blvd', blvd: 'blvd', blv: 'blvd',
  drive: 'dr', dr: 'dr',
  lane: 'ln', ln: 'ln',
  court: 'ct', ct: 'ct',
  place: 'pl', pl: 'pl',
  parkway: 'pkwy', pkwy: 'pkwy', pky: 'pkwy',
  circle: 'cir', cir: 'cir',
  terrace: 'ter', ter: 'ter',
  trail: 'trl', trl: 'trl',
  way: 'way',
  highway: 'hwy', hwy: 'hwy', hiway: 'hwy',
  freeway: 'fwy', fwy: 'fwy',
  expressway: 'expy', expy: 'expy', expwy: 'expy',
  square: 'sq', sq: 'sq',
  loop: 'loop',
  alley: 'aly', aly: 'aly',
};

const DIRECTION: Record<string, string> = {
  north: 'n', n: 'n', south: 's', s: 's', east: 'e', e: 'e', west: 'w', w: 'w',
};

const ORDINAL: Record<string, string> = {
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th',
  sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th',
};

/** Suffix tokens dropped to make the "base" key (e.g. "olive mill"). */
const DROPPABLE_SUFFIX = new Set(['rd', 'st', 'ave', 'blvd', 'dr', 'ln', 'ct', 'pl', 'pkwy', 'cir', 'ter', 'trl', 'way']);

function tokens(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Numbered highways all become "rte N" (state routes, US highways and plain
 * "Highway N" are used interchangeably in CEQAnet), interstates become "i N".
 * Returns null if the name is not a numbered highway.
 */
function routeKey(t: string[]): string | null {
  const s = t.join(' ');
  let m = s.match(/^(?:i|interstate)\s*(\d{1,3})(?:\s|$)/);
  if (m) return `i ${Number(m[1])}`;
  m = s.match(/^(?:state\s+(?:rte|route|highway|hwy)|sr|ca|hwy|highway|route|rte|us\s+(?:hwy|highway|route|rte)|us)\s*(\d{1,3})(?:\s|$)/);
  if (m) return `rte ${Number(m[1])}`;
  return null;
}

export interface StreetKeys {
  /** e.g. "olive mill rd", "n 1st st", "rte 101" */
  full: string;
  /** without suffix and leading direction, e.g. "olive mill", "1st" */
  base: string;
}

export function streetKeys(name: string): StreetKeys | null {
  let t = tokens(name);
  if (t.length === 0) return null;
  const route = routeKey(t);
  if (route) return { full: route, base: route };
  if (t.length === 1 && (SUFFIX[t[0]] || DIRECTION[t[0]])) return null; // "St", "Road", "North" alone
  t = t.map((w, i) => {
    if (ORDINAL[w]) return ORDINAL[w];
    if (i === 0 && w === 'st' && t.length > 2) return 'saint'; // "St Helena Rd"
    if (i === 0 && w === 'mt') return 'mount';
    if (i === 0 && DIRECTION[w] && t.length > 1) return DIRECTION[w];
    if (i === t.length - 1 && SUFFIX[w] && t.length > 1) return SUFFIX[w];
    return w;
  });
  const full = t.join(' ');
  let b = [...t];
  if (b.length > 1 && DROPPABLE_SUFFIX.has(b[b.length - 1])) b = b.slice(0, -1);
  if (b.length > 1 && ['n', 's', 'e', 'w'].includes(b[0])) b = b.slice(1);
  const base = b.join(' ');
  // A bare suffix or number on its own is too ambiguous to be a street.
  if (!/[a-z]{2}/.test(base) && !/^\d+(st|nd|rd|th)$/.test(base)) return null;
  return { full, base };
}

const VAGUE = /\b(various|multiple|several|numerous|n\/?a|none|unknown|see (attached|map|below|above)|throughout|countywide|citywide|statewide|regionwide|tbd|not applicable)\b/i;
const FILLER = /\b(intersection of|corner of|(?:north|south|east|west|n|s|e|w)\s+of|near|adjacent to|between|along|located (?:at|on)|at the|the)\b/gi;

/**
 * Pull up to four street names out of a "Cross Streets" field. Returns []
 * when the text is vague ("Various", "N/A") or has fewer than two names.
 */
export function parseCrossStreets(text: string | null | undefined): string[] {
  if (!text) return [];
  const t = text.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || VAGUE.test(t)) return [];
  const parts = t
    .replace(FILLER, ' ; ')
    .split(/\s*(?:\band\b|&|\/|\bat\b|@|;|,|\s-\s|\bx\b|\bwith\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => /[a-z]{2}/i.test(s) && s.length <= 40);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const p of parts) {
    const k = streetKeys(p);
    if (!k || seen.has(k.full)) continue;
    seen.add(k.full);
    names.push(p);
    if (names.length === 4) break;
  }
  return names.length >= 2 ? names : [];
}
