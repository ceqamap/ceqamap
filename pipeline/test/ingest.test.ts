import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays, CeqanetClient, monthBounds, monthsBetween, todayInCalifornia } from '../src/lib/ceqanet.ts';
import { decodePartition, encodePartition, mergeWindow } from '../src/lib/partitions.ts';
import { ceqaCsv, doc } from './helpers.ts';

const noSleep = async () => {};

function fakeFetch(responses: (() => Response)[]) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    return next();
  }) as typeof fetch;
  return { impl, calls };
}

const body = (s: string) => new TextEncoder().encode(s);

describe('CeqanetClient', () => {
  const csv = ceqaCsv([{ 'SCH Number': '2026110466', 'Document Type': 'NOE', Received: '11/17/2026' }]);

  it('requires a contact for the User-Agent', () => {
    assert.throws(() => new CeqanetClient({ contact: '' }));
  });

  it('retries the empty 200 responses CEQAnet sends when throttling', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response(''),
      () => new Response(''),
      () => new Response(body(csv), { headers: { 'content-type': 'text/csv' } }),
    ]);
    const c = new CeqanetClient({ contact: 'ops@example.com', fetchImpl: impl, sleep: noSleep, minIntervalMs: 0 });
    const r = await c.fetchRange('2026-11-01', '2026-11-18');
    assert.equal(r.records.length, 1);
    assert.equal(calls.length, 3);
    assert.match(calls[0], /StartRange=2026-11-01&EndRange=2026-11-18&OutputFormat=CSV/);
  });

  it('retries server errors and gives up after maxAttempts', async () => {
    const { impl, calls } = fakeFetch(Array.from({ length: 3 }, () => () => new Response('x', { status: 503 })));
    const c = new CeqanetClient({ contact: 'x', fetchImpl: impl, sleep: noSleep, minIntervalMs: 0, maxAttempts: 3 });
    await assert.rejects(c.fetchRange('2026-11-01', '2026-11-18'), /fetch failed/);
    assert.equal(calls.length, 3);
  });

  it('does not retry a 404', async () => {
    const { impl, calls } = fakeFetch([() => new Response('nope', { status: 404 })]);
    const c = new CeqanetClient({ contact: 'x', fetchImpl: impl, sleep: noSleep, minIntervalMs: 0 });
    await assert.rejects(c.fetchRange('2026-11-01', '2026-11-18'));
    assert.equal(calls.length, 1);
  });

  it('does not retry a schema change', async () => {
    const { impl, calls } = fakeFetch([() => new Response(csv.replace('Counties', 'County'))]);
    const c = new CeqanetClient({ contact: 'x', fetchImpl: impl, sleep: noSleep, minIntervalMs: 0 });
    await assert.rejects(c.fetchRange('2026-11-01', '2026-11-18'), /missing columns/);
    assert.equal(calls.length, 1);
  });
});

describe('date helpers', () => {
  it('lists months inclusively across years', () => {
    assert.deepEqual(monthsBetween('2025-11-20', '2026-02-01'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  });
  it('knows month lengths including leap years', () => {
    assert.deepEqual(monthBounds('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
    assert.deepEqual(monthBounds('2026-11'), { start: '2026-11-01', end: '2026-11-30' });
  });
  it('adds days across month boundaries', () => {
    assert.equal(addDays('2026-11-18', -21), '2026-10-28');
  });
  it('uses California time for today', () => {
    // 2026-11-19 06:30 UTC is still 2026-11-18 in Los Angeles.
    assert.equal(todayInCalifornia(new Date('2026-11-19T06:30:00Z')), '2026-11-18');
  });
});

describe('partitions', () => {
  it('round-trips through gzip NDJSON', () => {
    const docs = [doc({ key: 'b' }), doc({ key: 'a', description: 'Ünïcödé “quotes”' })];
    const back = decodePartition(encodePartition(docs));
    assert.deepEqual(
      back.map((d) => d.key),
      ['a', 'b'],
    );
    assert.equal(back[0].description, 'Ünïcödé “quotes”');
  });

  it('treats the fetch window as authoritative and keeps documents outside it', () => {
    const existing = [
      doc({ key: 'old', received: '2026-11-01' }),
      doc({ key: 'withdrawn', received: '2026-11-10' }),
      doc({ key: 'edited', received: '2026-11-12', documentTitle: 'Old title' }),
    ];
    const fetched = [
      doc({ key: 'edited', received: '2026-11-12', documentTitle: 'New title' }),
      doc({ key: 'new', received: '2026-11-17' }),
    ];
    const r = mergeWindow(existing, fetched, '2026-11-05', '2026-11-18');
    assert.equal(r.changed, true);
    assert.deepEqual(r.docs.map((d) => d.key).sort(), ['edited', 'new', 'old']);
    assert.equal(r.docs.find((d) => d.key === 'edited')?.documentTitle, 'New title');
  });

  it('reports no change when the window is identical', () => {
    const a = doc({ key: 'a', received: '2026-11-10' });
    assert.equal(mergeWindow([a], [{ ...a }], '2026-11-01', '2026-11-18').changed, false);
  });
});
