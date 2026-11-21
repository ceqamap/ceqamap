import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { type GeocodeCache, geocodeAll, parseBatchResponse, queryKey } from '../src/lib/geocode.ts';

const RESPONSE = [
  '"0","1234 Main St, Fresno, CA, ","Match","Exact","1234 MAIN ST, FRESNO, CA, 93721","-119.791,36.731","123","L"',
  '"1","9 Nowhere Ln, Fresno, CA, ","No_Match"',
  '"2","1 Elm St, , CA, 95814","Tie"',
].join('\n');

describe('parseBatchResponse', () => {
  it('reads matches and treats ties and misses as not found', () => {
    const r = parseBatchResponse(RESPONSE);
    assert.deepEqual(r.get('0'), { lon: -119.791, lat: 36.731 });
    assert.equal(r.get('1'), null);
    assert.equal(r.get('2'), null);
  });
});

describe('geocodeAll', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('sends only uncached queries and caches matches and misses', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(RESPONSE);
    }) as typeof fetch;
    const queries = [
      { street: '1234 Main St', city: 'Fresno', zip: '' },
      { street: '9 Nowhere Ln', city: 'Fresno', zip: '' },
      { street: '1 Elm St', city: '', zip: '95814' },
    ];
    const cache: GeocodeCache = {};
    const first = await geocodeAll(queries, cache, '2026-11-20');
    assert.equal(calls, 1);
    assert.equal(first.results.size, 1);
    assert.deepEqual(first.results.get(queryKey(queries[0])), { lon: -119.791, lat: 36.731 });
    assert.equal(Object.keys(cache).length, 3);

    const again = await geocodeAll(queries, cache, '2026-12-01');
    assert.equal(calls, 1, 'all cached');
    assert.equal(again.stats.newlySent, 0);

    // Misses are retried after six months.
    await geocodeAll(queries, cache, '2027-07-01');
    assert.equal(calls, 2);
  });
});
