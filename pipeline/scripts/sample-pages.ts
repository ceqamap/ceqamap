/**
 * Report: what the "Other Location Info" field on CEQAnet project pages holds
 * for projects filed in the past 12 months that we can't place exactly. The
 * CSV export doesn't include that field (SCH 2026040250 keeps its coordinates
 * only there). Fetches a seeded random sample of pages at CEQAnet's polite
 * pace. Nothing is saved.
 *
 *   SAMPLE=200 EXPLAIN=2026040250 node scripts/sample-pages.ts
 */
import { readFile } from 'node:fs/promises';
import { groupBySch } from '../src/lib/aggregate.ts';
import type { Boundaries } from '../src/lib/boundaries.ts';
import { addDays, CEQANET_ORIGIN, todayInCalifornia } from '../src/lib/ceqanet.ts';
import { parseCoordinates } from '../src/lib/coordinates.ts';
import type { CeqaDocument } from '../src/lib/document.ts';
import { agreesWithPlaces, haversineKm, listedPlaces, resolveLocation } from '../src/lib/location.ts';
import { listPartitionMonths, readPartition } from '../src/lib/partitions.ts';
import { seededRandom } from '../src/lib/random.ts';
import { storageFromEnv } from '../src/lib/storage.ts';

const SAMPLE = Number(process.env.SAMPLE ?? 200);
const EXPLAIN = (process.env.EXPLAIN ?? '').split(',').filter(Boolean);
const GAP_MS = 8000;
const out = (o: unknown) => console.log(JSON.stringify(o));
const storage = storageFromEnv();
const b = JSON.parse(await readFile(new URL('../data/boundaries.json', import.meta.url), 'utf8')) as Boundaries;
const contact = process.env.CEQANET_CONTACT;
if (!contact) throw new Error('Set CEQANET_CONTACT');

const today = todayInCalifornia();
const since = addDays(today, -365);
const docs: CeqaDocument[] = [];
for (const m of await listPartitionMonths(storage))
  if (m >= since.slice(0, 7)) docs.push(...(await readPartition(storage, m)));

const pool: { sch: string; newestFirst: CeqaDocument[] }[] = [];
const byPrecision: Record<string, number> = {};
for (const [sch, list] of groupBySch(docs)) {
  const newestFirst = [...list].sort((x, y) => (x.received < y.received ? 1 : -1));
  if (newestFirst[0].received < since) continue;
  const loc = resolveLocation(sch, newestFirst, b);
  const p = loc?.precision ?? 'unmapped';
  byPrecision[p] = (byPrecision[p] ?? 0) + 1;
  if (p !== 'exact') pool.push({ sch, newestFirst });
}
out({ since, projects12m: Object.values(byPrecision).reduce((s, n) => s + n, 0), byPrecision, notExact: pool.length });

const rand = seededRandom('pages');
const picked = [...pool].sort(() => rand() - 0.5).slice(0, SAMPLE);
for (const sch of EXPLAIN) {
  const p = pool.find((x) => x.sch === sch);
  if (p && !picked.includes(p)) picked.unshift(p);
}

let last = 0;
async function page(sch: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    try {
      const res = await fetch(`${CEQANET_ORIGIN}/${sch}`, {
        headers: { 'User-Agent': `ceqamap/1.0 (+https://ceqamap.org; ${contact})`, Accept: 'text/html' },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 403 || res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      return await res.text();
    } catch (e) {
      out({ warn: 'page fetch failed', sch, attempt, error: String(e) });
      await new Promise((r) => setTimeout(r, 60_000 * attempt));
    }
  }
  return null;
}

/** Page HTML to text lines (block tags become line breaks). */
function textLines(html: string): string[] {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:br|\/?(?:p|div|li|tr|td|th|dt|dd|h\d|section|label|span))\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const LABELS =
  /^(Coordinates|Cities|Counties|Regions|Cross Streets|Zip|Total Acres|Parcel #|State Highways|Railways|Airports|Schools|Waterways|Township|Range|Section|Base|Other Location Info|Notice of Exemption|Exempt Status|Disclaimer|Attachments|Notice of Completion|Notice of Determination|Development Type|Local Action|Project Issues|Document Description|Contact Information|Location)$/i;

function otherLocationInfo(html: string): string | null {
  const lines = textLines(html);
  const i = lines.findIndex((l) => /^Other Location Info:?$/i.test(l));
  if (i < 0) {
    const inline = lines.find((l) => /^Other Location Info:?\s+\S/i.test(l));
    return inline ? inline.replace(/^Other Location Info:?\s+/i, '') : null;
  }
  const value: string[] = [];
  for (let j = i + 1; j < lines.length && !LABELS.test(lines[j].replace(/:$/, '')); j++) value.push(lines[j]);
  return value.join(' ').trim() || null;
}

const DECIMAL =
  /(-?\d{2}\.\d{3,})\s*[°,]?\s*(?:N|North)?[\s,/;]+(?:Longitude|Long\.?|Lon\.?)?\s*:?\s*(-?1\d{2}\.\d{3,})/i;
const classes: Record<string, number> = {};
const inc = (k: string) => (classes[k] = (classes[k] ?? 0) + 1);
const moved: number[] = [];
let fetched = 0;
let shownHtml = 0;
for (const { sch, newestFirst } of picked) {
  const html = await page(sch);
  if (!html) {
    inc('page-missing');
    continue;
  }
  fetched++;
  if (shownHtml < 1 && /Other Location Info/i.test(html)) {
    const at = html.search(/Other Location Info/i);
    out({ htmlAround: sch, snippet: html.slice(Math.max(0, at - 300), at + 900) });
    shownHtml++;
  }
  const info = otherLocationInfo(html);
  if (!info) {
    inc('no-other-info');
    continue;
  }
  inc('has-other-info');
  let point = parseCoordinates(info);
  if (!point) {
    const m = info.match(DECIMAL);
    if (m) {
      const lat = Number(m[1]);
      const lon = -Math.abs(Number(m[2]));
      if (lat > 32 && lat < 42.1 && lon > -124.5 && lon < -114) point = { lon, lat };
    }
  }
  const kinds: string[] = [];
  if (point) {
    const places = listedPlaces(newestFirst, b);
    if (agreesWithPlaces(point, places, b)) {
      kinds.push('coordinates');
      const now = resolveLocation(sch, newestFirst, b);
      if (now) moved.push(haversineKm(now, point));
    } else kinds.push('coordinates-disagree');
  }
  if (/\b(APN|parcel)\b/i.test(info)) kinds.push('apn');
  if (
    /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\s(?:Road|Rd|Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Highway|Hwy)\b/.test(
      info,
    )
  )
    kinds.push('address');
  if (/\b(intersection|corner|north of|south of|east of|west of|between)\b/i.test(info)) kinds.push('relative');
  if (/\b(Township|T\d+[NS]|Section \d+|R\d+[EW])\b/.test(info)) kinds.push('plss');
  if (/\b(?:post ?miles?|PM)\s*[A-Z]?\d/i.test(info)) kinds.push('postmile');
  for (const k of kinds) inc(k);
  if (kinds.length === 0) inc('text-only');
  out({
    sch,
    kinds,
    info: info.slice(0, 400),
    csv: { coords: newestFirst[0].coordinates, cross: newestFirst[0].crossStreets },
  });
}
const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0;
out({
  sampled: picked.length,
  fetched,
  classes,
  coordinatesMovedKm: { n: moved.length, median: Math.round(median(moved) * 10) / 10 },
});
