import polygonClipping from 'polygon-clipping';
import type { LonLat, MultiPolygon, PolygonRings, Ring, Vec2 } from './types';

const EARTH_RADIUS = 6378137;
const RAD = Math.PI / 180;

/** Projection équirectangulaire locale (précise au centimètre sur quelques centaines de mètres). */
export class LocalProjection {
  constructor(
    readonly lon0: number,
    readonly lat0: number,
  ) {}

  toLocal(p: LonLat): Vec2 {
    return [
      (p.lon - this.lon0) * RAD * EARTH_RADIUS * Math.cos(this.lat0 * RAD),
      (p.lat - this.lat0) * RAD * EARTH_RADIUS,
    ];
  }

  toLonLat(v: Vec2): LonLat {
    return {
      lon: this.lon0 + v[0] / (RAD * EARTH_RADIUS * Math.cos(this.lat0 * RAD)),
      lat: this.lat0 + v[1] / (RAD * EARTH_RADIUS),
    };
  }
}

export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const scale = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
export const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
export const len = (a: Vec2) => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const midpoint = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const norm = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};

export function signedArea(ring: Ring): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export const ringArea = (ring: Ring) => Math.abs(signedArea(ring));

export function perimeter(ring: Ring): number {
  let p = 0;
  for (let i = 0; i < ring.length; i++) p += dist(ring[i], ring[(i + 1) % ring.length]);
  return p;
}

export function centroid(ring: Ring): Vec2 {
  const a = signedArea(ring);
  if (Math.abs(a) < 1e-9) {
    const n = ring.length || 1;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const f = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

export function pointInRing(pt: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, add(a, scale(ab, t)));
}

export function convexHull(points: Vec2[]): Ring {
  const pts = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts;
  const build = (list: Vec2[]) => {
    const h: Vec2[] = [];
    for (const p of list) {
      while (h.length >= 2 && cross(sub(h[h.length - 1], h[h.length - 2]), sub(p, h[h.length - 1])) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  return [...build(pts), ...build([...pts].reverse())];
}

/** Largeur minimale du polygone (plus petit diamètre), par rotation sur l'enveloppe convexe. */
export function minWidth(ring: Ring): number {
  const hull = convexHull(ring);
  if (hull.length < 3) return 0;
  let best = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const u = norm(sub(b, a));
    const n: Vec2 = [-u[1], u[0]];
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of hull) {
      const d = dot(sub(p, a), n);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    best = Math.min(best, hi - lo);
  }
  return best;
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => cross(sub(q, p), sub(r, p));
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Vrai si aucun côté n'en croise un autre (polygone simple). */
export function isSimplePolygon(ring: Ring): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** Supprime points dupliqués et sommets alignés. */
export function cleanRing(ring: Ring, eps = 0.02): Ring {
  let pts = ring.filter((p, i) => dist(p, ring[(i + 1) % ring.length]) > eps);
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const cur = pts[i];
      const next = pts[(i + 1) % pts.length];
      if (distToSegment(cur, prev, next) < eps) {
        pts = pts.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

// --- Opérations booléennes (via polygon-clipping) ---

const closeRing = (r: Ring): Ring => [...r, r[0]];
const openRing = (r: Ring): Ring => r.slice(0, -1);

export function toPolygon(ring: Ring): PolygonRings {
  return [closeRing(ring)];
}

export function toMulti(ring: Ring): MultiPolygon {
  return [toPolygon(ring)];
}

type RawMulti = ReturnType<typeof polygonClipping.union>;

const fromRaw = (m: RawMulti): MultiPolygon => m.map((poly) => poly.map(openRing));
const toRaw = (m: MultiPolygon) => m.map((poly) => poly.map(closeRing));

export const union = (a: MultiPolygon, ...rest: MultiPolygon[]): MultiPolygon =>
  a.length === 0 && rest.length === 0 ? [] : fromRaw(polygonClipping.union(toRaw(a), ...rest.map(toRaw)));

export const intersection = (a: MultiPolygon, b: MultiPolygon): MultiPolygon =>
  a.length === 0 || b.length === 0 ? [] : fromRaw(polygonClipping.intersection(toRaw(a), toRaw(b)));

export const difference = (a: MultiPolygon, b: MultiPolygon): MultiPolygon => {
  if (a.length === 0) return [];
  if (b.length === 0) return a;
  return fromRaw(polygonClipping.difference(toRaw(a), toRaw(b)));
};

export function polygonArea(poly: PolygonRings): number {
  const [outer, ...holes] = poly;
  return ringArea(outer) - holes.reduce((s, h) => s + ringArea(h), 0);
}

export const multiArea = (m: MultiPolygon) => m.reduce((s, p) => s + polygonArea(p), 0);

export function largestPolygon(m: MultiPolygon): PolygonRings | null {
  let best: PolygonRings | null = null;
  let bestArea = 1e-6;
  for (const p of m) {
    const a = polygonArea(p);
    if (a > bestArea) {
      best = p;
      bestArea = a;
    }
  }
  return best;
}

/**
 * Capsule = tous les points à distance ≤ r du segment [a,b].
 * Les grands côtés sont exacts (distance r) ; les extrémités sont des demi-cercles à 12 pans.
 */
export function capsule(a: Vec2, b: Vec2, r: number, steps = 12): Ring {
  const dir = norm(sub(b, a));
  const theta = Math.atan2(dir[1], dir[0]);
  const pts: Vec2[] = [];
  // demi-cercle autour de b, de -90° à +90° par rapport à la direction
  for (let k = 0; k <= steps; k++) {
    const ang = theta - Math.PI / 2 + (Math.PI * k) / steps;
    pts.push([b[0] + r * Math.cos(ang), b[1] + r * Math.sin(ang)]);
  }
  for (let k = 0; k <= steps; k++) {
    const ang = theta + Math.PI / 2 + (Math.PI * k) / steps;
    pts.push([a[0] + r * Math.cos(ang), a[1] + r * Math.sin(ang)]);
  }
  return pts;
}

export function bbox(ring: Ring): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/** Repère orthonormé (u le long de la rue, v vers l'intérieur du terrain). */
export class Frame {
  constructor(
    readonly origin: Vec2,
    readonly u: Vec2,
    readonly v: Vec2,
  ) {}

  to(p: Vec2): Vec2 {
    const d = sub(p, this.origin);
    return [dot(d, this.u), dot(d, this.v)];
  }

  from(q: Vec2): Vec2 {
    return [this.origin[0] + this.u[0] * q[0] + this.v[0] * q[1], this.origin[1] + this.u[1] * q[0] + this.v[1] * q[1]];
  }

  toRing(r: Ring): Ring {
    return r.map((p) => this.to(p));
  }

  fromRing(r: Ring): Ring {
    return r.map((p) => this.from(p));
  }

  toMulti(m: MultiPolygon): MultiPolygon {
    return m.map((poly) => poly.map((r) => this.toRing(r)));
  }
}

export function rectRing(x0: number, y0: number, x1: number, y1: number): Ring {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}
