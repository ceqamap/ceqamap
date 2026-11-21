/**
 * Street-address geocoding with the U.S. Census Geocoder batch service
 * (free, no key, public domain results, up to 10,000 addresses per request).
 * https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html
 *
 * Results (matches and misses) are cached in storage, keyed by the exact
 * query, so each address is sent once; a build only geocodes new ones.
 * Misses are retried after RETRY_MISSES_DAYS in case Census data improved.
 */
import { parseLenientCsv } from './csv.ts';
import { log } from './log.ts';
import type { Storage } from './storage.ts';

export const GEOCODE_CACHE_KEY = 'state/geocode-cache.json';
const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const BATCH_SIZE = 2_000; // well under the 10k limit: small batches fail fast and retry cheaply
const RETRY_MISSES_DAYS = 180;

export interface AddressQuery {
  street: string;
  city: string;
  zip: string;
}

/** [lon, lat, day geocoded] for a match, [null, day] for a miss. */
type CacheEntry = [number, number, string] | [null, string];
export type GeocodeCache = Record<string, CacheEntry>;

export function queryKey(q: AddressQuery): string {
  return [q.street, q.city, q.zip].map((s) => s.toLowerCase().replace(/\s+/g, ' ').trim()).join('|');
}

const csvField = (s: string) => `"${s.replace(/"/g, '')}"`;

/**
 * Parse the batch response. Rows: id, input, Match|No_Match|Tie,
 * Exact|Non_Exact, matched address, "lon,lat", TIGER line id, side.
 */
export function parseBatchResponse(text: string): Map<string, { lon: number; lat: number } | null> {
  const out = new Map<string, { lon: number; lat: number } | null>();
  for (const row of parseLenientCsv(text)) {
    const id = row[0]?.trim();
    if (!id) continue;
    if (row[2] !== 'Match') {
      out.set(id, null);
      continue;
    }
    const [lon, lat] = (row[5] ?? '').split(',').map(Number);
    out.set(id, Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null);
  }
  return out;
}

async function geocodeBatch(queries: AddressQuery[]): Promise<Map<number, { lon: number; lat: number } | null>> {
  const body = queries.map((q, i) => [i, q.street, q.city, 'CA', q.zip].map(String).map(csvField).join(',')).join('\n');
  for (let attempt = 1; ; attempt++) {
    try {
      const form = new FormData();
      form.set('benchmark', 'Public_AR_Current');
      form.set('addressFile', new Blob([body + '\n'], { type: 'text/csv' }), 'addresses.csv');
      const res = await fetch(ENDPOINT, { method: 'POST', body: form, signal: AbortSignal.timeout(15 * 60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseBatchResponse(await res.text());
      if (parsed.size === 0) throw new Error('empty response');
      const out = new Map<number, { lon: number; lat: number } | null>();
      for (const [id, p] of parsed) out.set(Number(id), p);
      return out;
    } catch (err) {
      if (attempt >= 4) throw err;
      log.warn('Census geocoder batch failed, retrying', { attempt, error: String(err) });
      await new Promise((r) => setTimeout(r, attempt * 30_000));
    }
  }
}

export async function loadGeocodeCache(storage: Storage): Promise<GeocodeCache> {
  const bytes = await storage.get(GEOCODE_CACHE_KEY);
  return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as GeocodeCache) : {};
}

export async function saveGeocodeCache(storage: Storage, cache: GeocodeCache): Promise<void> {
  await storage.put(GEOCODE_CACHE_KEY, new TextEncoder().encode(JSON.stringify(cache)), {
    contentType: 'application/json',
  });
}

/**
 * Geocode every query not already in the cache (at most `limit` new ones per
 * run, so a first run can't take hours), then return the results for all.
 * Updates `cache` in place. Network failures leave those queries unresolved
 * for this build; they are tried again next time.
 */
export async function geocodeAll(
  queries: AddressQuery[],
  cache: GeocodeCache,
  today: string,
  limit = 60_000,
): Promise<{ results: Map<string, { lon: number; lat: number }>; stats: Record<string, number> }> {
  const stale = (e: CacheEntry | undefined) =>
    !e || (e[0] === null && Date.parse(today) - Date.parse(e[1]) > RETRY_MISSES_DAYS * 86_400_000);
  const pending = new Map<string, AddressQuery>();
  for (const q of queries) {
    const k = queryKey(q);
    if (stale(cache[k]) && !pending.has(k)) pending.set(k, q);
  }
  const todo = [...pending].slice(0, limit);
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const chunk = todo.slice(i, i + BATCH_SIZE);
    try {
      const res = await geocodeBatch(chunk.map(([, q]) => q));
      chunk.forEach(([k], j) => {
        const p = res.get(j);
        cache[k] = p ? [p.lon, p.lat, today] : [null, today];
      });
      sent += chunk.length;
    } catch (err) {
      failed += chunk.length;
      log.warn('Census geocoder unavailable; skipping batch', { error: String(err) });
    }
    log.info('Geocoding progress', { done: sent + failed, of: todo.length });
  }
  const results = new Map<string, { lon: number; lat: number }>();
  for (const q of queries) {
    const e = cache[queryKey(q)];
    if (e && e[0] !== null) results.set(queryKey(q), { lon: e[0], lat: e[1] as number });
  }
  return {
    results,
    stats: { queries: queries.length, newlySent: sent, failed, deferred: pending.size - todo.length, found: results.size },
  };
}
