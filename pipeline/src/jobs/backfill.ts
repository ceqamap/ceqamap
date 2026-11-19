/**
 * One-time (and resumable) load of CEQAnet history, one month per request.
 *
 *   pnpm --filter @ceqa-atlas/pipeline backfill -- --from 1980-01 --to 2026-11
 *
 * Months already stored are skipped unless --force is passed, so this can be
 * run repeatedly inside GitHub Actions' 6 hour job limit until it finishes.
 * About 560 months at a 3 s pace plus fetch time takes roughly 45 to 60
 * minutes.
 */
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { CeqanetClient, monthBounds, monthsBetween, todayInCalifornia } from '../lib/ceqanet.ts';
import { normalizeRecord } from '../lib/document.ts';
import { log } from '../lib/log.ts';
import { listPartitionMonths, rawKey, writePartition } from '../lib/partitions.ts';
import { storageFromEnv } from '../lib/storage.ts';

const { values } = parseArgs({
  options: {
    from: { type: 'string', default: '1980-01' },
    to: { type: 'string', default: todayInCalifornia().slice(0, 7) },
    force: { type: 'boolean', default: false },
    'max-minutes': { type: 'string', default: '330' },
  },
});

const storage = storageFromEnv();
const client = new CeqanetClient({ contact: process.env.CEQANET_CONTACT ?? '' });
const deadline = Date.now() + Number(values['max-minutes']) * 60_000;
const have = new Set(values.force ? [] : await listPartitionMonths(storage));
const months = monthsBetween(`${values.from}-01`, `${values.to}-01`);
const currentMonth = todayInCalifornia().slice(0, 7);

let fetched = 0;
let rejectedTotal = 0;
for (const month of months) {
  // The current month is always refetched; it is still filling up.
  if (have.has(month) && month !== currentMonth) continue;
  if (Date.now() > deadline) {
    log.warn('Time budget reached; rerun to continue', { nextMonth: month });
    break;
  }
  const { start, end } = monthBounds(month);
  const res = await client.fetchRange(start, end);
  const docs = res.records.map(normalizeRecord).filter((d) => d !== null);
  await storage.put(rawKey(month), gzipSync(res.raw), { contentType: 'application/gzip' });
  await writePartition(storage, month, docs);
  rejectedTotal += res.rejected.length;
  if (res.rejected.length > 0) log.warn('Rejected rows', { month, rejected: res.rejected.slice(0, 5) });
  log.info('Backfilled month', { month, documents: docs.length, rejected: res.rejected.length });
  fetched++;
}

log.info('Backfill finished', { monthsFetched: fetched, rejectedTotal });
