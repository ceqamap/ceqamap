import type { StyleSpecification } from 'maplibre-gl';

/**
 * Basemaps. All are free to use without an API key:
 *
 *   OpenFreeMap  vector tiles from OpenStreetMap data (ODbL; attribution required)
 *                https://openfreemap.org
 *   USGS TNM     The National Map tile caches; U.S. public domain
 *                https://basemap.nationalmap.gov
 *                (USGSImageryTopo was retired by 2026-11; "Aerial + labels" is now
 *                composed from USGSImageryOnly plus OpenFreeMap labels.)
 *
 * "Paper" and "Night" are OpenFreeMap styles recolored at load time to match
 * the site's palette (see paperify.ts), so we get a custom cartographic look
 * without hosting our own tiles.
 */

export type BasemapId = 'paper' | 'night' | 'streets' | 'topo' | 'imagery' | 'hybrid' | 'relief';

export interface Basemap {
  id: BasemapId;
  label: string;
  /** Which status palette and point halo to use on top of this basemap. */
  mode: 'light' | 'dark';
  /**
   * Shown instead when this basemap's tile host is down (see basemapWatch.ts):
   * the OpenFreeMap styles fall back to USGS, which is hosted separately.
   */
  fallback?: BasemapId;
  /** Swatch for the picker. */
  swatch: string;
  style: () => Promise<StyleSpecification | string>;
}

/** Fonts for our labels (cluster counts). Served by OpenFreeMap. */
export const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
export const LABEL_FONT = ['Noto Sans Bold'];

const OSM_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const USGS_ATTRIBUTION =
  '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">USGS The National Map</a>';

function usgs(service: string, maxzoom: number): () => Promise<StyleSpecification> {
  return async () => ({
    version: 8,
    glyphs: GLYPHS,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [`https://basemap.nationalmap.gov/arcgis/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`],
        tileSize: 256,
        maxzoom,
        attribution: USGS_ATTRIBUTION,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#e9e7e2' } },
      { id: 'basemap', type: 'raster', source: 'basemap' },
    ],
  });
}

/** USGS aerial imagery with OpenStreetMap labels drawn on top. */
async function imageryWithLabels(): Promise<StyleSpecification> {
  const [imagery, vector] = await Promise.all([usgs('USGSImageryOnly', 16)(), openFreeMap('positron')]);
  const { labelOverlay } = await import('./paperify.ts');
  return {
    ...imagery,
    glyphs: vector.glyphs ?? GLYPHS,
    sprite: vector.sprite,
    sources: { ...imagery.sources, ...vector.sources },
    layers: [...imagery.layers, ...labelOverlay(vector)],
  };
}

async function openFreeMap(name: string, recolor?: 'paper' | 'night'): Promise<StyleSpecification> {
  const res = await fetch(`https://tiles.openfreemap.org/styles/${name}`).catch(() => null);
  if (!res?.ok) throw new Error('This base map couldn’t load. Try another under Layers.');
  const style = (await res.json()) as StyleSpecification;
  for (const src of Object.values(style.sources)) {
    if ('attribution' in src || src.type === 'vector') (src as { attribution?: string }).attribution = OSM_ATTRIBUTION;
  }
  if (!recolor) return style;
  const { paperify } = await import('./paperify.ts');
  return paperify(style, recolor);
}

export const BASEMAPS: readonly Basemap[] = [
  {
    id: 'paper',
    label: 'Paper',
    mode: 'light',
    swatch: '#f4f2ee',
    fallback: 'topo',
    style: () => openFreeMap('positron', 'paper'),
  },
  {
    id: 'night',
    label: 'Night',
    mode: 'dark',
    swatch: '#121212',
    fallback: 'imagery',
    style: () => openFreeMap('dark', 'night'),
  },
  {
    id: 'streets',
    label: 'Streets',
    mode: 'light',
    swatch: '#f2efe9',
    fallback: 'topo',
    style: () => openFreeMap('liberty'),
  },
  { id: 'topo', label: 'USGS Topo', mode: 'light', swatch: '#d9e4c8', style: usgs('USGSTopo', 16) },
  { id: 'imagery', label: 'Aerial', mode: 'dark', swatch: '#4a5a3c', style: usgs('USGSImageryOnly', 16) },
  {
    id: 'hybrid',
    label: 'Aerial + labels',
    mode: 'dark',
    swatch: '#5d6b4c',
    fallback: 'imagery',
    style: imageryWithLabels,
  },
  { id: 'relief', label: 'Shaded relief', mode: 'light', swatch: '#cfcac0', style: usgs('USGSShadedReliefOnly', 13) },
];

export const DEFAULT_BASEMAP: BasemapId = 'paper';

export function basemapById(id: string | null | undefined): Basemap {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS.find((b) => b.id === DEFAULT_BASEMAP)!;
}
