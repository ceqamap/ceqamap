import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  areaKm2,
  bboxOf,
  distanceToShapeKm,
  pointInShape,
  type Ring,
  samplePointInShape,
  simplifyRing,
} from '../src/lib/geometry.ts';
import { seededRandom } from '../src/lib/random.ts';
import { readShapefile } from '../src/lib/shapefile.ts';

const square: Ring = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0],
];
// Wound opposite to the square, as shapefiles store holes.
const hole: Ring = [
  [0.4, 0.4],
  [0.4, 0.6],
  [0.6, 0.6],
  [0.6, 0.4],
  [0.4, 0.4],
];

describe('geometry', () => {
  it('tests points against shapes with holes', () => {
    assert.equal(pointInShape(0.2, 0.2, [square]), true);
    assert.equal(pointInShape(0.5, 0.5, [square, hole]), false);
    assert.equal(pointInShape(1.5, 0.5, [square]), false);
  });

  it('measures distance to a shape in km', () => {
    // 0.1° of longitude east of the square, at latitude 0.5 (~11.1 km).
    const d = distanceToShapeKm(1.1, 0.5, [square]);
    assert.ok(Math.abs(d - 11.13) < 0.1, `got ${d}`);
    assert.equal(distanceToShapeKm(0.5, 0.2, [square]), 0);
  });

  it('computes net area with holes subtracted', () => {
    const full = areaKm2([square]);
    const withHole = areaKm2([square, hole]);
    assert.ok(Math.abs(withHole / full - 0.96) < 0.01);
  });

  it('samples points only inside the shape, deterministically', () => {
    const shape = [square, hole];
    const a = seededRandom('seed');
    const b = seededRandom('seed');
    for (let i = 0; i < 200; i++) {
      const p = samplePointInShape(shape, bboxOf(shape), a)!;
      assert.ok(pointInShape(p.lon, p.lat, shape));
      assert.deepEqual(p, samplePointInShape(shape, bboxOf(shape), b));
    }
  });

  it('simplifies rings while keeping their corners', () => {
    const noisy: Ring = [[0, 0], [0.5, 0.00001], [1, 0], [1, 1], [0, 1], [0, 0]];
    assert.deepEqual(simplifyRing(noisy, 0.001), [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
  });
});

describe('seededRandom', () => {
  it('is uniform and uncorrelated across consecutive SCH numbers', () => {
    const us: number[] = [];
    const vs: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const r = seededRandom(`2026${String(i).padStart(6, '0')}`);
      us.push(r());
      vs.push(r());
    }
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const corr = (xs: number[], ys: number[]) => {
      const mx = mean(xs);
      const my = mean(ys);
      let n = 0;
      let dx = 0;
      let dy = 0;
      for (let i = 0; i < xs.length; i++) {
        n += (xs[i] - mx) * (ys[i] - my);
        dx += (xs[i] - mx) ** 2;
        dy += (ys[i] - my) ** 2;
      }
      return n / Math.sqrt(dx * dy);
    };
    assert.ok(Math.abs(mean(us) - 0.5) < 0.03);
    assert.ok(Math.abs(corr(us, vs)) < 0.06, 'first and second draws correlated');
    assert.ok(Math.abs(corr(us.slice(1), us.slice(0, -1))) < 0.06, 'neighboring seeds correlated');
  });
});

describe('readShapefile', () => {
  // Build a one-record polygon shapefile and matching dBASE table in memory.
  function fixture() {
    const pts: [number, number][] = [
      [-122.5, 37.7],
      [-122.3, 37.7],
      [-122.3, 37.8],
      [-122.5, 37.8],
      [-122.5, 37.7],
    ];
    const content = 44 + 4 + pts.length * 16;
    const shp = new DataView(new ArrayBuffer(100 + 8 + content));
    shp.setInt32(0, 9994, false);
    shp.setInt32(24, (100 + 8 + content) / 2, false);
    shp.setInt32(32, 5, true);
    shp.setInt32(100, 1, false);
    shp.setInt32(104, content / 2, false);
    const r = 108;
    shp.setInt32(r, 5, true);
    shp.setInt32(r + 36, 1, true);
    shp.setInt32(r + 40, pts.length, true);
    shp.setInt32(r + 44, 0, true);
    pts.forEach(([x, y], i) => {
      shp.setFloat64(r + 48 + i * 16, x, true);
      shp.setFloat64(r + 48 + i * 16 + 8, y, true);
    });

    const fields = [
      ['STATEFP', 2],
      ['NAME', 20],
    ] as const;
    const headerLength = 32 + fields.length * 32 + 1;
    const recordLength = 1 + fields.reduce((s, [, l]) => s + l, 0);
    const dbf = new Uint8Array(headerLength + recordLength);
    const dv = new DataView(dbf.buffer);
    dbf[0] = 3;
    dv.setUint32(4, 1, true);
    dv.setUint16(8, headerLength, true);
    dv.setUint16(10, recordLength, true);
    const enc = new TextEncoder();
    fields.forEach(([name, len], i) => {
      dbf.set(enc.encode(name), 32 + i * 32);
      dbf[32 + i * 32 + 11] = 'C'.charCodeAt(0);
      dbf[32 + i * 32 + 16] = len;
    });
    dbf[headerLength - 1] = 0x0d;
    dbf[headerLength] = 0x20;
    dbf.set(enc.encode('06'), headerLength + 1);
    dbf.set(enc.encode('San Francisco'.padEnd(20)), headerLength + 3);
    return { shp: new Uint8Array(shp.buffer), dbf };
  }

  it('reads polygon geometry and attributes', () => {
    const { shp, dbf } = fixture();
    const [f] = readShapefile(shp, dbf);
    assert.deepEqual(f.properties, { STATEFP: '06', NAME: 'San Francisco' });
    assert.equal(f.shape?.length, 1);
    assert.equal(f.shape?.[0].length, 5);
    assert.deepEqual(f.shape?.[0][1], [-122.3, 37.7]);
  });
});
