# CEQA Atlas

A live, full‑screen map of every project filed with California's State Clearinghouse under the California
Environmental Quality Act (CEQA). The data comes from [CEQAnet](https://ceqanet.lci.ca.gov), which is public, but
CEQAnet only lets you dig through it one search at a time. This site puts all of it on one map and keeps it current
automatically.

> **Working name.** "CEQA Atlas" is a placeholder. Search the repo for it when the real name is chosen.

## How it works

```
 CEQAnet CSV export ──► Data refresh (GitHub Actions, every 3 h)
                          │  fetch recent filings, repair CSV, normalize
                          │  derive each project's stage and location
                          │  build map tiles (tippecanoe → PMTiles)
                          ▼
                     Cloudflare R2 bucket  ──(CDN)──►  Browser
                     data/meta.json                      MapLibre map
                     data/tiles/*.pmtiles                (Cloudflare Workers)
                     data/projects/<sch>.json
```

- **No server and no database.** Everything the browser needs is a static file on a CDN. Hundreds or thousands of
  simultaneous visitors cost the same as one, and there is nothing to patch or keep running.
- **Always fresh.** The map checks for a new data build every 5 minutes and swaps it in without a reload.
- **Shareable.** Every view has a URL: `?p=2025100575` opens a project, `?b=imagery` sets the base map, and the
  map position is kept after `#map=`.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · what the data can and cannot tell us:
[docs/DATA.md](docs/DATA.md) · visual system: [docs/DESIGN.md](docs/DESIGN.md) · open questions:
[docs/DECISIONS.md](docs/DECISIONS.md)

## Repository layout

| Path               | What it is                                                                     |
| ------------------ | ------------------------------------------------------------------------------ |
| `web/`             | The website (React, MapLibre GL, PMTiles, Vite)                                |
| `pipeline/`        | Data ingestion and publishing (TypeScript, runs on Node 24 with no build step) |
| `packages/shared/` | Types and constants both halves agree on: statuses, colors, data file shapes   |
| `.github/`         | CI checks, the scheduled data refresh, and site deploys                        |
| `docs/`            | Architecture, data notes, design notes, decisions                              |

## Working on it locally

Requirements: Node 24 and pnpm (`corepack enable` installs pnpm). For the data build you also need
[tippecanoe](https://github.com/felt/tippecanoe) (`brew install tippecanoe` on a Mac).

```sh
pnpm install
cp .env.example .env               # then put your email in CEQANET_CONTACT

# Pull a few recent months of real data into ./.data (takes about a minute)
set -a; . ./.env; set +a
pnpm --filter @ceqa-atlas/pipeline gazetteer      # once; writes pipeline/data/gazetteer.json
pnpm --filter @ceqa-atlas/pipeline backfill --from 2026-08
pnpm --filter @ceqa-atlas/pipeline build-data
pnpm --filter @ceqa-atlas/pipeline publish-data   # with no R2 settings, "publishes" into ./.data

pnpm dev                           # http://localhost:5173
```

Before pushing, run `pnpm check` (formatting, lint, types, tests). CI runs the same thing on every pull request.

## One‑time production setup

1. **GitHub.** Create the repository, push this code, and protect `main` (require pull requests and the CI check).
2. **Cloudflare account** (free plan is enough).
   - **R2:** create a bucket (e.g. `ceqa-atlas`). Connect a custom domain such as `data.<your-domain>` under the
     bucket's Settings so files are served through the CDN. Add a CORS rule allowing `GET` and `HEAD` from your site's
     origin, exposing the `ETag`, `Content-Length`, and `Content-Range` headers (PMTiles needs them).
   - Create an R2 API token with read and write access to that bucket only.
   - **Website:** nothing to create; the first deploy creates a Worker named `ceqamap` (see `wrangler.jsonc`).
     Attach your domain to it afterwards under Workers & Pages → ceqamap → Settings → Domains & Routes.
   - Create an API token with the "Workers Scripts: Edit" permission.
3. **GitHub repository settings → Secrets and variables → Actions**

   | Kind     | Name                    | Value                                      |
   | -------- | ----------------------- | ------------------------------------------ |
   | Secret   | `R2_ACCOUNT_ID`         | Cloudflare account ID                      |
   | Secret   | `R2_ACCESS_KEY_ID`      | from the R2 token                          |
   | Secret   | `R2_SECRET_ACCESS_KEY`  | from the R2 token                          |
   | Secret   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID                      |
   | Secret   | `CLOUDFLARE_API_TOKEN`  | the Workers deploy token                   |
   | Variable | `R2_BUCKET`             | bucket name                                |
   | Variable | `DATA_URL`              | e.g. `https://data.example.org/data`       |
   | Variable | `CEQANET_CONTACT`       | an email the State Clearinghouse can reach |

4. **Load history.** Actions → Data refresh → Run workflow → mode `backfill`. About an hour for 1980 to today. It
   resumes where it left off if interrupted. After that the scheduled refresh keeps it current on its own.

## When something breaks

- A failing scheduled refresh opens a GitHub issue labeled `data-refresh`. The site keeps serving the last good
  build, so visitors are not affected; the map just stops getting newer.
- If CEQAnet changes its CSV columns, ingestion stops with a message naming the missing columns, rather than
  publishing wrong data.
