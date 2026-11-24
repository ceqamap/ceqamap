/**
 * Tileset naming and pruning. Every build publishes immutable tilesets: per
 * time window tiles/projects-<buildId>-<scope>.pmtiles and
 * tiles/areas-<buildId>-<scope>.pmtiles, and once tiles/boundaries-<buildId>.pmtiles.
 * Older builds used tiles/projects-<buildId>.pmtiles.
 */

export type TilesetKind = 'projects' | 'areas' | 'boundaries';

export function tilesetName(buildId: string, scope: string | null, kind: TilesetKind = 'projects'): string {
  return scope ? `${kind}-${buildId}-${scope}.pmtiles` : `${kind}-${buildId}.pmtiles`;
}

/** The build id in a tileset key, or null if the key is not a tileset. */
export function buildIdOf(key: string): string | null {
  return /(?:^|\/)(?:projects|areas|boundaries)-(\d{14})(?:-[a-z0-9]+)?\.pmtiles$/.exec(key)?.[1] ?? null;
}

/**
 * Keys to delete: every tileset not from the newest `keepBuilds` builds.
 * Clients mid-session keep reading the previous builds' files until their next
 * meta.json poll, so a few builds are kept rather than just the current one.
 */
export function tilesetsToPrune(keys: readonly string[], keepBuilds: number, current: string): string[] {
  const builds = [...new Set(keys.map(buildIdOf).filter((b): b is string => b !== null))].sort();
  const keep = new Set(builds.slice(Math.max(0, builds.length - keepBuilds)));
  keep.add(current);
  return keys.filter((k) => {
    const b = buildIdOf(k);
    return b !== null && !keep.has(b);
  });
}
