import {
  Frame,
  bbox,
  cleanRing,
  difference,
  dot,
  intersection,
  largestPolygon,
  minWidth,
  multiArea,
  pointInRing,
  polygonArea,
  rectRing,
  ringArea,
  toMulti,
  union,
} from './geometry';
import type { FootprintShape, MultiPolygon, Placement, PolygonRings, Ring, Vec2 } from './types';

/** Une rue secondaire (terrain d'angle) le long de laquelle le bâtiment peut aussi s'étendre, en repère du terrain. */
export interface StreetFront {
  a: Vec2;
  b: Vec2;
  /** Normale unitaire de la limite, orientée vers l'intérieur du terrain. */
  n: Vec2;
  /** Retrait appliqué sur cette limite : la profondeur se compte depuis l'alignement de construction. */
  setback: number;
}

export interface FootprintOptions {
  shape: FootprintShape;
  maxDepth: number;
  minWidth: number;
  /** Plafond de surface d'emprise (CES, densité…), null = aucun. */
  areaCap: number | null;
  /** Position dans la profondeur : côté rue, en fond de parcelle, ou la meilleure des deux. */
  placement: Placement;
  /** Autres rues du terrain (angle) : l'emprise « adaptée » les longe aussi, sur la même profondeur maximale. */
  streetFronts?: StreetFront[];
}

export interface FootprintResult {
  /** Emprise en coordonnées locales, null si aucune emprise viable. */
  ring: Ring | null;
  /** Contraintes qui ont borné l'emprise. */
  limitedBy: string[];
  /** Où l'emprise a été placée. */
  at: 'rue' | 'fond';
  reason?: string;
}

const MIN_AREA = 12;
/** En mode automatique, le fond de parcelle ne l'emporte sur la rue que s'il offre au moins 3 % d'emprise de plus. */
const AUTO_GAIN = 1.03;

/** Cherche la plus grande profondeur d ∈ [0, dMax] telle que area(d) ≤ cap (area croissante). */
function bisectDepth(areaAt: (d: number) => number, dMax: number, cap: number): number {
  let lo = 0;
  let hi = dMax;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    if (areaAt(mid) <= cap) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Emprise « adaptée » : l'enveloppe constructible, tranchée à la profondeur maximale depuis la rue. Sur un terrain
 * d'angle, elle longe aussi les autres rues (bande de la même profondeur le long de chacune) : un « L » plutôt qu'une
 * simple bande le long de la rue principale. Si ces bandes refermaient une cour (terrain bordé de rues de tous côtés),
 * on garde la seule bande de la rue principale : l'emprise n'a pas de trou.
 */
function adaptedFootprint(comp: PolygonRings, opts: FootprintOptions, fronts: StreetFront[] = []): { ring: Ring; limitedBy: string[] } | null {
  const bb = bbox(comp[0]);
  const extent = bb.maxY - bb.minY;
  const dMax = fronts.length > 0 ? opts.maxDepth : Math.min(opts.maxDepth, extent);
  const band = (d: number): MultiPolygon => toMulti(rectRing(bb.minX - 1, bb.minY - 1, bb.maxX + 1, bb.minY + d));
  const strip = (f: StreetFront, d: number): MultiPolygon => {
    const at = (p: Vec2, k: number): Vec2 => [p[0] + f.n[0] * k, p[1] + f.n[1] * k];
    return toMulti([at(f.a, f.setback), at(f.b, f.setback), at(f.b, f.setback + d), at(f.a, f.setback + d)]);
  };
  const cut = (d: number) => {
    if (fronts.length > 0) {
      const poly = largestPolygon(intersection([comp], union(band(d), ...fronts.map((f) => strip(f, d)))));
      if (poly && poly.length === 1) return poly;
    }
    return largestPolygon(intersection([comp], band(d)));
  };
  const areaAt = (d: number) => {
    const p = cut(d);
    return p ? polygonArea(p) : 0;
  };
  const limitedBy: string[] = [];
  let d = dMax;
  const depthLimits = fronts.length > 0 ? areaAt(dMax) < polygonArea(comp) - 1e-3 : opts.maxDepth < extent - 1e-6;
  if (depthLimits) limitedBy.push('profondeur maximale');
  if (opts.areaCap !== null && areaAt(d) > opts.areaCap) {
    d = bisectDepth(areaAt, dMax, opts.areaCap);
    limitedBy.push('emprise / densité');
  }
  const poly = cut(d);
  if (!poly) return null;
  return { ring: cleanRing(poly[0]), limitedBy };
}

/** Plus grand rectangle (aligné sur la rue) inscrit dans le polygone, profondeur bornée. */
function largestRectangle(comp: PolygonRings, opts: FootprintOptions): { ring: Ring; limitedBy: string[] } | null {
  const outer = comp[0];
  const bb = bbox(outer);
  // résolution de la grille : 25 cm, relâchée pour les très grands terrains afin de borner la mémoire
  const res = Math.max(0.25, Math.sqrt(((bb.maxX - bb.minX) * (bb.maxY - bb.minY)) / 2e6));
  const W = Math.max(1, Math.ceil((bb.maxX - bb.minX) / res));
  const H = Math.max(1, Math.ceil((bb.maxY - bb.minY) / res));
  const inPoly = (x: number, y: number) =>
    pointInRing([x, y], outer) && !comp.slice(1).some((h) => pointInRing([x, y], h));
  const cell: Uint8Array[] = [];
  for (let j = 0; j < H; j++) {
    const row = new Uint8Array(W);
    for (let i = 0; i < W; i++) {
      const x0 = bb.minX + i * res;
      const y0 = bb.minY + j * res;
      row[i] = inPoly(x0 + 0.01, y0 + 0.01) && inPoly(x0 + res - 0.01, y0 + 0.01) && inPoly(x0 + 0.01, y0 + res - 0.01) && inPoly(x0 + res - 0.01, y0 + res - 0.01) ? 1 : 0;
    }
    cell.push(row);
  }
  const maxRows = Math.max(1, Math.floor(opts.maxDepth / res));
  const cap = opts.areaCap;
  let best = { score: 0, i0: 0, w: 0, j0: 0, rows: 0 };
  const ok = new Uint8Array(W);
  for (let j0 = 0; j0 < H; j0++) {
    ok.fill(1);
    for (let rows = 1; rows <= maxRows && j0 + rows <= H; rows++) {
      const row = cell[j0 + rows - 1];
      let any = false;
      for (let i = 0; i < W; i++) {
        ok[i] = ok[i] & row[i];
        if (ok[i]) any = true;
      }
      if (!any) break;
      let run = 0;
      let runStart = 0;
      for (let i = 0; i <= W; i++) {
        if (i < W && ok[i]) {
          if (run === 0) runStart = i;
          run++;
        } else if (run > 0) {
          let w = run;
          if (cap !== null) w = Math.min(w, Math.floor(cap / (rows * res * res)));
          const score = w * rows;
          if (score > best.score * 1.005 || (score >= best.score * 0.995 && w > best.w)) {
            best = { score, i0: runStart, w, j0, rows };
          }
          run = 0;
        }
      }
    }
  }
  if (best.score === 0) return null;
  let x0 = bb.minX + best.i0 * res;
  let x1 = x0 + best.w * res;
  const y0 = bb.minY + best.j0 * res;
  let y1 = y0 + best.rows * res;

  // Affinage : on agrandit chaque côté tant que le rectangle reste dans le polygone.
  const inside = (a: number, b: number, c: number, d: number) =>
    multiArea(difference(toMulti(rectRing(a, b, c, d)), [comp])) < 1e-4 &&
    (cap === null || (c - a) * (d - b) <= cap + 1e-6);
  const grow = (get: () => number, set: (v: number) => void, max: number) => {
    let lo = 0;
    let hi = max;
    for (let k = 0; k < 8; k++) {
      const mid = (lo + hi) / 2;
      const old = get();
      set(old + mid);
      const okRect = inside(x0, y0, x1, y1);
      set(old);
      if (okRect) lo = mid;
      else hi = mid;
    }
    set(get() + lo);
  };
  // Si le rectangle initial dépasse (échantillonnage), on le rétrécit un peu.
  for (let k = 0; k < 6 && !inside(x0, y0, x1, y1); k++) {
    x0 += 0.03;
    x1 -= 0.03;
    y1 -= 0.03;
  }
  grow(() => x1, (v) => (x1 = v), res);
  grow(() => x0, (v) => (x0 = v), -res);
  if (y1 - y0 < opts.maxDepth - 1e-6) grow(() => y1, (v) => (y1 = Math.min(v, y0 + opts.maxDepth)), res);

  const limitedBy: string[] = [];
  if (y1 - y0 >= opts.maxDepth - 0.3) limitedBy.push('profondeur maximale');
  if (cap !== null && (x1 - x0) * (y1 - y0) >= cap - 0.5) limitedBy.push('emprise / densité');
  return { ring: rectRing(x0, y0, x1, y1), limitedBy };
}

interface Candidate {
  ring: Ring;
  limitedBy: string[];
  area: number;
}

/** Meilleure emprise de l'enveloppe, calculée depuis le bas du repère (v = 0 : côté rue). */
function bestIn(env: MultiPolygon, opts: FootprintOptions, fronts: StreetFront[] = []): Candidate | null {
  let best: Candidate | null = null;
  for (const comp of env) {
    if (polygonArea(comp) < MIN_AREA) continue;
    const res = opts.shape === 'rectangle' ? largestRectangle(comp, opts) : adaptedFootprint(comp, opts, fronts);
    if (!res) continue;
    const area = ringArea(res.ring);
    if (!best || area > best.area) best = { ...res, area };
  }
  return best;
}

/** Symétrie par rapport à la rue : le fond de parcelle devient le côté d'où l'on tranche. */
const mirrorEnv = (m: MultiPolygon): MultiPolygon => m.map((poly) => poly.map((r) => r.map(([x, y]) => [x, -y] as Vec2)));
/** Symétrique d'un contour, parcouru en sens inverse pour garder son orientation. */
const mirrorRing = (r: Ring): Ring => r.map(([x, y]) => [x, -y] as Vec2).reverse();

/**
 * Génère l'emprise du bâtiment dans l'enveloppe constructible.
 * Tout se passe dans le repère (u le long de la rue, v vers le fond de parcelle). Le bâtiment se place soit côté rue
 * (on tranche depuis la rue), soit en fond de parcelle (même calcul dans le repère inversé), soit — en mode
 * automatique — là où l'emprise est la plus grande, la rue l'emportant à égalité.
 */
export function generateFootprint(envelope: MultiPolygon, frame: Frame, opts: FootprintOptions): FootprintResult {
  if (envelope.length === 0) return { ring: null, limitedBy: ['retraits'], at: 'rue', reason: 'Les retraits laissent un terrain inconstructible.' };
  const env = frame.toMulti(envelope);
  const placement: Placement = opts.placement === 'fond' || opts.placement === 'auto' ? opts.placement : 'rue';
  const viable = (c: Candidate | null): c is Candidate => c !== null && c.area >= MIN_AREA && minWidth(c.ring) >= opts.minWidth;

  // autres rues, converties dans le repère de calcul (la symétrie du fond de parcelle ne les utilise pas)
  const fronts: StreetFront[] = (opts.streetFronts ?? []).map((f) => ({
    a: frame.to(f.a),
    b: frame.to(f.b),
    n: [dot(f.n, frame.u), dot(f.n, frame.v)],
    setback: f.setback,
  }));
  let front = placement === 'fond' ? null : bestIn(env, opts, fronts);
  let back: Candidate | null = null;
  if (placement !== 'rue') {
    const m = bestIn(mirrorEnv(env), opts);
    back = m && { ...m, ring: mirrorRing(m.ring) };
  }
  if (placement === 'fond' && !viable(back)) front = bestIn(env, opts, fronts); // repli : mieux vaut un bâtiment sur rue que rien

  let at: 'rue' | 'fond' = 'rue';
  if (placement === 'fond') at = viable(back) || !viable(front) ? 'fond' : 'rue';
  else if (placement === 'auto') at = viable(back) && (!viable(front) || back.area > front.area * AUTO_GAIN) ? 'fond' : 'rue';

  const best = (at === 'fond' ? back : front) ?? front ?? back;
  if (!best || best.area < MIN_AREA) {
    return { ring: null, limitedBy: ['retraits'], at, reason: 'Emprise constructible trop petite après retraits.' };
  }
  const limitedBy = best.limitedBy.length > 0 ? best.limitedBy : ['retraits'];
  if (minWidth(best.ring) < opts.minWidth) {
    return {
      ring: null,
      limitedBy,
      at,
      reason: `Largeur exploitable (${minWidth(best.ring).toFixed(1)} m) inférieure au minimum de ${opts.minWidth} m.`,
    };
  }
  return { ring: frame.fromRing(best.ring), limitedBy, at };
}
