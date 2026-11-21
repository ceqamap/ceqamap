/**
 * Small, dependency-free geometry for California-scale work in lon/lat.
 *
 * A shape is a list of rings ([lon, lat][]). Point-in-shape uses the even-odd
 * rule across all rings, so multipart shapes (islands) and holes both work
 * without tracking which ring is which.
 */

export type Ring = [number, number][];
export type Shape = Ring[];
export type BBox = [west: number, south: number, east: number, north: number];

export function bboxOf(shape: Shape): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const ring of shape)
    for (const [x, y] of ring) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  return [w, s, e, n];
}

export function inBBox(lon: number, lat: number, b: BBox): boolean {
  return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}

export function pointInShape(lon: number, lat: number, shape: Shape): boolean {
  let inside = false;
  for (const ring of shape) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

const KM_PER_DEG_LAT = 111.32;

/** Shortest distance in km from a point to a shape's outline (0 if inside). */
export function distanceToShapeKm(lon: number, lat: number, shape: Shape): number {
  if (pointInShape(lon, lat, shape)) return 0;
  const kx = KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const ky = KM_PER_DEG_LAT;
  let best = Infinity;
  for (const ring of shape) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      // Project to a local flat plane in km around the point.
      const ax = (ring[j][0] - lon) * kx;
      const ay = (ring[j][1] - lat) * ky;
      const bx = (ring[i][0] - lon) * kx;
      const by = (ring[i][1] - lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const d = Math.sqrt(px * px + py * py);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Signed area of one ring in square degrees (sign = winding direction). */
export function signedRingArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

/**
 * Net area in km², from the shoelace formula. Holes subtract because shapefiles
 * wind them opposite to their outer rings.
 */
export function areaKm2(shape: Shape): number {
  let sum = 0;
  for (const ring of shape) {
    let a = 0;
    let latSum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      latSum += ring[i][1];
    }
    const kx = KM_PER_DEG_LAT * Math.cos(((latSum / ring.length) * Math.PI) / 180);
    sum += (a / 2) * kx * KM_PER_DEG_LAT;
  }
  return Math.abs(sum);
}

/**
 * A uniformly random point inside the shape (rejection sampling in its bbox).
 * Returns null only for degenerate shapes.
 */
export function samplePointInShape(shape: Shape, bbox: BBox, rand: () => number, maxTries = 2000) {
  const [w, s, e, n] = bbox;
  for (let i = 0; i < maxTries; i++) {
    const lon = w + rand() * (e - w);
    const lat = s + rand() * (n - s);
    if (pointInShape(lon, lat, shape)) return { lon, lat };
  }
  return null;
}

/** Douglas–Peucker simplification of one ring, in degrees. */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  const t2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = ring[a];
    const [bx, by] = ring[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      let d2;
      if (len2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > maxD) {
        maxD = d2;
        idx = i;
      }
    }
    if (maxD > t2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}
