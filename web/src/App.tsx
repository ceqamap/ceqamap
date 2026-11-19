import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PublishedMeta, PublishedProject } from '../../packages/shared/src/index.ts';
import { Controls } from './components/Controls.tsx';
import { Drawer } from './components/Drawer.tsx';
import { Header } from './components/Header.tsx';
import { HoverCard } from './components/HoverCard.tsx';
import { Legend } from './components/Legend.tsx';
import { absoluteDataUrl, fetchMeta, META_POLL_MS } from './lib/data.ts';
import { basemapById, type BasemapId } from './map/basemaps.ts';
import { type HoverInfo, MapView, type MapViewHandle } from './map/MapView.tsx';

/**
 * URL state, so every view is shareable:
 *   ?p=2025100575   open project
 *   ?b=imagery      basemap
 *   #map=12/40.58/-122.39   map position (managed by MapLibre)
 */
function readParam(name: string): string | null {
  return new URLSearchParams(location.search).get(name);
}
function writeParam(name: string, value: string | null, push: boolean) {
  const url = new URL(location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  if (url.href === location.href) return;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

const canHover = window.matchMedia('(hover: hover)').matches;

export function App() {
  const map = useRef<MapViewHandle>(null);
  const [meta, setMeta] = useState<PublishedMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [basemapId, setBasemapId] = useState<BasemapId>(() => basemapById(readParam('b')).id);
  const [selected, setSelected] = useState<string | null>(() => readParam('p'));
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [focus, setFocus] = useState<{ lon: number; lat: number } | null>(null);
  const openedFromLink = useRef(selected !== null);

  const basemap = useMemo(() => basemapById(basemapId), [basemapId]);
  const tilesUrl = meta ? absoluteDataUrl(meta.tiles) : null;

  // Load meta, then poll so the map refreshes itself when new filings land.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchMeta()
        .then((m) => {
          if (!alive) return;
          setError(null);
          setMeta((prev) => (prev?.buildId === m.buildId ? prev : m));
        })
        .catch((e: Error) => alive && setError(e.message));
    load();
    const id = setInterval(load, META_POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    const onPop = () => setSelected(readParam('p'));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const select = useCallback((sch: string | null) => {
    setSelected(sch);
    writeParam('p', sch, true);
  }, []);
  const close = useCallback(() => select(null), [select]);

  const onLoaded = useCallback((p: PublishedProject) => {
    // Only fly when the project was opened from a shared link, not a click.
    if (openedFromLink.current && p.location) setFocus({ lon: p.location.lon, lat: p.location.lat });
    openedFromLink.current = false;
  }, []);

  const changeBasemap = useCallback((id: BasemapId) => {
    setMapError(null);
    setBasemapId(id);
    writeParam('b', id === 'paper' ? null : id, false);
  }, []);

  return (
    <div className={`app mode-${basemap.mode} ${selected ? 'drawer-open' : ''}`}>
      <MapView
        ref={map}
        basemap={basemap}
        tilesUrl={tilesUrl}
        selected={selected}
        focus={focus}
        onHover={canHover ? setHover : () => {}}
        onSelect={select}
        onError={setMapError}
      />
      <div className="frame" aria-hidden="true">
        <span className="tick tl" />
        <span className="tick tr" />
        <span className="tick bl" />
        <span className="tick br" />
      </div>
      <Header meta={meta} error={error} />
      <Controls
        basemap={basemapId}
        onBasemap={changeBasemap}
        onZoomIn={() => map.current?.zoomIn()}
        onZoomOut={() => map.current?.zoomOut()}
        onReset={() => map.current?.resetView()}
      />
      <Legend meta={meta} mode={basemap.mode} />
      <HoverCard info={hover} mode={basemap.mode} />
      {mapError && (
        <p className="toast card" role="status">
          {mapError}
        </p>
      )}
      <Drawer sch={selected} mode="light" onClose={close} onLoaded={onLoaded} />
    </div>
  );
}
