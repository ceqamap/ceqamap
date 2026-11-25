import type { Map as MapLibreMap } from 'maplibre-gl';
import { AREA_LAYER, AREA_SOURCE } from './areaLayers.ts';
import { LAYER, SOURCE_ID } from './layers.ts';

/**
 * Ease in what changes as the map crosses a whole zoom level.
 *
 * Each zoom level has its own tiles: clusters regroup, badges move, and dots
 * come out of clusters. MapLibre swaps those in at once, which reads as a
 * jump. When the level changes we hide the layers that change, then fade
 * them back in once the new tiles arrive, the counts a beat after their circles.
 *
 * Only opacity: the radius is data-driven, and changing a data-driven value
 * makes MapLibre lay the tiles out again, too slow to do every frame.
 */

/** Layer, paint property, and how far into the ease it starts (0..1). */
type Part = [layer: string, prop: string, lag?: number];

/** Layers whose features regroup at every level they exist on. */
const REGROUPING: Part[] = [
  [LAYER.clusters, 'circle-opacity'],
  [LAYER.clusters, 'circle-stroke-opacity'],
  [LAYER.clusterCount, 'text-opacity', 0.25],
  [AREA_LAYER.badges, 'circle-opacity'],
  [AREA_LAYER.badges, 'circle-stroke-opacity'],
  [AREA_LAYER.badgeInner, 'circle-stroke-opacity'],
  [AREA_LAYER.badgeCount, 'text-opacity', 0.25],
  [AREA_LAYER.badgeName, 'text-opacity', 0.35],
];

/** Dots: these only change wholesale where clusters or badges give way to them. */
const PROJECT_DOTS: Part[] = [
  [LAYER.exact, 'circle-opacity'],
  [LAYER.exact, 'circle-stroke-opacity'],
  [LAYER.crossStreets, 'circle-opacity'],
  [LAYER.crossStreets, 'circle-stroke-opacity'],
  [LAYER.crossStreetsCenter, 'circle-opacity'],
  [LAYER.approx, 'circle-opacity'],
  [LAYER.approx, 'circle-stroke-opacity'],
];
const AREA_DOTS: Part[] = [
  [AREA_LAYER.dots, 'circle-opacity'],
  [AREA_LAYER.dots, 'circle-stroke-opacity'],
];

/** Last zoom with clusters (tippecanoe --cluster-maxzoom) and with area badges. */
const CLUSTER_MAXZOOM = 12;
const BADGE_MAXZOOM = 10;

const EASE_MS = 600;
const MAX_WAIT_MS = 180; // ease in even if the new tiles are slow

/** Ease-in-out: no sudden start, a soft landing. */
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function watchZoomFades(map: MapLibreMap): () => void {
  let level = Math.floor(map.getZoom());
  /** Each eased property's resting value, so we land exactly on what was there. */
  const active = new Map<string, { part: Part; base: number }>();
  let timer = 0;
  let raf = 0;

  const set = (layer: string, prop: string, value: number) => {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
  };

  const finish = () => {
    for (const { part, base } of active.values()) set(part[0], part[1], base);
    active.clear();
  };

  const easeIn = () => {
    window.clearTimeout(timer);
    map.off('sourcedata', onData);
    cancelAnimationFrame(raf);
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / EASE_MS);
      if (t >= 1) return finish();
      for (const { part, base } of active.values()) {
        const lag = part[2] ?? 0;
        set(part[0], part[1], base * ease(Math.max(0, (t - lag) / (1 - lag))));
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  };

  const onData = (e: { sourceId?: string }) => {
    if (e.sourceId !== SOURCE_ID && e.sourceId !== AREA_SOURCE) return;
    if ([SOURCE_ID, AREA_SOURCE].every((id) => !map.getSource(id) || map.isSourceLoaded(id))) easeIn();
  };

  const tuck = (parts: Part[]) => {
    cancelAnimationFrame(raf);
    for (const part of parts) {
      const [layer, prop] = part;
      if (!map.getLayer(layer)) continue;
      const key = `${layer}|${prop}`;
      if (!active.has(key)) {
        const now: unknown = map.getPaintProperty(layer, prop);
        if (now !== undefined && typeof now !== 'number') continue; // an expression: leave it alone
        active.set(key, { part, base: now ?? 1 });
        map.setPaintProperty(layer, `${prop}-transition`, { duration: 0, delay: 0 });
      }
      set(layer, prop, 0);
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(easeIn, MAX_WAIT_MS);
    map.off('sourcedata', onData);
    map.on('sourcedata', onData);
  };

  const onZoom = () => {
    const next = Math.floor(map.getZoom());
    if (next === level) return;
    const lo = Math.min(level, next);
    const hi = Math.max(level, next);
    level = next;
    if (lo > CLUSTER_MAXZOOM) return; // above the clusters nothing regroups
    const parts = [...REGROUPING];
    // Where clusters or badges hand over to dots, the dots arrive too.
    if (lo <= CLUSTER_MAXZOOM && hi > CLUSTER_MAXZOOM) parts.push(...PROJECT_DOTS);
    if (lo <= BADGE_MAXZOOM && hi > BADGE_MAXZOOM) parts.push(...AREA_DOTS);
    tuck(parts);
  };

  // Restyling (a new basemap) replaces these values; drop ours rather than land on stale ones.
  const onStyle = () => {
    cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    active.clear();
  };

  map.on('zoom', onZoom);
  map.on('style.load', onStyle);
  return () => {
    map.off('zoom', onZoom);
    map.off('style.load', onStyle);
    map.off('sourcedata', onData);
    cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    finish();
  };
}
