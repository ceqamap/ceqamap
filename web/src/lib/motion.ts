/**
 * The "ping": a hairline ring that grows and fades, used by the header's live
 * dot (CSS, app.css) and by projects that just arrived (map, MapView.tsx).
 * Both run on one clock, performance.now(), so they pulse in step.
 */

/** Must match the `ping` animation duration in app.css. */
export const PING_MS = 2400;

/** cubic-bezier(x1, y1, x2, y2), as in CSS. Matches --ease in tokens.css when called with (0.2, 0.7, 0.2, 1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const bx = (t: number) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t ** 2 * (1 - t) + t ** 3;
  const by = (t: number) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t ** 2 * (1 - t) + t ** 3;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Bisection: monotonic in t for valid CSS curves, and plenty fast at 15 fps.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (bx(mid) < x) lo = mid;
      else hi = mid;
    }
    return by((lo + hi) / 2);
  };
}

export const easePing = cubicBezier(0.2, 0.7, 0.2, 1);

/** Eased progress (0..1) of the shared ping at time `now` (ms, performance.now() clock). */
export function pingProgress(now: number): number {
  return easePing((now % PING_MS) / PING_MS);
}

/** Negative CSS animation delay that puts a ping started now in step with the shared clock. */
export function pingDelay(now: number): string {
  return `-${Math.round(now % PING_MS)}ms`;
}
