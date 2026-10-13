import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUILDING_HEIGHT,
  FLOOR_FALLBACK,
  LocalProjection,
  buildingsCredit,
  carveParcel,
  contextHeight,
  intersection,
  multiArea,
  polygonArea,
  toMulti,
  parseBdTopoBuildings,
  type ContextBuilding,
  type LonLat,
  type Vec2,
} from '../src/engine';
import sample from './fixtures/bdtopo-sample.json';

// Cinq vrais bâtiments de la BD TOPO (Paris 11e) extraits d'une réponse du WFS de la Géoplateforme.
const byId = (list: ContextBuilding[], id: string) => list.find((b) => b.id === id)!;

describe('lecture de la BD TOPO (vraies données)', () => {
  const list = parseBdTopoBuildings(sample);

  it('lit les cinq bâtiments, sans altitude ni point de fermeture', () => {
    expect(list).toHaveLength(5);
    for (const b of list) {
      expect(b.outer.length).toBeGreaterThanOrEqual(3);
      expect(b.outer[0]).not.toEqual(b.outer[b.outer.length - 1]);
      expect(Object.keys(b.outer[0]).sort()).toEqual(['lat', 'lon']);
      expect(b.outer[0].lat).toBeGreaterThan(48.86);
      expect(b.outer[0].lat).toBeLessThan(48.87);
    }
  });

  it('hauteur renseignée : utilisée telle quelle', () => {
    const b = byId(list, 'batiment.5319671');
    expect(b.height).toBe(20.1);
    expect(b.estimated).toBe(false);
  });

  it('cour intérieure conservée comme trou', () => {
    expect(byId(list, 'batiment.5319724').holes.length).toBeGreaterThanOrEqual(1);
    expect(byId(list, 'batiment.5319671').holes).toHaveLength(0);
  });

  it('sans hauteur mais avec étages : étages × 2,95 m, marqué estimé', () => {
    const b = byId(list, 'batiment.5321140');
    expect(b.height).toBeCloseTo(3 * FLOOR_FALLBACK, 6);
    expect(b.estimated).toBe(true);
  });

  it('sans hauteur ni étages : hauteur par défaut, marqué estimé', () => {
    const b = byId(list, 'batiment.5321111');
    expect(b.height).toBe(DEFAULT_BUILDING_HEIGHT);
    expect(b.estimated).toBe(true);
  });

  it('une annexe avec 0 étage mais une hauteur renseignée garde sa hauteur', () => {
    expect(byId(list, 'batiment.5321283').height).toBe(8.7);
  });
});

describe('robustesse de la lecture', () => {
  it('ignore sans planter les réponses vides, invalides ou partielles', () => {
    expect(parseBdTopoBuildings(null)).toEqual([]);
    expect(parseBdTopoBuildings({})).toEqual([]);
    expect(parseBdTopoBuildings({ features: 'non' })).toEqual([]);
    const bad = {
      features: [
        { id: 'a', properties: {}, geometry: null },
        { id: 'b', properties: {}, geometry: { type: 'Point', coordinates: [2, 48] } },
        { id: 'c', properties: {}, geometry: { type: 'Polygon', coordinates: [[[2, 48], [2.1, 48]]] } },
        { id: 'd', properties: {}, geometry: { type: 'Polygon', coordinates: [[[2, 48], ['x', 48], [2.1, 48.1]]] } },
        { id: 'ok', properties: { hauteur: 10 }, geometry: { type: 'Polygon', coordinates: [[[2, 48], [2.001, 48], [2.001, 48.001], [2, 48]]] } },
      ],
    };
    const list = parseBdTopoBuildings(bad);
    expect(list.map((b) => b.id)).toEqual(['ok']);
    expect(list[0].outer).toHaveLength(3);
  });

  it('un multipolygone à plusieurs parties donne des identifiants distincts', () => {
    const sq = (x: number) => [[[x, 48], [x + 0.001, 48], [x + 0.001, 48.001], [x, 48.001], [x, 48]]];
    const list = parseBdTopoBuildings({ features: [{ id: 'm', properties: { hauteur: 9 }, geometry: { type: 'MultiPolygon', coordinates: [sq(2), sq(2.01)] } }] });
    expect(list.map((b) => b.id)).toEqual(['m#0', 'm#1']);
  });

  it('valeurs documentées dans le README : 2,95 m par étage sans hauteur, 6 m sans aucune information', () => {
    expect(FLOOR_FALLBACK).toBe(2.95);
    expect(DEFAULT_BUILDING_HEIGHT).toBe(6);
  });

  it('hauteurs nulles, négatives ou absentes', () => {
    expect(contextHeight({ hauteur: 0, nombre_d_etages: 0 })).toEqual({ height: DEFAULT_BUILDING_HEIGHT, estimated: true });
    expect(contextHeight({ hauteur: -3, nombre_d_etages: 4 }).height).toBeCloseTo(4 * FLOOR_FALLBACK, 6);
    expect(contextHeight({})).toEqual({ height: DEFAULT_BUILDING_HEIGHT, estimated: true });
  });
});

describe('découpage du bâti voisin par le terrain étudié', () => {
  const O = new LocalProjection(2.375, 48.865);
  const ll = (pts: Vec2[]): LonLat[] => pts.map((p) => O.toLonLat(p));
  const bld = (id: string, pts: Vec2[], holes: Vec2[][] = []): ContextBuilding => ({ id, outer: ll(pts), holes: holes.map(ll), height: 15, estimated: false, updated: null });
  const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const parcel = ll(rect(0, 0, 10, 30));
  const local = (pts: LonLat[]): Vec2[] => pts.map((p) => O.toLocal(p));
  /** Surface (m²) d'un bâtiment ou d'un morceau, cours intérieures déduites. */
  const area = (b: ContextBuilding) => polygonArea([local(b.outer), ...b.holes.map(local)]);
  /** Surface (m²) d'un morceau qui chevauche le terrain. */
  const overlap = (b: ContextBuilding, par: Vec2[]) => multiArea(intersection(toMulti(par), [[local(b.outer), ...b.holes.map(local)]]));
  const total = (list: ContextBuilding[]) => list.reduce((s, b) => s + area(b), 0);

  it('un bâtiment entièrement sur le terrain disparaît, sans miette', () => {
    const r = carveParcel(parcel, [bld('dessus', rect(1, 2, 9, 14))]);
    expect([...r.hidden]).toEqual(['dessus']);
    expect(r.remainders).toHaveLength(0);
  });

  it('un bâtiment éloigné reste intact', () => {
    const r = carveParcel(parcel, [bld('loin', rect(200, 200, 220, 230))]);
    expect(r.hidden.size).toBe(0);
    expect(r.remainders).toHaveLength(0);
  });

  it('terrasse de six lots en un seul polygone : seul le lot étudié est retiré, les autres restent (lot au milieu)', () => {
    const row = bld('row', rect(0, 0, 60, 15)); // 900 m², six lots de 10 m
    const lot = rect(10, 0, 20, 15);
    const r = carveParcel(ll(lot), [row]);
    expect(r.hidden.has('row')).toBe(true);
    expect(total(r.remainders)).toBeCloseTo(900 - 150, 0);
    for (const m of r.remainders) expect(overlap(m, lot)).toBeLessThan(0.01);
  });

  it('même terrasse, lot contenant le centre du polygone : les autres lots ne disparaissent pas avec lui', () => {
    const row = bld('row', rect(0, 0, 60, 15));
    const lot = rect(25, 0, 35, 15); // contient le centre (30 ; 7,5)
    const r = carveParcel(ll(lot), [row]);
    expect(total(r.remainders)).toBeCloseTo(900 - 150, 0);
    for (const m of r.remainders) expect(overlap(m, lot)).toBeLessThan(0.01);
  });

  it('un voisin mitoyen qui déborde de 0,8 m sur le terrain est conservé, sans la bande qui chevauche le terrain', () => {
    const voisin = bld('voisin', rect(10 - 0.8, 0, 22, 30)); // 12,8 × 30 = 384 m², dont 24 m² sur le terrain
    const r = carveParcel(parcel, [voisin]);
    expect(total(r.remainders)).toBeCloseTo(384 - 24, 0);
    for (const m of r.remainders) expect(overlap(m, local(parcel))).toBeLessThan(0.01);
  });

  it('un écart de numérisation de 2 cm (0,3 m²) ne touche à rien', () => {
    const r = carveParcel(parcel, [bld('frole', rect(10 - 0.02, 0, 25, 15))]);
    expect(r.hidden.size).toBe(0);
    expect(r.remainders).toHaveLength(0);
  });

  it('bâtiment en U autour d’un terrain vide dans l’échancrure : intact (le centre du U est dans l’échancrure)', () => {
    const u: Vec2[] = [[0, 0], [30, 0], [30, 25], [22, 25], [22, 6], [8, 6], [8, 25], [0, 25]];
    const r = carveParcel(ll(rect(9, 8, 21, 24)), [bld('U', u)]);
    expect(r.hidden.size).toBe(0);
    expect(r.remainders).toHaveLength(0);
  });

  it('bâtiment en anneau autour d’un terrain situé dans sa cour : intact', () => {
    const ring = bld('anneau', rect(0, 0, 40, 40), [rect(8, 8, 32, 32)]);
    const r = carveParcel(ll(rect(14, 14, 26, 26)), [ring]);
    expect(r.hidden.size).toBe(0);
    expect(r.remainders).toHaveLength(0);
  });

  it('une cour intérieure n’est pas comptée comme du bâti à retirer', () => {
    const anneau = bld('cour', rect(-6, 0, 4, 10), [rect(-3, 1, 3, 9)]); // 100 − 48 = 52 m² de bâti
    const r = carveParcel(parcel, [anneau]);
    // sur le terrain (x ≥ 0) : 4×10 = 40 m² moins la part de cour (3×8 = 24 m²) → 16 m² de bâti retirés
    expect(total(r.remainders)).toBeCloseTo(52 - 16, 0);
  });

  it('terrain dégénéré (3 points exactement alignés), terrain en 8 ou liste vide : aucune exception, rien n’est modifié', () => {
    const list = [bld('x', rect(0, 0, 5, 5))];
    for (const bad of [ll([[0, 0], [5, 5], [10, 10]]), ll([[0, 0], [10, 10], [10, 0], [0, 10]]), ll([[0, 0], [5, 5]]), []]) {
      const r = carveParcel(bad, list);
      expect(r.hidden.size).toBe(0);
      expect(r.remainders).toHaveLength(0);
    }
    expect(carveParcel(parcel, []).hidden.size).toBe(0);
  });

  it('terrain à pointe de largeur nulle (aller-retour sur le même segment) : aucune exception, quel que soit le résultat', () => {
    const spike = ll([[0, 0], [10, 0], [10, 30], [0, 30], [0, 15], [-5, 15], [0, 15]]);
    const list = [bld('a', rect(1, 2, 9, 14)), bld('b', rect(-8, 10, -1, 20)), bld('c', rect(2, 20, 8, 28))];
    expect(() => carveParcel(spike, list)).not.toThrow();
  });

  it('une géométrie de bâtiment dégénérée est laissée telle quelle sans faire échouer les autres', () => {
    const casse = { ...bld('casse', rect(1, 1, 5, 5)), outer: ll([[1, 1], [3, 3], [5, 5]]) }; // alignés
    const bon = bld('bon', rect(2, 10, 8, 20));
    const r = carveParcel(parcel, [casse, bon]);
    expect(r.hidden.has('bon')).toBe(true);
  });

  it('vraies données : un terrain égal à l’emprise exacte d’un vrai bâtiment le fait disparaître, sans miette, et épargne les autres', () => {
    const list = parseBdTopoBuildings(sample);
    const cible = byId(list, 'batiment.5319671');
    const r = carveParcel(cible.outer, list);
    expect(r.hidden.has(cible.id)).toBe(true);
    expect(r.hidden.size).toBe(1);
    expect(r.remainders).toHaveLength(0);
  });

  it('les morceaux conservent la hauteur, le caractère estimé et la date du bâtiment d’origine, avec des identifiants uniques', () => {
    const src: ContextBuilding = { ...bld('row', rect(0, 0, 60, 15)), height: 18.5, estimated: true, updated: '2024-05-29T12:48:29.050Z' };
    const r = carveParcel(ll(rect(10, 0, 20, 15)), [src]);
    expect(r.remainders.length).toBeGreaterThanOrEqual(2);
    expect(new Set(r.remainders.map((m) => m.id)).size).toBe(r.remainders.length);
    for (const m of r.remainders) {
      expect(m.id.startsWith('row~')).toBe(true);
      expect(m.height).toBe(18.5);
      expect(m.estimated).toBe(true);
      expect(m.updated).toBe('2024-05-29T12:48:29.050Z');
    }
  });
});

describe('mention exigée par la Licence Ouverte 2.0 (source + date de mise à jour)', () => {
  const feat = (id: string, date_modification: unknown) => ({
    id,
    properties: { hauteur: 10, date_modification },
    geometry: { type: 'Polygon', coordinates: [[[2, 48], [2.001, 48], [2.001, 48.001], [2, 48]]] },
  });

  it('lit la date de modification de chaque bâtiment, ignore les dates absentes ou invalides', () => {
    const list = parseBdTopoBuildings({
      features: [feat('a', '2024-05-29T12:48:29.050Z'), feat('b', null), feat('c', 'pas une date'), feat('d', 12345), feat('e', '2019-03-15T12:40:14Z')],
    });
    expect(list.map((b) => b.updated)).toEqual(['2024-05-29T12:48:29.050Z', null, null, null, '2019-03-15T12:40:14Z']);
  });

  it('indique la source, la licence et la modification la plus récente parmi les bâtiments affichés', () => {
    const list = parseBdTopoBuildings({ features: [feat('a', '2024-05-29T12:48:29.050Z'), feat('b', '2011-03-08T13:47:52Z'), feat('c', '2019-03-15T12:40:14Z')] });
    expect(buildingsCredit(list, '2026-10-13')).toBe('Bâtiments : IGN, BD TOPO® (Licence Ouverte 2.0), objets modifiés jusqu’au 29/05/2024');
  });

  it('sans aucune date dans la donnée, indique la date de consultation', () => {
    const list = parseBdTopoBuildings({ features: [feat('a', null), feat('b', null)] });
    expect(buildingsCredit(list, '2026-10-13')).toBe('Bâtiments : IGN, BD TOPO® (Licence Ouverte 2.0), consulté le 13/10/2026');
    expect(buildingsCredit([], '2026-10-13')).toContain('consulté le 13/10/2026');
  });

  it('ne dit jamais « mis à jour » avec une date plus récente que celle des données', () => {
    const list = parseBdTopoBuildings({ features: [feat('a', '2020-01-02T00:00:00Z')] });
    expect(buildingsCredit(list, '2026-10-13')).not.toContain('2026');
  });
});
