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
  // Land stays at the #121212 surface the stage colors were validated on;
  // everything else steps away from it so water, parks, streets and labels
  // read apart (the first version had water and land 3 levels apart).
  night: {
    background: '#121212',
    water: '#0c171d',
    waterway: '#1a2b34',
    green: '#182a1d',
    landuse: '#171716',
    building: '#21201f',
    roadMajor: '#3d3b38',
    roadMinor: '#292826',
    rail: '#33312e',
    boundary: '#55524d',
    label: '#8f8b84',
    labelStrong: '#d6d3cc',
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

/**
 * Turn an OpenMapTiles style into a transparent overlay for aerial imagery:
 * place names, major roads, and boundaries only, in white with a dark halo.
 * Used for "Aerial + labels" after USGS retired its USGSImageryTopo service.
 */
export function labelOverlay(style: StyleSpecification): LayerSpecification[] {
  const keep = (l: LayerSpecification) => {
    const id = l.id.toLowerCase();
    if (/poi|housenumber|aerodrome|airport|mountain_peak|water_name|waterway/.test(id)) return false;
    if (l.type === 'symbol') return Boolean((l.layout as Record<string, unknown> | undefined)?.['text-field']);
    if (l.type === 'line') return /boundary|admin|motorway|trunk|primary/.test(id) && !/casing|tunnel/.test(id);
    return false;
  };
  return style.layers.filter(keep).map((l): LayerSpecification => {
    if (l.type === 'symbol') {
      const layout = { ...(l.layout ?? {}) } as Record<string, unknown>;
      delete layout['icon-image'];
      return {
        ...l,
        id: `labels-${l.id}`,
        layout,
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0, 0, 0, 0.75)', 'text-halo-width': 1.4 },
      } as LayerSpecification;
    }
    const isBoundary = /boundary|admin/.test(l.id.toLowerCase());
    const paint = { ...(l.paint ?? {}) } as Record<string, unknown>;
    paint['line-color'] = isBoundary ? 'rgba(255, 255, 255, 0.55)' : 'rgba(255, 255, 255, 0.35)';
    delete paint['line-opacity'];
    return { ...l, id: `labels-${l.id}`, paint } as LayerSpecification;
  });
}
