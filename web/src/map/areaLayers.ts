import type { ExpressionSpecification, LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { type MapMark, type ProjectStatus, STATUSES, stageCountKey } from '../../../packages/shared/src/index.ts';
import { LABEL_FONT } from './basemaps.ts';
import { arrivalRadius, type LayerTheme } from './layers.ts';

/**
 * Projects known only to a city, ZIP code or county (see pipeline/src/lib/areas.ts).
 *
 * They have no spot of their own, so the map doesn't invent one:
 *   up to z7  in the ordinary clusters (main tileset), as in production
 *   z8–10     a badge per city, ZIP code or county (double ring: an area, not
 *             a cluster of sites) with its count and name
 *   z11+      hollow rings in a sunflower around the area's downtown
 * Selecting one shows its area's outline instead of a pin. They are
 * "approximate": hiding approximate locations hides them, and badge counts
 * follow the stage filter (summed per stage).
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
  badges: 'areas-badges',
  badgeInner: 'areas-badge-inner',
  badgeCount: 'areas-badge-count',
  badgeName: 'areas-badge-name',
} as const;
export const AREA_INTERACTIVE = [AREA_LAYER.badges, AREA_LAYER.dots];

const isBadge: ExpressionSpecification = ['==', ['get', 'f'], 'b'];

/** Projects in a badge that belong to the shown stages. */
function badgeCount(stages: readonly ProjectStatus[]): ExpressionSpecification {
  return [
    '+',
    0,
    0,
    ...stages.map((s) => ['coalesce', ['get', stageCountKey(s)], 0]),
  ] as unknown as ExpressionSpecification;
}

function badgeRadius(stages: readonly ProjectStatus[]): ExpressionSpecification {
  // Keep in step with badgeRadiusPx in pipeline/src/lib/areas.ts, which nudges badges apart at these sizes.
  return ['step', badgeCount(stages), 12, 10, 14, 50, 17, 250, 21, 1000, 25] as unknown as ExpressionSpecification;
}

/** A badge's numbers, for its hover card. */
export function badgeInfo(props: Record<string, unknown>, stages: readonly ProjectStatus[]) {
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
  return {
    name: String(props.an ?? ''),
    count: stages.reduce((n, s) => n + num(props[stageCountKey(s)]), 0),
    inReview: stages.includes('in_review') ? num(props[stageCountKey('in_review')]) : 0,
    arrived: num(props.n),
    listed: String(props.ak ?? 'city') as 'city' | 'zip' | 'county' | 'mixed',
    several: num(props.am) > 0,
  };
}

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
  const card = mode === 'light' ? '#faf9f6' : '#1a1a1a';
  const on = showsApprox(marks);
  const dotFilter = on
    ? ([
        'all',
        ['!=', ['get', 'f'], 'b'],
        ['in', ['get', 's'], ['literal', [...stages]]],
      ] as unknown as ExpressionSpecification)
    : NONE;
  const count = badgeCount(stages);
  const badgeFilter = on ? (['all', isBadge, ['>', count, 0]] as unknown as ExpressionSpecification) : NONE;
  const inReview = stages.includes('in_review')
    ? (['>', ['coalesce', ['get', stageCountKey('in_review')], 0], 0] as unknown as ExpressionSpecification)
    : null;

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
      filter: [
        'all',
        ['>', ['coalesce', ['get', 'n'], 0], 0],
        ['any', dotFilter, badgeFilter],
      ] as unknown as ExpressionSpecification,
      paint: {
        'circle-radius': arrivalRadius(stages, 0.45, null, marks),
        'circle-color': 'rgba(0, 0, 0, 0)',
        'circle-stroke-color': green,
        'circle-stroke-width': 1.25,
        'circle-stroke-opacity': 0.75,
      },
    },
    {
      // Badges: a card-colored disc with two hairline rings, so it reads as an
      // area rather than a cluster of sites; green outer ring if any project
      // inside is in public review, like clusters.
      id: AREA_LAYER.badges,
      type: 'circle',
      source: AREA_SOURCE,
      'source-layer': AREA_SOURCE_LAYER,
      filter: badgeFilter,
      paint: {
        'circle-color': card,
        'circle-opacity': 0.94,
        'circle-radius': badgeRadius(stages),
        'circle-stroke-color': inReview ? (['case', inReview, green, ink] as unknown as ExpressionSpecification) : ink,
        'circle-stroke-width': ['case', hovered, 1.75, 1],
      },
    },
    {
      id: AREA_LAYER.badgeInner,
      type: 'circle',
      source: AREA_SOURCE,
      'source-layer': AREA_SOURCE_LAYER,
      filter: badgeFilter,
      paint: {
        'circle-color': 'rgba(0, 0, 0, 0)',
        'circle-radius': ['-', badgeRadius(stages), 3] as unknown as ExpressionSpecification,
        'circle-stroke-color': ink,
        'circle-stroke-width': 0.6,
        'circle-stroke-opacity': 0.4,
      },
    },
    {
      id: AREA_LAYER.badgeCount,
      type: 'symbol',
      source: AREA_SOURCE,
      'source-layer': AREA_SOURCE_LAYER,
      filter: badgeFilter,
      layout: {
        'text-field': [
          'case',
          ['>=', count, 1000],
          ['concat', ['to-string', ['/', ['round', ['/', count, 100]], 10]], 'k'],
          ['to-string', count],
        ] as unknown as ExpressionSpecification,
        'text-font': LABEL_FONT,
        'text-size': 11,
        'text-allow-overlap': true,
      },
      paint: { 'text-color': ink },
    },
    {
      // The area's name under its badge, where it fits.
      id: AREA_LAYER.badgeName,
      type: 'symbol',
      source: AREA_SOURCE,
      'source-layer': AREA_SOURCE_LAYER,
      filter: badgeFilter,
      layout: {
        'text-field': ['get', 'an'],
        'text-font': LABEL_FONT,
        'text-size': 10.5,
        'text-anchor': 'top',
        'text-offset': [
          'step',
          count,
          1.4,
          10,
          1.6,
          50,
          1.9,
          250,
          2.3,
          1000,
          2.7,
        ] as unknown as ExpressionSpecification,
        'text-optional': true,
      },
      paint: { 'text-color': ink, 'text-halo-color': surface, 'text-halo-width': 1.25, 'text-opacity': 0.8 },
    },
  ];
}

/** Layers to put under the project dots (outline) and above them (the rest). */
export const AREA_ORDER_BELOW = [AREA_LAYER.outlineFill, AREA_LAYER.outlineLine];
export const AREA_ORDER_ABOVE = [
  AREA_LAYER.dots,
  AREA_LAYER.arrivals,
  AREA_LAYER.badges,
  AREA_LAYER.badgeInner,
  AREA_LAYER.badgeCount,
  AREA_LAYER.badgeName,
];

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
