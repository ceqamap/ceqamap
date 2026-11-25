/**
 * Notices when the basemap's own tile host is down, so the map can switch to
 * a fallback instead of showing a blank page under the project dots.
 *
 * OpenFreeMap (Paper, Night, Streets) is a free service without an uptime
 * guarantee; on 2026-11-24 its tile index answered 503 for hours and every
 * one of those basemaps went blank. The basemap counts as down when, for a
 * source that isn't ours:
 *   - its tile index (TileJSON) fails: an error with no tile attached, or
 *   - its tiles keep failing with server or network errors: FAILURES_TO_TRIP
 *     within WINDOW_MS. A few missing tiles at the edges are normal.
 * It fires once per style; call reset() when a new style loads.
 */

export const FAILURES_TO_TRIP = 4;
export const WINDOW_MS = 20_000;

export interface MapErrorLike {
  sourceId?: string;
  tile?: unknown;
  error?: { status?: number } | null;
}

export class BasemapWatch {
  private failures: number[] = [];
  private tripped = false;
  private readonly ours: ReadonlySet<string>;
  private readonly onDown: () => void;

  /** `ours`: source ids of our own data, whose errors are handled elsewhere. */
  constructor(ours: Iterable<string>, onDown: () => void) {
    this.ours = new Set(ours);
    this.onDown = onDown;
  }

  /** Feed every map 'error' event here. Returns true if this one tripped the switch. */
  report(e: MapErrorLike, now = Date.now()): boolean {
    if (this.tripped || !e.sourceId || this.ours.has(e.sourceId)) return false;
    const status = e.error?.status;
    const serious = status === undefined || status === 0 || status >= 500;
    if (!e.tile) {
      // The tile index itself failed: nothing of this basemap can draw.
      if (!serious) return false;
      return this.trip();
    }
    if (!serious) return false;
    this.failures = [...this.failures.filter((t) => now - t < WINDOW_MS), now];
    return this.failures.length >= FAILURES_TO_TRIP ? this.trip() : false;
  }

  reset() {
    this.failures = [];
    this.tripped = false;
  }

  private trip(): boolean {
    this.tripped = true;
    this.onDown();
    return true;
  }
}
