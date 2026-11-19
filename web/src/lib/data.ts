import type { PublishedMeta, PublishedProject } from '../../../packages/shared/src/index.ts';

/**
 * Where published data lives. In production this is the public R2 bucket's
 * custom domain (e.g. https://data.example.org). In development it falls back
 * to /data, served by vite.config.ts from the local pipeline output.
 */
export const DATA_URL = (import.meta.env.VITE_DATA_URL as string | undefined)?.replace(/\/$/, '') || '/data';

export const META_POLL_MS = 5 * 60_000;

export function absoluteDataUrl(path: string): string {
  const base = DATA_URL.startsWith('http') ? DATA_URL : `${location.origin}${DATA_URL}`;
  return `${base}/${path.replace(/^\//, '')}`;
}

export async function fetchMeta(signal?: AbortSignal): Promise<PublishedMeta> {
  // `no-cache` revalidates with the CDN each time; meta.json is tiny.
  const res = await fetch(absoluteDataUrl('meta.json'), { cache: 'no-cache', signal }).catch(() => {
    throw new Error('Can’t reach the map data right now. Retrying shortly.');
  });
  if (!res.ok) throw new Error(`Map data is temporarily unavailable (${res.status}).`);
  return (await res.json()) as PublishedMeta;
}

const projectCache = new Map<string, Promise<PublishedProject>>();

export function fetchProject(sch: string): Promise<PublishedProject> {
  if (!/^\d{10}$/.test(sch)) return Promise.reject(new Error('Invalid SCH number'));
  let p = projectCache.get(sch);
  if (!p) {
    p = fetch(absoluteDataUrl(`projects/${sch}.json`)).then(async (res) => {
      if (!res.ok) throw new Error(res.status === 404 ? 'Project not found' : `Could not load project (${res.status})`);
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
