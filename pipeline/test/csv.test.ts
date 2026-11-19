import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CsvSchemaError, decodeCeqaCsv, parseCeqaCsv, parseLenientCsv } from '../src/lib/csv.ts';
import { ceqaCsv, CEQA_HEADER } from './helpers.ts';

describe('decodeCeqaCsv', () => {
  it('decodes Windows-1252 degree signs and curly quotes', () => {
    // 0xB0 = °, 0x92 = ’ in Windows-1252 (invalid as UTF-8)
    const bytes = Uint8Array.from([0x33, 0x38, 0xb0, 0x20, 0x43, 0x44, 0x46, 0x57, 0x92, 0x73]);
    assert.equal(decodeCeqaCsv(bytes), '38° CDFW’s');
  });
});

describe('parseLenientCsv', () => {
  it('handles standard quoting, escaped quotes, and CRLF', () => {
    assert.deepEqual(parseLenientCsv('a,"b,c","say ""hi"""\r\n1,2,3\r\n'), [
      ['a', 'b,c', 'say "hi"'],
      ['1', '2', '3'],
    ]);
  });

  it('keeps multi-line quoted fields intact', () => {
    assert.deepEqual(parseLenientCsv('x,"line one\r\nline two",y\r\n'), [['x', 'line one\r\nline two', 'y']]);
  });

  it('treats a quote in the middle of an unquoted field as a literal (coordinates)', () => {
    const rows = parseLenientCsv(`1,38°20'58.9"N 122°39'2.9"W,Sonoma\r\n2,ok,Yolo\r\n`);
    assert.deepEqual(rows, [
      ['1', `38°20'58.9"N 122°39'2.9"W`, 'Sonoma'],
      ['2', 'ok', 'Yolo'],
    ]);
  });

  it('treats inch marks in unquoted descriptions as literals (oil well NOEs)', () => {
    const rows = parseLenientCsv(`1,Install 7" casing and 2-7/8" tubing,NOE\r\n2,next,NOE\r\n`);
    assert.equal(rows.length, 2);
    assert.equal(rows[0][1], 'Install 7" casing and 2-7/8" tubing');
  });

  it('keeps a stray quote inside a quoted field that is not followed by a delimiter', () => {
    const rows = parseLenientCsv(`1,"Install 7" casing, then test",NOE\r\n`);
    assert.deepEqual(rows, [['1', 'Install 7" casing, then test', 'NOE']]);
  });
});

describe('parseCeqaCsv', () => {
  it('parses realistic rows including both CEQAnet quoting defects', () => {
    const csv = ceqaCsv([
      {
        'SCH Number': '2025100575',
        'Document Type': 'NOP',
        Received: '10/14/2025',
        'Document Title': 'OLD SHASTA COUNTY COURTHOUSE DEMOLITION PROJECT',
        'Location Coordinates': `40°34'57"N 122°23'47"W`,
        Cities: 'Redding',
        Counties: 'Shasta',
        'Document Description': 'Hazardous materials abatement,\r\nsite prep, and demolition.',
      },
      {
        'SCH Number': '2013081079',
        'Document Type': 'NOE',
        Received: '10/30/2026',
        'Document Description': 'Rework well 5403-11 with 7" casing',
        Counties: 'Kern',
      },
    ]);
    const parsed = parseCeqaCsv(csv);
    assert.equal(parsed.rejected.length, 0, JSON.stringify(parsed.rejected));
    assert.equal(parsed.records.length, 2);
    assert.equal(parsed.records[0]['Location Coordinates'], `40°34'57"N 122°23'47"W`);
    assert.equal(parsed.records[1]['Document Description'], 'Rework well 5403-11 with 7" casing');
    assert.equal(parsed.header.length, CEQA_HEADER.length);
  });

  it('rejects malformed rows instead of misreading them', () => {
    const csv = `${CEQA_HEADER.join(',')}\r\nnot-a-row,with,too,few,fields\r\n`;
    const parsed = parseCeqaCsv(csv);
    assert.equal(parsed.records.length, 0);
    assert.equal(parsed.rejected.length, 1);
  });

  it('rejects unknown document types', () => {
    const csv = ceqaCsv([{ 'SCH Number': '2025100575', 'Document Type': 'XYZ', Received: '1/1/2025' }]);
    assert.match(parseCeqaCsv(csv).rejected[0].reason, /unknown document type/);
  });

  it('fails loudly if CEQAnet renames a required column', () => {
    const csv = ceqaCsv([]).replace('Location Coordinates', 'Coordinates');
    assert.throws(() => parseCeqaCsv(csv), CsvSchemaError);
  });

  it('fails loudly on an empty response (CEQAnet returns these when throttling)', () => {
    assert.throws(() => parseCeqaCsv(''), CsvSchemaError);
  });
});
