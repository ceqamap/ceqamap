# Open decisions and known gaps

## Needed from you before launch

1. **Name and domain.** "CEQA Atlas" is a placeholder. Buy the domain (Cloudflare Registrar sells at cost, which
   keeps DNS, site, and data in one account).
2. **Who owns the accounts.** GitHub, Cloudflare, and the domain should belong to the client's organization (or yours,
   with a written handover plan), not a personal account of whoever set them up.
3. **Public or private repository.** Public is free on GitHub Actions and fine for public data; private keeps the code
   proprietary.
4. **Contact email** for the User‑Agent sent to CEQAnet.
5. **License** for the code (none is set, which means all rights reserved).

## Things you didn't ask about but will need

- **Legal pages.** A short "About the data" page (sources, inferred status, approximate locations) and a privacy
  note. The CEQAnet records include staff names, emails, and phone numbers; this site deliberately does not
  republish contacts and links to CEQAnet instead.
- **Privacy‑friendly analytics** (Cloudflare Web Analytics is free and cookieless) so you know if it's used.
- **Error monitoring** for the website (e.g. Sentry's free tier). The data pipeline already alerts via GitHub issues.
- **Uptime check** on the site and on `meta.json` freshness (e.g. alert if `builtAt` is older than 24 hours).
- **Social share image** (Open Graph) so links look good in Slack and on LinkedIn.
- **An accessible list view.** A map canvas cannot be read by screen readers. A keyboard‑ and screen‑reader‑friendly
  list of nearby or recent projects is the honest fix and will also serve as the base for filters.
- **Talk to the State Clearinghouse.** A courtesy note that we're building on CEQAnet lowers the odds of being
  blocked, and they may offer a supported feed.

## Deliberately deferred

- Filters and search (per your direction). The data model already carries stage, dates, agency, development type,
  and issues, so these are a UI addition, not a rebuild.
- The client's alerting use case (notify on new projects matching criteria). The same pipeline can do it: after
  each ingest, match new filings against saved criteria and send email.
- 3D terrain, self‑hosted basemap tiles, and boundary‑aware scattering (see DATA.md).

## Version pins to revisit

Pinned to the newest release of the previous major for libraries whose newest major could not be built and tested
when this was written: MapLibre GL 5 (6 is out), Vite 7 (8 is out), ESLint 9 (10 is out), TypeScript 6 (7 is out).
Dependabot will propose upgrades; take them one at a time with CI green.
