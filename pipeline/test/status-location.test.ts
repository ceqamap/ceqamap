import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregate, truncate } from '../src/lib/aggregate.ts';
import { normalizeRecord, splitList, toIsoDate } from '../src/lib/document.ts';
import { type Boundaries, normalizePlaceName, toArea } from '../src/lib/boundaries.ts';
import { pointInShape, type Ring } from '../src/lib/geometry.ts';
import { haversineKm, resolveLocation } from '../src/lib/location.ts';
import { deriveStatus } from '../src/lib/status.ts';
import { doc } from './helpers.ts';

const TODAY = '2026-11-18';

describe('deriveStatus', () => {
  it('marks an open comment period as in_review, regardless of document order', () => {
    const r = deriveStatus(
      [
        doc({ type: 'NOP', received: '2025-10-14' }),
        doc({ type: 'EIR', received: '2026-11-01', reviewStart: '2026-11-01', reviewEnd: '2026-12-15' }),
      ],
      TODAY,
    );
    assert.deepEqual(r, { status: 'in_review', date: '2026-11-01', reviewEnd: '2026-12-15' });
  });

  it('treats the last day of review as still open', () => {
    const r = deriveStatus([doc({ type: 'MND', reviewStart: '2026-10-19', reviewEnd: TODAY })], TODAY);
    assert.equal(r.status, 'in_review');
  });

  it('marks a closed review without a determination as review_closed', () => {
    const r = deriveStatus(
      [doc({ type: 'EIR', received: '2026-04-03', reviewStart: '2026-04-03', reviewEnd: '2026-05-18' })],
      TODAY,
    );
    assert.equal(r.status, 'review_closed');
  });

  it('marks a project with an NOD as approved', () => {
    const r = deriveStatus(
      [doc({ type: 'MND', received: '2025-01-01' }), doc({ type: 'NOD', received: '2025-03-01' })],
      TODAY,
    );
    assert.deepEqual(r, { status: 'approved', date: '2025-03-01', reviewEnd: null });
  });

  it('lets a newer supplemental EIR reopen an approved project', () => {
    const r = deriveStatus(
      [doc({ type: 'NOD', received: '2020-01-01' }), doc({ type: 'SIR', received: '2024-01-01' })],
      TODAY,
    );
    assert.equal(r.status, 'review_closed');
  });

  it('breaks same-day ties in favor of the later stage', () => {
    const r = deriveStatus(
      [doc({ type: 'NOD', received: '2025-03-01' }), doc({ type: 'FIN', received: '2025-03-01' })],
      TODAY,
    );
    assert.equal(r.status, 'approved');
  });

  it('marks NOE-only projects exempt and NOP-only projects scoping', () => {
    assert.equal(deriveStatus([doc({ type: 'NOE' })], TODAY).status, 'exempt');
    assert.equal(deriveStatus([doc({ type: 'NOP' })], TODAY).status, 'scoping');
  });

  it('falls back to other for administrative notices', () => {
    assert.equal(deriveStatus([doc({ type: 'FYI' }), doc({ type: 'CON' })], TODAY).status, 'other');
  });
});

describe('document normalization', () => {
  it('parses CEQAnet dates', () => {
    assert.equal(toIsoDate('10/14/2025'), '2025-10-14');
    assert.equal(toIsoDate('1/2/1999 12:00:00 AM'), '1999-01-02');
    assert.equal(toIsoDate('13/40/2025'), null);
    assert.equal(toIsoDate(''), null);
  });

  it('splits and dedupes place lists', () => {
    assert.deepEqual(splitList('Redding,  Anderson, Redding'), ['Redding', 'Anderson']);
  });

  it('uses the document URL as the key and rejects URLs for a different SCH', () => {
    const base = { 'SCH Number': '2025100575', Received: '10/14/2025', 'Document Type': 'NOP' };
    const a = normalizeRecord({ ...base, 'Document Portal URL': 'https://ceqanet.lci.ca.gov/2025100575/3' });
    assert.equal(a?.key, 'https://ceqanet.lci.ca.gov/2025100575/3');
    const b = normalizeRecord({ ...base, 'Document Portal URL': 'https://ceqanet.lci.ca.gov/2014051061/9' });
    assert.equal(b?.url, null);
    assert.match(b?.key ?? '', /^2025100575\|NOP\|2025-10-14/);
  });
});

// Miniature boundaries: simple rectangles standing in for Census outlines.
const rect = (w: number, s: number, e: number, n: number): Ring => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];
const area = (name: string, ...rings: Ring[]) => toArea(name, rings)!;
const B: Boundaries = {
  places: {
    redding: area('Redding', rect(-122.45, 40.53, -122.32, 40.65)),
    anderson: area('Anderson', rect(-122.33, 40.43, -122.27, 40.47)),
    'los angeles': area('Los Angeles', rect(-118.6, 33.75, -118.15, 34.3)),
    // Mainland plus a tiny island 40 km offshore, like San Francisco and the Farallones.
    'san francisco': area('San Francisco', rect(-122.51, 37.71, -122.36, 37.81), rect(-123.005, 37.695, -122.995, 37.705)),
  },
  counties: {
    shasta: area('Shasta', rect(-123.07, 40.29, -121.32, 41.19)),
    kern: area('Kern', rect(-120.19, 34.79, -117.62, 35.79)),
    tulare: area('Tulare', rect(-119.57, 35.79, -117.98, 36.75)),
    'del norte': area('Del Norte', rect(-124.25, 41.46, -123.52, 42.0)),
    mendocino: area('Mendocino', rect(-123.85, 38.76, -122.82, 40.0)),
    'san francisco': area('San Francisco', rect(-122.51, 37.71, -122.36, 37.81), rect(-123.005, 37.695, -122.995, 37.705)),
  },
};

describe('boundaries', () => {
  it('normalizes names across CEQAnet and Census spellings', () => {
    assert.equal(normalizePlaceName('City of Redding'), 'redding');
    assert.equal(normalizePlaceName('Redding city'), 'redding');
    assert.equal(normalizePlaceName('Shasta County'), 'shasta');
    assert.equal(normalizePlaceName('Cañada CDP'), 'canada');
    assert.equal(normalizePlaceName('St. Helena'), 'saint helena');
  });
});

describe('resolveLocation', () => {
  it('accepts typed coordinates inside the listed county', () => {
    const r = resolveLocation('x', [doc({ coordinates: `40°34'57"N 122°23'47"W`, counties: ['Shasta'] })], B);
    assert.equal(r?.precision, 'exact');
    assert.equal(r?.coordinatesRejected, false);
  });

  it('accepts coordinates just outside the county line (coastal and harbor work)', () => {
    // Shasta's west edge is -123.07; this is ~3 km west of it.
    const r = resolveLocation('x', [doc({ coordinates: '40.8, -123.105', counties: ['Shasta'] })], B);
    assert.equal(r?.precision, 'exact');
  });

  it('rejects a latitude typo that contradicts the listed county (Ukiah at 36° instead of 39°)', () => {
    const r = resolveLocation(
      '2024050310',
      [doc({ coordinates: `36°12'42"N 123°12'20"W`, cities: ['Nowhere'], counties: ['Mendocino'] })],
      B,
    )!;
    assert.equal(r.precision, 'county');
    assert.equal(r.coordinatesRejected, true);
    assert.ok(pointInShape(r.lon, r.lat, B.counties.mendocino.shape));
  });

  it('rejects coordinates far from the listed city even if inside its county (San Mateo, 122.565 for 122.315)', () => {
    const b2: Boundaries = {
      ...B,
      places: { ...B.places, 'san mateo': area('San Mateo', rect(-122.36, 37.53, -122.28, 37.59)) },
      counties: { ...B.counties, 'san mateo': area('San Mateo', rect(-122.52, 37.1, -122.1, 37.71)) },
    };
    const r = resolveLocation(
      '2016102067',
      [doc({ coordinates: '37.565, -122.565', cities: ['San Mateo'], counties: ['San Mateo'] })],
      b2,
    )!;
    assert.equal(r.precision, 'city');
    assert.equal(r.coordinatesRejected, true);
  });

  it('accepts coordinates a few km outside the listed city', () => {
    const r = resolveLocation('x', [doc({ coordinates: '40.70, -122.40', cities: ['Redding'] })], B);
    assert.equal(r?.precision, 'exact');
  });

  it('falls back to an older document whose coordinates are plausible', () => {
    const r = resolveLocation(
      'x',
      [doc({ coordinates: '36.2, -123.2', counties: ['Mendocino'] }), doc({ coordinates: '39.15, -123.2' })],
      B,
    );
    assert.equal(r?.precision, 'exact');
    assert.equal(r?.lat, 39.15);
  });

  it('with no county listed, rejects coordinates far from California', () => {
    const r = resolveLocation('x', [doc({ coordinates: '33.0, -126.5' })], B);
    assert.equal(r, null);
  });

  it('places single-city projects inside the city, deterministically', () => {
    const d = [doc({ cities: ['Redding'], counties: ['Shasta'] })];
    const a = resolveLocation('2025100575', d, B)!;
    assert.equal(a.precision, 'city');
    assert.deepEqual(a, resolveLocation('2025100575', d, B));
    assert.ok(pointInShape(a.lon, a.lat, B.places.redding.shape));
  });

  it('never puts San Francisco projects in the ocean or on its small offshore island', () => {
    for (let i = 0; i < 500; i++) {
      const r = resolveLocation(`2026${String(i).padStart(6, '0')}`, [doc({ cities: ['San Francisco'] })], B)!;
      assert.ok(pointInShape(r.lon, r.lat, B.places['san francisco'].shape));
      assert.ok(r.lon > -122.9, 'placed on the island');
    }
  });

  it('spreads consecutive SCH numbers apart instead of along a curve', () => {
    const pts = Array.from({ length: 300 }, (_, i) =>
      resolveLocation(`2026${String(i).padStart(6, '0')}`, [doc({ cities: ['Los Angeles'] })], B)!,
    );
    // Neighbors in SCH order should be about as far apart as random pairs, not adjacent.
    const step = pts.slice(1).map((p, i) => haversineKm(p, pts[i]));
    const meanStep = step.reduce((s, x) => s + x, 0) / step.length;
    assert.ok(meanStep > 10, `consecutive points average only ${meanStep.toFixed(1)} km apart`);
  });

  it('averages nearby cities and keeps the point inside one of them', () => {
    const r = resolveLocation('x', [doc({ cities: ['Redding', 'Anderson'] })], B)!;
    assert.equal(r.precision, 'city');
    assert.ok(
      pointInShape(r.lon, r.lat, B.places.redding.shape) || pointInShape(r.lon, r.lat, B.places.anderson.shape),
    );
  });

  it('falls back to county when the city is unknown, and treats unincorporated as no city', () => {
    assert.equal(
      resolveLocation('x', [doc({ cities: ['Nowhere Junction'], counties: ['Kern'] })], B)?.precision,
      'county',
    );
    assert.equal(
      resolveLocation('x', [doc({ cities: ['Unincorporated'], counties: ['Kern'] })], B)?.precision,
      'county',
    );
  });

  it('marks nearby multi-county projects as region', () => {
    assert.equal(resolveLocation('x', [doc({ counties: ['Kern', 'Tulare'] })], B)?.precision, 'region');
  });

  it('does not map far-apart or statewide projects', () => {
    assert.equal(resolveLocation('x', [doc({ counties: ['Kern', 'Del Norte'] })], B), null);
    assert.equal(resolveLocation('x', [doc({ counties: ['Kern', 'Tulare', 'Shasta', 'Del Norte'] })], B), null);
    assert.equal(resolveLocation('x', [doc({})], B), null);
  });
});

describe('aggregate', () => {
  it('groups documents into projects and counts everything', () => {
    const docs = [
      doc({ sch: '2025100575', type: 'NOP', received: '2025-10-14', cities: ['Redding'], projectTitle: 'Courthouse' }),
      doc({
        sch: '2025100575',
        type: 'EIR',
        received: '2026-11-03',
        reviewStart: '2026-11-03',
        reviewEnd: '2026-12-18',
        description: 'Demolish the old courthouse.',
        cities: ['Redding'],
      }),
      doc({
        sch: '2026110466',
        type: 'NOE',
        received: '2026-11-17',
        counties: ['Kern', 'Tulare', 'Shasta', 'Del Norte'],
      }),
    ];
    const r = aggregate(docs, B, TODAY, '2026-11-18T00:00:00Z');
    assert.equal(r.counts.projects, 2);
    assert.equal(r.counts.documents, 3);
    assert.equal(r.counts.mapped, 1);
    assert.equal(r.counts.unmapped, 1);
    assert.equal(r.counts.byStatus.in_review, 1);
    assert.equal(r.counts.byStatus.exempt, 1);
    assert.equal(r.latestReceived, '2026-11-17');

    const p = r.projects.find((x) => x.sch === '2025100575')!;
    assert.equal(p.description, 'Demolish the old courthouse.');
    assert.equal(p.reviewEnd, '2026-12-18');
    assert.deepEqual(
      p.documents.map((d) => d.type),
      ['EIR', 'NOP'],
    );
    assert.equal(r.points[0].properties.r, 1);
    assert.equal(r.points[0].properties.x, 0);
  });

  it('truncates hover titles on a word boundary-ish and collapses whitespace', () => {
    assert.equal(truncate('  a   b  ', 10), 'a b');
    assert.equal(truncate('x'.repeat(100), 10).length, 10);
  });
});
