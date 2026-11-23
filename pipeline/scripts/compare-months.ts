/**
 * Report: download whole months from CEQAnet again and compare them with the
 * stored copy, field by field. Ingest only refetches the last 21 days, so a
 * record edited later (coordinates or cross streets added, say) stays stale.
 * This measures how often that happens. Nothing is saved.
 *
 *   MONTHS=2026-04,2025-04 EXPLAIN=2026040250 node scripts/compare-months.ts
 */
import { CeqanetClient, monthBounds } from '../src/lib/ceqanet.ts';
import { type CeqaDocument, normalizeRecord } from '../src/lib/document.ts';
import { parseCoordinates } from '../src/lib/coordinates.ts';
import { readPartition } from '../src/lib/partitions.ts';
import { storageFromEnv } from '../src/lib/storage.ts';

const MONTHS = (process.env.MONTHS ?? '2026-04').split(',').filter(Boolean);
const EXPLAIN = new Set((process.env.EXPLAIN ?? '').split(',').filter(Boolean));
const out = (o: unknown) => console.log(JSON.stringify(o));
const storage = storageFromEnv();
const client = new CeqanetClient({ contact: process.env.CEQANET_CONTACT ?? '' });

const LOCATION: (keyof CeqaDocument)[] = ['coordinates', 'cities', 'counties', 'crossStreets', 'zip'];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const empty = (v: unknown) => (Array.isArray(v) ? v.length === 0 : !v);

for (const month of MONTHS) {
  const { start, end } = monthBounds(month);
  const res = await client.fetchRange(start, end);
  const fresh = res.records.map(normalizeRecord).filter((d): d is CeqaDocument => d !== null);
  const stored = await readPartition(storage, month);
  const storedByKey = new Map(stored.map((d) => [d.key, d]));
  const freshByKey = new Map(fresh.map((d) => [d.key, d]));

  const fieldChanges: Record<string, number> = {};
  const filledIn: Record<string, number> = {};
  const changedSch = new Set<string>();
  let changedDocs = 0;
  const gainedCoordinates = new Set<string>();
  const samples: unknown[] = [];
  for (const [key, f] of freshByKey) {
    const s = storedByKey.get(key);
    if (!s) continue;
    const fields = (Object.keys(f) as (keyof CeqaDocument)[]).filter((k) => !same(f[k], s[k]));
    if (fields.length === 0) continue;
    changedDocs++;
    changedSch.add(f.sch);
    for (const k of fields) {
      fieldChanges[k] = (fieldChanges[k] ?? 0) + 1;
      if (empty(s[k]) && !empty(f[k])) filledIn[k] = (filledIn[k] ?? 0) + 1;
    }
    if (!parseCoordinates(s.coordinates) && parseCoordinates(f.coordinates)) gainedCoordinates.add(f.sch);
    const loc = fields.filter((k) => LOCATION.includes(k));
    if ((loc.length > 0 && samples.length < 15) || EXPLAIN.has(f.sch))
      samples.push({
        sch: f.sch,
        type: f.type,
        received: f.received,
        fields,
        before: Object.fromEntries(loc.map((k) => [k, s[k]])),
        after: Object.fromEntries(loc.map((k) => [k, f[k]])),
      });
  }
  for (const sch of EXPLAIN) {
    const st = stored.filter((d) => d.sch === sch);
    const fr = fresh.filter((d) => d.sch === sch);
    if (st.length || fr.length)
      out({
        month,
        explain: sch,
        stored: st.map((d) => ({ key: d.key, type: d.type, received: d.received, ...pick(d) })),
        fresh: fr.map((d) => ({ key: d.key, type: d.type, received: d.received, ...pick(d) })),
      });
  }
  out({
    month,
    stored: stored.length,
    fresh: fresh.length,
    rejectedRows: res.rejected.length,
    onlyFresh: fresh.filter((d) => !storedByKey.has(d.key)).length,
    onlyStored: stored.filter((d) => !freshByKey.has(d.key)).length,
    changedDocs,
    changedProjects: changedSch.size,
    fieldChanges,
    filledIn,
    gainedCoordinates: gainedCoordinates.size,
  });
  for (const s of samples) out({ month, sample: s });
}

function pick(d: CeqaDocument) {
  return Object.fromEntries(LOCATION.map((k) => [k, d[k]]));
}
