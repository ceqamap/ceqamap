import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';

/**
 * Recolor an OpenMapTiles-schema style (OpenFreeMap Positron or Dark) into
 * the site's palette. Matching is by layer id and source-layer, so it keeps
 * working if OpenFreeMap adds or renames a few layers: anything unmatched is
 * left as is.
 */

interface Palette {
  background: string;
  water: string;
  waterway: string;
  green: string;
  landuse: string;
  building: string;
  roadMajor: string;
  roadMinor: string;
  rail: string;
  boundary: string;
  label: string;
  labelStrong: string;
  halo: string;
}

export const PALETTES: Record<'paper' | 'night', Palette> = {
  paper: {
    background: '#f4f2ee',
    water: '#d5dee2',
    waterway: '#c6d3d8',
    green: '#e9e8df',
    landuse: '#efede8',
    building: '#e6e3dc',
    roadMajor: '#ffffff',
    roadMinor: '#faf9f6',
    rail: '#e0ddd6',
    boundary: '#cfcbc3',
    label: '#8d8981',
    labelStrong: '#3b3a38',
    halo: '#f4f2ee',
  },
  night: {
    background: '#121212',
    water: '#0b0c0c',
    waterway: '#151818',
    green: '#161716',
    landuse: '#151515',
    building: '#1d1d1c',
    roadMajor: '#2b2a29',
    roadMinor: '#1f1e1e',
    rail: '#2b2a29',
    boundary: '#3b3a38',
    label: '#77746f',
    labelStrong: '#c9c6bf',
    halo: '#121212',
  },
};

type Role = keyof Palette | null;

/** Which palette role a layer plays, judged by its id and source-layer. */
export function roleFor(layer: Pick<LayerSpecification, 'id' | 'type'> & { 'source-layer'?: string }): Role {
  const id = layer.id.toLowerCase();
  const src = (layer['source-layer'] ?? '').toLowerCase();
  if (layer.type === 'background') return 'background';
  if (layer.type === 'symbol') {
    return /place|country|state|city|capital/.test(id) && !/village|hamlet|suburb|neighbourhood/.test(id)
      ? 'labelStrong'
      : 'label';
  }
  if (src === 'water' || /^water($|_)/.test(id)) return 'water';
  if (src === 'waterway' || id.includes('waterway')) return 'waterway';
  if (src === 'park' || /park|wood|grass|forest|landcover/.test(id)) return 'green';
  if (src === 'landuse' || id.includes('landuse')) return 'landuse';
  if (src === 'building' || id.includes('building')) return 'building';
  if (src === 'boundary' || id.includes('boundary') || id.includes('admin')) return 'boundary';
  if (/rail|transit/.test(id)) return 'rail';
  if (src === 'transportation' || /road|highway|street|bridge|tunnel|motorway|trunk|path/.test(id)) {
    return /motorway|trunk|primary|major/.test(id) ? 'roadMajor' : 'roadMinor';
  }
  return null;
}

export function paperify(style: StyleSpecification, palette: 'paper' | 'night'): StyleSpecification {
  const p = PALETTES[palette];
  const layers = style.layers.map((layer): LayerSpecification => {
    const role = roleFor(layer as Parameters<typeof roleFor>[0]);
    if (!role) return layer;
    const color = p[role];
    const paint = { ...(layer.paint ?? {}) } as Record<string, unknown>;
    switch (layer.type) {
      case 'background':
        paint['background-color'] = color;
        break;
      case 'fill':
        paint['fill-color'] = color;
        delete paint['fill-pattern'];
        delete paint['fill-outline-color'];
        break;
      case 'line':
        paint['line-color'] = color;
        break;
      case 'symbol':
        paint['text-color'] = color;
        paint['text-halo-color'] = p.halo;
        paint['text-halo-width'] = 1.2;
        delete paint['icon-color'];
        break;
      case 'fill-extrusion':
        paint['fill-extrusion-color'] = p.building;
        break;
      default:
        return layer;
    }
    return { ...layer, paint } as LayerSpecification;
  });
  // Points of interest compete with our data; hide their icons and labels.
  const quiet = layers.map((l) =>
    /poi|aerodrome|airport_label|housenumber/.test(l.id)
      ? ({ ...l, layout: { ...(l.layout ?? {}), visibility: 'none' } } as LayerSpecification)
      : l,
  );
  return { ...style, layers: quiet };
}
