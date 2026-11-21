import type { ExpressionSpecification, LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { type ProjectStatus, STATUSES, stageCountKey } from '../../../packages/shared/src/index.ts';
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
 *   arrivals    a hairline ring that grows and fades (the header's "ping") around
 *               projects, and clusters of projects, that arrived in the latest batch
 *
 * The legend's stage filter is applied here: points by their stage, clusters
 * by summing the per-stage counts tippecanoe accumulated (c_in_review, ...).
 * Data built before those counts existed falls back to point_count.
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
  arrivals: 'projects-arrivals',
} as const;
export const INTERACTIVE_LAYERS = [LAYER.clusters, LAYER.exact, LAYER.crossStreets, LAYER.approx];

export interface LayerTheme {
  mode: 'light' | 'dark';
  /** Stages the legend shows. */
  stages: readonly ProjectStatus[];
}

/** Projects in a cluster that belong to the shown stages. */
function clusterCountExpr(stages: readonly ProjectStatus[]): ExpressionSpecification {
  const terms = stages.map((s) => ['coalesce', ['get', stageCountKey(s)], 0]);
  return [
    'case',
    ['has', stageCountKey('in_review')],
    ['+', 0, 0, ...terms],
    ['get', 'point_count'],
  ] as unknown as ExpressionSpecification;
}

/** In-review projects in a cluster, if the in-review stage is shown. */
function clusterInReviewExpr(stages: readonly ProjectStatus[]): ExpressionSpecification | number {
  if (!stages.includes('in_review')) return 0;
  return ['coalesce', ['get', stageCountKey('in_review')], ['get', 'r'], 0] as unknown as ExpressionSpecification;
}

function stageFilter(stages: readonly ProjectStatus[]): ExpressionSpecification {
  return ['in', ['get', 's'], ['literal', [...stages]]] as unknown as ExpressionSpecification;
}

/** The same counts in JavaScript, for the hover card. */
export function clusterCounts(props: Record<string, unknown>, stages: readonly ProjectStatus[]) {
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
  const hasStages = props[stageCountKey('in_review')] !== undefined;
  const count = hasStages ? stages.reduce((n, s) => n + num(props[stageCountKey(s)]), 0) : num(props.point_count);
  const inReview = stages.includes('in_review') ? num(props[stageCountKey('in_review')] ?? props.r) : 0;
  return { count, inReview, arrived: num(props.n) };
}

const clusterRadiusSteps = [11, 25, 14, 100, 18, 1000, 24, 5000, 30];

function clusterRadiusExpr(stages: readonly ProjectStatus[]): ExpressionSpecification {
  return ['step', clusterCountExpr(stages), ...clusterRadiusSteps] as unknown as ExpressionSpecification;
}

/**
 * Ping ring size: from just outside the dot (or cluster) edge, growing by up to
 * 10 px. Follows the dots' zoom curve and selection size (see pointRadius) so
 * the ring is never hidden under its own dot.
 */
export function arrivalRadius(
  stages: readonly ProjectStatus[],
  progress: number,
  selectedId: string | null = null,
): ExpressionSpecification {
  const grow = progress * 10;
  const at = (dot: number, selectedDot: number) => [
    'case',
    ['has', 'point_count'],
    ['+', clusterRadiusExpr(stages), 1 + grow],
    // By id rather than feature-state, which this layer did not pick up
    // reliably while its radius is re-set every frame (2026-11-21).
    ['==', ['to-string', ['get', 'id']], selectedId ?? ''],
    selectedDot + 2 + grow,
    dot + 2 + grow,
  ];
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    4,
    at(2.4, 8),
    10,
    at(4, 9),
    15,
    at(7.2, 11),
  ] as unknown as ExpressionSpecification;
}

/** Ping ring opacity at eased progress 0..1 (matches the header's keyframes). */
export function arrivalOpacity(progress: number): number {
  return 0.9 * (1 - progress);
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

export function projectLayers({ mode, stages }: LayerTheme): LayerSpecification[] {
  const surface = mode === 'light' ? '#f4f2ee' : '#121212';
  const ink = mode === 'light' ? '#151515' : '#efede8';
  const card = mode === 'light' ? '#faf9f6' : '#1a1a1a';
  const color = statusColor(mode);
  const green = STATUSES[0][mode];
  const count = clusterCountExpr(stages);
  const inReview = clusterInReviewExpr(stages);
  const clusterFilter = ['all', isCluster, ['>', count, 0]] as unknown as ExpressionSpecification;
  const hasOpenReview = ['>', inReview, 0] as unknown as ExpressionSpecification;
  const shown = stageFilter(stages);

  return [
    {
      id: LAYER.clusters,
      type: 'circle',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      filter: clusterFilter,
      paint: {
        'circle-color': card,
        'circle-opacity': 0.92,
        'circle-radius': clusterRadiusExpr(stages),
        'circle-stroke-color': ['case', hasOpenReview, green, ink],
        'circle-stroke-width': ['case', hasOpenReview, 2, 0.75],
      },
    },
    {
      id: LAYER.clusterCount,
      type: 'symbol',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      filter: clusterFilter,
      layout: {
        // 1284 -> "1.3k". Computed here rather than relying on a tippecanoe-specific attribute.
        'text-field': [
          'case',
          ['>=', count, 1000],
          ['concat', ['to-string', ['/', ['round', ['/', count, 100]], 10]], 'k'],
          ['to-string', count],
        ] as unknown as ExpressionSpecification,
        'text-font': LABEL_FONT,
        'text-size': ['step', count, 10, 1000, 11] as unknown as ExpressionSpecification,
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
      filter: ['all', notCluster, ['==', ['get', 'x'], 0], shown],
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
      filter: ['all', notCluster, ['==', ['get', 'x'], 1], shown],
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
      filter: ['all', notCluster, ['==', ['get', 'x'], 2], shown],
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
      filter: ['all', notCluster, ['==', ['get', 'x'], 2], shown],
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
      filter: ['all', notCluster, ['==', ['get', 's'], 'in_review'], shown],
      paint: {
        'circle-radius': 8,
        'circle-color': green,
        'circle-opacity': 0,
        'circle-blur': 0.6,
      },
    },
    {
      // The header's ping, around projects that arrived in the latest batch
      // (radius and opacity animated in MapView; these values are the still
      // frame shown with reduced motion). Clusters ping if they contain one.
      id: LAYER.arrivals,
      type: 'circle',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      filter: [
        'all',
        ['>', ['coalesce', ['get', 'n'], 0], 0],
        ['any', clusterFilter, ['all', notCluster, shown]],
      ] as unknown as ExpressionSpecification,
      paint: {
        'circle-radius': arrivalRadius(stages, 0.45),
        'circle-color': 'rgba(0, 0, 0, 0)',
        'circle-stroke-color': green,
        'circle-stroke-width': 1.25,
        'circle-stroke-opacity': 0.75,
      },
    },
  ];
}

/** Paint properties MapView animates; re-applying the stage filter leaves them alone. */
const ANIMATED: Record<string, string[]> = {
  [LAYER.pulse]: ['circle-radius', 'circle-opacity'],
  [LAYER.arrivals]: ['circle-stroke-opacity'],
};

/** Apply a new stage selection to layers already on the map, without reloading tiles. */
export function applyStages(map: MapLibreMap, theme: LayerTheme) {
  for (const layer of projectLayers(theme)) {
    if (!map.getLayer(layer.id) || !('filter' in layer)) continue;
    map.setFilter(layer.id, layer.filter ?? null);
    const skip = ANIMATED[layer.id] ?? [];
    for (const [k, v] of Object.entries(layer.paint ?? {})) {
      if (!skip.includes(k)) map.setPaintProperty(layer.id, k, v);
    }
    for (const [k, v] of Object.entries(layer.layout ?? {})) map.setLayoutProperty(layer.id, k, v);
  }
}

/** Add (or re-add after a basemap switch) the data source and layers. */
export function ensureProjectLayers(map: MapLibreMap, tilesUrl: string, theme: LayerTheme) {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, { type: 'vector', url: `pmtiles://${tilesUrl}`, promoteId: 'id' });
  }
  for (const layer of projectLayers(theme)) {
    if (map.getLayer(layer.id)) map.removeLayer(layer.id);
  }
  // Pulse sits beneath the dots, arrival rings above them; clusters on top of everything.
  const order = [
    LAYER.pulse,
    LAYER.approx,
    LAYER.crossStreets,
    LAYER.crossStreetsCenter,
    LAYER.exact,
    LAYER.arrivals,
    LAYER.clusters,
    LAYER.clusterCount,
  ];
  const byId = Object.fromEntries(projectLayers(theme).map((l) => [l.id, l]));
  for (const id of order) map.addLayer(byId[id]);
}
