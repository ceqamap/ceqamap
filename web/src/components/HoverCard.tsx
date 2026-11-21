import { type PublishedArrivals, STATUS_BY_ID } from '../../../packages/shared/src/index.ts';
import { formatNumber, timeAgo } from '../lib/format.ts';
import type { HoverInfo } from '../map/MapView.tsx';

/** Follows the cursor; flips to stay on screen. Not rendered on touch devices. */
export function HoverCard({
  info,
  mode,
  arrivals,
}: {
  info: HoverInfo | null;
  mode: 'light' | 'dark';
  arrivals: PublishedArrivals | undefined;
}) {
  if (!info) return null;
  const flipX = info.x > window.innerWidth - 340;
  const flipY = info.y > window.innerHeight - 140;
  const style = {
    left: info.x,
    top: info.y,
    transform: `translate(${flipX ? 'calc(-100% - 14px)' : '14px'}, ${flipY ? 'calc(-100% - 14px)' : '14px'})`,
  };

  if (info.kind === 'cluster') {
    return (
      <div className="hover-card card" style={style} role="tooltip">
        <p className="hover-title">{formatNumber(info.count)} projects</p>
        <p className="hover-meta">
          {info.inReview > 0 ? (
            <>
              <span className="dot" style={{ background: STATUS_BY_ID.in_review[mode] }} aria-hidden="true" />
              {formatNumber(info.inReview)} in public review now
            </>
          ) : (
            'Click to zoom in'
          )}
        </p>
        {info.arrived > 0 && (
          <p className="hover-meta hover-new">
            <span className="new-ring" aria-hidden="true" />
            {formatNumber(info.arrived)} just arrived
          </p>
        )}
      </div>
    );
  }

  const arrival = info.props.n ? arrivals?.items.find((i) => i.id === info.props.id) : undefined;

  const status = STATUS_BY_ID[info.props.s] ?? STATUS_BY_ID.other;
  return (
    <div className="hover-card card" style={style} role="tooltip">
      <p className="hover-title">{info.props.t}</p>
      <p className="hover-meta">
        <span
          className={`dot ${info.props.x === 0 ? 'ring-only' : info.props.x === 2 ? 'cross' : ''}`}
          style={{ backgroundColor: status[mode], borderColor: status[mode] }}
          aria-hidden="true"
        />
        {status.label}
        {info.props.x === 0 ? ' · approximate location' : info.props.x === 2 ? ' · near the listed cross streets' : ''}
      </p>
      {arrival && arrivals && (
        <p className="hover-meta hover-new">
          <span className="new-ring" aria-hidden="true" />
          {arrival.kind === 'project' ? 'New project' : `New filing: ${arrival.typeLabel}`} · {timeAgo(arrivals.at)}
        </p>
      )}
    </div>
  );
}
