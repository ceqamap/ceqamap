import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toArea } from '../src/lib/boundaries.ts';
import type { Ring } from '../src/lib/geometry.ts';
import { buildRoadIndex } from '../src/lib/intersections.ts';
import { buildRoadGrid, type LineRequest, resolveLines, routeNames, textLines } from '../src/lib/namedLines.ts';
import { placeAtPostmiles, postmileMentions, type PostmileTable } from '../src/lib/postmiles.ts';
import type { ShapefileFeature } from '../src/lib/shapefile.ts';
import { streetKeys } from '../src/lib/streets.ts';

const rect = (w: number, s: number, e: number, n: number): Ring => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];
const line = (name: string, mtfcc: string, ...pts: [number, number][]): ShapefileFeature => ({
  properties: { FULLNAME: name, MTFCC: mtfcc },
  shape: [pts],
});

describe('textLines', () => {
  it('finds a route in a title (SCH 2026090885)', () => {
    const t = textLines(['Remove and Replace Concrete Median Barriers, Install Signs on SR-76']);
    assert.deepEqual(t.roads, ['SR-76']);
    assert.equal(streetKeys(t.roads[0])!.full, 'rte 76');
  });

  it('finds a creek and the crossing words (SCH 2026040250)', () => {
    const t = textLines([
      'Quiota Creek Crossing 0A Sediment Removal Project',
      'routine maintenance of aggraded sediments within Quiota Creek under, upstream, and downstream of the bottomless arch culvert-bridge known as Quiota Crossing 0A. Access to the streambed will be from an adjacent ranch road.',
    ]);
    assert.deepEqual(t.waters, ['Quiota Creek']);
    assert.deepEqual(t.roads, []);
    assert.equal(t.crossingWord, true);
  });

  it('reads streets in Title Case and all-caps text, stopping at connecting words', () => {
    assert.deepEqual(textLines(['widen State Route 76 from Melrose Drive to Interstate 15']).roads, [
      'State Route 76',
      'Interstate 15',
      'Melrose Drive',
    ]);
    assert.deepEqual(textLines(['WIDENING OF ALVARADO BLVD BETWEEN HORNER ST AND DYER ST']).roads, [
      'ALVARADO BLVD',
      'HORNER ST',
      'DYER ST',
    ]);
    assert.deepEqual(textLines(['access via the Existing Ranch Road']).roads, []);
  });

  it('keeps "Creek Road" a road and skips waterways that are city names', () => {
    const t = textLines(['repair Lewis Creek Road near Walnut Creek'], (k) => k === 'walnut creek');
    assert.deepEqual(t.roads, ['Lewis Creek Road']);
    assert.deepEqual(t.waters, []);
  });

  it('does not read project numbers or lowercase "i" as routes', () => {
    assert.deepEqual(routeNames('MODIFY DEXTER BUILDING SR 89-007'), []);
    assert.deepEqual(routeNames('Route 71 Improvements Route 10 to Route 91'), ['Route 71', 'Route 10', 'Route 91']);
    assert.deepEqual(routeNames('north of I-80 and US 101'), ['I-80', 'US 101']);
  });
});

describe('resolveLines', () => {
  const county = toArea('County', [rect(-121, 34, -119, 37)])!;
  const area = { city: null, county };
  const request = (r: Partial<LineRequest>): LineRequest => ({
    sch: '2026000001',
    roads: [],
    waters: [],
    crossingWord: false,
    places: [],
    city: null,
    counties: ['county'],
    ...r,
  });
  const index = (features: ShapefileFeature[], names: string[]) =>
    buildRoadIndex(features, new Set(names.flatMap((n) => [streetKeys(n)!.full, streetKeys(n)!.nodir])));

  it('places a creek at its one road crossing, naming the road', () => {
    const water = [line('Quiota Crk', 'H3010', [-120.1, 34.5], [-120.1, 34.6])];
    const roads = [
      line('N Refugio Rd', 'S1400', [-120.12, 34.55], [-120.08, 34.55]),
      line('Driveway', 'S1740', [-120.12, 34.58], [-120.08, 34.58]), // private: not a crossing
    ];
    const r = resolveLines(
      request({ waters: ['Quiota Creek'], crossingWord: true }),
      area,
      index(roads, []),
      index(water, ['Quiota Creek']),
      () => buildRoadGrid(roads),
    );
    assert.ok(r.ok);
    assert.equal(r.placement.kind, 'crossing');
    assert.deepEqual(r.placement.kind === 'crossing' && r.placement.names, ['Quiota Creek', 'N Refugio Rd']);
    assert.ok(Math.abs(r.placement.lat - 34.55) < 1e-9);
  });

  it('falls back to a spot along a short creek when its road crossings are spread out', () => {
    const water = [line('Quiota Crk', 'H3010', [-120.1, 34.5], [-120.1, 34.6])];
    const roads = [
      line('Refugio Rd', 'S1400', [-120.12, 34.51], [-120.08, 34.51]),
      line('Refugio Rd', 'S1400', [-120.12, 34.59], [-120.08, 34.59]), // ~9 km away
    ];
    const r = resolveLines(
      request({ waters: ['Quiota Creek'], crossingWord: true }),
      area,
      index(roads, []),
      index(water, ['Quiota Creek']),
      () => buildRoadGrid(roads),
    );
    assert.ok(r.ok);
    assert.equal(r.placement.kind, 'along');
    assert.ok(Math.abs(r.placement.lon - -120.1) < 1e-9);
  });

  it('places a route and a named street at their crossing', () => {
    const roads = [
      line('State Rte 76', 'S1200', [-117.4, 33.2], [-117.2, 33.25]),
      line('Melrose Dr', 'S1400', [-117.3, 33.1], [-117.3, 33.3]),
    ];
    const r = resolveLines(
      request({ roads: ['SR-76', 'Melrose Drive'] }),
      { city: null, county: toArea('San Diego', [rect(-118, 32.5, -116, 33.5)])! },
      index(roads, ['SR-76', 'Melrose Drive']),
      null,
      () => buildRoadGrid(roads),
    );
    assert.ok(r.ok);
    assert.equal(r.placement.kind, 'crossing');
  });

  it('settles a same-name place with a named road (SCH 2026070843, Emigrant Pass)', () => {
    const roads = [line('Trona Wildrose Rd', 'S1400', [-117.25, 36.23], [-117.19, 36.27])];
    const r = resolveLines(
      request({
        roads: ['Trona Wildrose Road', 'Emigrant Pass Road'],
        places: [
          {
            name: 'Emigrant Pass',
            featureClass: 'Gap',
            rank: 2,
            candidates: [
              { lon: -117.1408925, lat: 36.3352247 },
              { lon: -116.0614091, lat: 35.8835789 },
            ],
          },
        ],
      }),
      { city: null, county: toArea('Inyo', [rect(-118.5, 35.7, -115.6, 37.5)])! },
      index(roads, ['Trona Wildrose Road']),
      null,
      () => buildRoadGrid(roads),
    );
    assert.ok(r.ok);
    assert.deepEqual(r.placement, {
      kind: 'place',
      lon: -117.1408925,
      lat: 36.3352247,
      name: 'Emigrant Pass',
      rank: 2,
    });
  });

  it('leaves a same-name place unsettled when both are near the named road', () => {
    const roads = [line('Long Rd', 'S1400', [-117.3, 36.0], [-117.0, 36.4])];
    const r = resolveLines(
      request({
        roads: ['Long Road'],
        places: [
          {
            name: 'Twin Peak',
            featureClass: 'Summit',
            rank: 2,
            candidates: [
              { lon: -117.25, lat: 36.05 },
              { lon: -117.05, lat: 36.35 },
            ],
          },
        ],
      }),
      { city: null, county: toArea('Inyo', [rect(-118.5, 35.7, -115.6, 37.5)])! },
      index(roads, ['Long Road']),
      null,
      () => buildRoadGrid(roads),
    );
    assert.notEqual(r.ok && r.placement.kind, 'place');
  });
});

describe('postmiles', () => {
  it('reads Caltrans postmiles tied to a route', () => {
    const text =
      'Caltrans proposes to prevent wrong way entrances onto SR 76. The area of concern is in San Diego County along SR 76 from PM R16.4 to R16.9.';
    assert.deepEqual(postmileMentions(text), [
      { route: 76, from: { prefix: 'R', pm: 16.4 }, to: { prefix: 'R', pm: 16.9 }, text: 'PM R16.4 to R16.9' },
    ]);
    assert.equal(postmileMentions('11-SD-76 PM 16.4/16.9')[0].county, 'SD');
    assert.equal(postmileMentions('Three bridges on State Route 3, bridge at post mile 27.09')[0].from.pm, 27.09);
  });

  it('ignores parcel maps and particulate matter', () => {
    assert.deepEqual(postmileMentions('IS 89-81/PM 89-24 CROSS SPRINGS RANCH LAND DIVISION'), []);
    assert.deepEqual(postmileMentions('Widen SR 99; PM10 and PM 2.5 emissions will be below thresholds'), []);
  });

  const table: PostmileTable = {
    source: 'test',
    routes: {
      'SD|76': Array.from(
        { length: 30 },
        (_, i) => ['R', 10 + i / 10, -117.1 + i * 0.002, 33.3] as [string, number, number, number],
      ),
    },
  };

  it('places a short range at its middle, in a listed county', () => {
    const r = placeAtPostmiles('along SR 76 from PM R11.0 to R11.4', ['San Diego'], table);
    assert.equal(r.kind, 'placed');
    assert.ok(r.kind === 'placed' && Math.abs(r.lon - (-117.1 + 12 * 0.002)) < 1e-9);
    assert.equal(r.kind === 'placed' && r.label, 'SR 76, PM R11–R11.4');
  });

  it('skips postmiles not on the route, in other counties, or without a route', () => {
    assert.equal(placeAtPostmiles('SR 76 PM R40.0', ['San Diego'], table).kind, 'not-found');
    assert.equal(placeAtPostmiles('SR 76 PM R11.0', ['Riverside'], table).kind, 'not-found');
    assert.equal(placeAtPostmiles('Parcel map PM 11.2', ['San Diego'], table).kind, 'none');
  });
});

describe('resolveLines: tributaries and repeats', () => {
  const county = toArea('County', [rect(-124, 39, -122, 41)])!;
  const area = { city: null, county };
  const keys = (names: string[]) => new Set(names.flatMap((n) => [streetKeys(n)!.full, streetKeys(n)!.nodir]));
  const base: LineRequest = {
    sch: '2004088511',
    roads: [],
    waters: [],
    crossingWord: false,
    places: [],
    city: null,
    counties: ['county'],
  };

  it('places a creek named as a tributary along the stretch that reaches the river, not at the mouth', () => {
    // Two "Tramp Creek"s; the one in two segments flows into the river at (-123.1, 39.8).
    const water = [
      line('Tramp Crk', 'H3010', [-123.15, 39.85], [-123.12, 39.82]),
      line('Tramp Crk', 'H3010', [-123.12, 39.82], [-123.1, 39.8]),
      line('Tramp Crk', 'H3010', [-122.5, 40.5], [-122.45, 40.5]),
      line('Middle Fork Eel Riv', 'H3010', [-123.2, 39.8], [-123.0, 39.8]),
    ];
    const r = resolveLines(
      { ...base, waters: ['Tramp Creek', 'Middle Fork Eel River'], crossingWord: true },
      area,
      buildRoadIndex([], new Set()),
      buildRoadIndex(water, keys(['Tramp Creek', 'Middle Fork Eel River'])),
      () => buildRoadGrid([]),
    );
    assert.ok(r.ok);
    assert.equal(r.placement.kind, 'along');
    assert.ok(r.placement.lon < -123.09 && r.placement.lon > -123.16, `${r.placement.lon}`);
  });

  it('does not pair a street with itself written two ways', () => {
    const roads = [
      line('Central Ave', 'S1400', [-123.0, 40.0], [-123.0, 40.02]),
      line('7th St', 'S1400', [-123.01, 40.01], [-122.99, 40.01]),
    ];
    const r = resolveLines(
      { ...base, roads: ['CENTRAL', 'CENTRAL AVENUE', '7TH STREET'] },
      area,
      buildRoadIndex(roads, keys(['CENTRAL', 'CENTRAL AVENUE', '7TH STREET'])),
      null,
      () => buildRoadGrid(roads),
    );
    assert.ok(r.ok);
    assert.equal(r.placement.kind, 'crossing');
    assert.deepEqual(r.placement.kind === 'crossing' && r.placement.names, ['CENTRAL', '7TH STREET']);
  });
});
