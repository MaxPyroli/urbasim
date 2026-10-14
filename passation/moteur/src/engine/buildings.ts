import { LocalProjection, bbox, difference, intersection, isSimplePolygon, multiArea, polygonArea, ringArea, toMulti } from './geometry';
import type { LonLat, PolygonRings, Ring } from './types';

/** Bâtiment voisin affiché pour situer le projet dans son contexte (données IGN BD TOPO). */
export interface ContextBuilding {
  id: string;
  outer: LonLat[];
  /** Cours intérieures. */
  holes: LonLat[][];
  /** Hauteur en mètres. */
  height: number;
  /** Vrai si la hauteur n'est pas renseignée dans la donnée et a été estimée. */
  estimated: boolean;
  /** Date de dernière modification de l'objet dans la BD TOPO (ISO 8601), si renseignée. */
  updated: string | null;
}

/** Hauteur d'un étage courant pour estimer un bâtiment sans hauteur (médiane observée sur la BD TOPO, Paris). */
export const FLOOR_FALLBACK = 2.95;
/** Hauteur par défaut d'un bâtiment sans hauteur ni nombre d'étages (le plus souvent une annexe ou un abri). */
export const DEFAULT_BUILDING_HEIGHT = 6;

interface Props {
  hauteur?: number | null;
  nombre_d_etages?: number | null;
  date_modification?: string | null;
}

export function contextHeight(p: Props): { height: number; estimated: boolean } {
  if (typeof p.hauteur === 'number' && p.hauteur > 0) return { height: p.hauteur, estimated: false };
  if (typeof p.nombre_d_etages === 'number' && p.nombre_d_etages > 0) return { height: p.nombre_d_etages * FLOOR_FALLBACK, estimated: true };
  return { height: DEFAULT_BUILDING_HEIGHT, estimated: true };
}

/** Anneau GeoJSON fermé [lon, lat, z?] → anneau ouvert sans altitude ; null si dégénéré. */
function toRing(coords: unknown): LonLat[] | null {
  if (!Array.isArray(coords)) return null;
  const pts: LonLat[] = [];
  for (const c of coords) {
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
    pts.push({ lon: c[0], lat: c[1] });
  }
  if (pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (a.lon === b.lon && a.lat === b.lat) pts.pop();
  }
  return pts.length >= 3 ? pts : null;
}

/**
 * Lit la réponse GeoJSON du WFS « BDTOPO_V3:batiment ». Tolère les géométries absentes ou invalides (ignorées),
 * les altitudes (ignorées : la carte est à plat), les cours intérieures et les multipolygones.
 */
export function parseBdTopoBuildings(geojson: unknown): ContextBuilding[] {
  const out: ContextBuilding[] = [];
  const features = (geojson as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(features)) return out;
  features.forEach((f, i) => {
    const feat = f as { id?: string | number; properties?: Props; geometry?: { type?: string; coordinates?: unknown } };
    const g = feat?.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon') || !Array.isArray(g.coordinates)) return;
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as unknown[][];
    const { height, estimated } = contextHeight(feat.properties ?? {});
    const dm = feat.properties?.date_modification;
    const updated = typeof dm === 'string' && Number.isFinite(Date.parse(dm)) ? dm : null;
    polys.forEach((rings, k) => {
      if (!Array.isArray(rings) || rings.length === 0) return;
      const outer = toRing(rings[0]);
      if (!outer) return;
      const holes = rings.slice(1).map(toRing).filter((h): h is LonLat[] => h !== null);
      out.push({ id: `${feat.id ?? `b${i}`}${polys.length > 1 ? `#${k}` : ''}`, outer, holes, height, estimated, updated });
    });
  });
  return out;
}

/** Résultat du découpage des bâtiments voisins par le terrain étudié. */
export interface CarveResult {
  /** Bâtiments d'origine à ne plus dessiner : ils chevauchent le terrain. */
  hidden: Set<string>;
  /** Ce qu'il en reste une fois le terrain retiré (parties situées hors du terrain). */
  remainders: ContextBuilding[];
}

/** En dessous de ce chevauchement (m²), c'est un simple écart de numérisation entre cadastre et bâti : on ne touche à rien. */
const MIN_OVERLAP = 0.5;
/** On ne redessine pas les miettes plus petites que cela (m²). */
const MIN_REMAINDER = 0.5;

/**
 * Retire du bâti voisin tout ce qui se trouve sur le terrain étudié : le projet remplace l'existant.
 * Un bâtiment entièrement sur le terrain disparaît ; un bâtiment qui le déborde (une terrasse de plusieurs lots,
 * un voisin mitoyen) est découpé et ses parties hors terrain sont conservées. Un bâtiment n'est jamais masqué en
 * entier à cause d'un lot voisin, ni gardé par-dessus le terrain parce que sa part sur le terrain serait petite.
 * Toute géométrie dégénérée est laissée telle quelle plutôt que de faire échouer l'affichage.
 */
export function carveParcel(parcel: LonLat[], buildings: ContextBuilding[]): CarveResult {
  const out: CarveResult = { hidden: new Set(), remainders: [] };
  if (parcel.length < 3 || buildings.length === 0) return out;
  const n = parcel.length;
  const proj = new LocalProjection(
    parcel.reduce((s, p) => s + p.lon, 0) / n,
    parcel.reduce((s, p) => s + p.lat, 0) / n,
  );
  const pRing: Ring = parcel.map((p) => proj.toLocal(p));
  if (!isSimplePolygon(pRing) || ringArea(pRing) < 1) return out; // contour invalide : rien à découper
  const pb = bbox(pRing);
  const pMulti = toMulti(pRing);
  for (const b of buildings) {
    try {
      const outer = b.outer.map((p) => proj.toLocal(p));
      const bb = bbox(outer);
      if (bb.maxX < pb.minX || bb.minX > pb.maxX || bb.maxY < pb.minY || bb.minY > pb.maxY) continue;
      const poly: PolygonRings = [outer, ...b.holes.map((h) => h.map((p) => proj.toLocal(p)))];
      if (multiArea(intersection(pMulti, [poly])) < MIN_OVERLAP) continue;
      out.hidden.add(b.id);
      difference([poly], pMulti).forEach((piece, k) => {
        if (polygonArea(piece) < MIN_REMAINDER) return;
        out.remainders.push({
          ...b,
          id: `${b.id}~${k}`,
          outer: piece[0].map((v) => proj.toLonLat(v)),
          holes: piece.slice(1).map((h) => h.map((v) => proj.toLonLat(v))),
        });
      });
    } catch {
      /* géométrie dégénérée (anneau invalide…) : ce bâtiment reste dessiné tel quel */
    }
  }
  return out;
}

const frDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * Mention exigée par la Licence Ouverte 2.0 : la source ET la date de dernière mise à jour des données réutilisées.
 * La date est celle de la modification la plus récente parmi les bâtiments chargés (vraie par construction) ; si aucun
 * bâtiment n'en porte, on indique la date de consultation. `consultedIso` : date du jour au format AAAA-MM-JJ.
 */
export function buildingsCredit(list: ContextBuilding[], consultedIso: string): string {
  let latest = '';
  for (const b of list) if (b.updated && b.updated > latest) latest = b.updated;
  const when = latest ? `objets modifiés jusqu’au ${frDate(latest)}` : `consulté le ${frDate(consultedIso)}`;
  return `Bâtiments : IGN, BD TOPO® (Licence Ouverte 2.0), ${when}`;
}
