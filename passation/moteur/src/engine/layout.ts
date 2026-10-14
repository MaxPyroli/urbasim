import {
  Frame,
  capsule,
  difference,
  dist,
  distToSegment,
  dot,
  len,
  midpoint,
  norm,
  signedArea,
  sub,
  toMulti,
  union,
} from './geometry';
import type { Criteria, EdgeInfo, EdgeKind, FootprintEdge, MultiPolygon, Ring, Vec2 } from './types';

/** Arête de voie de référence : la plus longue des arêtes sur rue. */
export function primaryStreetEdge(ring: Ring, streetEdges: number[]): number {
  const valid = streetEdges.filter((i) => i >= 0 && i < ring.length);
  if (valid.length === 0) return 0;
  return valid.reduce((best, i) => {
    const l = dist(ring[i], ring[(i + 1) % ring.length]);
    const lb = dist(ring[best], ring[(best + 1) % ring.length]);
    return l > lb ? i : best;
  }, valid[0]);
}

/** Normale unitaire de l'arête i, orientée vers l'intérieur du terrain. */
export function inwardNormal(ring: Ring, i: number): Vec2 {
  const a = ring[i];
  const b = ring[(i + 1) % ring.length];
  const d = norm(sub(b, a));
  return signedArea(ring) >= 0 ? [-d[1], d[0]] : [d[1], -d[0]];
}

export function classifyEdges(ring: Ring, streetEdges: number[]): EdgeKind[] {
  const n = ring.length;
  const kinds: EdgeKind[] = new Array(n).fill('laterale');
  const streets = streetEdges.filter((i) => i >= 0 && i < n);
  const main = primaryStreetEdge(ring, streets);
  for (const i of streets) kinds[i] = 'voie';
  if (streets.length === 0) kinds[main] = 'voie';

  const a = ring[main];
  const b = ring[(main + 1) % n];
  const u = norm(sub(b, a));
  const nrm = inwardNormal(ring, main);

  let rear = -1;
  let rearDist = -Infinity;
  for (let i = 0; i < n; i++) {
    if (kinds[i] === 'voie') continue;
    const p = ring[i];
    const q = ring[(i + 1) % n];
    const d = norm(sub(q, p));
    if (Math.abs(dot(d, u)) < 0.7) continue;
    const depth = dot(sub(midpoint(p, q), a), nrm);
    if (depth > rearDist) {
      rearDist = depth;
      rear = i;
    }
  }
  if (rear >= 0) kinds[rear] = 'fond';
  return kinds;
}

export function computeEdges(ring: Ring, streetEdges: number[], c: Criteria, height: number): EdgeInfo[] {
  const kinds = classifyEdges(ring, streetEdges);
  return ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const kind = kinds[i];
    const base =
      c.edgeSetbacks[i] ?? (kind === 'voie' ? c.setbackVoie : kind === 'fond' ? c.setbackFond : c.setbackLateral);
    let setback = Math.max(0, base);
    if (kind !== 'voie' && setback > 0 && c.prospectRatio > 0) setback = Math.max(setback, c.prospectRatio * height);
    return { index: i, a, b, length: dist(a, b), kind, setback, party: setback < 1e-6 };
  });
}

/** Zone constructible = terrain − bandes de retrait (tout point à moins de `setback` de la limite). */
export function buildEnvelope(ring: Ring, edges: EdgeInfo[]): MultiPolygon {
  const bands = edges.filter((e) => e.setback > 1e-6 && e.length > 1e-6).map((e) => [[capsule(e.a, e.b, e.setback)]] as MultiPolygon);
  const parcel = toMulti(ring);
  if (bands.length === 0) return parcel;
  return difference(parcel, union(bands[0], ...bands.slice(1)));
}

/** Repère de calcul : u le long de la voie principale, v vers l'intérieur du terrain. */
export function makeFrame(ring: Ring, streetEdges: number[]): Frame {
  const main = primaryStreetEdge(ring, streetEdges);
  const a = ring[main];
  const b = ring[(main + 1) % ring.length];
  return new Frame(a, norm(sub(b, a)), inwardNormal(ring, main));
}

/** Rôle de chaque façade de l'emprise : mitoyenne, sur rue ou sur jardin. */
export function classifyFootprintEdges(footprint: Ring, edges: EdgeInfo[]): FootprintEdge[] {
  return footprint.map((a, i) => {
    const b = footprint[(i + 1) % footprint.length];
    const m = midpoint(a, b);
    const d = norm(sub(b, a));
    let best: EdgeInfo | null = null;
    let bestDist = Infinity;
    for (const e of edges) {
      const dd = distToSegment(m, e.a, e.b);
      if (dd < bestDist) {
        bestDist = dd;
        best = e;
      }
    }
    let role: FootprintEdge['role'] = 'free';
    if (best) {
      const parallel = Math.abs(dot(d, norm(sub(best.b, best.a)))) > 0.9;
      if (best.kind === 'voie' && parallel) role = 'street';
      else if (best.party && bestDist < 0.05 && parallel) role = 'party';
    }
    return { a, b, length: len(sub(b, a)), role };
  });
}

/**
 * Azimut (radians, sens horaire depuis le nord) d'une caméra placée côté rue qui regarde vers l'intérieur du terrain.
 * `ring` est en repère local : x vers l'est, y vers le nord.
 */
export function streetHeading(ring: Ring, streetEdges: number[]): number {
  const n = inwardNormal(ring, primaryStreetEdge(ring, streetEdges));
  return Math.atan2(n[0], n[1]);
}

/**
 * Devine les côtés sur rue à partir de polylignes de voies (repère local, en m).
 * Un côté est « sur rue » s'il est (quasi) parallèle à la voie la plus proche et aussi proche d'elle que le meilleur côté
 * (à `tolerance` m près), à moins de `maxDist` m. Retourne [] si aucune voie n'est assez proche.
 */
export function pickStreetEdgesFromRoads(ring: Ring, roads: Vec2[][], maxDist = 35, tolerance = 3): number[] {
  const n = ring.length;
  const info = ring.map((a, i) => {
    const b = ring[(i + 1) % n];
    const dir = norm(sub(b, a));
    const samples: Vec2[] = [a, midpoint(a, b), b];
    let best = Infinity;
    let bestPar = 0;
    for (const road of roads) {
      for (let k = 0; k + 1 < road.length; k++) {
        const rd = norm(sub(road[k + 1], road[k]));
        const par = Math.abs(dot(dir, rd));
        // la distance comptée est celle du milieu du côté à la voie ; les extrémités évitent de rater une voie oblique
        const d = Math.min(distToSegment(samples[1], road[k], road[k + 1]), 0.5 * (distToSegment(samples[0], road[k], road[k + 1]) + distToSegment(samples[2], road[k], road[k + 1])));
        if (d < best) {
          best = d;
          bestPar = par;
        }
      }
    }
    return { best, par: bestPar };
  });
  const candidates = info.map((x, i) => ({ ...x, i })).filter((x) => Number.isFinite(x.best) && x.best <= maxDist && x.par >= 0.5);
  if (candidates.length === 0) return [];
  const dmin = Math.min(...candidates.map((x) => x.best));
  return candidates.filter((x) => x.best <= dmin + tolerance).map((x) => x.i);
}
