/**
 * Exit 0 if pipeline/data/boundaries.json exists and is the current format,
 * 1 otherwise. CI runs `node boundaries-current.ts || pnpm boundaries`.
 */
import { readFile } from 'node:fs/promises';
import { BOUNDARIES_FORMAT } from '../src/lib/boundaries.ts';

try {
  const text = await readFile(new URL('../data/boundaries.json', import.meta.url), 'utf8');
  const format = (JSON.parse(text) as { format?: number }).format;
  if (format !== BOUNDARIES_FORMAT) {
    console.log(`boundaries.json is format ${format ?? 1}; need ${BOUNDARIES_FORMAT}`);
    process.exit(1);
  }
} catch {
  console.log('boundaries.json is missing');
  process.exit(1);
}
