# Architecture

## Goals

1. Show every CEQAnet project on one map, fast, on any device.
2. Stay current with no human involvement.
3. Handle hundreds of concurrent visitors (and traffic spikes from press) without a server to scale.
4. Be cheap and boring to operate, by a small team that is not primarily engineers.

## Decisions

| Decision         | Choice                                                    | Why                                                                                                    | Rejected                                                                                        |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Serving model    | Static files on a CDN                                     | Nothing to scale, patch, or wake up at 3 a.m. for; a traffic spike is free                             | API server + Postgres/PostGIS: real ops burden for no visible gain until we need search/filters |
| Map library      | MapLibre GL JS                                            | The leading open‑source WebGL map renderer; vector and raster basemaps; smooth zoom                    | Leaflet (raster‑first, struggles with 300k points), Mapbox GL (proprietary license, metered)    |
| Point delivery   | Vector tiles in one PMTiles file, clustered by tippecanoe | The browser downloads only what is on screen; clustering is precomputed and consistent at every zoom   | One big GeoJSON clustered in the browser: tens of MB up front, slow on phones                   |
| Hosting          | Cloudflare Workers static assets (site) + R2 (data)                       | Free tiers cover this comfortably; R2 has no egress fees; PMTiles works over plain HTTP range requests | Vercel + S3 (egress fees), GitHub Pages (no custom headers, no range‑request guarantees)        |
| Scheduler        | GitHub Actions cron                                       | Already where the code lives; logs and failure alerts built in                                         | A separate cron service or server                                                               |
| Language         | TypeScript everywhere                                     | One language for site and pipeline; types shared between them                                          | Python pipeline + TS site: two toolchains for one small team                                    |
| Pipeline runtime | Node 24, native TypeScript                                | No build step for the pipeline                                                                         | ts-node/tsx, bundling                                                                           |

## Data flow

1. **Ingest** (`pipeline/src/jobs/ingest.ts`): fetch the last 21 days of CEQAnet CSV, repair and validate it, and
   merge it into monthly partitions in R2 (`state/docs/YYYY-MM.ndjson.gz`). Raw CSV is archived beside it so we can
   reprocess history without refetching.
2. **Build** (`build.ts`): read all partitions, group documents into projects, derive stage and location, and write
   per‑project JSON plus a point file that tippecanoe turns into `projects.pmtiles`.
3. **Publish** (`publish.ts`): upload the tileset under a new immutable name, upload only project files whose content
   changed, then write `meta.json` last. Clients switch to the new build only once it is complete.

## The web app

- `web/src/map/` holds everything MapLibre: basemaps, the recoloring that gives OpenFreeMap styles our paper palette,
  and the project layers.
- `web/src/components/` holds the interface: header, legend, controls, hover card, and project drawer.
- Each point in the tiles carries only its SCH number, a truncated title (for hover), stage, and precision. The
  drawer fetches the full record (`data/projects/<sch>.json`, a few KB) on click.

## Scale and cost (estimates, verify current pricing)

- Data: roughly 300,000 projects. Tileset in the tens of MB; visitors download only a few hundred KB of it per view.
- Storage: low single‑digit GB in R2, within Cloudflare's free allowance as of mid‑2025.
- GitHub Actions: free for public repositories. A private repository on the free plan gets 2,000 minutes a month;
  this workload should use well under half of that, mostly on days with new filings.
- Domain: about $10 to $20 a year.

## Dependencies we do not control

| Dependency              | Risk                                                 | Mitigation                                                                                                                                   |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| CEQAnet CSV export      | Undocumented; could change or block automated access | Fail loudly on schema change; site keeps last good build; identify ourselves in User‑Agent; ask the State Clearinghouse for an official feed |
| OpenFreeMap basemaps    | Free public service, no SLA                          | Fallback blank style already keeps data visible; next step is self‑hosting a California Protomaps extract on R2                              |
| USGS National Map tiles | Government service, occasional outages               | Other basemaps remain available                                                                                                              |
| GitHub Actions IPs      | CEQAnet could block cloud IP ranges                  | Move the fetch to a Cloudflare Worker cron or a small VM if it happens                                                                       |
