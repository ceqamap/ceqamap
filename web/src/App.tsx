import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  inScope,
  type MapMark,
  markOf,
  narrowestScopeFor,
  PRECISION_MARK,
  type ProjectStatus,
  type PublishedMeta,
  type PublishedProject,
  STATUS_BY_ID,
  type TimeScope,
} from '../../packages/shared/src/index.ts';
import { Controls } from './components/Controls.tsx';
import { Drawer } from './components/Drawer.tsx';
import { Header } from './components/Header.tsx';
import { HoverCard } from './components/HoverCard.tsx';
import { Legend } from './components/Legend.tsx';
import { absoluteDataUrl, DataStatusError, fetchMeta, META_POLL_MS, META_POLL_PENDING_MS } from './lib/data.ts';
import { ALL_MARKS, filterParams, marksSupported, readMarks, readScope, readStages } from './lib/filters.ts';
import { todayInCalifornia } from './lib/format.ts';
import { basemapById, type BasemapId } from './map/basemaps.ts';
import { type HoverInfo, MapView, type MapViewHandle, type SelectedArea } from './map/MapView.tsx';

/**
 * URL state, so every view is shareable:
 *   ?p=2025100575   open project
 *   ?b=imagery      basemap
 *   ?t=30d          time window (default: past 12 months)
 *   ?stages=…       stages shown (default: all); see lib/filters.ts
 *   ?marks=…        locations shown (default: all); see lib/filters.ts
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
  const [marksWanted, setMarks] = useState<MapMark[]>(() => readMarks(new URLSearchParams(location.search)));
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [focus, setFocus] = useState<{
    lon: number;
    lat: number;
    bbox?: [number, number, number, number];
  } | null>(null);
  // The selected project's area, when it's known only to a city, ZIP code or county.
  const [loadedArea, setLoadedArea] = useState<{
    sch: string;
    area: Omit<SelectedArea, 'color'>;
    status: ProjectStatus;
  } | null>(null);
  const openedFromLink = useRef(selected !== null);

  const basemap = useMemo(() => basemapById(basemapId), [basemapId]);

  // Phone browsers paint their own bar areas (status bar, iOS Safari's address
  // and tab bars) with the page background or theme color; the map can't draw
  // there. Match them to the basemap so they read as map, not as white strips.
  useEffect(() => {
    document.documentElement.style.setProperty('--page', basemap.swatch);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', basemap.swatch);
  }, [basemap]);
  // The location filter needs per stage-and-location counts in the data; until
  // a build has them, every location shows (and the legend's rows don't toggle).
  const canFilterMarks = marksSupported(meta, scope);
  const marks = canFilterMarks ? marksWanted : ALL_MARKS;

  // Each time window has its own tileset; data built before windows existed has only `tiles`.
  const tilesUrl = meta ? absoluteDataUrl(meta.scopes?.[scope]?.tiles || meta.tiles) : null;
  // Projects known only to an area, and the outlines (absent in data built before them).
  const areaTiles = meta?.scopes?.[scope]?.areaTiles;
  const areaTilesUrl = areaTiles ? absoluteDataUrl(areaTiles) : null;
  const boundariesUrl = meta?.boundaries ? absoluteDataUrl(meta.boundaries) : null;

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
      setMarks(readMarks(params));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const select = useCallback((sch: string | null) => {
    setSelected(sch);
    writeParam('p', sch, true);
  }, []);
  const close = useCallback(() => select(null), [select]);

  const changeFilters = useCallback(
    (nextScope: TimeScope, nextStages: ProjectStatus[], nextMarks: readonly MapMark[]) => {
      setScope(nextScope);
      setStages(nextStages);
      setMarks([...nextMarks]);
      const params = filterParams(nextScope, nextStages, nextMarks);
      writeParam('t', params.t, false);
      writeParam('stages', params.stages, false);
      writeParam('marks', params.marks, false);
    },
    [],
  );

  // "N new" in the header steps through the latest arrivals, one project at a
  // time: fly there and open it. (They are spread across the state, so framing
  // them all at once mostly shows California.)
  const [arrivalIndex, setArrivalIndex] = useState<number | null>(null);
  const mappedArrivals = useMemo(
    () => meta?.arrivals?.items.filter((i) => i.lon !== null && i.lat !== null) ?? [],
    [meta?.arrivals],
  );
  useEffect(() => setArrivalIndex(null), [meta?.arrivals?.at]);
  const nextArrival = useCallback(() => {
    if (mappedArrivals.length === 0) return;
    const i = arrivalIndex === null ? 0 : (arrivalIndex + 1) % mappedArrivals.length;
    const item = mappedArrivals[i];
    setArrivalIndex(i);
    map.current?.showPlaces([{ lon: item.lon!, lat: item.lat! }]);
    select(item.id);
  }, [arrivalIndex, mappedArrivals, select]);

  // Latest values for callbacks that should not re-run on every filter change.
  const current = useRef({ scope, stages, marks: marksWanted, meta });
  current.current = { scope, stages, marks: marksWanted, meta };

  const onLoaded = useCallback(
    (p: PublishedProject) => {
      const area = p.location?.area;
      setLoadedArea(area ? { sch: p.sch, area: { keys: area.keys, bbox: area.bbox }, status: p.status } : null);
      // Only fly when the project was opened from a shared link, not a click.
      if (openedFromLink.current && p.location) {
        setFocus({ lon: p.location.lon, lat: p.location.lat, ...(area ? { bbox: area.bbox } : {}) });
        // Make sure the linked project is actually drawn: widen the time
        // window and show its stage and location if the current filters hide it.
        const { scope: s, stages: st, marks: mk, meta: m } = current.current;
        const facts = {
          lastFiling: p.documents[0]?.received ?? p.statusDate,
          status: p.status,
          arrived: m?.arrivals?.items.some((i) => i.id === p.sch) ?? false,
        };
        const today = todayInCalifornia();
        const nextScope = inScope(s, today, facts) ? s : narrowestScopeFor(today, facts);
        const nextStages = st.includes(p.status) ? st : [...st, p.status];
        const mark = markOf(PRECISION_MARK[p.location.precision]);
        const nextMarks = mk.includes(mark) ? mk : ALL_MARKS.filter((x) => x === mark || mk.includes(x));
        if (nextScope !== s || nextStages !== st || nextMarks !== mk) changeFilters(nextScope, nextStages, nextMarks);
      }
      openedFromLink.current = false;
    },
    [changeFilters],
  );

  // Outline the selected project's area in its stage color; nothing once it's closed.
  const selectedArea = useMemo<SelectedArea | null>(
    () =>
      loadedArea && loadedArea.sch === selected
        ? { ...loadedArea.area, color: STATUS_BY_ID[loadedArea.status][basemap.mode] }
        : null,
    [loadedArea, selected, basemap.mode],
  );

  const changeBasemap = useCallback((id: BasemapId) => {
    setMapError(null);
    setBasemapId(id);
    writeParam('b', id === 'paper' ? null : id, false);
  }, []);

  // A basemap's tile host is down: show its fallback, but keep the visitor's
  // choice in the link, so the next visit tries it again.
  const basemapDown = useCallback((id: BasemapId) => {
    const down = basemapById(id);
    if (!down.fallback) return;
    const fallback = basemapById(down.fallback);
    setBasemapId((current) => (current === id ? fallback.id : current));
    const notice = `The ${down.label} map isn’t loading right now, so you’re seeing ${fallback.label}.`;
    setMapError(notice);
    // The map works; the notice needn't stay.
    window.setTimeout(() => setMapError((m) => (m === notice ? null : m)), 8000);
  }, []);

  return (
    <div className={`app mode-${basemap.mode} ${selected ? 'drawer-open' : ''}`}>
      <MapView
        ref={map}
        basemap={basemap}
        tilesUrl={tilesUrl}
        areaTilesUrl={areaTilesUrl}
        boundariesUrl={boundariesUrl}
        selectedArea={selectedArea}
        stages={stages}
        marks={marks}
        selected={selected}
        focus={focus}
        onHover={canHover ? setHover : () => {}}
        onSelect={select}
        onError={setMapError}
        onBasemapDown={basemapDown}
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
        marks={marks}
        onScope={(t) => changeFilters(t, stages, marksWanted)}
        arrivalIndex={arrivalIndex}
        onNextArrival={nextArrival}
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
        marks={marks}
        canFilterMarks={canFilterMarks}
        onStages={(st) => changeFilters(scope, st, marksWanted)}
        onMarks={(m) => changeFilters(scope, stages, m)}
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
