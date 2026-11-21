import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  inScope,
  narrowestScopeFor,
  type ProjectStatus,
  type PublishedMeta,
  type PublishedProject,
  type TimeScope,
} from '../../packages/shared/src/index.ts';
import { Controls } from './components/Controls.tsx';
import { Drawer } from './components/Drawer.tsx';
import { Header } from './components/Header.tsx';
import { HoverCard } from './components/HoverCard.tsx';
import { Legend } from './components/Legend.tsx';
import { absoluteDataUrl, DataStatusError, fetchMeta, META_POLL_MS, META_POLL_PENDING_MS } from './lib/data.ts';
import { filterParams, readScope, readStages } from './lib/filters.ts';
import { todayInCalifornia } from './lib/format.ts';
import { basemapById, type BasemapId } from './map/basemaps.ts';
import { type HoverInfo, MapView, type MapViewHandle } from './map/MapView.tsx';

/**
 * URL state, so every view is shareable:
 *   ?p=2025100575   open project
 *   ?b=imagery      basemap
 *   ?t=30d          time window (default: past 12 months)
 *   ?stages=…       stages shown (default: all); see lib/filters.ts
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
  const [dataStatus, setDataStatus] = useState<DataStatusError | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [basemapId, setBasemapId] = useState<BasemapId>(() => basemapById(readParam('b')).id);
  const [selected, setSelected] = useState<string | null>(() => readParam('p'));
  const [scope, setScope] = useState<TimeScope>(() => readScope(new URLSearchParams(location.search)));
  const [stages, setStages] = useState<ProjectStatus[]>(() => readStages(new URLSearchParams(location.search)));
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [focus, setFocus] = useState<{ lon: number; lat: number } | null>(null);
  const openedFromLink = useRef(selected !== null);

  const basemap = useMemo(() => basemapById(basemapId), [basemapId]);
  // Each time window has its own tileset; data built before windows existed has only `tiles`.
  const tilesUrl = meta ? absoluteDataUrl(meta.scopes?.[scope]?.tiles || meta.tiles) : null;

  // Load meta, then poll so the map refreshes itself when new filings land.
  // Poll every minute until data exists, then every five minutes.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(timer);
      let ok = false;
      try {
        const m = await fetchMeta();
        if (!alive) return;
        ok = true;
        setDataStatus(null);
        setMeta((prev) => (prev?.buildId === m.buildId ? prev : m));
      } catch (e) {
        if (!alive) return;
        setDataStatus(
          e instanceof DataStatusError ? e : new DataStatusError('unreachable', 'Can’t reach the map data right now.'),
        );
      }
      timer = setTimeout(load, ok ? META_POLL_MS : META_POLL_PENDING_MS);
    };
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(location.search);
      setSelected(params.get('p'));
      setScope(readScope(params));
      setStages(readStages(params));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const select = useCallback((sch: string | null) => {
    setSelected(sch);
    writeParam('p', sch, true);
  }, []);
  const close = useCallback(() => select(null), [select]);

  const changeFilters = useCallback((nextScope: TimeScope, nextStages: ProjectStatus[]) => {
    setScope(nextScope);
    setStages(nextStages);
    const params = filterParams(nextScope, nextStages);
    writeParam('t', params.t, false);
    writeParam('stages', params.stages, false);
  }, []);

  // Latest values for callbacks that should not re-run on every filter change.
  const current = useRef({ scope, stages, meta });
  current.current = { scope, stages, meta };

  const onLoaded = useCallback(
    (p: PublishedProject) => {
      // Only fly when the project was opened from a shared link, not a click.
      if (openedFromLink.current && p.location) {
        setFocus({ lon: p.location.lon, lat: p.location.lat });
        // Make sure the linked project is actually drawn: widen the time
        // window and show its stage if the current filters hide it.
        const { scope: s, stages: st, meta: m } = current.current;
        const facts = {
          lastFiling: p.documents[0]?.received ?? p.statusDate,
          status: p.status,
          arrived: m?.arrivals?.items.some((i) => i.id === p.sch) ?? false,
        };
        const today = todayInCalifornia();
        const nextScope = inScope(s, today, facts) ? s : narrowestScopeFor(today, facts);
        const nextStages = st.includes(p.status) ? st : [...st, p.status];
        if (nextScope !== s || nextStages !== st) changeFilters(nextScope, nextStages);
      }
      openedFromLink.current = false;
    },
    [changeFilters],
  );

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
        stages={stages}
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
      <Header
        meta={meta}
        status={dataStatus}
        scope={scope}
        stages={stages}
        onScope={(t) => changeFilters(t, stages)}
        onShowArrivals={(places) => map.current?.showPlaces(places)}
      />
      <Controls
        basemap={basemapId}
        onBasemap={changeBasemap}
        onZoomIn={() => map.current?.zoomIn()}
        onZoomOut={() => map.current?.zoomOut()}
        onReset={() => map.current?.resetView()}
      />
      <Legend
        meta={meta}
        mode={basemap.mode}
        scope={scope}
        stages={stages}
        onStages={(st) => changeFilters(scope, st)}
      />
      <HoverCard info={hover} mode={basemap.mode} arrivals={meta?.arrivals} />
      {mapError && (
        <p className="toast card" role="status">
          {mapError}
        </p>
      )}
      <Drawer sch={selected} mode="light" onClose={close} onLoaded={onLoaded} />
    </div>
  );
}
