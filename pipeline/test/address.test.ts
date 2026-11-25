import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { caZip, extractAddress } from '../src/lib/address.ts';

const street = (t: string) => extractAddress(t)?.street ?? null;

describe('extractAddress', () => {
  it('finds plain and ranged addresses', () => {
    assert.equal(street('1234 Main St'), '1234 Main St');
    assert.equal(street('1201-1215 S. Figueroa Street'), '1201 S. Figueroa Street');
    assert.equal(street('Lot split at 55 W. 3rd Ave., Escondido'), '55 W. 3rd Ave');
    assert.equal(street('22500 Pacific Coast Highway Residence'), '22500 Pacific Coast Highway');
    assert.equal(street('Demolition at 410 Via Colinas'), '410 Via Colinas');
    assert.equal(street('5990 West Camino De La Costa, San Diego CA'), '5990 West Camino De La Costa');
    assert.equal(street('Location: 3337 County Road 307, Elk Creek'), '3337 County Road 307');
    assert.equal(street('511 West Avenue 49 (ENV-2026-648-CE)'), '511 West Avenue 49');
    assert.equal(street('ENV-2013-2239-MND / 15275 W. De Pauw Street'), '15275 W. De Pauw Street');
  });

  it('reads past underscores in file-name-style titles (SCH 2026021010)', () => {
    assert.equal(
      street('PSH Outdoor Recreational & Accessibility Improvements program_5050 W. Pico Blvd., Los Angeles, CA 90019'),
      '5050 W. Pico Blvd',
    );
    assert.equal(street('Project_Site_1234_Main_St'), '1234 Main St');
  });

  it('ignores highways, quantities and years', () => {
    assert.equal(street('Olive Mill Rd. and Hot Springs Road'), null);
    assert.equal(street('101 Freeway and Main St'), null);
    assert.equal(street('Highway 99 at 5th Street'), null);
    assert.equal(street('12 lots on Elm Ave'), null);
    assert.equal(street('40 acres near Foothill Blvd'), null);
    assert.equal(street('2040 General Plan Update'), null);
    assert.equal(street('$1,500 Main St'), null);
    assert.equal(street('1 State Route 1'), null);
    assert.equal(street('SR-99 Washington Avenue Water Crossing'), null);
    assert.equal(street('PROPOSED DIVISION 6 JEFFERSON BLVD RELOCATION'), null);
    assert.equal(street('pursuant to Section 2019 by Industrial Court'), null);
    assert.equal(street('addition of 700 square foot terrace'), null);
    assert.equal(street('a 12 foot wide access road'), null);
    assert.equal(street('South of Avenue 38 along Madison Street'), null);
    assert.equal(street('4500 maximum pounds per square'), null);
  });
});

describe('caZip', () => {
  it('accepts California ZIP codes only', () => {
    assert.equal(caZip('95814'), '95814');
    assert.equal(caZip(' 95814-1234 '), '95814');
    assert.equal(caZip('10001'), null);
    assert.equal(caZip('9581'), null);
    assert.equal(caZip(''), null);
  });
});
