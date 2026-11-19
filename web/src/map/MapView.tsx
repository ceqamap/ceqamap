import maplibregl, { type MapGeoJSONFeature, type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { TilePointProperties } from '../../../packages/shared/src/index.ts';
import { type Basemap, GLYPHS } from './basemaps.ts';
import { ensureProjectLayers, INTERACTIVE_LAYERS, LAYER, SOURCE_ID, SOURCE_LAYER } from './layers.ts';

/** California, with room for the header and legend. */
export const CALIFORNIA_BOUNDS: [[number, number], [number, number]] = [
  [-124.48, 32.53],
  [-114.13, 42.01],
];

export type HoverInfo =
  | { kind: 'point'; x: number; y: number; props: TilePointProperties }
  | { kind: 'cluster'; x: number; y: number; count: number; inReview: number };

export interface MapViewProps {
  basemap: Basemap;
  /** Absolute URL of the current .pmtiles file, or null while loading. */
  tilesUrl: string | null;
  selected: string | null;
  /** Fly here when a project is opened from a link and is off-screen. */
  focus: { lon: number; lat: number } | null;
  onHover: (info: HoverInfo | null) => void;
  onSelect: (sch: string | null) => void;
  onError: (message: string) => void;
}

export interface MapViewHandle {
  zoomIn(): void;
  zoomOut(): void;
  resetView(): void;
}

const BLANK_STYLE: StyleSpecification = {
  version: 8,
  glyphs: GLYPHS,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f4f2ee' } }],
};

let protocolRegistered = false;
function registerPmtiles() {
  if (protocolRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  protocolRegistered = true;
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // Latest props for event handlers registered once.
  const latest = useRef(props);
  latest.current = props;
  const hoveredId = useRef<string | null>(null);
  const appliedSelected = useRef<string | null>(null);
  const appliedTiles = useRef<string | null>(null);

  useImperativeHandle(ref, () => ({
    zoomIn: () => mapRef.current?.zoomIn(),
    zoomOut: () => mapRef.current?.zoomOut(),
    resetView: () => mapRef.current?.fitBounds(CALIFORNIA_BOUNDS, { padding: fitPadding() }),
  }));

  // --- Create the map once -------------------------------------------------
  useEffect(() => {
    registerPmtiles();
    let disposed = false;
    let map: MapLibreMap | null = null;
    let raf = 0;

    (async () => {
      let style: StyleSpecification | string;
      try {
        style = await latest.current.basemap.style();
      } catch (e) {
        // Keep the data usable even if the basemap host is down.
        latest.current.onError(String((e as Error).message));
        style = BLANK_STYLE;
      }
      if (disposed || !container.current) return;
      map = new maplibregl.Map({
        container: container.current,
        style,
        bounds: location.hash.includes('map=') ? undefined : CALIFORNIA_BOUNDS,
        fitBoundsOptions: { padding: fitPadding() },
        hash: 'map',
        minZoom: 4,
        maxZoom: 18,
        maxBounds: [
          [-140, 25],
          [-100, 50],
        ],
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        attributionControl: { compact: true },
        cooperativeGestures: false,
      });
      map.touchZoomRotate.disableRotation();
      mapRef.current = map;

      map.on('style.load', () => addDataLayers(map!));
      map.on('error', (e) => {
        // Missing tiles at the edges are normal; only surface source failures.
        if ((e as { sourceId?: string }).sourceId === SOURCE_ID) latest.current.onError('Some map data failed to load.');
      });

      map.on('mousemove', (e) => {
        const f = map!.queryRenderedFeatures(e.point, { layers: INTERACTIVE_LAYERS })[0] as MapGeoJSONFeature | undefined;
        setHovered(map!, f && !f.properties.point_count ? String(f.properties.id) : null);
        map!.getCanvas().style.cursor = f ? 'pointer' : '';
        if (!f) return latest.current.onHover(null);
        if (f.properties.point_count) {
          latest.current.onHover({
            kind: 'cluster',
            x: e.point.x,
            y: e.point.y,
            count: Number(f.properties.point_count),
            inReview: Number(f.properties.r ?? 0),
          });
        } else {
          latest.current.onHover({ kind: 'point', x: e.point.x, y: e.point.y, props: f.properties as TilePointProperties });
        }
      });
      map.getCanvas().addEventListener('mouseleave', () => {
        setHovered(map!, null);
        latest.current.onHover(null);
      });

      map.on('click', (e) => {
        const f = map!.queryRenderedFeatures(e.point, { layers: INTERACTIVE_LAYERS })[0] as MapGeoJSONFeature | undefined;
        if (!f) return latest.current.onSelect(null);
        if (f.properties.point_count) {
          const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
          map!.easeTo({ center: [lon, lat], zoom: Math.min(map!.getZoom() + 2, 14), duration: prefersReducedMotion() ? 0 : 600 });
        } else {
          latest.current.onSelect(String(f.properties.id));
        }
      });

      // Breathing halo around projects in public review.
      if (!prefersReducedMotion()) {
        let last = 0;
        const tick = (t: number) => {
          raf = requestAnimationFrame(tick);
          if (t - last < 66 || !map!.getLayer(LAYER.pulse)) return; // ~15 fps is plenty
          last = t;
          const phase = (t % 2400) / 2400;
          map!.setPaintProperty(LAYER.pulse, 'circle-radius', 6 + phase * 14);
          map!.setPaintProperty(LAYER.pulse, 'circle-opacity', 0.35 * (1 - phase));
        };
        raf = requestAnimationFrame(tick);
      }
    })();

    function addDataLayers(m: MapLibreMap) {
      const { tilesUrl, basemap } = latest.current;
      if (!tilesUrl) return;
      ensureProjectLayers(m, tilesUrl, { mode: basemap.mode });
      appliedTiles.current = tilesUrl;
      // Feature state does not survive a style change; restore the selection.
      hoveredId.current = null;
      if (appliedSelected.current) setFeature(m, appliedSelected.current, { selected: true });
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // --- Basemap switching ---------------------------------------------------
  const appliedBasemap = useRef(props.basemap.id);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedBasemap.current === props.basemap.id) return;
    appliedBasemap.current = props.basemap.id;
    let cancelled = false;
    props.basemap
      .style()
      .then((style) => {
        if (!cancelled) map.setStyle(style, { diff: false }); // style.load re-adds our layers
      })
      .catch((e: Error) => props.onError(e.message));
    return () => {
      cancelled = true;
    };
  }, [props.basemap]);

  // --- New data build: swap the tileset in place ---------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.tilesUrl || appliedTiles.current === props.tilesUrl || !map.isStyleLoaded()) return;
    const source = map.getSource(SOURCE_ID) as maplibregl.VectorTileSource | undefined;
    if (source) source.setUrl(`pmtiles://${props.tilesUrl}`);
    else ensureProjectLayers(map, props.tilesUrl, { mode: props.basemap.mode });
    appliedTiles.current = props.tilesUrl;
  }, [props.tilesUrl, props.basemap.mode]);

  // --- Selection highlight -------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const prev = appliedSelected.current;
    appliedSelected.current = props.selected;
    if (!map || !map.getSource(SOURCE_ID)) return;
    if (prev) setFeature(map, prev, { selected: false });
    if (props.selected) setFeature(map, props.selected, { selected: true });
  }, [props.selected]);

  // --- Fly to a project opened from a link ---------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.focus) return;
    const { lon, lat } = props.focus;
    if (!map.getBounds().contains([lon, lat]) || map.getZoom() < 9) {
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 12), duration: prefersReducedMotion() ? 0 : 1600 });
    }
  }, [props.focus]);

  function setHovered(map: MapLibreMap, id: string | null) {
    if (hoveredId.current === id) return;
    if (hoveredId.current) setFeature(map, hoveredId.current, { hover: false });
    if (id) setFeature(map, id, { hover: true });
    hoveredId.current = id;
  }

  return <div ref={container} className="map" role="region" aria-label="Map of CEQA projects" />;
});

function setFeature(map: MapLibreMap, id: string, state: Record<string, boolean>) {
  try {
    map.setFeatureState({ source: SOURCE_ID, sourceLayer: SOURCE_LAYER, id }, state);
  } catch {
    // Source not ready yet (e.g. mid style switch); the style.load handler restores it.
  }
}

function fitPadding() {
  const w = window.innerWidth;
  return w < 720 ? { top: 120, bottom: 140, left: 16, right: 16 } : { top: 96, bottom: 48, left: 300, right: 96 };
}
