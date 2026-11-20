# The data: what CEQAnet gives us, and what it doesn't

Everything here was verified against the live CEQAnet site on 2026‑11‑18.

## Source

CEQAnet's search page has an undocumented CSV export:

```
https://ceqanet.lci.ca.gov/Search?StartRange=2026-10-01&EndRange=2026-10-31&OutputFormat=CSV
```

- One row per **document** (a notice, a draft EIR, a determination), 55 columns. Projects are grouped by their
  10‑digit **SCH number**; one project usually has several documents over the years.
- About **436,000 documents** in total, going back to the 1980s. A busy recent month is about 1,800 to 3,000 rows
  (≈3.4 MB) and returns in under two seconds. No row cap was observed.
- CEQAnet's Conditions of Use describe the information as generally public domain and state no attribution
  requirement. We credit CEQAnet anyway and send a User‑Agent with a contact email so the State Clearinghouse can
  reach us instead of blocking us.

## Two defects in the export, and how we handle them

1. **Encoding.** The file is Windows‑1252, not UTF‑8. Read naively, `°` and `’` turn into `�`.
2. **Broken quoting.** Double quotes inside fields are not escaped. Coordinates are typed like `38°20'58.9"N`, and
   oil‑well notices say things like `7" casing`. A standard CSV parser treats those quotes as the start of a quoted
   field and silently merges hundreds of following rows. Even after decoding correctly, a strict parser recovered
   only 837 of October 2026's 1,830 rows.

The pipeline's lenient parser (`pipeline/src/lib/csv.ts`) recovered **100%** of rows for June and October 2026 and
**99.6–100%** for sampled months in 1985, 1995, 2005, and 2015. Rows that still fail validation are rejected and
logged, never guessed at.

Also observed: rapid back‑to‑back requests sometimes return an **empty** 200 response. The client paces requests
(8 s apart; CEQAnet answered 403 to requests 3 s apart from GitHub's servers), treats empty responses as failures, and retries with backoff.

## Location: the biggest limitation

Each project gets the best location available, in this order:

| Precision | Source                                                                  | On the map          |
| --------- | ----------------------------------------------------------------------- | ------------------- |
| Exact     | Coordinates typed by the lead agency, if consistent with listed county  | Solid dot           |
| City      | A seeded random spot inside the listed city (Census outline)            | Hollow ring         |
| County    | A seeded random spot inside the listed county (Census outline)          | Hollow ring         |
| Region    | Inside one of 2–3 neighboring listed counties                           | Hollow ring         |
| None      | Statewide, or counties far apart                                        | Not mapped; counted |

Only about 11% of projects (38,000 of 335,000) have agency coordinates; nothing before roughly 2010 does.
**Most points on the map are approximate**, and say so with a hollow ring and a line in the drawer.

How placement works, and why (lessons from the first full build, 2026‑11‑20):

- **Real outlines, not center points.** Approximate points are drawn inside the U.S. Census cartographic boundary
  for the city or county (2024, 1:500k, clipped to the shoreline), weighted by area. The first version used a single
  Census "internal point" per place; San Francisco's is about 30 km offshore because its boundary includes the
  Farallon Islands, which put roughly 1,700 projects in the Pacific.
- **Seeded randomness.** A project's spot is random but derived from its SCH number, so it never moves between
  rebuilds. The first version's seed mixing was weak and laid consecutive projects out along spirals.
- **Agency coordinates are checked.** Coordinates must fall inside, or within 5 km of, a county the project lists
  (25 km of California when no county is listed). Otherwise they are treated as a typo, the project is placed by
  city or county, and the drawer explains why. Example: SCH 2024050310 near Ukiah was filed as 36°12′N instead of
  about 39°12′N, which is 330 km south and out to sea. `meta.json` reports how many were rejected.

Ways to improve this later:

1. Geocode the **cross streets** and **ZIP code** fields, which many coordinate‑less records have.
2. Match **parcel numbers** (APNs) against county parcel layers. Most precise, most work (58 counties, 58 formats).

## Status: inferred, not reported

CEQAnet has no status field. We infer the **stage of CEQA review** from the documents filed:

| Stage         | Rule                                                                           |
| ------------- | ------------------------------------------------------------------------------ |
| In review     | Any document's public (or state) comment period includes today                 |
| Approved      | Latest decisive filing is a Notice of Determination (NOD, NDE, ROD)            |
| Exempt        | Latest decisive filing is a Notice of Exemption                                |
| Scoping       | Latest decisive filing is a Notice of Preparation or Intent                    |
| Review closed | Latest decisive filing is a draft or final environmental document, review over |
| Other         | Only administrative or federal notices                                         |

Honest caveats, also shown to visitors in the drawer:

- Many cities and counties file their Notice of Determination only with the county clerk. Those projects stay
  **Review closed** even though they were approved. This is the largest known source of error.
- CEQAnet does not record denials, withdrawals, lawsuits, construction, or completion. "Approved" means a
  determination was filed, not that anything was built.
- Status depends on the date (comment periods open and close), so the data is rebuilt at least daily.

## Refresh cadence

Every 3 hours the pipeline refetches the last 21 days (CEQAnet posts some documents days after their received date
and sometimes corrects records), and rebuilds only if something changed, plus once a day regardless.
