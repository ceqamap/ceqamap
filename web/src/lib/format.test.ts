import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { daysUntil, formatDate, placeLine, reviewCountdown, splitFacts, timeAgo, todayInCalifornia } from './format.ts';

describe('format', () => {
  it('formats ISO dates without timezone drift', () => {
    assert.equal(formatDate('2026-11-03'), 'Nov 3, 2026');
    assert.equal(formatDate(null), '');
  });
  it('counts days to a deadline', () => {
    assert.equal(daysUntil('2026-12-18', '2026-11-18'), 30);
    assert.equal(reviewCountdown('2026-11-18', '2026-11-18'), 'Comments due today');
    assert.equal(reviewCountdown('2026-11-19', '2026-11-18'), 'Comments due tomorrow');
    assert.equal(reviewCountdown('2026-12-18', '2026-11-18'), 'Comments due Dec 18, 2026 · 30 days left');
    assert.equal(reviewCountdown('2026-11-01', '2026-11-18'), 'Comment period has closed');
  });
  it('describes elapsed time', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    assert.equal(timeAgo('2026-11-18T11:59:30Z', now), 'just now');
    assert.equal(timeAgo('2026-11-18T11:00:00Z', now), '1 hour ago');
    assert.equal(timeAgo('2026-11-18T09:00:00Z', now), '3 hours ago');
    assert.equal(timeAgo('2026-11-17T10:00:00Z', now), 'yesterday');
  });
  it('uses California time for today', () => {
    assert.equal(todayInCalifornia(new Date('2026-11-19T06:30:00Z')), '2026-11-18');
  });
  it('builds a readable place line', () => {
    assert.equal(placeLine(['Redding'], ['Shasta']), 'Redding');
    assert.equal(placeLine([], ['Shasta']), 'Shasta County');
    assert.equal(placeLine([], ['Kern', 'Tulare']), 'Kern and Tulare counties');
    assert.equal(placeLine(['a', 'b', 'c', 'd'], ['x', 'y', 'z']), '3 counties');
  });
  it('splits fact lists but not inside parentheses', () => {
    assert.deepEqual(splitFacts('Other (Courthouse, Demolition), Redevelopment'), [
      'Other (Courthouse, Demolition)',
      'Redevelopment',
    ]);
  });
});
