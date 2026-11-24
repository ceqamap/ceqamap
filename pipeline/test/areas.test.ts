import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stageFlags } from '../../packages/shared/src/index.ts';
import { aggregate } from '../src/lib/aggregate.ts';
import {
  Anchors,
  areaTileFeatures,
  type AreaMember,
  boundaryFeatures,
  interiorPoint,
  spiralPosition,
  SPIRAL_STEP_M,
} from '../src/lib/areas.ts';
import { type Boundaries, toArea } from '../src/lib/boundaries.ts';
import { pointInShape, type Ring } from '../src/lib/geometry.ts';
import type { Gazetteer } from '../src/lib/landmarks.ts';
import { haversineKm, resolveLocation } from '../src/lib/location.ts';
import { doc } from './helpers.ts';

const rect = (w: number, s: number, e: number, n: number): Ring => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];
const area = (name: string, ...rings: Ring[]) => toArea(name, rings)!;
// An L-shaped city: its bounding-box center (-119.75, 36.75) is outside it.
const L: Ring = [
  [-120, 36.5],
  [-119.5, 36.5],
  [-119.5, 36.6],
  [-119.9, 36.6],
  [-119.9, 37],
  [-120, 37],
  [-120, 36.5],
];
const B: Boundaries = {
  places: {
    fresno: area('Fresno', rect(-119.9, 36.7, -119.7, 36.85)),
    clovis: area('Clovis', rect(-119.72, 36.8, -119.65, 36.86)),
    elbow: area('Elbow', L),
  },
  counties: {
    fresno: area('Fresno', rect(-120.9, 35.9, -118.36, 37.58)),
    inyo: area('Inyo', rect(-118.8, 35.78, -115.65, 37.47)),
  },
  zips: { '93721': area('93721', rect(-119.8, 36.72, -119.77, 36.75)) },
};
// One-word names live only in `towns` (see parseGnis).
const GNIS: Gazetteer = {
  source: 'test',
  names: {},
  towns: {
    fresno: [
      { n: 'City of Fresno', c: 'Civil', k: 'fresno', lon: -119.77, lat: 36.75 },
      { n: 'Fresno', c: 'Populated Place', k: 'fresno', lon: -119.7871, lat: 36.7378 },
    ],
    independence: [{ n: 'Independence', c: 'Populated Place', k: 'inyo', lon: -118.2001, lat: 36.8027 }],
  },
};

describe('resolveLocation areas', () => {
  it('records the area for city, ZIP code and county placements', () => {
    const city = resolveLocation('2026010001', [doc({ cities: ['Fresno'], counties: ['Fresno'] })], B);
    assert.deepEqual(city?.area, { kind: 'city', keys: ['fresno'], name: 'Fresno' });
    const two = resolveLocation('2026010002', [doc({ cities: ['Fresno', 'Clovis'], counties: ['Fresno'] })], B);
    assert.deepEqual(two?.area, { kind: 'city', keys: ['fresno', 'clovis'], name: 'Fresno and Clovis' });
    const zip = resolveLocation('2026010003', [doc({ cities: ['Fresno'], counties: ['Fresno'], zip: '93721' })], B);
    assert.deepEqual(zip?.area, { kind: 'zip', keys: ['93721'], name: '93721' });
    const county = resolveLocation('2026010004', [doc({ cities: [], counties: ['Inyo'] })], B);
    assert.deepEqual(county?.area, { kind: 'county', keys: ['inyo'], name: 'Inyo County' });
  });

  it('leaves the area out for placements of their own', () => {
    const exact = resolveLocation(
      '2026010005',
      [doc({ cities: ['Fresno'], counties: ['Fresno'], coordinates: '36.78, -119.8' })],
      B,
    );
    assert.equal(exact?.precision, 'exact');
    assert.equal(exact?.area, undefined);
  });
});

describe('anchors', () => {
  const anchors = new Anchors(B, GNIS);

  it("uses a city's own GNIS point, its downtown", () => {
    assert.deepEqual(anchors.city('fresno'), { lon: -119.7871, lat: 36.7378 });
  });

  it('falls back to the point deepest inside, never outside an odd shape', () => {
    const p = anchors.city('elbow')!;
    assert.ok(pointInShape(p.lon, p.lat, B.places.elbow.shape));
    const q = interiorPoint(B.places.elbow.shape, B.places.elbow.bbox);
    assert.deepEqual(p, q);
  });

  it('puts county badges at the county seat', () => {
    assert.deepEqual(anchors.countyBadge('fresno'), { lon: -119.7871, lat: 36.7378 });
    assert.deepEqual(anchors.countyBadge('inyo'), { lon: -118.2001, lat: 36.8027 });
  });
});

describe('spiral', () => {
  it('spaces dots evenly, newest in the middle', () => {
    const a = { lon: -119.7871, lat: 36.7378 };
    const pts = Array.from({ length: 200 }, (_, i) => spiralPosition(a, i));
    assert.ok(haversineKm(pts[0], a) < SPIRAL_STEP_M / 1000);
    let minGap = Infinity;
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) minGap = Math.min(minGap, haversineKm(pts[i], pts[j]));
    // Neighbors stay roughly a dot apart at zoom 11 (no two on top of each other).
    assert.ok(minGap > (SPIRAL_STEP_M / 1000) * 1.2, `min gap ${minGap}`);
    assert.ok(haversineKm(pts[199], a) < (SPIRAL_STEP_M / 1000) * Math.sqrt(200) * 1.01);
  });
});

describe('area tiles', () => {
  const anchors = new Anchors(B, GNIS);
  const member = (id: string, s: 'exempt' | 'in_review', latest: string, keys = ['fresno']): AreaMember => ({
    point: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { id, t: id, s, x: 0, r: s === 'in_review' ? 1 : 0, n: 0, ...stageFlags(s) },
    },
    area: { kind: 'city', keys, name: 'Fresno' },
    latest,
  });

  it('makes dots around the anchor, an area badge and a county badge with stage counts', () => {
    const f = areaTileFeatures(
      [
        member('a', 'exempt', '2026-01-01'),
        member('b', 'in_review', '2026-03-01'),
        member('c', 'exempt', '2026-02-01'),
      ],
      B,
      anchors,
    );
    const dots = f.filter((x) => x.properties.f === 'd');
    assert.deepEqual(
      dots.map((d) => d.properties.id),
      ['b', 'c', 'a'],
    );
    assert.deepEqual(dots[0].tippecanoe, { minzoom: 11 });
    assert.equal(dots[0].properties.an, 'Fresno');
    const badge = f.find((x) => x.properties.f === 'b')!;
    assert.deepEqual(badge.geometry.coordinates, [-119.7871, 36.7378]);
    assert.deepEqual(badge.tippecanoe, { minzoom: 8, maxzoom: 10 });
    assert.equal(badge.properties.total, 3);
    assert.equal(badge.properties.c_exempt, 2);
    assert.equal(badge.properties.c_in_review, 1);
    assert.equal(badge.properties.r, 1);
    const county = f.find((x) => x.properties.f === 'c')!;
    assert.equal(county.properties.an, 'Fresno County');
    assert.deepEqual(county.tippecanoe, { maxzoom: 7 });
    assert.equal(county.properties.total, 3);
  });

  it('emits outlines keyed like published areas', () => {
    const keys = [...boundaryFeatures(B)].map((l) => JSON.parse(l).properties.k);
    assert.ok(keys.includes('city:fresno') && keys.includes('zip:93721') && keys.includes('county:inyo'));
  });
});

describe('aggregate with anchors', () => {
  it('publishes the area and puts the point at its anchor', () => {
    const result = aggregate(
      [doc({ sch: '2026010009', cities: ['Fresno'], counties: ['Fresno'] })],
      B,
      '2026-11-24',
      '2026-11-24T00:00:00Z',
      { anchors: new Anchors(B, GNIS) },
    );
    const loc = result.projects[0].location!;
    assert.deepEqual(loc.area, {
      kind: 'city',
      name: 'Fresno',
      keys: ['city:fresno'],
      bbox: [-119.9, 36.7, -119.7, 36.85],
    });
    assert.deepEqual([loc.lon, loc.lat], [-119.7871, 36.7378]);
    assert.equal(loc.precision, 'city');
  });
});
