import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toArea } from '../src/lib/boundaries.ts';
import type { Ring } from '../src/lib/geometry.ts';
import { buildRoadIndex, findIntersection } from '../src/lib/intersections.ts';
import type { ShapefileFeature } from '../src/lib/shapefile.ts';
import { parseCrossStreets, streetKeys } from '../src/lib/streets.ts';

describe('streetKeys', () => {
  const same = (a: string, b: string) => assert.equal(streetKeys(a)?.full, streetKeys(b)?.full, `${a} vs ${b}`);
  it('matches CEQAnet spellings to TIGER names', () => {
    same('Olive Mill Rd.', 'Olive Mill Rd');
    same('Hot Springs Road', 'Hot Springs Rd');
    same('North First Street', 'N 1st St');
    same('St. Helena Hwy', 'St Helena Highway');
    same('Mt. Diablo Blvd', 'Mount Diablo Boulevard');
  });
  it('treats state routes, US highways and "Highway N" as the same road', () => {
    same('SR-1', 'State Rte 1');
    same('Hwy 101', 'US Hwy 101');
    same('Highway 99', 'State Rte 99');
    same('Interstate 5', 'I- 5');
    assert.notEqual(streetKeys('I-5')?.full, streetKeys('SR 5')?.full);
  });
  it('knows common local names and abbreviations', () => {
    same('PCH', 'State Rte 1');
    same('Pacific Coast Highway', 'State Rte 1');
    same('El Camino', 'El Camino Real');
    same('Trade Center Drv', 'Trade Center Dr');
    same('SR 299E', 'State Rte 299');
  });

  it('drops the suffix and direction for a fallback key', () => {
    assert.equal(streetKeys('Olive Mill')?.base, streetKeys('Olive Mill Rd')?.base);
    assert.equal(streetKeys('W Main St')?.base, 'main');
  });
  it('rejects fragments that are not street names', () => {
    assert.equal(streetKeys('St'), null);
    assert.equal(streetKeys('123'), null);
  });
});

describe('parseCrossStreets', () => {
  it('splits the common forms', () => {
    assert.deepEqual(parseCrossStreets('Olive Mill Rd. and Hot Springs Road'), ['Olive Mill Rd.', 'Hot Springs Road']);
    assert.deepEqual(parseCrossStreets('SR-1 / Main St'), ['SR-1', 'Main St']);
    assert.deepEqual(parseCrossStreets('Hwy 101 & Old Redwood Highway'), ['Hwy 101', 'Old Redwood Highway']);
    assert.deepEqual(parseCrossStreets('Intersection of N. First St. and Elm Ave'), ['N. First St.', 'Elm Ave']);
    assert.deepEqual(parseCrossStreets('Elm Ave between 3rd St and 5th St'), ['Elm Ave', '3rd St', '5th St']);
  });
  it('returns nothing for vague or single-street entries', () => {
    assert.deepEqual(parseCrossStreets('Various'), []);
    assert.deepEqual(parseCrossStreets('N/A'), []);
    assert.deepEqual(parseCrossStreets('Countywide'), []);
    assert.deepEqual(parseCrossStreets('Main Street'), []);
    assert.deepEqual(parseCrossStreets(''), []);
  });
});

describe('findIntersection', () => {
  // A tiny road network: Olive Mill Rd (north-south) meets Hot Springs Rd at
  // (-119.63, 34.43). A second "Main St" / "1st St" pair exists in two towns.
  const road = (name: string, ...pts: [number, number][]): ShapefileFeature => ({
    properties: { FULLNAME: name },
    shape: [pts],
  });
  const roads = [
    road('Olive Mill Rd', [-119.63, 34.42], [-119.63, 34.43], [-119.63, 34.44]),
    road('Hot Springs Rd', [-119.64, 34.43], [-119.63, 34.43], [-119.62, 34.435]),
    road('Main St', [-120.0, 35.0], [-120.0, 35.01]),
    road('1st St', [-120.01, 35.0], [-120.0, 35.0]),
    road('Main St', [-121.0, 36.0], [-121.0, 36.01]),
    road('1st St', [-121.01, 36.0], [-121.0, 36.0]),
  ];
  const wanted = new Set(['olive mill rd', 'olive mill', 'hot springs rd', 'hot springs', 'main st', 'main', '1st st', '1st']);
  const index = buildRoadIndex(roads, wanted);
  const rect = (w: number, s: number, e: number, n: number): Ring => [[w, s], [e, s], [e, n], [w, n], [w, s]];

  it('matches a name with or without a leading direction (Olive Ave vs W Olive Ave)', () => {
    const idx = buildRoadIndex(
      [
        road('W Olive Ave', [-118.34, 34.18], [-118.33, 34.18], [-118.32, 34.18]),
        road('Olive Ave', [-117.0, 33.0], [-117.0, 33.1]), // a different Olive Ave elsewhere
        road('Hollywood Way', [-118.33, 34.17], [-118.33, 34.18], [-118.33, 34.19]),
      ],
      new Set(['olive ave', 'olive', 'hollywood way', 'hollywood']),
    );
    const r = findIntersection(idx, ['OLIVE AVE', 'HOLLYWOOD WAY'], {});
    assert.equal(r.ok && r.lat, 34.18);
  });

  it('prefers the exact name over a different road type with the same base name', () => {
    const idx = buildRoadIndex(
      [
        road('Olive Ave', [-118.0, 34.0], [-118.0, 34.1]),
        road('Olive St', [-118.2, 34.0], [-118.2, 34.1]),
        road('Cherry Ln', [-118.3, 34.05], [-117.9, 34.05]),
      ],
      new Set(['olive st', 'olive', 'cherry ln', 'cherry']),
    );
    const r = findIntersection(idx, ['Olive St', 'Cherry Ln'], {});
    assert.equal(r.ok && r.lon, -118.2);
  });

  it('finds crossings with no shared vertex (overpasses)', () => {
    const idx = buildRoadIndex(
      [road('US Hwy 101', [-122.0, 37.0], [-122.0, 37.2]), road('Becker Ln', [-122.1, 37.1], [-121.9, 37.1])],
      new Set(['rte 101', 'becker ln', 'becker']),
    );
    const r = findIntersection(idx, ['Highway 101', 'Becker Lane'], {});
    assert.ok(r.ok);
    assert.ok(Math.abs((r as { lat: number }).lat - 37.1) < 1e-9);
  });

  it('accepts a single crossing just outside the listed city', () => {
    const city = toArea('Near', [rect(-119.7, 34.3, -119.65, 34.35)]);
    const r = findIntersection(index, ['Olive Mill Rd', 'Hot Springs Rd'], { city });
    assert.ok(r.ok);
  });

  it('finds the shared vertex of two named roads', () => {
    const r = findIntersection(index, ['Olive Mill Rd.', 'Hot Springs Road'], {});
    assert.deepEqual(r, { ok: true, lon: -119.63, lat: 34.43, streets: ['Olive Mill Rd.', 'Hot Springs Road'] });
  });

  it('refuses to guess between far-apart crossings with no city to decide', () => {
    assert.deepEqual(findIntersection(index, ['Main St', '1st St'], {}), { ok: false, reason: 'ambiguous' });
  });

  it('uses the listed city to pick the right crossing', () => {
    const city = toArea('Town B', [rect(-121.05, 35.95, -120.95, 36.05)]);
    const r = findIntersection(index, ['Main Street', 'First Street'], { city });
    assert.equal(r.ok && r.lon, -121.0);
  });

  it('reports why it failed', () => {
    assert.deepEqual(findIntersection(index, ['Nowhere Rd', 'Hot Springs Rd'], {}), {
      ok: false,
      reason: 'street-not-found',
    });
    assert.deepEqual(findIntersection(index, ['Olive Mill Rd', 'Main St'], {}), { ok: false, reason: 'no-crossing' });
    const far = toArea('Far', [rect(-118.1, 33.9, -118.0, 34.0)]);
    assert.deepEqual(findIntersection(index, ['Olive Mill Rd', 'Hot Springs Rd'], { city: far }), {
      ok: false,
      reason: 'outside-area',
    });
  });
});
