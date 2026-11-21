/**
 * Placing projects at a street address written in their own text.
 *
 * For each project without usable agency coordinates, find the first street
 * address in its Cross Streets field, title, or description (see address.ts),
 * geocode it with the Census (geocode.ts), and keep the result only if it
 * agrees with the cities and counties the project lists, so an address
 * copied from an agency letterhead or a mistyped city can't move a project.
 *
 * On a 3,000-project sample (2026-11-20), 77% geocoded and agreed with the
 * listed places, 1% geocoded somewhere that contradicted them (rejected) and
 * 22% weren't found by the Census.
 */
import { caZip, extractAddress } from './address.ts';
import type { Boundaries } from './boundaries.ts';
import type { CeqaDocument } from './document.ts';
import { type AddressQuery, type GeocodeCache, geocodeAll, queryKey } from './geocode.ts';
import { type AddressPlacement, agreesWithPlaces, type ListedPlaces, listedPlaces } from './location.ts';

const FIELDS = ['crossStreets', 'projectTitle', 'documentTitle', 'description'] as const;

export interface AddressRequest {
  sch: string;
  query: AddressQuery;
  places: ListedPlaces;
}

/** The address to geocode for a project, or null if there's none (or no city or ZIP to pair it with). */
export function addressRequest(sch: string, newestFirst: readonly CeqaDocument[], b: Boundaries): AddressRequest | null {
  let street: string | null = null;
  for (const field of FIELDS) {
    for (const d of newestFirst) {
      const a = extractAddress(d[field]);
      if (a) {
        street = a.street;
        break;
      }
    }
    if (street) break;
  }
  if (!street) return null;
  const places = listedPlaces(newestFirst, b);
  const city = places.cityAreas?.length === 1 ? places.cityAreas[0].name : '';
  const zip = newestFirst.map((d) => caZip(d.zip)).find((z) => z !== null) ?? '';
  if (!city && !zip) return null;
  return { sch, query: { street, city, zip }, places };
}

export async function placeAtAddresses(
  requests: AddressRequest[],
  b: Boundaries,
  cache: GeocodeCache,
  today: string,
): Promise<{ placements: Map<string, AddressPlacement>; stats: Record<string, number> }> {
  const { results, stats } = await geocodeAll(
    requests.map((r) => r.query),
    cache,
    today,
  );
  const placements = new Map<string, AddressPlacement>();
  let rejected = 0;
  for (const r of requests) {
    const p = results.get(queryKey(r.query));
    if (!p) continue;
    if (!agreesWithPlaces(p, r.places, b)) {
      rejected++;
      continue;
    }
    const where = r.query.city || r.query.zip;
    placements.set(r.sch, { lon: p.lon, lat: p.lat, address: `${r.query.street}, ${where}` });
  }
  return { placements, stats: { requests: requests.length, ...stats, rejected, placed: placements.size } };
}
