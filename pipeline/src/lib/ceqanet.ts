import { CsvSchemaError, decodeCeqaCsv, parseCeqaCsv, type ParsedCsv } from './csv.ts';
import { log } from './log.ts';

/**
 * A polite client for CEQAnet's CSV export.
 *
 * Observed behavior (2026-11-18): one month of data returns in about 0.3 to
 * 1.6 s. Requests fired back-to-back sometimes come back as HTTP 200 with an
 * empty body, so every response is validated and empty ones are retried with
 * backoff. We identify ourselves in the User-Agent so the State Clearinghouse
 * can contact us rather than block us.
 */

export const CEQANET_ORIGIN = 'https://ceqanet.lci.ca.gov';

export interface CeqanetClientOptions {
  /** Contact for the User-Agent header. Required: be a good citizen. */
  contact: string;
  /** Minimum gap between requests. */
  minIntervalMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface RangeResult extends ParsedCsv {
  start: string;
  end: string;
  /** The raw CSV text, archived so we can reprocess without refetching. */
  raw: string;
}

/**
 * If a single request returns at least this many rows we assume a server-side
 * cap might be truncating it, and split the range in half. The busiest month
 * observed has about 3,000 documents, so this never triggers in practice
 * unless CEQAnet starts capping.
 */
const SUSPECT_CAP_ROWS = 5000;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CeqanetClient {
  private lastRequestAt = 0;
  private readonly opts: Required<CeqanetClientOptions>;

  constructor(opts: CeqanetClientOptions) {
    if (!opts.contact) throw new Error('CeqanetClient requires a contact (set CEQANET_CONTACT)');
    this.opts = {
      minIntervalMs: 8000,
      maxAttempts: 7,
      fetchImpl: fetch,
      sleep: realSleep,
      ...opts,
    };
  }

  private async throttle() {
    const wait = this.lastRequestAt + this.opts.minIntervalMs - Date.now();
    if (wait > 0) await this.opts.sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /** Fetch every document received between two ISO dates (inclusive). */
  async fetchRange(start: string, end: string): Promise<RangeResult> {
    const result = await this.fetchOnce(start, end);
    if (result.records.length >= SUSPECT_CAP_ROWS && start !== end) {
      const mid = midpoint(start, end);
      log.warn('Possible row cap; splitting range', { start, end, rows: result.records.length });
      const a = await this.fetchRange(start, mid);
      const b = await this.fetchRange(addDays(mid, 1), end);
      return {
        start,
        end,
        header: a.header,
        records: [...a.records, ...b.records],
        rejected: [...a.rejected, ...b.rejected],
        raw: a.raw + '\n' + b.raw,
      };
    }
    return result;
  }

  private async fetchOnce(start: string, end: string): Promise<RangeResult> {
    const url = `${CEQANET_ORIGIN}/Search?StartRange=${start}&EndRange=${end}&OutputFormat=CSV`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      await this.throttle();
      try {
        const res = await this.opts.fetchImpl(url, {
          headers: {
            'User-Agent': `ceqamap/1.0 (+https://ceqamap.org; ${this.opts.contact})`,
            Accept: 'text/csv',
          },
          signal: AbortSignal.timeout(120_000),
        });
        // CEQAnet answers 403 (not 429) when it decides we are going too fast;
        // observed from GitHub Actions on 2026-11-19 after ~10 requests in 30 s.
        if (res.status === 403 || res.status === 429) throw new Error(`HTTP ${res.status}`, { cause: 'throttled' });
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) throw new Error(`HTTP ${res.status} (not retrying)`, { cause: 'fatal' });
        const raw = decodeCeqaCsv(await res.arrayBuffer());
        const parsed = parseCeqaCsv(raw); // throws CsvSchemaError on empty / changed schema
        return { start, end, raw, ...parsed };
      } catch (err) {
        lastError = err;
        if (err instanceof Error && err.cause === 'fatal') break;
        // A changed schema will not fix itself; only retry empties.
        if (err instanceof CsvSchemaError && !/Empty/.test(err.message)) break;
        const throttled = err instanceof Error && err.cause === 'throttled';
        const backoff = throttled
          ? Math.min(600_000, 60_000 * 2 ** (attempt - 1)) // 1, 2, 4, 8, 10 min
          : Math.min(120_000, 2 ** attempt * 2000);
        log.warn('CEQAnet request failed; backing off', { start, end, attempt, backoff, error: String(err) });
        await this.opts.sleep(backoff);
      }
    }
    throw new Error(`CEQAnet fetch failed for ${start}..${end}: ${String(lastError)}`);
  }
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function midpoint(start: string, end: string): string {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return new Date(a + Math.floor((b - a) / 86_400_000 / 2) * 86_400_000).toISOString().slice(0, 10);
}

/** Today's date in California, which is what CEQAnet's "Received" uses. */
export function todayInCalifornia(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
}

/** Inclusive list of calendar months [YYYY-MM] between two ISO dates. */
export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const ey = Number(end.slice(0, 4));
  const em = Number(end.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}
