import type { ExpressionSpecification, LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { type MapMark, STATUSES } from '../../../packages/shared/src/index.ts';
import { arrivalRadius, type LayerTheme } from './layers.ts';

/**
 * Projects known only to a city, ZIP code or county (see pipeline/src/lib/areas.ts).
 *
 * They have no spot of their own, so the map doesn't invent one. Up to z10
 * they sit in the ordinary clusters (main tileset); from z11 this layer shows
 * them as hollow rings in a sunflower around the area's downtown, newest in
 * the middle. Selecting one shows its area's outline instead of a pin.
 * They are "approximate": hiding approximate locations hides them.
 */

export const AREA_SOURCE = 'areas';
export const AREA_SOURCE_LAYER = 'areas';
export const OUTLINE_SOURCE = 'area-outlines';
export const OUTLINE_SOURCE_LAYER = 'areas';

export const AREA_LAYER = {
  outlineFill: 'area-outline-fill',
  outlineLine: 'area-outline-line',
  dots: 'areas-dots',
  arrivals: 'areas-arrivals',
} as const;
export const AREA_INTERACTIVE = [AREA_LAYER.dots];

const selected: ExpressionSpecification = ['boolean', ['feature-state', 'selected'], false];
const hovered: ExpressionSpecification = ['boolean', ['feature-state', 'hover'], false];

const showsApprox = (marks: readonly MapMark[]) => marks.includes('approx');
const NONE: ExpressionSpecification = ['==', 1, 0];

function statusColor(mode: 'light' | 'dark'): ExpressionSpecification {
  const pairs = STATUSES.flatMap((s) => [s.id, s[mode]]);
  return ['match', ['get', 's'], ...pairs, STATUSES.at(-1)![mode]] as unknown as ExpressionSpecification;
}

export function areaLayers({ mode, stages, marks }: LayerTheme): LayerSpecification[] {
  const surface = mode === 'light' ? '#f4f2ee' : '#121212';
  const ink = mode === 'light' ? '#151515' : '#efede8';
  const green = STATUSES[0][mode];
  const dotFilter = showsApprox(marks)
    ? (['in', ['get', 's'], ['literal', [...stages]]] as unknown as ExpressionSpecification)
    : NONE;

  return [
    {
      // A selected project's area: a light tint in its stage color (set in MapView)…
      id: AREA_LAYER.outlineFill,
      type: 'fill',
      source: OUTLINE_SOURCE,
      'source-layer': OUTLINE_SOURCE_LAYER,
      filter: NONE,
      layout: { visibility: 'none' },
      paint: { 'fill-color': ink, 'fill-opacity': 0.1 },
    },
    {
      // …and its outline.
      id: AREA_LAYER.outlineLine,
      type: 'line',
      source: OUTLINE_SOURCE,
      'source-layer': OUTLINE_SOURCE_LAYER,
      filter: NONE,
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: { 'line-color': ink, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.25, 12, 2] },
    },
    {
      // Each project, around its area's downtown: hollow rings like other approximate locations.
      id: AREA_LAYER.dots,
      type: 'circle',
      source: AREA_SOURCE,
      'source-layer': AREA_SOURCE_LAYER,
      filter: dotFilter,
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          11,
          ['case', selected, 8, hovered, 6.5, 4],
          15,
          ['case', selected, 10, hovered, 8, 6],
        ] as unknown as ExpressionSpecification,
        'circle-color': surface,
        'circle-opacity': 0.9,
        'circle-stroke-color': ['case', selected, ink, statusColor(mode)],
        'circle-stroke-width': ['case', selected, 2.5, hovered, 2, 1.5],
      },
    },
    {
      // The header's ping around just-arrived projects (animated in MapView).
      id: AREA_LAYER.arrivals,
      type: 'circle',
      source: AREA_SOURCE,
      'source-layer': AREA_SOURCE_LAYER,
      filter: ['all', ['>', ['coalesce', ['get', 'n'], 0], 0], dotFilter] as unknown as ExpressionSpecification,
      paint: {
        'circle-radius': arrivalRadius(stages, 0.45, null, marks),
        'circle-color': 'rgba(0, 0, 0, 0)',
        'circle-stroke-color': green,
        'circle-stroke-width': 1.25,
        'circle-stroke-opacity': 0.75,
      },
    },
  ];
}

/** Layers to put under the project dots (outline) and above them (the rest). */
export const AREA_ORDER_BELOW = [AREA_LAYER.outlineFill, AREA_LAYER.outlineLine];
export const AREA_ORDER_ABOVE = [AREA_LAYER.dots, AREA_LAYER.arrivals];

/**
 * Add (or re-add after a basemap switch) the area sources and layers.
 * `beforeId`: the first project layer, so the outline sits under every dot.
 */
export function ensureAreaLayers(
  map: MapLibreMap,
  areaTilesUrl: string,
  boundariesUrl: string | null,
  theme: LayerTheme,
  beforeId: string | undefined,
) {
  if (!map.getSource(AREA_SOURCE))
    map.addSource(AREA_SOURCE, { type: 'vector', url: `pmtiles://${areaTilesUrl}`, promoteId: 'id' });
  if (boundariesUrl && !map.getSource(OUTLINE_SOURCE))
    map.addSource(OUTLINE_SOURCE, { type: 'vector', url: `pmtiles://${boundariesUrl}` });
  const layers = areaLayers(theme);
  for (const l of layers) if (map.getLayer(l.id)) map.removeLayer(l.id);
  const byId = Object.fromEntries(layers.map((l) => [l.id, l]));
  if (map.getSource(OUTLINE_SOURCE)) for (const id of AREA_ORDER_BELOW) map.addLayer(byId[id], beforeId);
  for (const id of AREA_ORDER_ABOVE) map.addLayer(byId[id]);
}

/** Apply new stage or location filters to the area layers. */
export function applyAreaStages(map: MapLibreMap, theme: LayerTheme) {
  for (const layer of areaLayers(theme)) {
    if (!map.getLayer(layer.id) || AREA_ORDER_BELOW.includes(layer.id as (typeof AREA_ORDER_BELOW)[number])) continue;
    if ('filter' in layer) map.setFilter(layer.id, layer.filter ?? null);
    for (const [k, v] of Object.entries(layer.paint ?? {}))
      if (!(layer.id === AREA_LAYER.arrivals && k === 'circle-stroke-opacity')) map.setPaintProperty(layer.id, k, v);
    for (const [k, v] of Object.entries(layer.layout ?? {})) map.setLayoutProperty(layer.id, k, v);
  }
}

/** Show a selected project's area outline in its stage color, or hide it (null). */
export function showAreaOutline(map: MapLibreMap, area: { keys: string[]; color: string } | null) {
  for (const id of AREA_ORDER_BELOW) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, 'visibility', area ? 'visible' : 'none');
    map.setFilter(
      id,
      area ? (['in', ['get', 'k'], ['literal', area.keys]] as unknown as ExpressionSpecification) : NONE,
    );
  }
  if (area) {
    if (map.getLayer(AREA_LAYER.outlineFill)) map.setPaintProperty(AREA_LAYER.outlineFill, 'fill-color', area.color);
    if (map.getLayer(AREA_LAYER.outlineLine)) map.setPaintProperty(AREA_LAYER.outlineLine, 'line-color', area.color);
  }
}
