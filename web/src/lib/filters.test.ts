import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PublishedMeta } from '../../../packages/shared/src/index.ts';
import { ALL_STAGES, filterParams, nextStages, readScope, readStages, scopeCounts, shownCount } from './filters.ts';
import { cubicBezier, PING_MS, pingDelay, pingProgress } from './motion.ts';

const q = (s: string) => new URLSearchParams(s);

describe('filter URL state', () => {
  it('defaults to the past 12 months and every stage', () => {
    assert.equal(readScope(q('')), '12m');
    assert.equal(readScope(q('t=bogus')), '12m');
    assert.deepEqual(readStages(q('')), ALL_STAGES);
  });

  it('reads stages in legend order and ignores unknown ids', () => {
    assert.deepEqual(readStages(q('t=30d&stages=scoping,nope,in_review')), ['in_review', 'scoping']);
    assert.deepEqual(readStages(q('stages=')), []);
  });

  it('omits defaults when writing', () => {
    assert.deepEqual(filterParams('12m', [...ALL_STAGES]), { t: null, stages: null });
    assert.deepEqual(filterParams('all', ['scoping', 'in_review']), { t: 'all', stages: 'in_review,scoping' });
  });
});

describe('legend clicks', () => {
  it('toggles a stage, keeping legend order', () => {
    assert.deepEqual(nextStages(['in_review', 'approved'], 'approved', false), ['in_review']);
    assert.deepEqual(nextStages(['approved'], 'in_review', false), ['in_review', 'approved']);
  });

  it('solos a stage with Alt, and a second Alt-click shows everything again', () => {
    assert.deepEqual(nextStages([...ALL_STAGES], 'scoping', true), ['scoping']);
    assert.deepEqual(nextStages(['scoping'], 'scoping', true), ALL_STAGES);
  });
});

describe('counts', () => {
  const byStatus = { in_review: 5, scoping: 10, review_closed: 20, approved: 30, exempt: 100, other: 1 };
  const meta = {
    counts: {
      mapped: 200,
      byStatus: { ...byStatus, exempt: 1000 },
      byPrecision: { exact: 1, address: 1, intersection: 2, street: 1, zip: 1, city: 1, county: 1, region: 1 },
    },
    scopes: {
      '12m': { tiles: 't', mapped: 166, byStatus, byMark: { exact: 1, intersection: 2, approx: 3 } },
    },
  } as unknown as PublishedMeta;

  it('counts what the map shows for the window and stages', () => {
    assert.equal(shownCount(meta, '12m', [...ALL_STAGES]), 166);
    assert.equal(shownCount(meta, '12m', ['in_review', 'scoping']), 15);
  });

  it('falls back to all-time counts for data built before windows', () => {
    const old = { ...meta, scopes: undefined } as PublishedMeta;
    assert.equal(shownCount(old, '12m', [...ALL_STAGES]), 200);
    assert.deepEqual(scopeCounts(old, '12m').byMark, { exact: 2, intersection: 2, approx: 5 });
  });
});

describe('ping motion', () => {
  it('follows the CSS easing curve', () => {
    const linear = cubicBezier(0, 0, 1, 1);
    assert.ok(Math.abs(linear(0.3) - 0.3) < 1e-4);
    assert.equal(pingProgress(0), 0);
    assert.ok(pingProgress(PING_MS / 2) > 0.8); // the --ease curve front-loads the motion
  });

  it('aligns a newly started CSS ping with the shared clock', () => {
    assert.equal(pingDelay(PING_MS * 3 + 600), '-600ms');
  });
});
