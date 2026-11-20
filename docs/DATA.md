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
(3 s apart), treats empty responses as failures, and retries with backoff.

## Location: the biggest limitation

Each project gets the best location available, in this order:

| Precision | Source                                                        | On the map          |
| --------- | ------------------------------------------------------------- | ------------------- |
| Exact     | Coordinates typed by the lead agency                          | Solid dot           |
| City      | The listed city (or 2–3 nearby cities), from Census Gazetteer | Hollow ring         |
| County    | The listed county                                             | Hollow ring         |
| Region    | 2–3 neighboring counties                                      | Hollow ring         |
| None      | Statewide, or counties far apart                              | Not mapped; counted |

What the samples showed:

| Month    | With coordinates | City only | County only |
| -------- | ---------------- | --------- | ----------- |
| Oct 2026 | about 1 in 3     | ~39%      | ~20%        |
| Mar 2021 | ~23%             | ~41%      | ~26%        |
| Mar 2015 | ~31%             | ~37%      | ~31%        |
| Mar 2005 | **0%**           | ~55%      | ~44%        |
| Mar 1995 | **0%**           | ~64%      | ~33%        |

So **most points on the map are approximate**, and nothing before roughly 2010 has real coordinates. Approximate
points are scattered deterministically inside a disk sized to the place's land area, so 4,000 Los Angeles
projects do not stack on one pixel, and a project always lands in the same spot. The hollow ring tells visitors the
spot is approximate, and the drawer says so in words.

Ways to improve this later, roughly in order of value:

1. Scatter inside the real city or county boundary (Census TIGER polygons) instead of a disk, so points never land
   in the ocean or a neighboring city.
2. Geocode the **cross streets** and **ZIP code** fields, which many coordinate‑less records have.
3. Match **parcel numbers** (APNs) against county parcel layers. Most precise, most work (58 counties, 58 formats).

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
