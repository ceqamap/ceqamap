/**
 * A minimal reader for ESRI shapefiles (.shp + .dbf), enough for the Census
 * cartographic boundary files: polygon geometry (type 5) and text attributes.
 * Written here instead of adding a dependency; the format is fixed and small.
 *
 * Spec: https://www.esri.com/content/dam/esrisites/sitecore-archive/Files/Pdfs/library/whitepapers/pdfs/shapefile.pdf
 */
import type { Shape } from './geometry.ts';

export interface ShapefileFeature {
  properties: Record<string, string>;
  /** null for "null shape" records. */
  shape: Shape | null;
}

const SHAPE_NULL = 0;
const SHAPE_POLYLINE = 3;
const SHAPE_POLYGON = 5;

export function readShp(buf: Uint8Array): (Shape | null)[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getInt32(0, false) !== 9994) throw new Error('Not a shapefile (bad file code)');
  const fileBytes = dv.getInt32(24, false) * 2;
  const out: (Shape | null)[] = [];
  let off = 100;
  while (off + 8 <= Math.min(fileBytes, buf.byteLength)) {
    const contentBytes = dv.getInt32(off + 4, false) * 2;
    const rec = off + 8;
    const type = dv.getInt32(rec, true);
    if (type === SHAPE_NULL) {
      out.push(null);
    } else if (type === SHAPE_POLYGON || type === SHAPE_POLYLINE) {
      // Same layout: polylines' parts are lines instead of rings.
      const numParts = dv.getInt32(rec + 36, true);
      const numPoints = dv.getInt32(rec + 40, true);
      const partsAt = rec + 44;
      const pointsAt = partsAt + numParts * 4;
      const starts = Array.from({ length: numParts }, (_, i) => dv.getInt32(partsAt + i * 4, true));
      const shape: Shape = starts.map((start, i) => {
        const end = i + 1 < numParts ? starts[i + 1] : numPoints;
        const ring: [number, number][] = [];
        for (let p = start; p < end; p++) {
          ring.push([dv.getFloat64(pointsAt + p * 16, true), dv.getFloat64(pointsAt + p * 16 + 8, true)]);
        }
        return ring;
      });
      out.push(shape);
    } else {
      throw new Error(`Unsupported shape type ${type}`);
    }
    off = rec + contentBytes;
  }
  return out;
}

export function readDbf(buf: Uint8Array): Record<string, string>[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = dv.getUint32(4, true);
  const headerLength = dv.getUint16(8, true);
  const recordLength = dv.getUint16(10, true);
  const decoder = new TextDecoder('utf-8');
  const fields: { name: string; offset: number; length: number }[] = [];
  let offset = 1; // first byte of each record is the deletion flag
  for (let at = 32; at + 32 <= headerLength && buf[at] !== 0x0d; at += 32) {
    const raw = buf.subarray(at, at + 11);
    const name = decoder.decode(raw.subarray(0, raw.indexOf(0) === -1 ? 11 : raw.indexOf(0)));
    const length = buf[at + 16];
    fields.push({ name, offset, length });
    offset += length;
  }
  const rows: Record<string, string>[] = [];
  for (let r = 0; r < count; r++) {
    const base = headerLength + r * recordLength;
    const row: Record<string, string> = {};
    for (const f of fields)
      row[f.name] = decoder.decode(buf.subarray(base + f.offset, base + f.offset + f.length)).trim();
    rows.push(row);
  }
  return rows;
}

export function readShapefile(shp: Uint8Array, dbf: Uint8Array): ShapefileFeature[] {
  const shapes = readShp(shp);
  const rows = readDbf(dbf);
  if (shapes.length !== rows.length) throw new Error(`.shp has ${shapes.length} records but .dbf has ${rows.length}`);
  return shapes.map((shape, i) => ({ shape, properties: rows[i] }));
}
