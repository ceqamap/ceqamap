import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregate, truncate } from '../src/lib/aggregate.ts';
import { normalizeRecord, splitList, toIsoDate } from '../src/lib/document.ts';
import { buildGazetteer, normalizePlaceName, parseGazetteerFile } from '../src/lib/gazetteer.ts';
import { haversineKm, jitter, resolveLocation } from '../src/lib/location.ts';
import { deriveStatus } from '../src/lib/status.ts';
import { doc } from './helpers.ts';

const TODAY = '2026-11-18';

describe('deriveStatus', () => {
  it('marks an open comment period as in_review, regardless of document order', () => {
    const r = deriveStatus(
      [
        doc({ type: 'NOP', received: '2025-10-14' }),
        doc({ type: 'EIR', received: '2026-11-01', reviewStart: '2026-11-01', reviewEnd: '2026-12-15' }),
      ],
      TODAY,
    );
    assert.deepEqual(r, { status: 'in_review', date: '2026-11-01', reviewEnd: '2026-12-15' });
  });

  it('treats the last day of review as still open', () => {
    const r = deriveStatus([doc({ type: 'MND', reviewStart: '2026-10-19', reviewEnd: TODAY })], TODAY);
    assert.equal(r.status, 'in_review');
  });

  it('marks a closed review without a determination as review_closed', () => {
    const r = deriveStatus(
      [doc({ type: 'EIR', received: '2026-04-03', reviewStart: '2026-04-03', reviewEnd: '2026-05-18' })],
      TODAY,
    );
    assert.equal(r.status, 'review_closed');
  });

  it('marks a project with an NOD as approved', () => {
    const r = deriveStatus(
      [doc({ type: 'MND', received: '2025-01-01' }), doc({ type: 'NOD', received: '2025-03-01' })],
      TODAY,
    );
    assert.deepEqual(r, { status: 'approved', date: '2025-03-01', reviewEnd: null });
  });

  it('lets a newer supplemental EIR reopen an approved project', () => {
    const r = deriveStatus(
      [doc({ type: 'NOD', received: '2020-01-01' }), doc({ type: 'SIR', received: '2024-01-01' })],
      TODAY,
    );
    assert.equal(r.status, 'review_closed');
  });

  it('breaks same-day ties in favor of the later stage', () => {
    const r = deriveStatus(
      [doc({ type: 'NOD', received: '2025-03-01' }), doc({ type: 'FIN', received: '2025-03-01' })],
      TODAY,
    );
    assert.equal(r.status, 'approved');
  });

  it('marks NOE-only projects exempt and NOP-only projects scoping', () => {
    assert.equal(deriveStatus([doc({ type: 'NOE' })], TODAY).status, 'exempt');
    assert.equal(deriveStatus([doc({ type: 'NOP' })], TODAY).status, 'scoping');
  });

  it('falls back to other for administrative notices', () => {
    assert.equal(deriveStatus([doc({ type: 'FYI' }), doc({ type: 'CON' })], TODAY).status, 'other');
  });
});

describe('document normalization', () => {
  it('parses CEQAnet dates', () => {
    assert.equal(toIsoDate('10/14/2025'), '2025-10-14');
    assert.equal(toIsoDate('1/2/1999 12:00:00 AM'), '1999-01-02');
    assert.equal(toIsoDate('13/40/2025'), null);
    assert.equal(toIsoDate(''), null);
  });

  it('splits and dedupes place lists', () => {
    assert.deepEqual(splitList('Redding,  Anderson, Redding'), ['Redding', 'Anderson']);
  });

  it('uses the document URL as the key and rejects URLs for a different SCH', () => {
    const base = { 'SCH Number': '2025100575', Received: '10/14/2025', 'Document Type': 'NOP' };
    const a = normalizeRecord({ ...base, 'Document Portal URL': 'https://ceqanet.lci.ca.gov/2025100575/3' });
    assert.equal(a?.key, 'https://ceqanet.lci.ca.gov/2025100575/3');
    const b = normalizeRecord({ ...base, 'Document Portal URL': 'https://ceqanet.lci.ca.gov/2014051061/9' });
    assert.equal(b?.url, null);
    assert.match(b?.key ?? '', /^2025100575\|NOP\|2025-10-14/);
  });
});

// A miniature gazetteer in the Census's own format (tab-delimited, padded last header).
const PLACES = [
  'USPS\tGEOID\tANSICODE\tNAME\tLSAD\tFUNCSTAT\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG                                                                                                               ',
  'CA\t0659444\t02411573\tRedding city\t25\tA\t155000000\t3000000\t59.8\t1.2\t40.5865\t-122.3917',
  'CA\t0602252\t02409698\tAnderson city\t25\tA\t17000000\t0\t6.6\t0\t40.4521\t-122.2970',
  'CA\t0644000\t02410877\tLos Angeles city\t25\tA\t1214000000\t87000000\t468.7\t33.6\t34.0194\t-118.4108',
  'CA\t0606308\t02409892\tCañada CDP\t57\tS\t5000000\t0\t1.9\t0\t37.6000\t-122.4000',
  'NV\t3240000\t02410923\tReno city\t25\tA\t280000000\t0\t108\t0\t39.5\t-119.8',
].join('\n');
const COUNTIES = [
  'USPS|GEOID|ANSICODE|NAME|ALAND|AWATER|ALAND_SQMI|AWATER_SQMI|INTPTLAT|INTPTLONG',
  'CA|06089|00277309|Shasta County|9779000000|180000000|3775.8|69.6|40.7637|-122.0405',
  'CA|06029|02054176|Kern County|21062000000|80000000|8132.5|30.9|35.3431|-118.7298',
  'CA|06107|00277318|Tulare County|12495000000|40000000|4824.4|15.4|36.2205|-118.7809',
  'CA|06015|01682074|Del Norte County|2606000000|580000000|1006.4|224|41.7499|-123.9809',
].join('\n');
const GAZ = buildGazetteer(parseGazetteerFile(PLACES), parseGazetteerFile(COUNTIES));

describe('gazetteer', () => {
  it('parses tab and pipe delimited files and filters to California', () => {
    assert.equal(Object.keys(GAZ.places).length, 4);
    assert.equal(Object.keys(GAZ.counties).length, 4);
  });
  it('normalizes names across CEQAnet and Census spellings', () => {
    assert.equal(normalizePlaceName('City of Redding'), 'redding');
    assert.equal(normalizePlaceName('Redding city'), 'redding');
    assert.equal(normalizePlaceName('Shasta County'), 'shasta');
    assert.equal(normalizePlaceName('Cañada CDP'), 'canada');
    assert.equal(normalizePlaceName('St. Helena'), 'saint helena');
  });
});

describe('resolveLocation', () => {
  it('prefers typed coordinates from the newest document', () => {
    const r = resolveLocation('x', [doc({ coordinates: `40°34'57"N 122°23'47"W`, cities: ['Redding'] })], GAZ);
    assert.equal(r?.precision, 'exact');
  });

  it('places single-city projects inside the city, deterministically', () => {
    const d = [doc({ cities: ['Redding'], counties: ['Shasta'] })];
    const a = resolveLocation('2025100575', d, GAZ);
    const b = resolveLocation('2025100575', d, GAZ);
    assert.equal(a?.precision, 'city');
    assert.deepEqual(a, b);
    assert.ok(haversineKm(a!, GAZ.places.redding) <= 8.01);
  });

  it('spreads different projects in the same city apart', () => {
    const d = [doc({ cities: ['Los Angeles'] })];
    const a = resolveLocation('2026000001', d, GAZ)!;
    const b = resolveLocation('2026000002', d, GAZ)!;
    assert.ok(haversineKm(a, b) > 0.05);
  });

  it('averages nearby cities', () => {
    const r = resolveLocation('x', [doc({ cities: ['Redding', 'Anderson'] })], GAZ);
    assert.equal(r?.precision, 'city');
  });

  it('falls back to county when the city is unknown', () => {
    const r = resolveLocation('x', [doc({ cities: ['Nowhere Junction'], counties: ['Kern'] })], GAZ);
    assert.equal(r?.precision, 'county');
  });

  it('treats unincorporated as no city', () => {
    const r = resolveLocation('x', [doc({ cities: ['Unincorporated'], counties: ['Kern'] })], GAZ);
    assert.equal(r?.precision, 'county');
  });

  it('marks nearby multi-county projects as region', () => {
    const r = resolveLocation('x', [doc({ counties: ['Kern', 'Tulare'] })], GAZ);
    assert.equal(r?.precision, 'region');
  });

  it('does not map far-apart or statewide projects', () => {
    assert.equal(resolveLocation('x', [doc({ counties: ['Kern', 'Del Norte'] })], GAZ), null);
    assert.equal(resolveLocation('x', [doc({ counties: ['Kern', 'Tulare', 'Shasta', 'Del Norte'] })], GAZ), null);
    assert.equal(resolveLocation('x', [doc({})], GAZ), null);
  });

  it('jitter stays within its radius', () => {
    for (let i = 0; i < 200; i++) {
      const p = jitter({ lon: -120, lat: 37 }, 5, String(i));
      assert.ok(haversineKm(p, { lon: -120, lat: 37 }) <= 5.01);
    }
  });
});

describe('aggregate', () => {
  it('groups documents into projects and counts everything', () => {
    const docs = [
      doc({ sch: '2025100575', type: 'NOP', received: '2025-10-14', cities: ['Redding'], projectTitle: 'Courthouse' }),
      doc({
        sch: '2025100575',
        type: 'EIR',
        received: '2026-11-03',
        reviewStart: '2026-11-03',
        reviewEnd: '2026-12-18',
        description: 'Demolish the old courthouse.',
        cities: ['Redding'],
      }),
      doc({
        sch: '2026110466',
        type: 'NOE',
        received: '2026-11-17',
        counties: ['Kern', 'Tulare', 'Shasta', 'Del Norte'],
      }),
    ];
    const r = aggregate(docs, GAZ, TODAY, '2026-11-18T00:00:00Z');
    assert.equal(r.counts.projects, 2);
    assert.equal(r.counts.documents, 3);
    assert.equal(r.counts.mapped, 1);
    assert.equal(r.counts.unmapped, 1);
    assert.equal(r.counts.byStatus.in_review, 1);
    assert.equal(r.counts.byStatus.exempt, 1);
    assert.equal(r.latestReceived, '2026-11-17');

    const p = r.projects.find((x) => x.sch === '2025100575')!;
    assert.equal(p.description, 'Demolish the old courthouse.');
    assert.equal(p.reviewEnd, '2026-12-18');
    assert.deepEqual(
      p.documents.map((d) => d.type),
      ['EIR', 'NOP'],
    );
    assert.equal(r.points[0].properties.r, 1);
    assert.equal(r.points[0].properties.x, 0);
  });

  it('truncates hover titles on a word boundary-ish and collapses whitespace', () => {
    assert.equal(truncate('  a   b  ', 10), 'a b');
    assert.equal(truncate('x'.repeat(100), 10).length, 10);
  });
});
