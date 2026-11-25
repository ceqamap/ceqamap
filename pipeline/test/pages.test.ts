import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CeqaDocument } from '../src/lib/document.ts';
import { attachPageInfo, coordinatesInText, otherLocationInfo } from '../src/lib/pages.ts';

// Trimmed from https://ceqanet.lci.ca.gov/2026040250 (2026-11-23).
const QUIOTA_HTML = `
            <div class="row">
                <div class="col col-xs-3 document-label">
                    <strong>Regions</strong>
                </div>

                <div class="col-md-9 dont-break-out" style="margin-bottom: 1rem">Southern California</div>
            </div>

            <div class="row">
                <div class="col col-xs-3 document-label">
                    <strong>Other Location Info</strong>
                </div>
                <div class="col-md-9" style="margin-bottom: 1rem">
                    The Quiota Creek Crossing 0A Sediment Removal Project (Project) is located where Quiota Creek crosses through Alisal Ranch, just west of North Refugio Road in the town of Santa Ynez, Santa Barbara County, California; Latitude 34.581478, Longitude -120.108033. The Project is located within Assessor&#8217;s Parcel Number (APN) 137-290-027.
                </div>
            </div>

    </div>
</div>
    <hr />
    <h2>Notice of Exemption</h2>`;

describe('otherLocationInfo', () => {
  it('reads the field from a project page', () => {
    const info = otherLocationInfo(QUIOTA_HTML)!;
    assert.match(info, /^The Quiota Creek Crossing 0A .* Latitude 34\.581478, Longitude -120\.108033\./);
    assert.match(info, /Assessor’s Parcel Number \(APN\) 137-290-027\.$/);
  });

  it('returns null when the page has no such field', () => {
    assert.equal(otherLocationInfo('<strong>Regions</strong></div><div>Southern California</div>'), null);
  });
});

describe('coordinatesInText', () => {
  it('reads labeled, paired and DMS coordinates', () => {
    assert.deepEqual(coordinatesInText(otherLocationInfo(QUIOTA_HTML)!), { lon: -120.108033, lat: 34.581478 });
    assert.deepEqual(coordinatesInText('Cow Camp Road Bridge (33.528784, -117.610603), Rancho Mission Viejo'), {
      lon: -117.610603,
      lat: 33.528784,
    });
    const dms = coordinatesInText(`Site at 34°34'53.3"N 120°06'29.0"W near Santa Ynez`)!;
    assert.ok(Math.abs(dms.lat - 34.5815) < 1e-3 && Math.abs(dms.lon - -120.108) < 1e-3);
  });

  it('ignores numbers that are not clearly coordinates', () => {
    assert.equal(coordinatesInText('Between post miles 12.4 and 15.3 on US-101'), null);
    assert.equal(coordinatesInText('APN 137-290-027, 38.5 acres, 121.2 feet'), null);
    assert.equal(coordinatesInText('Lots 36.123, 119.456 are vacant'), null);
  });
});

describe('attachPageInfo', () => {
  const doc = (over: Partial<CeqaDocument>): CeqaDocument =>
    ({
      key: 'k',
      sch: '2026040250',
      type: 'NOE',
      received: '2026-04-07',
      coordinates: '',
      cities: [],
      counties: ['Santa Barbara'],
      crossStreets: '',
      ...over,
    }) as CeqaDocument;

  it('attaches text to the newest document and fills empty coordinates', () => {
    const older = doc({ key: 'a', received: '2026-01-01' });
    const newer = doc({ key: 'b', received: '2026-04-07' });
    const stats = attachPageInfo([[older, newer]], {
      version: 1,
      pages: { '2026040250': { info: 'Latitude 34.581478, Longitude -120.108033', at: '', latest: '2026-04-07' } },
    });
    assert.deepEqual(stats, { withInfo: 1, withCoordinates: 1 });
    assert.equal(newer.otherLocation, 'Latitude 34.581478, Longitude -120.108033');
    assert.equal(newer.coordinates, '34.581478, -120.108033');
    assert.equal(older.otherLocation, undefined);
  });

  it('keeps coordinates the agency already entered', () => {
    const d = doc({ coordinates: '34.6, -120.2' });
    attachPageInfo([[d]], {
      version: 1,
      pages: { '2026040250': { info: 'Latitude 34.581478, Longitude -120.108033', at: '', latest: '' } },
    });
    assert.equal(d.coordinates, '34.6, -120.2');
  });
});

describe('zipAfter', () => {
  it('reads the ZIP written with an address', async () => {
    const { zipAfter } = await import('../src/lib/addresses.ts');
    assert.equal(zipAfter('The project is located at 3325 Myrtle Avenue, North Highlands, CA 95660', 3325), '95660');
    assert.equal(zipAfter('17802 Del Puerto Canyon Road, Patterson, CA 95363', 17802), '95363');
    assert.equal(zipAfter('3325 Myrtle Avenue near the 95660 sign', 3325), null);
    assert.equal(zipAfter('program_5050 W. Pico Blvd., Los Angeles, CA 90019', 5050), '90019');
  });
});
