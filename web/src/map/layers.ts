import type { ExpressionSpecification, LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { STATUSES } from '../../../packages/shared/src/index.ts';
import { LABEL_FONT } from './basemaps.ts';

/**
 * The project layers drawn on top of any basemap.
 *
 * Encoding (see docs/DESIGN.md):
 *   color       CEQA stage (validated categorical palette, light and dark sets)
 *   fill        solid = coordinates from the agency; solid with a lighter center =
 *               near the listed cross streets; hollow ring = approximate
 *   clusters    hairline circles sized by count, echoing the reference site's
 *               node graph; a green ring means at least one project inside is
 *               in public review right now
 */

export const SOURCE_ID = 'projects';
export const SOURCE_LAYER = 'projects';
export const LAYER = {
  clusters: 'projects-clusters',
  clusterCount: 'projects-cluster-count',
  approx: 'projects-approx',
  exact: 'projects-exact',
  crossStreets: 'projects-cross-streets',
  crossStreetsCenter: 'projects-cross-streets-center',
  pulse: 'projects-pulse',
} as const;
export const INTERACTIVE_LAYERS = [LAYER.clusters, LAYER.exact, LAYER.crossStreets, LAYER.approx];

export interface LayerTheme {
  mode: 'light' | 'dark';
}

function statusColor(mode: 'light' | 'dark'): ExpressionSpecification {
  const pairs = STATUSES.flatMap((s) => [s.id, s[mode]]);
  // Built from the shared status list, which MapLibre's fixed tuple types cannot describe.
  return ['match', ['get', 's'], ...pairs, STATUSES.at(-1)![mode]] as unknown as ExpressionSpecification;
}

const sortKey = [
  'match',
  ['get', 's'],
  ...STATUSES.flatMap((s) => [s.id, s.z]),
  0,
] as unknown as ExpressionSpecification;

const isCluster: ExpressionSpecification = ['has', 'point_count'];
const notCluster: ExpressionSpecification = ['!', ['has', 'point_count']];
const hovered: ExpressionSpecification = ['boolean', ['feature-state', 'hover'], false];
const selected: ExpressionSpecification = ['boolean', ['feature-state', 'selected'], false];

/**
 * Point radius grows gently with zoom; hover and selection enlarge it.
 * `scale` shrinks the whole curve (for the lighter center of cross-street dots;
 * zoom curves can't be multiplied after the fact).
 */
function pointRadius(base: number, scale = 1): ExpressionSpecification {
  const r = (v: number) => v * scale;
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    4,
    ['case', selected, r(base + 4), hovered, r(base + 2), r(base * 0.6)],
    10,
    ['case', selected, r(base + 5), hovered, r(base + 3), r(base)],
    15,
    ['case', selected, r(base + 7), hovered, r(base + 4), r(base * 1.8)],
  ] as ExpressionSpecification;
}

export function projectLayers({ mode }: LayerTheme): LayerSpecification[] {
  const surface = mode === 'light' ? '#f4f2ee' : '#121212';
  const ink = mode === 'light' ? '#151515' : '#efede8';
  const card = mode === 'light' ? '#faf9f6' : '#1a1a1a';
  const color = statusColor(mode);
  const green = STATUSES[0][mode];

  return [
    {
      id: LAYER.clusters,
      type: 'circle',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      filter: isCluster,
      paint: {
        'circle-color': card,
        'circle-opacity': 0.92,
        'circle-radius': ['step', ['get', 'point_count'], 11, 25, 14, 100, 18, 1000, 24, 5000, 30],
        'circle-stroke-color': ['case', ['>', ['coalesce', ['get', 'r'], 0], 0], green, ink],
        'circle-stroke-width': ['case', ['>', ['coalesce', ['get', 'r'], 0], 0], 2, 0.75],
      },
    },
    {
      id: LAYER.clusterCount,
      type: 'symbol',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      filter: isCluster,
      layout: {
        // 1284 -> "1.3k". Computed here rather than relying on a tippecanoe-specific attribute.
        'text-field': [
          'case',
          ['>=', ['get', 'point_count'], 1000],
          ['concat', ['to-string', ['/', ['round', ['/', ['get', 'point_count'], 100]], 10]], 'k'],
          ['to-string', ['get', 'point_count']],
        ],
        'text-font': LABEL_FONT,
        'text-size': ['step', ['get', 'point_count'], 10, 1000, 11],
        'text-allow-overlap': true,
      },
      paint: { 'text-color': ink },
    },
    {
      // Approximate locations: hollow rings in the status color.
      id: LAYER.approx,
      type: 'circle',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      filter: ['all', notCluster, ['==', ['get', 'x'], 0]],
      layout: { 'circle-sort-key': sortKey },
      paint: {
        'circle-radius': pointRadius(3.5),
        'circle-color': surface,
        'circle-opacity': 0.85,
        'circle-stroke-color': ['case', selected, ink, color],
        'circle-stroke-width': ['case', selected, 2.5, hovered, 2, 1.5],
      },
    },
    {
      // Exact locations: solid dots with a surface-colored ring so they stay
      // legible over each other and over aerial imagery.
      id: LAYER.exact,
      type: 'circle',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      filter: ['all', notCluster, ['==', ['get', 'x'], 1]],
      layout: { 'circle-sort-key': sortKey },
      paint: {
        'circle-radius': pointRadius(4),
        'circle-color': color,
        'circle-stroke-color': ['case', selected, ink, surface],
        'circle-stroke-width': ['case', selected, 2.5, 1.5],
      },
    },
    {
      // Near the listed cross streets: a solid dot in the status color…
      id: LAYER.crossStreets,
      type: 'circle',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      filter: ['all', notCluster, ['==', ['get', 'x'], 2]],
      layout: { 'circle-sort-key': sortKey },
      paint: {
        'circle-radius': pointRadius(4),
        'circle-color': color,
        'circle-stroke-color': ['case', selected, ink, surface],
        'circle-stroke-width': ['case', selected, 2.5, 1.5],
      },
    },
    {
      // …with a lighter center, so it reads as "close, not exact".
      id: LAYER.crossStreetsCenter,
      type: 'circle',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      filter: ['all', notCluster, ['==', ['get', 'x'], 2]],
      layout: { 'circle-sort-key': sortKey },
      paint: {
        'circle-radius': pointRadius(4, 0.45),
        'circle-color': '#ffffff',
        'circle-opacity': 0.62,
      },
    },
    {
      // A soft halo that breathes around in-review projects (animated in MapView).
      id: LAYER.pulse,
      type: 'circle',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      filter: ['all', notCluster, ['==', ['get', 's'], 'in_review']],
      paint: {
        'circle-radius': 8,
        'circle-color': green,
        'circle-opacity': 0,
        'circle-blur': 0.6,
      },
    },
  ];
}

/** Add (or re-add after a basemap switch) the data source and layers. */
export function ensureProjectLayers(map: MapLibreMap, tilesUrl: string, theme: LayerTheme) {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, { type: 'vector', url: `pmtiles://${tilesUrl}`, promoteId: 'id' });
  }
  for (const layer of projectLayers(theme)) {
    if (map.getLayer(layer.id)) map.removeLayer(layer.id);
  }
  // Pulse sits beneath the dots; clusters on top of everything.
  const order = [
    LAYER.pulse,
    LAYER.approx,
    LAYER.crossStreets,
    LAYER.crossStreetsCenter,
    LAYER.exact,
    LAYER.clusters,
    LAYER.clusterCount,
  ];
  const byId = Object.fromEntries(projectLayers(theme).map((l) => [l.id, l]));
  for (const id of order) map.addLayer(byId[id]);
}
