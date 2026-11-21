/**
 * Tileset naming and pruning. Every build publishes one immutable tileset per
 * time window: tiles/projects-<buildId>-<scope>.pmtiles. Older builds used
 * tiles/projects-<buildId>.pmtiles.
 */

export function tilesetName(buildId: string, scope: string): string {
  return `projects-${buildId}-${scope}.pmtiles`;
}

/** The build id in a tileset key, or null if the key is not a tileset. */
export function buildIdOf(key: string): string | null {
  return /(?:^|\/)projects-(\d{14})(?:-[a-z0-9]+)?\.pmtiles$/.exec(key)?.[1] ?? null;
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
