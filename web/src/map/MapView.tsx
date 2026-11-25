import maplibregl, { type MapGeoJSONFeature, type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { MapMark, ProjectStatus, TilePointProperties } from '../../../packages/shared/src/index.ts';
import { pingProgress } from '../lib/motion.ts';
import {
  AREA_INTERACTIVE,
  AREA_LAYER,
  AREA_SOURCE,
  AREA_SOURCE_LAYER,
  applyAreaStages,
  badgeInfo,
  ensureAreaLayers,
  OUTLINE_SOURCE,
  showAreaOutline,
} from './areaLayers.ts';
import { type Basemap, type BasemapId, GLYPHS } from './basemaps.ts';
import { BasemapWatch, type MapErrorLike } from './basemapWatch.ts';
import {
  applyStages,
  arrivalOpacity,
  arrivalRadius,
  clusterCounts,
  ensureProjectLayers,
  INTERACTIVE_LAYERS,
  LAYER,
  SOURCE_ID,
  SOURCE_LAYER,
} from './layers.ts';

/** Our own data sources: their errors are ours to report, not a basemap outage. */
const DATA_SOURCES = [SOURCE_ID, AREA_SOURCE, OUTLINE_SOURCE];

/** California, with room for the header and legend. */
export const CALIFORNIA_BOUNDS: [[number, number], [number, number]] = [
  [-124.48, 32.53],
  [-114.13, 42.01],
];

export type HoverInfo =
  | { kind: 'point'; x: number; y: number; props: TilePointProperties }
  | {
      kind: 'cluster';
      x: number;
      y: number;
      count: number;
      inReview: number;
      arrived: number;
    }
  | {
      /** A city, ZIP code or county badge: projects known only to that area. */
      kind: 'area';
      x: number;
      y: number;
      name: string;
      count: number;
      inReview: number;
      arrived: number;
      /** What the records list: a city, a ZIP code, a county; `several` for "cities", "counties". */
      listed: 'city' | 'zip' | 'county' | 'mixed';
      several: boolean;
    };

/** Zoom for a project opened from a link: streets are labeled and clusters have split (cluster-maxzoom is 12). */
const LINK_ZOOM = 15;

/** A selected project known only to an area: outline these, in this color. */
export interface SelectedArea {
  keys: string[];
  bbox: [number, number, number, number];
  color: string;
}

export interface MapViewProps {
  basemap: Basemap;
  /** Absolute URL of the current .pmtiles file, or null while loading. */
  tilesUrl: string | null;
  /** Absolute URL of the current area tileset (the sunflowers from z11), if the data has one. */
  areaTilesUrl: string | null;
  /** Absolute URL of the city, ZIP and county outlines tileset, if the data has one. */
  boundariesUrl: string | null;
  /** The selected project's area, when it is known only to one. */
  selectedArea: SelectedArea | null;
  /** Stages the legend shows. */
  stages: readonly ProjectStatus[];
  /** Locations (map marks) the legend shows. */
  marks: readonly MapMark[];
  selected: string | null;
  /** Fly here when a project is opened from a link and is off-screen; frame `bbox` if given (an area). */
  focus: { lon: number; lat: number; bbox?: [number, number, number, number] } | null;
  onHover: (info: HoverInfo | null) => void;
  onSelect: (sch: string | null) => void;
  onError: (message: string) => void;
  /** The basemap's tile host is down (see basemapWatch.ts); show its fallback. */
  onBasemapDown: (id: BasemapId) => void;
}

export interface MapViewHandle {
  zoomIn(): void;
  zoomOut(): void;
  resetView(): void;
  /** Frame these positions (e.g. the latest arrivals). */
  showPlaces(places: { lon: number; lat: number }[]): void;
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

/** Clickable layers present on the map (area layers exist only with area data). */
function interactiveLayers(map: MapLibreMap): string[] {
  return [...AREA_INTERACTIVE, ...INTERACTIVE_LAYERS].filter((id) => map.getLayer(id));
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // Latest props for event handlers registered once.
  const latest = useRef(props);
  latest.current = props;
  const hoveredId = useRef<string | null>(null);
  const appliedSelected = useRef<string | null>(null);
  const appliedTiles = useRef<string | null>(null);
  const appliedAreaTiles = useRef<string | null>(null);
  const appliedBoundaries = useRef<string | null>(null);
  const basemapWatch = useRef(
    new BasemapWatch(DATA_SOURCES, () => latest.current.onBasemapDown(latest.current.basemap.id)),
  );
  // True between a style's 'style.load' and the next setStyle. We track this
  // ourselves: map.isStyleLoaded() is also false while basemap tiles are still
  // streaming in, which made us skip adding the project layers (2026-11-19).
  const styleReady = useRef(false);
  // Set once the map exists. The style is fetched first, so a project opened
  // from a link can arrive before there is a map to move.
  const [mapReady, setMapReady] = useState(false);

  useImperativeHandle(ref, () => ({
    zoomIn: () => mapRef.current?.zoomIn(),
    zoomOut: () => mapRef.current?.zoomOut(),
    resetView: () => mapRef.current?.fitBounds(CALIFORNIA_BOUNDS, { padding: fitPadding() }),
    showPlaces: (places) => {
      const map = mapRef.current;
      if (!map || places.length === 0) return;
      const duration = prefersReducedMotion() ? 0 : 1200;
      if (places.length === 1) {
        map.flyTo({ center: [places[0].lon, places[0].lat], zoom: Math.max(map.getZoom(), 12), duration });
        return;
      }
      const bounds = new maplibregl.LngLatBounds();
      for (const p of places) bounds.extend([p.lon, p.lat]);
      map.fitBounds(bounds, { padding: fitPadding(), maxZoom: 12, duration });
    },
  }));

  // --- Create the map once -------------------------------------------------
  useEffect(() => {
    registerPmtiles();
    let disposed = false;
    let map: MapLibreMap | null = null;
    let raf = 0;
    let unplaceCredits = () => {};

    (async () => {
      let style: StyleSpecification | string;
      try {
        style = await latest.current.basemap.style();
      } catch (e) {
        // Keep the data usable even if the basemap host is down, and switch to the fallback if there is one.
        if (latest.current.basemap.fallback) latest.current.onBasemapDown(latest.current.basemap.id);
        else latest.current.onError(String((e as Error).message));
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
        attributionControl: false,
        cooperativeGestures: false,
      });
      map.touchZoomRotate.disableRotation();
      // Credits: in the bottom-right corner on desktop; on phones, in the
      // controls column under the zoom buttons (see Controls). Added as usual,
      // then moved between the two as the window crosses the breakpoint.
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
      const credits = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
      // MapLibre opens compact credits when it first makes them compact; start
      // them closed (the "i") instead. It doesn't reopen them after that.
      if (credits) {
        const collapse = () => {
          if (!credits.classList.contains('maplibregl-compact')) return false;
          credits.classList.remove('maplibregl-compact-show');
          credits.removeAttribute('open');
          return true;
        };
        if (!collapse()) {
          const watch = new MutationObserver(() => collapse() && watch.disconnect());
          watch.observe(credits, { attributes: true, attributeFilter: ['class'] });
        }
      }
      const corner = credits?.parentElement;
      const phone = window.matchMedia('(max-width: 719px)');
      const placeCredits = () => {
        const slot = document.getElementById('map-attribution');
        const target = phone.matches && slot ? slot : corner;
        if (credits && target && credits.parentElement !== target) target.appendChild(credits);
      };
      placeCredits();
      phone.addEventListener('change', placeCredits);
      unplaceCredits = () => phone.removeEventListener('change', placeCredits);
      mapRef.current = map;
      setMapReady(true);

      map.on('style.load', () => {
        styleReady.current = true;
        addDataLayers(map!);
      });
      map.on('error', (e) => {
        // Missing tiles at the edges are normal; only surface source failures.
        const source = (e as { sourceId?: string }).sourceId;
        if (source === SOURCE_ID || source === AREA_SOURCE) latest.current.onError('Some map data failed to load.');
        // The basemap's own host failing: switch to its fallback.
        if (latest.current.basemap.fallback) basemapWatch.current.report(e as MapErrorLike);
      });

      map.on('mousemove', (e) => {
        const f = map!.queryRenderedFeatures(e.point, { layers: interactiveLayers(map!) })[0] as
          MapGeoJSONFeature | undefined;
        setHovered(map!, f && !f.properties.point_count ? f : null);
        map!.getCanvas().style.cursor = f ? 'pointer' : '';
        if (!f) return latest.current.onHover(null);
        if (f.properties.f === 'b') {
          latest.current.onHover({
            kind: 'area',
            x: e.point.x,
            y: e.point.y,
            ...badgeInfo(f.properties, latest.current.stages),
          });
        } else if (f.properties.point_count) {
          latest.current.onHover({
            kind: 'cluster',
            x: e.point.x,
            y: e.point.y,
            ...clusterCounts(f.properties, latest.current.stages, latest.current.marks),
          });
        } else {
          latest.current.onHover({
            kind: 'point',
            x: e.point.x,
            y: e.point.y,
            props: f.properties as TilePointProperties,
          });
        }
      });
      map.getCanvas().addEventListener('mouseleave', () => {
        setHovered(map!, null);
        latest.current.onHover(null);
      });

      map.on('click', (e) => {
        const f = map!.queryRenderedFeatures(e.point, { layers: interactiveLayers(map!) })[0] as
          MapGeoJSONFeature | undefined;
        if (!f) return latest.current.onSelect(null);
        if (f.properties.f === 'b') {
          // An area badge: zoom in on its downtown, where its projects spread out.
          const [lon, lat] = (f.geometry as { coordinates: [number, number] }).coordinates;
          map!.easeTo({
            center: [lon, lat],
            zoom: Math.max(map!.getZoom() + 1, 12),
            duration: prefersReducedMotion() ? 0 : 700,
          });
        } else if (f.properties.point_count) {
          const [lon, lat] = (f.geometry as { coordinates: [number, number] }).coordinates;
          map!.easeTo({
            center: [lon, lat],
            zoom: Math.min(map!.getZoom() + 2, 14),
            duration: prefersReducedMotion() ? 0 : 600,
          });
        } else {
          latest.current.onSelect(String(f.properties.id));
        }
      });

      // Breathing halo around projects in public review, and the header's
      // ping around projects that just arrived. The frame timestamp shares
      // performance.now()'s clock, which the header's ping is aligned to.
      if (!prefersReducedMotion()) {
        let last = 0;
        const tick = (t: number) => {
          raf = requestAnimationFrame(tick);
          if (t - last < 66 || !map!.getLayer(LAYER.pulse)) return; // ~15 fps is plenty
          last = t;
          const phase = (t % 2400) / 2400;
          map!.setPaintProperty(LAYER.pulse, 'circle-radius', 6 + phase * 14);
          map!.setPaintProperty(LAYER.pulse, 'circle-opacity', 0.35 * (1 - phase));
          if (map!.getLayer(LAYER.arrivals)) {
            const ping = pingProgress(t);
            map!.setPaintProperty(
              LAYER.arrivals,
              'circle-radius',
              arrivalRadius(latest.current.stages, ping, latest.current.selected, latest.current.marks),
            );
            map!.setPaintProperty(LAYER.arrivals, 'circle-stroke-opacity', arrivalOpacity(ping));
            if (map!.getLayer(AREA_LAYER.arrivals)) {
              map!.setPaintProperty(
                AREA_LAYER.arrivals,
                'circle-radius',
                arrivalRadius(latest.current.stages, ping, latest.current.selected, latest.current.marks),
              );
              map!.setPaintProperty(AREA_LAYER.arrivals, 'circle-stroke-opacity', arrivalOpacity(ping));
            }
          }
        };
        raf = requestAnimationFrame(tick);
      }
    })();

    function addDataLayers(m: MapLibreMap) {
      const { tilesUrl, basemap } = latest.current;
      if (!tilesUrl) return;
      const theme = { mode: basemap.mode, stages: latest.current.stages, marks: latest.current.marks };
      ensureProjectLayers(m, tilesUrl, theme);
      appliedTiles.current = tilesUrl;
      const { areaTilesUrl, boundariesUrl, selectedArea } = latest.current;
      if (areaTilesUrl) {
        ensureAreaLayers(m, areaTilesUrl, boundariesUrl, theme, LAYER.pulse);
        appliedAreaTiles.current = areaTilesUrl;
        appliedBoundaries.current = boundariesUrl;
        showAreaOutline(m, selectedArea);
      }
      // Feature state does not survive a style change; restore the selection.
      hoveredId.current = null;
      if (appliedSelected.current) setFeature(m, appliedSelected.current, { selected: true });
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      unplaceCredits();
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // --- Basemap switching ---------------------------------------------------
  const appliedBasemap = useRef(props.basemap.id);
  const { basemap } = props;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedBasemap.current === basemap.id) return;
    appliedBasemap.current = basemap.id;
    let cancelled = false;
    basemap
      .style()
      .then((style) => {
        if (cancelled) return;
        styleReady.current = false;
        basemapWatch.current.reset();
        map.setStyle(style, { diff: false }); // style.load re-adds our layers
      })
      .catch((e: Error) => {
        if (cancelled) return;
        if (basemap.fallback) latest.current.onBasemapDown(basemap.id);
        else latest.current.onError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [basemap]);

  // --- New data build: swap the tileset in place ---------------------------
  useEffect(() => {
    const map = mapRef.current;
    // If the style isn't ready yet, its style.load handler adds the layers with the latest URL.
    if (!map || !props.tilesUrl || appliedTiles.current === props.tilesUrl || !styleReady.current) return;
    const source = map.getSource(SOURCE_ID) as maplibregl.VectorTileSource | undefined;
    if (source) source.setUrl(`pmtiles://${props.tilesUrl}`);
    else {
      ensureProjectLayers(map, props.tilesUrl, {
        mode: props.basemap.mode,
        stages: latest.current.stages,
        marks: latest.current.marks,
      });
      // The style loaded before the data did, so the selection had no source to mark yet.
      if (appliedSelected.current) setFeature(map, appliedSelected.current, { selected: true });
    }
    appliedTiles.current = props.tilesUrl;
  }, [props.tilesUrl, props.basemap.mode]);

  // --- Area tiles and outlines: swap in place, or add once the data has them --
  useEffect(() => {
    const map = mapRef.current;
    const { areaTilesUrl, boundariesUrl } = props;
    if (!map || !styleReady.current || !areaTilesUrl || !map.getSource(SOURCE_ID)) return;
    if (appliedAreaTiles.current === areaTilesUrl && appliedBoundaries.current === boundariesUrl) return;
    const areas = map.getSource(AREA_SOURCE) as maplibregl.VectorTileSource | undefined;
    const outlines = map.getSource(OUTLINE_SOURCE) as maplibregl.VectorTileSource | undefined;
    if (areas && (outlines || !boundariesUrl)) {
      areas.setUrl(`pmtiles://${areaTilesUrl}`);
      if (outlines && boundariesUrl) outlines.setUrl(`pmtiles://${boundariesUrl}`);
    } else {
      ensureAreaLayers(
        map,
        areaTilesUrl,
        boundariesUrl,
        { mode: props.basemap.mode, stages: latest.current.stages, marks: latest.current.marks },
        LAYER.pulse,
      );
      showAreaOutline(map, latest.current.selectedArea);
      if (appliedSelected.current) setFeature(map, appliedSelected.current, { selected: true });
    }
    appliedAreaTiles.current = areaTilesUrl;
    appliedBoundaries.current = boundariesUrl;
  }, [props.areaTilesUrl, props.boundariesUrl, props.basemap.mode]);

  // --- Legend stage and location filters: restyle in place, no tile reload --
  const appliedFilters = useRef({ stages: props.stages, marks: props.marks });
  useEffect(() => {
    const map = mapRef.current;
    const applied = appliedFilters.current;
    if (applied.stages === props.stages && applied.marks === props.marks) return;
    appliedFilters.current = { stages: props.stages, marks: props.marks };
    // Before the style is ready, style.load adds the layers with the latest filters.
    if (!map || !styleReady.current || !map.getSource(SOURCE_ID)) return;
    applyStages(map, { mode: props.basemap.mode, stages: props.stages, marks: props.marks });
    if (map.getSource(AREA_SOURCE))
      applyAreaStages(map, { mode: props.basemap.mode, stages: props.stages, marks: props.marks });
  }, [props.stages, props.marks, props.basemap.mode]);

  // --- Selection highlight -------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const prev = appliedSelected.current;
    appliedSelected.current = props.selected;
    if (!map || !map.getSource(SOURCE_ID)) return;
    if (prev) setFeature(map, prev, { selected: false });
    if (props.selected) setFeature(map, props.selected, { selected: true });
  }, [props.selected]);

  // --- Selected project's area outline -------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady.current) return;
    showAreaOutline(map, props.selectedArea);
  }, [props.selectedArea]);

  // --- Fly to a project opened from a link ---------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.focus) return;
    const { lon, lat, bbox } = props.focus;
    const duration = prefersReducedMotion() ? 0 : 1600;
    if (bbox) {
      // Known only to an area: frame the area, not a spot we don't have.
      const view = map.getBounds();
      const inView = view.contains([bbox[0], bbox[1]]) && view.contains([bbox[2], bbox[3]]);
      const area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
      const viewArea = (view.getEast() - view.getWest()) * (view.getNorth() - view.getSouth());
      if (!inView || area < viewArea / 50)
        map.fitBounds(
          [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[3]],
          ],
          { padding: fitPadding(), maxZoom: 13, duration },
        );
      return;
    }
    // Street level, past the cluster zoom, so the selected dot itself shows.
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), LINK_ZOOM), duration });
  }, [props.focus, mapReady]);

  function setHovered(map: MapLibreMap, f: MapGeoJSONFeature | null) {
    const id = f ? String(f.properties.id) : null;
    if (hoveredId.current === id) return;
    if (hoveredId.current) setFeature(map, hoveredId.current, { hover: false });
    if (id) setFeature(map, id, { hover: true });
    hoveredId.current = id;
  }

  return <div ref={container} className="map" role="region" aria-label="Map of CEQA projects" />;
});

/** Set state on a project in whichever source holds it. */
function setFeature(map: MapLibreMap, id: string, state: Record<string, boolean>) {
  for (const [source, sourceLayer] of [
    [SOURCE_ID, SOURCE_LAYER],
    [AREA_SOURCE, AREA_SOURCE_LAYER],
  ]) {
    if (!map.getSource(source)) continue;
    try {
      map.setFeatureState({ source, sourceLayer, id }, state);
    } catch {
      // Source not ready yet (e.g. mid style switch); the style.load handler restores it.
    }
  }
}

function fitPadding() {
  const w = window.innerWidth;
  // On phones the map runs under the browser's bottom bar (see .map in app.css);
  // pad by the part of it below the visible area so fits land in view.
  const map = document.querySelector('.map');
  const hidden = map ? Math.max(0, Math.round(map.getBoundingClientRect().bottom - window.innerHeight)) : 0;
  return w < 720
    ? { top: 120, bottom: 140 + hidden, left: 16, right: 16 }
    : { top: 96, bottom: 48 + hidden, left: 300, right: 96 };
}
