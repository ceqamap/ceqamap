import { gunzipSync, gzipSync } from 'node:zlib';
import type { CeqaDocument } from './document.ts';
import type { Storage } from './storage.ts';

/**
 * Normalized documents are stored one gzip'd NDJSON file per received month.
 * Partitioning by month keeps incremental runs cheap: a daily ingest only
 * rewrites the one or two months it touched.
 */

export const DOCS_PREFIX = 'state/docs/';
export const RAW_PREFIX = 'state/raw/';

export const partitionKey = (month: string) => `${DOCS_PREFIX}${month}.ndjson.gz`;
export const rawKey = (month: string, suffix = '') => `${RAW_PREFIX}${month}${suffix}.csv.gz`;

export function encodePartition(docs: CeqaDocument[]): Uint8Array {
  const sorted = [...docs].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return gzipSync(sorted.map((d) => JSON.stringify(d)).join('\n') + '\n', { level: 9 });
}

export function decodePartition(bytes: Uint8Array): CeqaDocument[] {
  return gunzipSync(bytes)
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as CeqaDocument);
}

export async function readPartition(storage: Storage, month: string): Promise<CeqaDocument[]> {
  const bytes = await storage.get(partitionKey(month));
  return bytes ? decodePartition(bytes) : [];
}

export async function writePartition(storage: Storage, month: string, docs: CeqaDocument[]) {
  await storage.put(partitionKey(month), encodePartition(docs), { contentType: 'application/gzip' });
}

export async function listPartitionMonths(storage: Storage): Promise<string[]> {
  const keys = await storage.list(DOCS_PREFIX);
  return keys
    .map((k) => k.slice(DOCS_PREFIX.length).replace('.ndjson.gz', ''))
    .filter((m) => /^\d{4}-\d{2}$/.test(m))
    .sort();
}

/**
 * Merge freshly fetched documents for [start, end] into existing partition
 * contents. The fetch is authoritative for its date range: documents in that
 * range that CEQAnet no longer returns are dropped (corrections and
 * withdrawals), documents outside it are kept untouched.
 *
 * Returns the merged list and whether anything actually changed.
 */
export function mergeWindow(
  existing: CeqaDocument[],
  fetched: CeqaDocument[],
  start: string,
  end: string,
): { docs: CeqaDocument[]; changed: boolean; added: CeqaDocument[] } {
  const outside = existing.filter((d) => d.received < start || d.received > end);
  const byKey = new Map<string, CeqaDocument>();
  for (const d of fetched) byKey.set(d.key, d); // last one wins on duplicates
  const merged = [...outside, ...byKey.values()];
  // Documents we have never stored before, by key. Edits to known documents
  // and documents whose Received date moved are not arrivals.
  const known = new Set(existing.map((d) => d.key));
  const added = [...byKey.values()].filter((d) => !known.has(d.key));

  const fingerprint = (docs: CeqaDocument[]) =>
    docs
      .map((d) => JSON.stringify(d))
      .sort()
      .join('\n');
  return { docs: merged, changed: fingerprint(existing) !== fingerprint(merged), added };
}
