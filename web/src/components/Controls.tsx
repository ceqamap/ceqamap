import { useEffect, useRef, useState } from 'react';
import { BASEMAPS, type BasemapId } from '../map/basemaps.ts';

interface Props {
  basemap: BasemapId;
  onBasemap: (id: BasemapId) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}

export function Controls({ basemap, onBasemap, onZoomIn, onZoomOut, onReset }: Props) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="controls" ref={panel}>
      <button
        className="pill pill-outline layers-button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <LayersIcon /> {BASEMAPS.find((b) => b.id === basemap)?.label}
      </button>
      {open && (
        <div className="basemap-panel card" role="radiogroup" aria-label="Base map">
          {BASEMAPS.map((b) => (
            <button
              key={b.id}
              role="radio"
              aria-checked={b.id === basemap}
              className="basemap-option"
              onClick={() => {
                onBasemap(b.id);
                setOpen(false);
              }}
            >
              <span className="swatch" style={{ background: b.swatch }} aria-hidden="true" />
              {b.label}
            </button>
          ))}
        </div>
      )}
      <div className="zoom-group card">
        <button className="icon-button" aria-label="Zoom in" onClick={onZoomIn}>
          +
        </button>
        <button className="icon-button" aria-label="Zoom out" onClick={onZoomOut}>
          −
        </button>
        <button className="icon-button" aria-label="Show all of California" onClick={onReset}>
          <ResetIcon />
        </button>
      </div>
    </div>
  );
}

function LayersIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <path d="M8 2 1.5 5.5 8 9l6.5-3.5L8 2Z" />
      <path d="m1.5 8.5 6.5 3.5 6.5-3.5" />
      <path d="m1.5 11.2 6.5 3.3 6.5-3.3" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
      <path d="M8 0.5v2.5M8 13v2.5M0.5 8H3M13 8h2.5" />
    </svg>
  );
}
