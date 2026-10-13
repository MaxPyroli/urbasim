import { LocalProjection, bbox, centroid, intersection, multiArea, pointInRing, polygonArea, ringArea, toMulti } from './geometry';
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

/**
 * Bâtiments existants situés sur le terrain étudié : ils seraient démolis par le projet, on les masque.
 * Un bâtiment est masqué si son centre est dans le terrain ou si au moins `ratio` de son emprise y est. Le seuil évite de
 * masquer un voisin mitoyen dont l'emprise déborderait de quelques décimètres (cadastre et bâti IGN ne coïncident pas
 * exactement, et un terrain dessiné à la main est approximatif).
 */
export function hiddenBuildingIds(parcel: LonLat[], buildings: ContextBuilding[], ratio = 0.35): Set<string> {
  const hidden = new Set<string>();
  if (parcel.length < 3 || buildings.length === 0) return hidden;
  const c0 = parcel.reduce((s, p) => ({ lon: s.lon + p.lon / parcel.length, lat: s.lat + p.lat / parcel.length }), { lon: 0, lat: 0 });
  const proj = new LocalProjection(c0.lon, c0.lat);
  const pRing: Ring = parcel.map((p) => proj.toLocal(p));
  const pb = bbox(pRing);
  const pMulti = toMulti(pRing);
  for (const b of buildings) {
    const outer = b.outer.map((p) => proj.toLocal(p));
    const bb = bbox(outer);
    if (bb.maxX < pb.minX || bb.minX > pb.maxX || bb.maxY < pb.minY || bb.minY > pb.maxY) continue;
    if (pointInRing(centroid(outer), pRing)) {
      hidden.add(b.id);
      continue;
    }
    const poly: PolygonRings = [outer, ...b.holes.map((h) => h.map((p) => proj.toLocal(p)))];
    const area = polygonArea(poly) || ringArea(outer);
    if (area <= 0) continue;
    if (multiArea(intersection(pMulti, [poly])) / area >= ratio) hidden.add(b.id);
  }
  return hidden;
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
