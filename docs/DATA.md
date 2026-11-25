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

| Precision     | Source                                                                 | On the map          |
| ------------- | ---------------------------------------------------------------------- | ------------------- |
| Exact         | Coordinates typed by the lead agency, if consistent with listed county | Solid dot           |
| Address       | A street address in the project's text, geocoded by the Census         | Solid dot           |
| Cross streets | Where the listed cross streets meet (Census road network)              | Dot, lighter center |
| Postmile      | State highway postmiles in the project's text (Caltrans)               | Dot, lighter center |
| Crossing      | Where two roads, or a road and a waterway, named in the text cross     | Dot, lighter center |
| Named place   | A beach, island, pass, summit... named in the text (USGS GNIS)         | Dot, lighter center |
| Street        | A seeded spot along the one listed (or named) short street or creek    | Hollow ring         |
| Community     | A community named in the text (USGS GNIS)                              | Hollow ring         |
| ZIP code      | Only the listed ZIP (smaller than the listed city): grouped by area    | Badge / sunflower   |
| City          | Only the listed city: grouped by area                                  | Badge / sunflower   |
| County        | Only the listed county: grouped by area                                | Badge / sunflower   |
| Region        | Only 2–3 neighboring listed counties: grouped by area                  | Badge / sunflower   |
| None          | Statewide, or counties far apart                                       | Not mapped; counted |

Only about 11% of projects (38,000 of 335,000) have agency coordinates; nothing before roughly 2010 does.
**Most points on the map are approximate**, and say so with a hollow ring and a line in the drawer.

**Projects known only to an area** (about 59% of mapped projects) are not given a spot of their own. Until
2026‑11‑24 they were scattered at a seeded random spot inside the area, which read as a real site. Now (`areas.ts`)
each area has an anchor (a city's GNIS populated-place point, i.e. its downtown, else the point deepest inside the
outline) and its projects are laid out in a sunflower spiral around it, newest filing in the middle (210 m step, ~12 px
apart at z11). Up to z7 they sit in the ordinary clusters at those positions, so the statewide map looks as before;
at z8–10 one badge per city (ZIP codes inside it and records listing several cities join it), or ZIP code or county outside any city, counts them, nudged per zoom so badges don't overlap (hover: "Coalinga", "6 projects, city listed only"); from
z11 the area tileset shows them unclustered. (Badges per county at statewide zoom, drawn over the clusters, were tried
on the preview and dropped as clutter.) Selecting one shows the area's outline (boundaries
tileset, property `k` = "city:fresno", "zip:95660", "county:inyo") and the drawer says "Fresno · Only the city is
listed". The published `location.area` carries the name, boundary keys and bounding box; lon/lat is the anchor.
Known gaps: sunflowers of neighboring areas can overlap at zoom 11–12, and outlines fill a city's enclaves.

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
- **No points across a land border.** The 5 km allowance is for the ocean off coastal counties, so coordinates
  (and geocoded addresses) in Mexico, Oregon, Nevada or Arizona are always rejected. Example: SCH 2011081008, a
  Poway Road bike path, was filed as 32°30′N instead of about 32°57′N, which is 1 km inside Tijuana.

**Cross streets.** About 86,000 approximate projects have text in "Cross Streets", and 58,000 of those name two or
more streets. `pipeline/src/lib/crossStreets.ts` matches those names against Census TIGER/Line roads (public domain)
and places the project where the streets meet, inside or near the listed city or county. Names are matched strictly
first ("Olive Ave" = "W Olive Ave", never "Olive St"), loosely only if that fails; crossings are found geometrically,
so overpasses count; if the same pair of names crosses in several far-apart places, nothing is guessed. On the full
dataset (2026‑11‑20): **33,281 placed (57.6%)**, 26.7% name a street the Census data doesn't have (typos, nicknames,
old names), 13.3% name streets that don't meet. The rest are ambiguous or too far from the listed city.

**Street addresses.** CEQAnet has no address field, but about 23,600 approximate projects write one in Cross
Streets (8,600), the project title (6,200) or the description (8,700), e.g. "1450 Expo Parkway". `address.ts` pulls out
the first house number + street name + street type (strictly: highways, acreages and lot counts don't count), and
`geocode.ts` sends it with the listed city or ZIP to the free Census batch geocoder. A result is kept only if it
agrees with the listed places (as for agency coordinates). Results, including misses, are cached in
`state/geocode-cache.json`, so each address is geocoded once; misses are retried after six months. On a 3,000-project
sample (2026‑11‑20): 77% placed, 22% not found by the Census, 1% rejected for contradicting the listed places (usually
a wrong city, e.g. a Sacramento address on a project listed in Los Angeles). About 3,800 have an address but no
single city or ZIP to pair it with and are skipped.

**Named places.** Many projects without coordinates, an address or cross streets still name where they are: "beach
nourishment at La Playa Beach, Shelter Island", "Grover Hot Springs State Park", "Ocotillo Wells SVRA". We look Title
Case names of two or more words up in the USGS Geographic Names Information System (GNIS, public domain), keep only
point‑like features (islands, beaches, points, summits, springs, passes, military sites) and communities, and require
the feature to be in a listed county and near a listed city. Names of streets ("San Pedro Street"), agencies ("…
Corridor Agency"), cities and counties are skipped, as are names shared by distant features and projects naming places
more than 15 km apart. A named site is drawn like a cross‑street placement (dot with a lighter center); a named
community (e.g. Ocotillo Wells, Studio City) as an approximate ring. On the full dataset (2026‑11‑21) this places about
14,000 projects; a hand check of 70 looked right in roughly 8 of 10. GNIS no longer lists buildings, schools, parks,
dams or airports (removed in 2022), so "Black Mountain Middle School" finds the summit, not the school.

**Project pages ("Other Location Info").** The CSV export leaves out a free-text field that project pages on CEQAnet
show, "Other Location Info", and some agencies put the real location only there: SCH 2026040250 has no coordinates or
cross streets in the CSV, but its page says "just west of North Refugio Road ...; Latitude 34.581478, Longitude
-120.108033". In a sample of 200 projects from the past 12 months that the CSV can't place exactly (2026‑11‑23), 55%
had the field: a street address in about 17%, a relative description ("west of Hayride Road") in 9%, postmiles in 3%,
coordinates in under 1%. The **Project pages** workflow (`jobs/pages.ts`, hourly) reads the pages of projects filed in
the past 12 months that the CSV can't place exactly, one every 8 seconds, and keeps the field in `state/pages.json`; it
refetches a page when the project gets a new filing. The build attaches it to the project's newest document, where the
address, postmile, road and place steps read it like the rest of the text, and coordinates written in it fill an empty
Coordinates field (then checked like any agency coordinates). Older projects are not read: about 300,000 pages would
take weeks at this pace.

**Highway postmiles.** Caltrans locates work on a state highway by county, route and postmile ("in San Diego County
along SR 76 from PM R16.4 to R16.9", "11-SD-76 PM 16.4/16.9"); postmiles restart at each county line, and a letter
prefix marks a realigned stretch. `postmiles.ts` reads a postmile only next to a route the text names (so "PM 89-24", a
parcel map, and "PM10", particulate matter, don't count) and looks it up in a listed county in Caltrans' SHN Postmiles
Tenth (a point every 0.1 mile, fetched by `scripts/fetch-postmiles.ts`). A range is placed at its middle if it is at
most 5 miles long; postmiles that disagree by more than 8 km are skipped.

**Roads and waterways named in the text.** Titles and descriptions name roads, highways and creeks far more often
than the Cross Streets field does: "Install Signs on SR-76", "within Quiota Creek under ... the culvert-bridge known as
Quiota Crossing 0A", "widen State Route 76 from Melrose Drive to Interstate 15". `namedLines.ts` reads Title Case (or
all-caps) names ending in a street or water type, and numbered routes, and finds them in Census TIGER/Line roads and
linear water (streams, rivers, canals; also public domain). In order: two named lines that meet in one place inside the
listed city or county give a **crossing**; a named place GNIS lists more than once in the county (two "Emigrant Pass"
in Inyo) is **settled** by a named road within 20 km when the other same-name places are 40 km or more away; a named
creek with the words crossing, bridge or culvert and no road named goes where it crosses a public road, if all such
crossings are within 3 km (the one nearest their middle), but only as an approximate spot, because the bridge may be on
a private road the Census doesn't map (SCH 2026040250's is 3 km from the public crossing); and one named line that is short in the area gives a spot
**along** it (still approximate). Two waterways meeting are not a crossing: "Tramp Creek, tributary to the Middle Fork
Eel River" is about the creek, so it is placed along the stretch of Tramp Creek that reaches that river.

Measured on all 299,469 approximately placed projects (2026‑11‑23, `scripts/match-named-lines.ts`): **1,850 placed at
postmiles, 10,653 at crossings, 21 at a same-name place settled by a road**, together about 12,300 more projects
"near a named location" (39,429 → 51,769); another 22,700 move from a random spot in their city or county to a spot
along a named street or creek (still approximate). A hand check of about 80 (25 county‑level crossings, 12 postmiles,
plus city crossings and road-settled places) looked right in all but a few; the misses are descriptions naming a road
that only bounds a much larger area (a redevelopment plan "along River Road"). Before the tributary rule, about a third
of county‑level crossings were creek mouths.

**ZIP codes.** About 46,000 approximate projects list a valid California ZIP. They are placed at a seeded random spot
in the Census ZIP Code Tabulation Area (ZCTA), restricted to the part inside the listed city (or county), and only
when the ZIP is smaller than the city. A ZIP that doesn't overlap the listed places is ignored (agencies sometimes
type their own office's ZIP).

**One listed street.** When Cross Streets names a single street ("Poway Road"), the project is placed at a seeded
spot along the part of that street inside the listed city (or county, with no city), using the same Census roads. It
is still marked approximate, and is skipped if that part of the street spreads over more than 15 km. Abbreviations
inside names are expanded on both sides ("Med. Center Dr" = "Medical Center Dr", also Ctr, Cyn, Ft, Mtn, Hts...).

Ways to improve this later:

1. A commercial geocoder (e.g. Geocodio) for the ~24,000 unmatched cross streets and the addresses the Census misses.
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

## Arrivals ("new" on the map)

"New" means first seen by our pipeline, not CEQAnet's Received date: agencies' documents often appear days after the
date they were received, and every run refetches 21 days. Ingest compares document keys against what is stored and
saves the new ones as the latest batch (`state/arrivals.json`). Edits to known documents don't count.

- A project is a **new project** if all its documents arrived in the batch, otherwise an existing project with a **new
  filing**.
- A run with nothing new keeps the previous batch, so pings survive nights and weekends. A batch older than 14 days
  stops pinging (a stalled pipeline shouldn't show week-old filings as new).
- A run with more than 500 new documents is treated as a bulk change (first run, re-keying) and clears the pings.
- Documents without a CEQAnet link get a synthetic key; if one later gains a link it may show as new once.
- Until the first ingest saves a batch, the build approximates one from CEQAnet's most recent Posted date.

## Refresh cadence

Every 3 hours the pipeline refetches the last 21 days (CEQAnet posts some documents days after their received date
and sometimes corrects records), and rebuilds only if something changed, plus once a day regardless.
