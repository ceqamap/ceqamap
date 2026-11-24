/**
 * Report: the published location of some projects, from production and
 * preview data side by side, plus the stored page text. Nothing changes.
 *
 *   EXPLAIN=2026040250,2026010905 node scripts/show-published.ts
 */
import { loadPages } from '../src/lib/pages.ts';
import { storageFromEnv } from '../src/lib/storage.ts';

const storage = storageFromEnv();
const pages = await loadPages(storage);
const read = async (key: string) => {
  const bytes = await storage.get(key);
  return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as { location?: unknown; title?: string }) : null;
};
for (const sch of (process.env.EXPLAIN ?? '').split(',').filter(Boolean)) {
  const [prod, preview] = await Promise.all([
    read(`data/projects/${sch}.json`),
    read(`preview-data/projects/${sch}.json`),
  ]);
  console.log(
    JSON.stringify({
      sch,
      title: preview?.title ?? prod?.title,
      production: prod?.location,
      preview: preview?.location,
      page: pages.pages[sch]?.info?.slice(0, 300) ?? null,
    }),
  );
}
