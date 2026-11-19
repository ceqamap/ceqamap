/**
 * Parsing CEQAnet's CSV export.
 *
 * The export at /Search?...&OutputFormat=CSV has two defects we must tolerate
 * (both verified against live data on 2026-11-18):
 *
 * 1. It is Windows-1252, not UTF-8. Decoding as UTF-8 corrupts ° ’ “ ” etc.
 * 2. It does not escape double quotes inside unquoted fields. Coordinates are
 *    written like 38°20'58.9"N, and oil-well descriptions contain 7" casing.
 *    A strict RFC 4180 parser treats those as field openers and swallows
 *    hundreds of following rows.
 *
 * The lenient parser below only treats a quote as an opener at the very start
 * of a field, and inside a quoted field only treats a lone quote as a closer
 * when it is followed by a comma, a line break, or end of input. On live data
 * this recovered 100% of rows for 2026 and 99.6 to 100% for 1985 to 2015.
 */

const DECODER = new TextDecoder('windows-1252');

export function decodeCeqaCsv(bytes: ArrayBuffer | Uint8Array): string {
  return DECODER.decode(bytes);
}

export function parseLenientCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let atFieldStart = true;
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          const next = text[i + 1];
          if (next === undefined || next === ',' || next === '\r' || next === '\n') {
            inQuotes = false;
          } else {
            field += c; // a stray quote inside a quoted field
          }
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
    } else if (c === ',') {
      row.push(field);
      field = '';
      atFieldStart = true;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      atFieldStart = true;
    } else if (c === '\r' && text[i + 1] === '\n') {
      // swallow; the \n ends the row
    } else {
      field += c;
      atFieldStart = false;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Document type codes accepted by CEQAnet's Advanced Search. */
export const KNOWN_DOCUMENT_TYPES = new Set(
  'NDE NOD NOE ADM BIA BLA CON EA EIR EIS FED FIN FIS FON FOT FYI JD MEA MND NEG NOC NOI NOP OTH RAN RC REV RIR ROD SBE SCA SEA SIR SIS TRI'.split(
    ' ',
  ),
);

/** Columns we rely on. If CEQAnet renames one, ingestion fails loudly. */
export const REQUIRED_COLUMNS = [
  'SCH Number',
  'Lead Agency Name',
  'Document Title',
  'Document Type',
  'Received',
  'Document Description',
  'Document Portal URL',
  'Project Title',
  'Location Coordinates',
  'Cities',
  'Counties',
] as const;

export type CsvRecord = Record<string, string>;

export interface ParsedCsv {
  header: string[];
  records: CsvRecord[];
  /** Rows that failed validation; logged and counted, never silently used. */
  rejected: { line: number; reason: string; preview: string }[];
}

export class CsvSchemaError extends Error {}

export function parseCeqaCsv(text: string): ParsedCsv {
  const rows = parseLenientCsv(text);
  if (rows.length === 0) throw new CsvSchemaError('Empty CSV response');
  const header = rows[0].map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new CsvSchemaError(`CEQAnet CSV is missing columns: ${missing.join(', ')}`);
  }
  const typeIdx = header.indexOf('Document Type');
  const records: CsvRecord[] = [];
  const rejected: ParsedCsv['rejected'] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0].trim() === '') continue; // blank trailing line
    let reason: string | null = null;
    if (r.length !== header.length) reason = `expected ${header.length} fields, got ${r.length}`;
    else if (!/^\d{10}$/.test(r[0].trim())) reason = 'SCH Number is not 10 digits';
    else if (!KNOWN_DOCUMENT_TYPES.has(r[typeIdx].trim())) reason = `unknown document type "${r[typeIdx].trim()}"`;
    if (reason) {
      rejected.push({ line: i + 1, reason, preview: r.slice(0, 3).join(' | ').slice(0, 120) });
      continue;
    }
    const rec: CsvRecord = {};
    for (let j = 0; j < header.length; j++) rec[header[j]] = r[j].trim();
    records.push(rec);
  }
  return { header, records, rejected };
}
