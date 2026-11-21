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
