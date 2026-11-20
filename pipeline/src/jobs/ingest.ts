/**
 * Incremental refresh. Refetches a trailing window of days (default 21)
 * because CEQAnet posts some documents days after their Received date and
 * occasionally corrects records.
 *
 * Writes `changed=true|false` to $GITHUB_OUTPUT so the workflow can skip the
 * rebuild when nothing moved.
 */
import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { addDays, CeqanetClient, monthBounds, monthsBetween, todayInCalifornia } from '../lib/ceqanet.ts';
import { normalizeRecord } from '../lib/document.ts';
import { log } from '../lib/log.ts';
import { mergeWindow, readPartition, writePartition } from '../lib/partitions.ts';
import { storageFromEnv } from '../lib/storage.ts';

const { values } = parseArgs({ options: { days: { type: 'string', default: '21' } } });

const storage = storageFromEnv();
const client = new CeqanetClient({ contact: process.env.CEQANET_CONTACT ?? '' });
const end = todayInCalifornia();
const start = addDays(end, -Number(values.days));

let anyChanged = false;
// Fetch month by month so each request stays small and maps to one partition.
for (const month of monthsBetween(start, end)) {
  const bounds = monthBounds(month);
  const s = bounds.start < start ? start : bounds.start;
  const e = bounds.end > end ? end : bounds.end;
  const res = await client.fetchRange(s, e);
  const fetched = res.records.map(normalizeRecord).filter((d) => d !== null);
  const existing = await readPartition(storage, month);
  const { docs, changed } = mergeWindow(existing, fetched, s, e);
  if (changed) {
    await writePartition(storage, month, docs);
    anyChanged = true;
  }
  log.info('Ingested window', {
    month,
    start: s,
    end: e,
    fetched: fetched.length,
    rejected: res.rejected.length,
    changed,
  });
}

if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${anyChanged}\n`);
log.info('Ingest finished', { changed: anyChanged });
