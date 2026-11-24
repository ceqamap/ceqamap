/**
 * Download the Caltrans state highway postmiles (a point every 0.1 mile, "SHN
 * Postmiles Tenth") and write the compact table to pipeline/data/postmiles.json
 * (see lib/postmiles.ts). Published by Caltrans for public use; the data
 * workflow caches the output and refetches when this script changes.
 *
 *   node scripts/fetch-postmiles.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import type { PostmileTable } from '../src/lib/postmiles.ts';

const LAYER =
  process.env.POSTMILES_URL ??
  'https://gisdata.dot.ca.gov/arcgis/rest/services/CHhighway/SHN_Postmiles_Tenth/FeatureServer/0';
const PAGE = 2000;

interface Feature {
  attributes: Record<string, string | number | null>;
  geometry?: { x: number; y: number };
}

interface QueryResult {
  features?: Feature[];
  count?: number;
  exceededTransferLimit?: boolean;
  error?: unknown;
}

async function query(params: Record<string, string>): Promise<QueryResult> {
  const url = `${LAYER}/query?${new URLSearchParams({ f: 'json', ...params })}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      const json = (await res.json()) as QueryResult;
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json;
    } catch (e) {
      if (attempt >= 4) throw new Error(`Postmile query failed: ${url}: ${e}`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
}

const { count } = await query({ where: '1=1', returnCountOnly: 'true' });
console.log(JSON.stringify({ msg: 'Postmile points', count }));

/** The attribute whose name matches one of these (case-insensitive). */
function field(attrs: Record<string, unknown>, ...names: string[]): string {
  const keys = Object.keys(attrs);
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase() === n.toLowerCase());
    if (k) return k;
  }
  throw new Error(`No ${names.join('/')} field in postmiles (got: ${keys.join(', ')})`);
}

const routes: PostmileTable['routes'] = {};
let fields: { county: string; route: string; prefix: string; pm: string } | null = null;
let n = 0;
for (let offset = 0; ; offset += PAGE) {
  const page = await query({
    where: '1=1',
    outFields: '*',
    outSR: '4326',
    orderByFields: 'OBJECTID',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE),
  });
  const feats = page.features ?? [];
  for (const f of feats) {
    const a = f.attributes;
    if (!fields) {
      fields = {
        county: field(a, 'County', 'CNTY', 'County_Code'),
        route: field(a, 'Route', 'RTE'),
        prefix: field(a, 'PMPrefix', 'PM_Prefix', 'PMPFX'),
        pm: field(a, 'PM', 'PostMile', 'PMc'),
      };
      console.log(JSON.stringify({ msg: 'Postmile fields', fields, sample: a }));
    }
    if (!f.geometry) continue;
    const county = String(a[fields.county] ?? '')
      .trim()
      .toUpperCase();
    const route = Number(String(a[fields.route] ?? '').replace(/\D/g, ''));
    const pm = Number(a[fields.pm]);
    if (!county || !route || !Number.isFinite(pm)) continue;
    const prefix = String(a[fields.prefix] ?? '')
      .trim()
      .toUpperCase();
    (routes[`${county}|${route}`] ??= []).push([
      prefix,
      Math.round(pm * 1000) / 1000,
      Math.round(f.geometry.x * 1e6) / 1e6,
      Math.round(f.geometry.y * 1e6) / 1e6,
    ]);
    n++;
  }
  if (feats.length === 0 || (!page.exceededTransferLimit && feats.length < PAGE)) break;
}
for (const pts of Object.values(routes)) pts.sort((a, b) => a[1] - b[1]);
if (n < 50_000) throw new Error(`Unexpected count: ${n} postmile points`);
const table: PostmileTable = {
  source: `Caltrans SHN Postmiles Tenth (${new Date().toISOString().slice(0, 10)})`,
  routes,
};
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/postmiles.json', import.meta.url), JSON.stringify(table));
console.log(JSON.stringify({ msg: 'Wrote postmiles.json', points: n, routes: Object.keys(routes).length }));
