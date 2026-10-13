import type { LonLat, Parcel } from './types';

/** Insère un sommet au milieu de l'arête `edge` (ou en `at`) et décale les indices d'arêtes de voie. */
export function insertVertex(parcel: Parcel, edge: number, at?: LonLat): Parcel {
  const n = parcel.ring.length;
  const a = parcel.ring[edge];
  const b = parcel.ring[(edge + 1) % n];
  const pt = at ?? { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
  const ring = [...parcel.ring.slice(0, edge + 1), pt, ...parcel.ring.slice(edge + 1)];
  const street = new Set<number>();
  for (const i of parcel.streetEdges) {
    if (i < edge) street.add(i);
    else if (i === edge) {
      street.add(edge);
      street.add(edge + 1);
    } else street.add(i + 1);
  }
  return { ring, streetEdges: [...street].sort((x, y) => x - y) };
}

/** Supprime le sommet k : les arêtes k−1 et k fusionnent (de voie si l'une l'était). Minimum 3 sommets. */
export function removeVertex(parcel: Parcel, k: number): Parcel {
  const n = parcel.ring.length;
  if (n <= 3) return parcel;
  const ring = parcel.ring.filter((_, i) => i !== k);
  const prev = (k - 1 + n) % n;
  // indice, dans le nouvel anneau, de l'arête issue de la fusion des arêtes prev et k
  const merged = k > 0 ? k - 1 : n - 2;
  const street = new Set<number>();
  for (const i of parcel.streetEdges) {
    if (i === k || i === prev) street.add(merged);
    else street.add(i > k ? i - 1 : i);
  }
  const out = [...street].filter((i) => i >= 0 && i < ring.length).sort((x, y) => x - y);
  return { ring, streetEdges: out.length > 0 ? out : [0] };
}

/** Bascule une arête entre « sur rue » et « limite privée » (au moins une voie est toujours conservée). */
export function toggleStreetEdge(parcel: Parcel, edge: number): Parcel {
  const has = parcel.streetEdges.includes(edge);
  if (has && parcel.streetEdges.length === 1) return parcel;
  const streetEdges = has ? parcel.streetEdges.filter((i) => i !== edge) : [...parcel.streetEdges, edge].sort((a, b) => a - b);
  return { ...parcel, streetEdges };
}
