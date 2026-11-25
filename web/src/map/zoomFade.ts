import type { Map as MapLibreMap } from 'maplibre-gl';
import { AREA_LAYER, AREA_SOURCE } from './areaLayers.ts';
import { LAYER, SOURCE_ID } from './layers.ts';

/**
 * Soften what changes as the map crosses a whole zoom level.
 *
 * Each zoom level has its own tiles: clusters regroup, badges move, and dots
 * come out of clusters. MapLibre swaps those in at once, which reads as a
 * jump. When the level changes we dip the layers that change and fade them
 * back in as the new tiles arrive.
 */

/** Layers whose features regroup at every level they exist on. */
const REGROUPING: Array<[string, string]> = [
  [LAYER.clusters, 'circle-opacity'],
  [LAYER.clusters, 'circle-stroke-opacity'],
  [LAYER.clusterCount, 'text-opacity'],
  [AREA_LAYER.badges, 'circle-opacity'],
  [AREA_LAYER.badges, 'circle-stroke-opacity'],
  [AREA_LAYER.badgeInner, 'circle-stroke-opacity'],
  [AREA_LAYER.badgeCount, 'text-opacity'],
  [AREA_LAYER.badgeName, 'text-opacity'],
];

/** Dots: these only change wholesale where clusters or badges give way to them. */
const DOTS: Array<[string, string]> = [
  [LAYER.exact, 'circle-opacity'],
  [LAYER.exact, 'circle-stroke-opacity'],
  [LAYER.crossStreets, 'circle-opacity'],
  [LAYER.crossStreets, 'circle-stroke-opacity'],
  [LAYER.crossStreetsCenter, 'circle-opacity'],
  [LAYER.approx, 'circle-opacity'],
  [LAYER.approx, 'circle-stroke-opacity'],
  [AREA_LAYER.dots, 'circle-opacity'],
  [AREA_LAYER.dots, 'circle-stroke-opacity'],
];

/** Last zoom with clusters (tippecanoe --cluster-maxzoom) and with area badges. */
const CLUSTER_MAXZOOM = 12;
const BADGE_MAXZOOM = 10;

const DIP = 0.2; // share of full opacity at the moment of the swap
const FADE_MS = 320;
const MAX_WAIT_MS = 400; // fade in even if the new tiles are slow

export function watchZoomFades(map: MapLibreMap): () => void {
  let level = Math.floor(map.getZoom());
  /** Full opacity of each dipped layer property, so we restore what was there. */
  const dipped = new Map<string, number>();
  let timer = 0;

  const restore = () => {
    window.clearTimeout(timer);
    map.off('sourcedata', onData);
    for (const [key, full] of dipped) {
      const [layer, prop] = key.split('|');
      if (!map.getLayer(layer)) continue;
      map.setPaintProperty(layer, `${prop}-transition`, { duration: FADE_MS, delay: 0 });
      map.setPaintProperty(layer, prop, full);
    }
    dipped.clear();
  };

  const onData = (e: { sourceId?: string }) => {
    if (e.sourceId !== SOURCE_ID && e.sourceId !== AREA_SOURCE) return;
    const ready = [SOURCE_ID, AREA_SOURCE].every((id) => !map.getSource(id) || map.isSourceLoaded(id));
    if (ready) restore();
  };

  const dip = (props: Array<[string, string]>) => {
    for (const [layer, prop] of props) {
      if (!map.getLayer(layer)) continue;
      const key = `${layer}|${prop}`;
      if (!dipped.has(key)) {
        const now = map.getPaintProperty(layer, prop);
        if (now !== undefined && typeof now !== 'number') continue; // an expression: leave it alone
        dipped.set(key, now ?? 1);
      }
      map.setPaintProperty(layer, `${prop}-transition`, { duration: 0, delay: 0 });
      map.setPaintProperty(layer, prop, dipped.get(key)! * DIP);
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(restore, MAX_WAIT_MS);
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
    const props = [...REGROUPING];
    // Where clusters or badges hand over to dots, the dots arrive too.
    if ((lo <= CLUSTER_MAXZOOM && hi > CLUSTER_MAXZOOM) || (lo <= BADGE_MAXZOOM && hi > BADGE_MAXZOOM))
      props.push(...DOTS);
    dip(props);
  };

  map.on('zoom', onZoom);
  return () => {
    map.off('zoom', onZoom);
    restore();
  };
}
