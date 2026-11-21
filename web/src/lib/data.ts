import type { PublishedMeta, PublishedProject } from '../../../packages/shared/src/index.ts';

/**
 * Where published data lives. In production this is the public R2 bucket's
 * custom domain (e.g. https://data.example.org). In development it falls back
 * to /data, served by vite.config.ts from the local pipeline output.
 */
export const DATA_URL = (import.meta.env.VITE_DATA_URL as string | undefined)?.replace(/\/$/, '') || '/data';

/**
 * On preview.ceqamap.org, a pull request that changes the data publishes its
 * own build to preview-data. Use it only if it was built from this preview's
 * branch; otherwise show the live data.
 */
const PREVIEW_DATA_URL = (import.meta.env.VITE_PREVIEW_DATA_URL as string | undefined)?.replace(/\/$/, '');
const PREVIEW_REF = import.meta.env.VITE_PREVIEW_REF as string | undefined;

/** The data origin in use; switches to preview data when it matches. */
let activeBase = DATA_URL;
/**
 * Resolves once the first meta check has picked the data origin. Project
 * fetches wait on it; otherwise a shared link could load the drawer from the
 * wrong origin before the check finishes (seen on the preview, 2026-11-20).
 */
let markBaseChosen: () => void = () => {};
const baseChosen = new Promise<void>((resolve) => {
  markBaseChosen = resolve;
});

export const META_POLL_MS = 5 * 60_000;
/** Poll faster while no data has been published yet, so it appears promptly. */
export const META_POLL_PENDING_MS = 60_000;

/** Status shown in the header when meta.json can't be loaded. */
export class DataStatusError extends Error {
  /** `pending`: nothing published yet (404). `unreachable`: network or server trouble. */
  readonly kind: 'pending' | 'unreachable';
  constructor(kind: 'pending' | 'unreachable', message: string) {
    super(message);
    this.kind = kind;
  }
}

export function absoluteDataUrl(path: string): string {
  const base = activeBase.startsWith('http') ? activeBase : `${location.origin}${activeBase}`;
  return `${base}/${path.replace(/^\//, '')}`;
}

async function previewMeta(signal?: AbortSignal): Promise<PublishedMeta | null> {
  if (!PREVIEW_DATA_URL || !PREVIEW_REF) return null;
  try {
    const res = await fetch(`${PREVIEW_DATA_URL}/meta.json`, { cache: 'no-cache', signal });
    if (!res.ok) return null;
    const meta = (await res.json()) as PublishedMeta;
    return meta.ref === PREVIEW_REF ? meta : null;
  } catch {
    return null;
  }
}

export async function fetchMeta(signal?: AbortSignal): Promise<PublishedMeta> {
  const preview = await previewMeta(signal);
  if (preview) {
    activeBase = PREVIEW_DATA_URL!;
    markBaseChosen();
    return preview;
  }
  activeBase = DATA_URL;
  markBaseChosen();
  // `no-cache` revalidates with the CDN each time; meta.json is tiny.
  const res = await fetch(absoluteDataUrl('meta.json'), { cache: 'no-cache', signal }).catch(() => {
    throw new DataStatusError('unreachable', 'Can’t reach the map data right now. Retrying shortly.');
  });
  if (res.status === 404) throw new DataStatusError('pending', 'Preparing the map data. It will appear here shortly.');
  if (!res.ok) throw new DataStatusError('unreachable', 'The map data is briefly unavailable. Retrying shortly.');
  return (await res.json()) as PublishedMeta;
}

const projectCache = new Map<string, Promise<PublishedProject>>();

export function fetchProject(sch: string): Promise<PublishedProject> {
  if (!/^\d{10}$/.test(sch)) return Promise.reject(new Error('Invalid SCH number'));
  let p = projectCache.get(sch);
  if (!p) {
    p = baseChosen
      .then(() => fetch(absoluteDataUrl(`projects/${sch}.json`)))
      .then(async (res) => {
        if (!res.ok)
          throw new Error(res.status === 404 ? 'Project not found' : `Could not load project (${res.status})`);
        return (await res.json()) as PublishedProject;
      });
    p = p.catch((e: unknown) => {
      projectCache.delete(sch); // allow a retry after failures
      throw e instanceof TypeError ? new Error('Can’t reach the map data right now') : e;
    });
    projectCache.set(sch, p);
  }
  return p;
}
