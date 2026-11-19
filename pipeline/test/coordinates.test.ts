import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCoordinates } from '../src/lib/coordinates.ts';

function near(actual: { lon: number; lat: number } | null, lat: number, lon: number, eps = 1e-4) {
  assert.ok(actual, 'expected a coordinate');
  assert.ok(Math.abs(actual.lat - lat) < eps, `lat ${actual.lat} != ${lat}`);
  assert.ok(Math.abs(actual.lon - lon) < eps, `lon ${actual.lon} != ${lon}`);
}

describe('parseCoordinates', () => {
  // Every format below was observed in live CEQAnet data.
  it('parses the common DMS form', () => {
    near(parseCoordinates(`40°34'57"N 122°23'47"W`), 40.5825, -122.396389);
  });
  it('parses decimal seconds', () => {
    near(parseCoordinates(`38°20'58.9"N 122°39'2.9"W`), 38.349694, -122.650806);
  });
  it('parses the double-prime variant', () => {
    near(parseCoordinates(`38°20'58.9″N 122°39'2.9″W`), 38.349694, -122.650806);
  });
  it('parses when the seconds mark is missing', () => {
    near(parseCoordinates(`37°23'54.906N 121°55'49.056W`), 37.398585, -121.930293);
  });
  it('parses degrees and minutes only', () => {
    near(parseCoordinates(`34°3'N 118°14'W`), 34.05, -118.233333);
  });
  it('parses degrees only with empty minutes', () => {
    near(parseCoordinates(`36°'N 119°'W`), 36, -119);
  });
  it('parses double-prime used for minutes', () => {
    near(parseCoordinates(`36°47″2.27″N 119°37″2.92″W`), 36.783964, -119.617478);
  });
  it('parses dash-separated minutes and seconds', () => {
    near(parseCoordinates(`35°12-30'N 119°5-10'W`), 35.208333, -119.086111);
  });
  it('parses decimal degree pairs', () => {
    near(parseCoordinates('38.5816, -121.4944'), 38.5816, -121.4944);
  });
  it('repairs a missing minus sign on longitude', () => {
    near(parseCoordinates('38.5816, 121.4944'), 38.5816, -121.4944);
  });
  it('repairs swapped latitude and longitude', () => {
    near(parseCoordinates('-121.4944, 38.5816'), 38.5816, -121.4944);
  });
  it('rejects points outside California', () => {
    assert.equal(parseCoordinates(`40°42'46"N 74°0'21"W`), null); // New York
  });
  it('rejects impossible minutes', () => {
    assert.equal(parseCoordinates(`38°75'0"N 122°0'0"W`), null);
  });
  it('rejects empty and junk input', () => {
    assert.equal(parseCoordinates(''), null);
    assert.equal(parseCoordinates(undefined), null);
    assert.equal(parseCoordinates('see attached map'), null);
  });
});
