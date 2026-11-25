import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BasemapWatch, FAILURES_TO_TRIP, WINDOW_MS } from './basemapWatch.ts';

describe('BasemapWatch', () => {
  const setup = () => {
    let downs = 0;
    const w = new BasemapWatch(['projects'], () => downs++);
    return { w, downs: () => downs };
  };

  it('trips when the tile index fails (OpenFreeMap 503, 2026-11-24)', () => {
    const { w, downs } = setup();
    assert.equal(w.report({ sourceId: 'openmaptiles', error: { status: 503 } }), true);
    assert.equal(downs(), 1);
    // Once per style.
    w.report({ sourceId: 'openmaptiles', error: { status: 503 } });
    assert.equal(downs(), 1);
    w.reset();
    w.report({ sourceId: 'openmaptiles', error: { status: 503 } });
    assert.equal(downs(), 2);
  });

  it('ignores our own sources and errors without a source', () => {
    const { w, downs } = setup();
    w.report({ sourceId: 'projects', error: { status: 503 } });
    w.report({ error: { status: 503 } });
    assert.equal(downs(), 0);
  });

  it('tolerates a few missing tiles, but not a stream of server errors', () => {
    const { w, downs } = setup();
    for (let i = 0; i < 10; i++) w.report({ sourceId: 'openmaptiles', tile: {}, error: { status: 404 } }, i);
    assert.equal(downs(), 0);
    for (let i = 0; i < FAILURES_TO_TRIP - 1; i++)
      w.report({ sourceId: 'openmaptiles', tile: {}, error: { status: 502 } }, i * WINDOW_MS);
    assert.equal(downs(), 0, 'spread out over time');
    for (let i = 0; i < FAILURES_TO_TRIP; i++)
      w.report({ sourceId: 'openmaptiles', tile: {}, error: { status: 0 } }, 1e6 + i);
    assert.equal(downs(), 1);
  });
});
