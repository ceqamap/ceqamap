/**
 * Deterministic randomness for placing approximate points.
 *
 * Every project must land in the same spot on every rebuild (so the map is
 * stable and shared links point at the same dot), but nearby SCH numbers must
 * land in unrelated spots. The first version hashed "<sch>:u" and "<sch>:v"
 * with FNV-1a directly; for consecutive SCH numbers those hashes move almost
 * in lockstep, which drew spirals (seen west of San Francisco, 2026-11-20).
 *
 * Fix: FNV-1a to fold the string, a murmur3 finalizer to avalanche the bits,
 * then mulberry32 as a small, well-distributed generator.
 */

/** FNV-1a over UTF-16 code units. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 fmix32: every input bit affects every output bit. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A generator of floats in [0, 1), seeded from a string. */
export function seededRandom(seed: string): () => number {
  let a = fmix32(fnv1a(seed));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
