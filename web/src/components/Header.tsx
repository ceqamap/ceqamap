import { useEffect, useState } from 'react';
import type { PublishedMeta } from '../../../packages/shared/src/index.ts';
import { formatNumber, timeAgo } from '../lib/format.ts';

export function Header({ meta, error }: { meta: PublishedMeta | null; error: string | null }) {
  // Re-render every minute so "updated N minutes ago" stays honest.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="header card">
      <h1 className="wordmark">CEQA Atlas</h1>
      <p className="header-sub">Every project filed with California’s State Clearinghouse, on one map.</p>
      <p className="live" aria-live="polite">
        {error ? (
          <span className="live-error">{error}</span>
        ) : meta ? (
          <>
            <span className="live-dot" aria-hidden="true" />
            <span>
              Updated {timeAgo(meta.builtAt)} · {formatNumber(meta.counts.mapped)} projects
            </span>
          </>
        ) : (
          <span className="muted">Loading the latest filings…</span>
        )}
      </p>
    </header>
  );
}
