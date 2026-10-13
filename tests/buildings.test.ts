import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUILDING_HEIGHT,
  FLOOR_FALLBACK,
  LocalProjection,
  buildingsCredit,
  contextHeight,
  hiddenBuildingIds,
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

  it('hauteurs nulles, négatives ou absentes', () => {
    expect(contextHeight({ hauteur: 0, nombre_d_etages: 0 })).toEqual({ height: DEFAULT_BUILDING_HEIGHT, estimated: true });
    expect(contextHeight({ hauteur: -3, nombre_d_etages: 4 }).height).toBeCloseTo(4 * FLOOR_FALLBACK, 6);
    expect(contextHeight({})).toEqual({ height: DEFAULT_BUILDING_HEIGHT, estimated: true });
  });
});

describe('masquage des bâtiments situés sur le terrain', () => {
  const O = new LocalProjection(2.375, 48.865);
  const ll = (pts: Vec2[]): LonLat[] => pts.map((p) => O.toLonLat(p));
  const bld = (id: string, pts: Vec2[], holes: Vec2[][] = []): ContextBuilding => ({ id, outer: ll(pts), holes: holes.map(ll), height: 15, estimated: false, updated: null });
  const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const parcel = ll(rect(0, 0, 10, 30));

  it('masque un bâtiment entièrement sur le terrain', () => {
    expect([...hiddenBuildingIds(parcel, [bld('dessus', rect(1, 2, 9, 14))])]).toEqual(['dessus']);
  });

  it('garde le voisin mitoyen, même avec un faible débordement (imprécision du dessin)', () => {
    const voisin = bld('voisin', rect(10 - 0.8, 0, 22, 30)); // déborde de 0,8 m sur le terrain (≈ 4 % de son emprise)
    expect(hiddenBuildingIds(parcel, [voisin]).size).toBe(0);
  });

  it('garde un bâtiment éloigné', () => {
    expect(hiddenBuildingIds(parcel, [bld('loin', rect(200, 200, 220, 230))]).size).toBe(0);
  });

  it('masque un bâtiment dont le centre est sur le terrain même s’il déborde beaucoup', () => {
    // centre à x = 4,5 (dans le terrain) ; seulement 10 m sur 33 m dedans (≈ 30 % < 35 %) : c'est la règle du centre qui joue
    const b = bld('debordant', rect(-12, 5, 21, 12));
    expect(hiddenBuildingIds(parcel, [b]).has('debordant')).toBe(true);
  });

  it('garde un grand bâtiment voisin dont le centre est hors terrain et qui y déborde peu', () => {
    // centre à x = 21 (hors terrain), 8 m sur 38 m dedans (≈ 21 % < 35 %)
    expect(hiddenBuildingIds(parcel, [bld('grand-voisin', rect(2, 5, 40, 12))]).size).toBe(0);
  });

  it('seuil de chevauchement : 9 % gardé, 86 % masqué', () => {
    const peu = bld('peu', [[8, 0], [30, 0], [30, 10], [8, 10]]); // 2 m sur 22 → 9 %, centre à x = 19 (hors terrain)
    expect(hiddenBuildingIds(parcel, [peu]).size).toBe(0);
    const beaucoup = bld('beaucoup', [[4, 0], [11, 0], [11, 10], [4, 10]]); // 6 m sur 7 → 86 %, centre dans le terrain
    expect(hiddenBuildingIds(parcel, [beaucoup]).has('beaucoup')).toBe(true);
  });

  it('une cour intérieure ne compte ni dans l’emprise du bâtiment ni dans la part qui chevauche le terrain', () => {
    const outer = rect(-6, 0, 4, 10); // 100 m², centre hors terrain (x = -1)
    // sans cour : 40 m² sur le terrain = 40 % → masqué (cas témoin)
    expect(hiddenBuildingIds(parcel, [bld('plein', outer)]).has('plein')).toBe(true);
    // avec une cour de 6×8 : surface réelle 52 m², dont 16 m² seulement sur le terrain (≈ 31 %) → conservé
    expect(hiddenBuildingIds(parcel, [bld('cour', outer, [rect(-3, 1, 3, 9)])]).has('cour')).toBe(false);
  });

  it('terrain ou liste vide : rien n’est masqué, sans erreur', () => {
    expect(hiddenBuildingIds([], [bld('x', rect(0, 0, 5, 5))]).size).toBe(0);
    expect(hiddenBuildingIds(parcel, []).size).toBe(0);
  });

  it('fonctionne sur de vraies données : un terrain posé sur un bâtiment réel le masque et épargne ses voisins', () => {
    const list = parseBdTopoBuildings(sample);
    const cible = byId(list, 'batiment.5319671');
    const ring = cible.outer;
    // terrain = emprise exacte du bâtiment ciblé : seul lui est masqué
    const hidden = hiddenBuildingIds(ring, list);
    expect(hidden.has(cible.id)).toBe(true);
    expect(hidden.size).toBe(1);
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
