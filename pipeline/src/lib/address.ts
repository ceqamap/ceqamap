/**
 * Street addresses written into CEQAnet free text.
 *
 * CEQAnet has no address field, but agencies often put one in the Cross
 * Streets field ("1234 Main St", "1201-1215 S. Figueroa Street") or in the
 * project title ("2100 Bridgeway Mixed-Use Project"). We pull out the first
 * thing that looks like a house number + street name + street type, and
 * geocode it (see geocode.ts).
 *
 * Deliberately strict: a street type is required, highways are excluded
 * ("101 Freeway", "Highway 99"), and acreages, lot counts and unit counts
 * can't match because they lack a street type.
 */

const STREET_TYPE =
  'street|st|avenue|ave|av|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|place|pl|way|parkway|pkwy|circle|cir|terrace|ter|trail|trl|highway|hwy|alameda|plaza|plz|square|sq|loop|row|walk|path|crescent|pike|camino|alley';

// House number (optionally a range or with a letter), optional direction,
// 1-5 name words, then a street type. Spanish-style "Camino X" / "Via X"
// names without a trailing type are matched by the second branch.
const ADDRESS = new RegExp(
  String.raw`(?<![\d.,$#])\b(\d{1,6})(?:\s*[-–]\s*\d{1,6})?[A-Za-z]?\s+` +
    String.raw`((?:(?:N|S|E|W|North|South|East|West)\.?\s+)?` +
    String.raw`(?:(?:[A-Za-z][A-Za-z'.]*|\d{1,3}(?:st|nd|rd|th))\s+){1,5}?(?:${STREET_TYPE})\b\.?` +
    String.raw`|(?:Via|Calle|Camino|Paseo|Avenida|Rancho)\s+[A-Z][A-Za-z']+(?:\s+[A-Z][A-Za-z']+){0,2})`,
  'gi',
);

/** Name words that mean this isn't a street ("101 freeway", "5 lots on Main St"). */
const NOT_A_STREET =
  /^(?:(?:n|s|e|w|north|south|east|west)\.?\s+)?(?:state\s+|us\s+|u\.s\.\s+|interstate\s+|i\s+|ca\s+|sr\s+|route\s+|rte\s+)|\b(?:acres?|ac|lots?|units?|homes|dwelling|parcels?|sq|square\s+feet|feet|ft|miles?|mi|percent|year|years|stories|story|spaces|beds?|rooms?|apn|of|and|on|at|to|the|from|between|near|for|in)\b/i;

export interface ExtractedAddress {
  /** "1234 Main St", ready for a geocoder. */
  street: string;
  number: number;
}

export function extractAddress(text: string): ExtractedAddress | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ');
  for (const m of clean.matchAll(ADDRESS)) {
    const number = Number(m[1]);
    const name = m[2].replace(/\.$/, '').trim();
    if (number === 0) continue;
    // Highways and non-street words make it not an address.
    const words = name.replace(new RegExp(String.raw`\s+(?:${STREET_TYPE})$`, 'i'), '');
    if (NOT_A_STREET.test(words)) continue;
    if (/\b(?:highway|hwy)$/i.test(name) && !/^(?:old|pacific|coast)\b/i.test(words)) continue;
    return { street: `${number} ${name}`, number };
  }
  return null;
}

/** A California ZIP code (90001-96162), or null. "95814-1234" -> "95814". */
export function caZip(value: string): string | null {
  const m = value.trim().match(/^(9[0-6]\d{3})(?:-\d{4})?$/);
  return m ? m[1] : null;
}
