import { add, distToSegment, dot, midpoint, norm, scale, signedArea, sub } from './geometry';
import { inwardNormal } from './layout';
import type { EdgeInfo, FootprintEdge, Ring, Vec2 } from './types';

/** Largeur de la porte de garage (m) : une voie, avec feux d'alternat au-delà de quelques places. */
export const DOOR_WIDTH = 3.5;
/** Longueur de rampe prise sur le rez-de-chaussée (m) : DOOR_WIDTH × 4,3 ≈ les 15 m² de `rampEntryLoss`. */
export const RAMP_LENGTH = 4.3;
const DOOR_MARGIN = 0.6;

export interface ParkingAccess {
  kind: 'sous-sol' | 'rez-de-chaussée';
  /** Niveaux de sous-sol desservis (0 pour un parking en rez-de-chaussée). */
  levels: number;
  /** Porte de garage dans la façade. */
  door: [Vec2, Vec2];
  /** Normale unitaire sortante de la façade (vers la rue). */
  out: Vec2;
  /** Allée entre la voie et la porte, null si la façade est sur la voie. */
  drive: Ring | null;
  /** Rampe descendant dans le bâtiment (sous-sol seulement). */
  ramp: Ring | null;
}

interface Input {
  footprint: Ring;
  footprintEdges: FootprintEdge[];
  edges: EdgeInfo[];
  parcelRing: Ring;
  kind: ParkingAccess['kind'];
  levels: number;
}

/**
 * Place l'entrée du parking : une porte de 3,5 m à l'extrémité de la façade sur rue la plus longue (ou, si le bâtiment
 * est en retrait ou en fond de parcelle, de la façade la mieux orientée vers la voie), reliée à la voie par une allée.
 * Retourne null si aucune façade n'est assez large ou tournée vers la rue.
 */
export function computeParkingAccess(input: Input): ParkingAccess | null {
  const { footprint, footprintEdges, edges, parcelRing, kind, levels } = input;
  const streets = edges.filter((e) => e.kind === 'voie');
  if (streets.length === 0) return null;
  const orient = signedArea(footprint) >= 0 ? 1 : -1;
  const outward = (a: Vec2, b: Vec2): Vec2 => {
    const d = norm(sub(b, a));
    return orient > 0 ? [d[1], -d[0]] : [-d[1], d[0]];
  };
  const nearestStreet = (p: Vec2) => streets.reduce((best, e) => (distToSegment(p, e.a, e.b) < distToSegment(p, best.a, best.b) ? e : best), streets[0]);
  const wide = footprintEdges.filter((e) => e.length >= DOOR_WIDTH + 1);

  let facade: FootprintEdge | undefined = wide.filter((e) => e.role === 'street').sort((x, y) => y.length - x.length)[0];
  if (!facade) {
    let bestDist = Infinity;
    for (const e of wide) {
      const m = midpoint(e.a, e.b);
      const st = nearestStreet(m);
      const toStreet = scale(inwardNormal(parcelRing, st.index), -1);
      if (dot(outward(e.a, e.b), toStreet) < 0.7) continue;
      const d = distToSegment(m, st.a, st.b);
      if (d < bestDist) {
        bestDist = d;
        facade = e;
      }
    }
  }
  if (!facade) return null;

  const out = outward(facade.a, facade.b);
  const mid = midpoint(facade.a, facade.b);
  const street = nearestStreet(mid);
  // la porte est posée à l'extrémité de la façade située du côté « début » de la voie (choix déterministe)
  const u = norm(sub(street.b, street.a));
  const [s, e] = dot(facade.a, u) <= dot(facade.b, u) ? [facade.a, facade.b] : [facade.b, facade.a];
  const d = norm(sub(e, s));
  const m0 = Math.min(DOOR_MARGIN, (facade.length - DOOR_WIDTH) / 2);
  const door: [Vec2, Vec2] = [add(s, scale(d, m0)), add(s, scale(d, m0 + DOOR_WIDTH))];

  const nIn = inwardNormal(parcelRing, street.index);
  const depth = dot(sub(midpoint(door[0], door[1]), street.a), nIn);
  const back = (p: Vec2): Vec2 => sub(p, scale(nIn, depth));
  const drive: Ring | null = depth >= 0.5 ? [door[0], door[1], back(door[1]), back(door[0])] : null;
  const inside = scale(out, -RAMP_LENGTH);
  const ramp: Ring | null = kind === 'sous-sol' ? [door[0], door[1], add(door[1], inside), add(door[0], inside)] : null;
  return { kind, levels, door, out, drive, ramp };
}
