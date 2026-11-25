import type { Map as MapLibreMap } from 'maplibre-gl';
import { AREA_LAYER, AREA_SOURCE } from './areaLayers.ts';
import { LAYER, SOURCE_ID } from './layers.ts';

/**
 * Ease in what changes as the map crosses a whole zoom level.
 *
 * Each zoom level has its own tiles: clusters regroup, badges move, and dots
 * come out of clusters. MapLibre swaps those in at once, which reads as a
 * jump. So as the map nears a level change, in either direction, the layers
 * that change dim with the zoom; once the new tiles arrive they fade
 * back up, the counts a beat after their circles. Stopping short of the
 * change fades them back without one.
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

/** How far before a level change (in zoom levels) the fade-out starts. */
const LEAD = 0.4;
/**
 * The faintest they get. Fading all the way out blanked the map at every
 * level, which read as a flicker on a long zoom (2026-11-25); dimmed, the swap
 * is soft and there is always something on screen.
 */
const FLOOR = 0.35;
const FADE_IN_MS = 450;
const MAX_WAIT_MS = 260; // from the level change: fade in even if the new tiles are slow

/** Ease-in-out: no sudden start, a soft landing. */
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** What changes between two neighboring levels, or null if nothing does. */
function partsBetween(a: number, b: number): Part[] | null {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo > CLUSTER_MAXZOOM) return null; // above the clusters nothing regroups
  const parts = [...REGROUPING];
  // Where clusters or badges hand over to dots, the dots go and come too.
  if (lo <= CLUSTER_MAXZOOM && hi > CLUSTER_MAXZOOM) parts.push(...PROJECT_DOTS);
  if (lo <= BADGE_MAXZOOM && hi > BADGE_MAXZOOM) parts.push(...AREA_DOTS);
  return parts;
}

export interface ZoomFades {
  /** How visible the clusters and badges are now, 0..1, for rings drawn around them. */
  shown(): number;
  stop(): void;
}

export function watchZoomFades(map: MapLibreMap): ZoomFades {
  let zoom = map.getZoom();
  let level = Math.floor(zoom);
  /** Each eased property's resting value, so we land exactly on what was there. */
  const active = new Map<string, { part: Part; base: number }>();
  /** How visible the eased layers are now, 0..1. */
  let shown = 1;
  let raf = 0;
  let timer = 0;
  /** Waiting for the new level's tiles before fading in. */
  let waiting = false;

  const set = (layer: string, prop: string, value: number) => {
    if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value);
  };

  /** Start easing these, at the current visibility so nothing jumps. */
  const join = (parts: Part[]) => {
    for (const part of parts) {
      const [layer, prop] = part;
      const key = `${layer}|${prop}`;
      if (active.has(key) || !map.getLayer(layer)) continue;
      const now: unknown = map.getPaintProperty(layer, prop);
      if (now !== undefined && typeof now !== 'number') continue; // an expression: leave it alone
      active.set(key, { part, base: now ?? 1 });
      map.setPaintProperty(layer, `${prop}-transition`, { duration: 0, delay: 0 });
      set(layer, prop, (now ?? 1) * shown);
    }
  };

  const show = (k: number) => {
    shown = k;
    for (const { part, base } of active.values()) set(part[0], part[1], base * k);
  };

  const finish = () => {
    for (const { part, base } of active.values()) set(part[0], part[1], base);
    active.clear();
    shown = 1;
  };

  const fadeIn = () => {
    waiting = false;
    window.clearTimeout(timer);
    map.off('sourcedata', onData);
    cancelAnimationFrame(raf);
    if (active.size === 0) return;
    const from = shown;
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / FADE_IN_MS);
      // Counts trail their circles: each part runs on its own lagged clock.
      for (const { part, base } of active.values()) {
        const lag = part[2] ?? 0;
        set(part[0], part[1], base * (from + (1 - from) * ease(Math.max(0, (t - lag) / (1 - lag)))));
      }
      shown = from + (1 - from) * ease(t);
      if (t < 1) raf = requestAnimationFrame(frame);
      else finish();
    };
    raf = requestAnimationFrame(frame);
  };

  const onData = (e: { sourceId?: string }) => {
    if (e.sourceId !== SOURCE_ID && e.sourceId !== AREA_SOURCE) return;
    if ([SOURCE_ID, AREA_SOURCE].every((id) => !map.getSource(id) || map.isSourceLoaded(id))) fadeIn();
  };

  const onZoom = () => {
    const z = map.getZoom();
    const dir = Math.sign(z - zoom);
    zoom = z;
    const next = Math.floor(z);

    if (next !== level) {
      // Crossed: whatever was still showing goes now, and the new tiles fade in when they land.
      const parts = partsBetween(level, next);
      level = next;
      if (!parts) return;
      cancelAnimationFrame(raf);
      join(parts);
      show(Math.min(shown, FLOOR));
      waiting = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(fadeIn, MAX_WAIT_MS);
      map.off('sourcedata', onData);
      map.on('sourcedata', onData);
      return;
    }
    if (waiting || dir === 0) return;

    // Approaching the next level in the direction of travel: fade out with the zoom.
    const ahead = dir > 0 ? level + 1 : level - 1;
    const parts = partsBetween(level, ahead);
    if (!parts) return;
    const left = dir > 0 ? level + 1 - z : z - level; // zoom levels to go
    if (left >= LEAD) return;
    const k = FLOOR + ((1 - FLOOR) * left) / LEAD;
    if (k >= shown) return; // already fainter (a fade-in caught up with us)
    cancelAnimationFrame(raf);
    join(parts);
    show(k);
  };

  // Stopped short of a level change: bring back what we faded.
  const onZoomEnd = () => {
    if (!waiting && active.size > 0) fadeIn();
  };

  // Restyling (a new basemap) replaces these values; drop ours rather than land on stale ones.
  const onStyle = () => {
    cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    map.off('sourcedata', onData);
    active.clear();
    shown = 1;
    waiting = false;
  };

  map.on('zoom', onZoom);
  map.on('zoomend', onZoomEnd);
  map.on('style.load', onStyle);
  return {
    shown: () => shown,
    stop: () => {
      map.off('zoom', onZoom);
      map.off('zoomend', onZoomEnd);
      map.off('style.load', onStyle);
      map.off('sourcedata', onData);
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      finish();
    },
  };
}
