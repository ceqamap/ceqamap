/**
 * Parsing the free-text "Location Coordinates" field.
 *
 * Lead agencies type this by hand. Formats observed in live data:
 *   38°20'58.9"N 122°39'2.9"W        (the common modern form)
 *   37°23'54.906N 121°55'49.056W     (seconds mark missing)
 *   34°3'N 118°14'W                   (no seconds)
 *   36°'N 119°'W                      (no minutes)
 *   36°47″2.27″N 119°37″2.92″W        (″ used for minutes)
 *   36°.5'.3″N 119°37'2.92″W          (stray dots)
 *   35°12-30'N 119°5-10'W             (dash between minutes and seconds)
 * plus decimal degrees in various forms.
 *
 * Every result is validated against a California bounding box; anything that
 * lands outside is discarded (and the project falls back to city/county).
 */

/** California plus a small buffer for offshore and border projects. */
export const CA_BOUNDS = { west: -124.6, east: -113.9, south: 32.3, north: 42.1 } as const;

export function inCalifornia(lon: number, lat: number): boolean {
  return lon >= CA_BOUNDS.west && lon <= CA_BOUNDS.east && lat >= CA_BOUNDS.south && lat <= CA_BOUNDS.north;
}

const NUM = /\d+(?:\.\d+)?|\.\d+/g;

function partToDecimal(part: string): number | null {
  const nums = part.match(NUM)?.map(Number) ?? [];
  if (nums.length === 0 || nums.length > 3 || nums.some((n) => !Number.isFinite(n))) return null;
  const [deg, min = 0, sec = 0] = nums;
  if (nums.length === 1) return deg; // decimal degrees with a hemisphere letter
  if (min >= 60 || sec >= 60) return null;
  return deg + min / 60 + sec / 3600;
}

export interface LonLat {
  lon: number;
  lat: number;
}

export function parseCoordinates(raw: string | null | undefined): LonLat | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s === '') return null;

  // Hemisphere-tagged form: "<lat stuff>N <lon stuff>W"
  const tagged = s.match(/^(.*?)([NS])[\s,;/]*(.*?)([EW])\s*$/i);
  if (tagged) {
    let lat = partToDecimal(tagged[1]);
    let lon = partToDecimal(tagged[3]);
    if (lat !== null && lon !== null) {
      if (tagged[2].toUpperCase() === 'S') lat = -lat;
      if (tagged[4].toUpperCase() === 'W') lon = -lon;
      return validate(lon, lat);
    }
  }

  // Plain decimal pair: "38.123, -122.456" or "38.123 -122.456"
  const pair = s.match(/^(-?\d+(?:\.\d+)?)[\s,;/]+(-?\d+(?:\.\d+)?)$/);
  if (pair) return validate(Number(pair[2]), Number(pair[1]));

  return null;
}

/** Accept the point if it is in California, repairing two common slips. */
function validate(lon: number, lat: number): LonLat | null {
  if (inCalifornia(lon, lat)) return { lon, lat };
  if (inCalifornia(-lon, lat)) return { lon: -lon, lat }; // forgot the W / minus sign
  if (inCalifornia(lat, lon)) return { lon: lat, lat: lon }; // swapped order
  if (inCalifornia(-lat, lon)) return { lon: -lat, lat: lon };
  return null;
}
