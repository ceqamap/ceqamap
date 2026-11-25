import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  inScope,
  narrowestScopeFor,
  type PublishedProject,
  scopeStart,
  stageFlags,
  type TilePointProperties,
} from '../../packages/shared/src/index.ts';
import type { PointFeature } from '../src/lib/aggregate.ts';
import {
  approximateArrivals,
  ARRIVALS_MAX_AGE_DAYS,
  MAX_ARRIVALS,
  nextArrivals,
  summarizeArrivals,
} from '../src/lib/arrivals.ts';
import { mergeWindow } from '../src/lib/partitions.ts';
import { splitByScope } from '../src/lib/scopes.ts';
import { buildIdOf, tilesetName, tilesetsToPrune } from '../src/lib/tilesets.ts';
import { doc } from './helpers.ts';

const TODAY = '2026-11-20';

function project(sch: string, lon: number | null = -122.4, lat = 40.6): PublishedProject {
  return {
    sch,
    title: 'T',
    leadAgency: '',
    description: '',
    status: 'scoping',
    statusDate: TODAY,
    reviewEnd: null,
    location:
      lon === null
        ? null
        : {
            lon,
            lat,
            precision: 'exact',
            cities: [],
            counties: [],
            crossStreets: null,
            zip: null,
            coordinatesRejected: false,
          },
    facts: { totalAcres: null, developmentTypes: null, localActions: null, projectIssues: null, exemptStatus: null },
    documents: [],
    ceqanetUrl: '',
    builtAt: '',
  };
}

describe('mergeWindow arrivals', () => {
  it('reports only keys it has never stored', () => {
    const existing = [doc({ key: 'a', received: '2026-11-10' }), doc({ key: 'b', received: '2026-11-11' })];
    const fetched = [
      doc({ key: 'a', received: '2026-11-10', documentTitle: 'edited' }), // edit, not an arrival
      doc({ key: 'b', received: '2026-11-11' }),
      doc({ key: 'c', received: '2026-11-12' }),
    ];
    const r = mergeWindow(existing, fetched, '2026-11-01', '2026-11-20');
    assert.deepEqual(
      r.added.map((d) => d.key),
      ['c'],
    );
  });
});

describe('nextArrivals', () => {
  it('keeps the previous batch when nothing is new', () => {
    assert.equal(nextArrivals([], '2026-11-20T18:17:00Z'), null);
  });

  it('saves a normal batch', () => {
    const r = nextArrivals([doc({ key: 'x', sch: '2026110001', type: 'NOD' })], '2026-11-20T18:17:00Z');
    assert.deepEqual(r, { at: '2026-11-20T18:17:00Z', docs: [{ key: 'x', sch: '2026110001', type: 'NOD' }] });
  });

  it('clears the pings on a bulk change instead of pinging hundreds of projects', () => {
    const many = Array.from({ length: MAX_ARRIVALS + 1 }, (_, i) => doc({ key: `k${i}` }));
    const r = nextArrivals(many, '2026-11-20T18:17:00Z');
    assert.deepEqual(r?.docs, []);
    assert.equal(r?.skipped, MAX_ARRIVALS + 1);
  });
});

describe('summarizeArrivals', () => {
  const now = new Date('2026-11-20T20:00:00Z');
  const oldDoc = doc({ key: 'old', sch: '2025010001', type: 'NOP', received: '2025-01-10' });
  const newNod = doc({ key: 'nod', sch: '2025010001', type: 'NOD', received: '2026-11-19' });
  const brandNew = doc({ key: 'noe', sch: '2026110002', type: 'NOE', received: '2026-11-18' });
  const unmapped = doc({ key: 'u', sch: '2026110003', type: 'NOE', received: '2026-11-18' });
  const groups = new Map([
    ['2025010001', [oldDoc, newNod]],
    ['2026110002', [brandNew]],
    ['2026110003', [unmapped]],
  ]);
  const projects = new Map([
    ['2025010001', project('2025010001')],
    ['2026110002', project('2026110002', -118.2, 34.0)],
    ['2026110003', project('2026110003', null)],
  ]);
  const stored = {
    at: '2026-11-20T18:17:00Z',
    docs: [
      { key: 'nod', sch: '2025010001', type: 'NOD' },
      { key: 'noe', sch: '2026110002', type: 'NOE' },
      { key: 'u', sch: '2026110003', type: 'NOE' },
      { key: 'gone', sch: '2026110009', type: 'NOE' }, // withdrawn since
    ],
  };

  it('tells new projects from new filings on existing ones', () => {
    const r = summarizeArrivals(stored, groups, projects, now);
    assert.equal(r.flags.get('2025010001'), 1);
    assert.equal(r.flags.get('2026110002'), 2);
    assert.equal(r.flags.has('2026110009'), false);
    assert.equal(r.published?.projects, 2);
    assert.equal(r.published?.filings, 1);
    const nod = r.published?.items.find((i) => i.id === '2025010001');
    assert.equal(nod?.kind, 'filing');
    assert.equal(nod?.typeLabel, 'Notice of Determination');
    assert.equal(r.published?.items.find((i) => i.id === '2026110003')?.lon, null);
  });

  it('puts projects taking comments first, soonest deadline first', () => {
    const review = (sch: string, reviewEnd: string) => ({
      ...project(sch, -120, 37),
      status: 'in_review' as const,
      reviewEnd,
    });
    const docs = ['2026110010', '2026110011', '2026110012', '2026110013'].map((sch) =>
      doc({ key: sch, sch, type: 'NOP', received: '2026-11-19' }),
    );
    const r = summarizeArrivals(
      { at: stored.at, docs: docs.map((d) => ({ key: d.key, sch: d.sch, type: d.type })) },
      new Map(docs.map((d) => [d.sch, [d]])),
      new Map([
        ['2026110010', project('2026110010', -120, 37)],
        ['2026110011', review('2026110011', '2026-12-20')],
        ['2026110012', project('2026110012', -120, 37)],
        ['2026110013', review('2026110013', '2026-12-05')],
      ]),
      now,
    );
    assert.deepEqual(
      r.published?.items.map((i) => i.id),
      ['2026110013', '2026110011', '2026110010', '2026110012'],
    );
  });

  it('stops pinging a stale batch', () => {
    const later = new Date(Date.parse(stored.at) + (ARRIVALS_MAX_AGE_DAYS + 1) * 86_400_000);
    const r = summarizeArrivals(stored, groups, projects, later);
    assert.equal(r.published, null);
    assert.equal(r.flags.size, 0);
  });

  it('publishes nothing for an empty or missing batch', () => {
    assert.equal(summarizeArrivals(null, groups, projects, now).published, null);
    assert.equal(summarizeArrivals({ at: stored.at, docs: [], skipped: 900 }, groups, projects, now).published, null);
  });
});

describe('approximateArrivals', () => {
  it('uses the most recent posting day, ignoring future-dated typos', () => {
    const docs = [
      doc({ key: 'a', posted: '2026-11-18' }),
      doc({ key: 'b', posted: '2026-11-19' }),
      doc({ key: 'c', posted: '2026-11-19' }),
      doc({ key: 'd', posted: '2027-01-01' }),
      doc({ key: 'e', posted: null }),
    ];
    const r = approximateArrivals(docs, TODAY);
    assert.deepEqual(r?.docs.map((d) => d.key).sort(), ['b', 'c']);
    assert.equal(r?.approximate, true);
    assert.equal(r?.at.slice(0, 10), '2026-11-19');
  });
});

describe('time windows', () => {
  it('computes inclusive window starts', () => {
    assert.equal(scopeStart('30d', TODAY), '2026-10-22');
    assert.equal(scopeStart('12m', TODAY), '2025-11-21');
    assert.equal(scopeStart('all', TODAY), null);
  });

  it('keeps open reviews and arrivals in every window', () => {
    assert.equal(inScope('30d', TODAY, { lastFiling: '2026-09-01', status: 'in_review' }), true);
    assert.equal(inScope('30d', TODAY, { lastFiling: '2026-09-01', status: 'exempt', arrived: true }), true);
    assert.equal(inScope('30d', TODAY, { lastFiling: '2026-09-01', status: 'exempt' }), false);
    assert.equal(inScope('12m', TODAY, { lastFiling: '2026-09-01', status: 'exempt' }), true);
  });

  it('picks the narrowest window that shows a project', () => {
    assert.equal(narrowestScopeFor(TODAY, { lastFiling: '2026-11-01', status: 'approved' }), '30d');
    assert.equal(narrowestScopeFor(TODAY, { lastFiling: '2024-06-01', status: 'approved' }), '5y');
    assert.equal(narrowestScopeFor(TODAY, { lastFiling: '1998-06-01', status: 'review_closed' }), 'all');
  });

  it('splits points and counts them per window', () => {
    const point = (id: string, s: TilePointProperties['s'], x: 0 | 1 | 2, n: 0 | 1 = 0): PointFeature => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122, 40] },
      properties: { id, t: id, s, x, r: s === 'in_review' ? 1 : 0, n, ...stageFlags(s) },
    });
    const points = [
      point('recent', 'exempt', 1),
      point('lastyear', 'approved', 0),
      point('ancient', 'review_closed', 2),
      point('open', 'in_review', 0),
      point('late', 'approved', 1, 1),
    ];
    const lastFiling = new Map([
      ['recent', '2026-11-10'],
      ['lastyear', '2026-03-01'],
      ['ancient', '1999-01-01'],
      ['open', '2026-09-15'],
      ['late', '2026-08-01'],
    ]);
    const s = splitByScope(points, lastFiling, TODAY);
    assert.deepEqual(
      s['30d'].points.map((p) => p.properties.id),
      ['recent', 'open', 'late'],
    );
    assert.equal(s['12m'].counts.mapped, 4);
    assert.equal(s.all.counts.mapped, 5);
    assert.deepEqual(s.all.counts.byMark, { exact: 2, intersection: 1, approx: 2 });
    assert.equal(s['30d'].counts.byStatus.in_review, 1);
    assert.equal(s['30d'].counts.byStatus.approved, 1);
  });
});

describe('tilesets', () => {
  it('names and parses tilesets, old and new', () => {
    assert.equal(tilesetName('20261120181700', '12m'), 'projects-20261120181700-12m.pmtiles');
    assert.equal(buildIdOf('data/tiles/projects-20261120181700-12m.pmtiles'), '20261120181700');
    assert.equal(buildIdOf('data/tiles/projects-20261119000000.pmtiles'), '20261119000000');
    assert.equal(buildIdOf('data/tiles/other.pmtiles'), null);
  });

  it('prunes whole builds, keeping the newest few and the current one', () => {
    const keys = [
      'data/tiles/projects-20261118000000.pmtiles',
      'data/tiles/projects-20261119000000-all.pmtiles',
      'data/tiles/projects-20261119000000-12m.pmtiles',
      'data/tiles/projects-20261120000000-all.pmtiles',
      'data/tiles/projects-20261120000000-12m.pmtiles',
    ];
    assert.deepEqual(tilesetsToPrune(keys, 2, '20261120000000'), ['data/tiles/projects-20261118000000.pmtiles']);
    assert.deepEqual(tilesetsToPrune(keys, 1, '20261120000000'), keys.slice(0, 3));
  });
});
