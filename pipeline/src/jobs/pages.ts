/**
 * Fetch CEQAnet project pages for "Other Location Info" (see lib/pages.ts).
 *
 * Covers projects with a filing in the past 12 months that the CSV can't place
 * exactly, newest filings first: pages never fetched, or fetched before the
 * project's latest filing. One page every 8 s (CEQAnet answers 403 when
 * requests come faster), for at most --minutes, saving progress as it goes.
 * The first pass over ~11,000 projects takes about a day of hourly runs; after
 * that each run only picks up new filings.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { groupBySch } from '../lib/aggregate.ts';
import type { Boundaries } from '../lib/boundaries.ts';
import { addDays, monthsBetween, todayInCalifornia } from '../lib/ceqanet.ts';
import type { CeqaDocument } from '../lib/document.ts';
import { resolveLocation } from '../lib/location.ts';
import { log } from '../lib/log.ts';
import { loadPages, otherLocationInfo, pageUrl, savePages } from '../lib/pages.ts';
import { readPartition } from '../lib/partitions.ts';
import { storageFromEnv } from '../lib/storage.ts';

const { values } = parseArgs({
  options: {
    minutes: { type: 'string', default: '50' },
    days: { type: 'string', default: '365' },
    gap: { type: 'string', default: '8000' },
  },
});
const deadline = Date.now() + Number(values.minutes) * 60_000;
const gapMs = Number(values.gap);
const contact = process.env.CEQANET_CONTACT;
if (!contact) throw new Error('Set CEQANET_CONTACT (identifies us to the State Clearinghouse)');

const storage = storageFromEnv();
const b = JSON.parse(await readFile(new URL('../../data/boundaries.json', import.meta.url), 'utf8')) as Boundaries;
const today = todayInCalifornia();
const since = addDays(today, -Number(values.days));
const docs: CeqaDocument[] = [];
for (const month of monthsBetween(since, today)) docs.push(...(await readPartition(storage, month)));

const store = await loadPages(storage);
const todo: { sch: string; latest: string }[] = [];
let exact = 0;
for (const [sch, list] of groupBySch(docs)) {
  const newestFirst = [...list].sort((x, y) => (x.received < y.received ? 1 : x.received > y.received ? -1 : 0));
  const latest = newestFirst[0].received;
  if (latest < since) continue;
  if (resolveLocation(sch, newestFirst, b)?.precision === 'exact') {
    exact++;
    continue;
  }
  const have = store.pages[sch];
  if (have && have.latest >= latest) continue;
  todo.push({ sch, latest });
}
todo.sort((x, y) => (x.latest < y.latest ? 1 : x.latest > y.latest ? -1 : 0));
log.info('Pages to fetch', { since, todo: todo.length, stored: Object.keys(store.pages).length, exact });

let fetched = 0;
let withInfo = 0;
let failures = 0;
let lastAt = 0;
const SAVE_EVERY = 25;
for (const { sch, latest } of todo) {
  if (Date.now() + gapMs > deadline) break;
  const wait = lastAt + gapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAt = Date.now();
  let html: string | null = null;
  try {
    const res = await fetch(pageUrl(sch), {
      headers: { 'User-Agent': `ceqamap/1.0 (+https://ceqamap.org; ${contact})`, Accept: 'text/html' },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 403 || res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (res.ok) html = await res.text();
    else log.warn('Page not available', { sch, status: res.status });
  } catch (err) {
    failures++;
    log.warn('Page fetch failed; backing off', { sch, failures, error: String(err) });
    // Being throttled: wait it out, and stop for this run after repeated failures.
    if (failures >= 5) break;
    await new Promise((r) => setTimeout(r, Math.min(600_000, 60_000 * 2 ** (failures - 1))));
    continue;
  }
  failures = 0;
  // A page without the field (or a 404) is recorded too, so it isn't fetched again until a new filing.
  const info = html ? otherLocationInfo(html) : null;
  store.pages[sch] = { info, at: new Date().toISOString(), latest };
  fetched++;
  if (info) withInfo++;
  if (fetched % SAVE_EVERY === 0) await savePages(storage, store);
}
if (fetched > 0) await savePages(storage, store);
log.info('Fetched pages', {
  fetched,
  withInfo,
  remaining: todo.length - fetched,
  stored: Object.keys(store.pages).length,
});
