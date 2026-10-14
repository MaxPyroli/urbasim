import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CRITERIA,
  LocalProjection,
  buildEnvelope,
  buildGeoJson,
  buildKml,
  capsule,
  compareScenarios,
  computeEdges,
  computeProject,
  difference,
  isSimplePolygon,
  minWidth,
  multiArea,
  parseParcelGeoJson,
  ringArea,
  toMulti,
  type Criteria,
  type LonLat,
  type Parcel,
  type Vec2,
} from '../src/engine';

const ORIGIN = new LocalProjection(2.35, 48.85);
const parcelFromLocal = (pts: Vec2[], streetEdges: number[]): Parcel => ({ ring: pts.map((p) => ORIGIN.toLonLat(p)), streetEdges });

/** Lanière 8 m × 30 m ; l'arête 0 (sud, 8 m) donne sur la rue. */
const strip = (): Parcel =>
  parcelFromLocal(
    [
      [0, 0],
      [8, 0],
      [8, 30],
      [0, 30],
    ],
    [0],
  );

const crit = (over: Partial<Criteria> = {}): Criteria => ({ ...DEFAULT_CRITERIA, ...over });

describe('géométrie de base', () => {
  it('la projection locale est réversible et métrique', () => {
    const ll = ORIGIN.toLonLat([100, 50]);
    const back = ORIGIN.toLocal(ll);
    expect(back[0]).toBeCloseTo(100, 6);
    expect(back[1]).toBeCloseTo(50, 6);
    const north = ORIGIN.toLocal({ lon: 2.35, lat: 48.85 + 0.001 });
    expect(north[1]).toBeCloseTo(111.3, 0);
  });

  it('largeur minimale d’un rectangle', () => {
    expect(minWidth([[0, 0], [8, 0], [8, 30], [0, 30]])).toBeCloseTo(8, 6);
  });

  it('la capsule couvre bien les points à distance ≤ r et exclut les autres', () => {
    const cap = capsule([0, 0], [10, 0], 3);
    const area = ringArea(cap);
    // 10×6 + πr² = 60 + 28.27, approximé par un polygone inscrit
    expect(area).toBeGreaterThan(86);
    expect(area).toBeLessThan(88.5);
  });
});

describe('retraits et enveloppe constructible', () => {
  it('classe voie / fond / latérales', () => {
    const p = strip();
    const proj = new LocalProjection(p.ring.reduce((s, q) => s + q.lon, 0) / 4, p.ring.reduce((s, q) => s + q.lat, 0) / 4);
    const ring = p.ring.map((q) => proj.toLocal(q));
    const edges = computeEdges(ring, [0], crit(), 10);
    expect(edges.map((e) => e.kind)).toEqual(['voie', 'laterale', 'fond', 'laterale']);
  });

  it('applique les retraits par catégorie : 8×30 avec fond 4 m ⇒ 8×26', () => {
    const proj = computeProject(strip(), crit({ setbackFond: 4 }));
    expect(multiArea(proj.envelope)).toBeCloseTo(8 * 26, 0);
  });

  it('retrait latéral de 3 m des deux côtés ⇒ 2 m de large utile, trop étroit pour bâtir', () => {
    const proj = computeProject(strip(), crit({ setbackLateral: 3, setbackFond: 0 }));
    expect(multiArea(proj.envelope)).toBeCloseTo(2 * 30, 0);
    expect(proj.footprint).toBeNull();
    expect(proj.checks[0].status).toBe('error');
  });

  it('le prospect H/2 augmente les retraits non mitoyens mais pas ceux à 0', () => {
    const p = computeProject(strip(), crit({ setbackLateral: 0, setbackFond: 3, prospectRatio: 0.5, levels: 4 }));
    const fond = p.edges.find((e) => e.kind === 'fond')!;
    expect(fond.setback).toBeCloseTo(0.5 * p.indicators.height, 6);
    expect(p.edges.filter((e) => e.kind === 'laterale').every((e) => e.setback === 0)).toBe(true);
  });

  it('un retrait par arête remplace la valeur de la catégorie', () => {
    const p = computeProject(strip(), crit({ edgeSetbacks: { 1: 2 }, setbackFond: 0 }));
    expect(multiArea(p.envelope)).toBeCloseTo(6 * 30, 0);
  });

  it('distance au segment : sur un terrain en L, un coin rentrant écarte bien la zone de retrait', () => {
    const ring: Vec2[] = [
      [0, 0],
      [20, 0],
      [20, 10],
      [10, 10],
      [10, 20],
      [0, 20],
    ];
    const edges = computeEdges(ring, [0], crit({ setbackVoie: 0, setbackLateral: 2, setbackFond: 2 }), 10);
    const env = buildEnvelope(ring, edges);
    // aucun point de l'enveloppe ne doit être à moins de 2 m du coin rentrant (10,10)
    for (const poly of env) for (const [x, y] of poly[0]) expect(Math.hypot(x - 10, y - 10)).toBeGreaterThan(1.99);
  });
});

describe('emprise du bâtiment', () => {
  it('lanière 8×30, mitoyen des deux côtés, fond 4 m : bâtiment 8 m × 12 m collé à la rue', () => {
    const p = computeProject(strip(), crit());
    expect(p.footprint).not.toBeNull();
    expect(p.indicators.footprintArea).toBeCloseTo(8 * 12, 0);
    expect(p.indicators.facadeWidth).toBeCloseTo(8, 1);
    expect(p.indicators.depth).toBeCloseTo(12, 1);
    expect(p.limitedBy).toContain('profondeur maximale');
    // façades : 2 murs mitoyens, 1 sur rue, 1 sur jardin
    const roles = p.footprintEdges.map((e) => e.role).sort();
    expect(roles).toEqual(['free', 'party', 'party', 'street']);
  });

  it('le CES borne l’emprise en réduisant la profondeur', () => {
    const p = computeProject(strip(), crit({ maxCoverage: 0.3 }));
    expect(p.indicators.footprintArea).toBeLessThanOrEqual(0.3 * 240 + 0.01);
    expect(p.indicators.footprintArea).toBeGreaterThan(0.3 * 240 - 1);
    expect(p.limitedBy).toContain('emprise / densité');
    expect(p.checks.find((c) => c.id === 'ces')?.status).toBe('ok');
  });

  it('la densité maximale réduit l’emprise jusqu’à respecter SDP / terrain', () => {
    const p = computeProject(strip(), crit({ levels: 4, maxFAR: 1.2 }));
    expect(p.indicators.far).toBeLessThanOrEqual(1.2 + 0.02);
    expect(p.indicators.far).toBeGreaterThan(1.0);
  });

  it('suit un trapèze (les limites obliques) en forme adaptée', () => {
    const trap = parcelFromLocal(
      [
        [0, 0],
        [10, 0],
        [8, 30],
        [0, 30],
      ],
      [0],
    );
    const p = computeProject(trap, crit({ setbackFond: 0, maxDepth: 15 }));
    expect(p.footprint).not.toBeNull();
    expect(p.indicators.footprintArea).toBeCloseTo(15 * ((10 + (10 - 2 * 0.5)) / 2), -0.3); // ≈ trapèze de 15 m de profondeur
    expect(p.indicators.footprintArea).toBeLessThan(15 * 10);
  });

  it('la forme rectangle donne un rectangle inscrit', () => {
    const trap = parcelFromLocal(
      [
        [0, 0],
        [10, 0],
        [8, 30],
        [0, 30],
      ],
      [0],
    );
    const p = computeProject(trap, crit({ setbackFond: 0, maxDepth: 15, footprintShape: 'rectangle' }));
    expect(p.footprint).not.toBeNull();
    expect(p.footprint!.length).toBe(4);
    expect(p.indicators.footprintArea).toBeGreaterThan(15 * 7);
  });

  it('terrain d’angle : deux voies, retrait appliqué sur les deux', () => {
    const corner = parcelFromLocal(
      [
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
      ],
      [0, 1],
    );
    const p = computeProject(corner, crit({ setbackVoie: 3, setbackLateral: 0, setbackFond: 0 }));
    expect(p.edges.filter((e) => e.kind === 'voie')).toHaveLength(2);
    expect(multiArea(p.envelope)).toBeCloseTo(17 * 17, 0);
  });
});

describe('programme', () => {
  it('R+3 sur 8×12 : 4 niveaux, hauteur 3,2 + 3×2,9 = 11,9 m, ascenseur dès R+3', () => {
    const p = computeProject(strip(), crit({ levels: 3 }));
    expect(p.levels).toHaveLength(4);
    expect(p.indicators.height).toBeCloseTo(11.9, 6);
    expect(p.indicators.hasLift).toBe(true);
    expect(computeProject(strip(), crit({ levels: 2 })).indicators.hasLift).toBe(false);
  });

  it('la SDP et les logements augmentent avec les niveaux', () => {
    const s = compareScenarios(strip(), crit(), 6);
    for (let i = 1; i < s.length; i++) {
      expect(s[i].project.indicators.sdpTotal).toBeGreaterThan(s[i - 1].project.indicators.sdpTotal);
      expect(s[i].project.indicators.dwellings).toBeGreaterThanOrEqual(s[i - 1].project.indicators.dwellings);
    }
  });

  it('la surface habitable des logements correspond à la surface utile × ratio SHAB', () => {
    const p = computeProject(strip(), crit({ levels: 4 }));
    const usable = p.levels.filter((l) => l.use === 'logement').reduce((s, l) => s + l.usable, 0);
    expect(p.indicators.shab).toBeGreaterThan(0.6 * usable);
    expect(p.indicators.shab).toBeLessThanOrEqual(usable * 0.92 + 1e-6);
    expect(p.dwellings.reduce((s, d) => s + d.area, 0)).toBeCloseTo(p.indicators.shab, 6);
    expect(Object.values(p.typologyCounts).reduce((s, n) => s + n, 0)).toBe(p.dwellings.length);
  });

  it('le nombre de logements par niveau est borné par la façade vitrée disponible', () => {
    const p = computeProject(strip(), crit({ levels: 3 }));
    const maxPerLevel = Math.floor(p.indicators.glazedLength / 4);
    for (const l of p.levels) expect(l.dwellings).toBeLessThanOrEqual(Math.max(1, maxPerLevel));
  });

  it('un RDC commercial ne crée pas de logement et génère des places de stationnement requises', () => {
    const p = computeProject(strip(), crit({ levels: 3, groundFloorUse: 'commerce' }));
    expect(p.levels[0].use).toBe('commerce');
    expect(p.levels[0].dwellings).toBe(0);
    expect(p.indicators.sdpCommerce).toBeGreaterThan(0);
    expect(p.parking.required).toBeGreaterThan(Math.ceil(p.indicators.dwellings));
  });

  it('l’attique est en retrait des façades avant/arrière et ajoute un niveau', () => {
    const base = computeProject(strip(), crit({ levels: 3 }));
    const att = computeProject(strip(), crit({ levels: 3, attic: true }));
    expect(att.levels).toHaveLength(5);
    expect(att.levels[4].kind).toBe('attique');
    expect(att.atticFootprint).not.toBeNull();
    expect(ringArea(att.atticFootprint!)).toBeCloseTo(8 * (12 - 4), 0);
    expect(att.indicators.height).toBeCloseTo(base.indicators.height + 2.9, 6);
  });

  it('R+0 sans noyau : pas de hall ni d’escalier', () => {
    const p = computeProject(strip(), crit({ levels: 0 }));
    expect(p.levels).toHaveLength(1);
    expect(p.levels[0].core).toBe(0);
    expect(p.levels[0].services).toBe(0);
  });
});

describe('stationnement', () => {
  it('1 place par logement, en surface d’abord puis sous-sol (auto)', () => {
    const p = computeProject(strip(), crit({ levels: 4 }));
    expect(p.parking.required).toBe(p.indicators.dwellings);
    expect(p.parking.provided).toBeGreaterThanOrEqual(0);
    expect(p.parking.surface + p.parking.basement).toBe(p.parking.provided);
  });

  it('sous-sol : détermine le nombre de niveaux nécessaires', () => {
    const p = computeProject(strip(), crit({ levels: 5, parkingStrategy: 'sous-sol', parkingPerDwelling: 1.5, maxBasementLevels: 3 }));
    expect(p.parking.basementLevels).toBeGreaterThanOrEqual(1);
    expect(p.parking.feasibleBasement).toBe(true);
    if (p.parking.provided >= p.parking.required) expect(p.checks.find((c) => c.id === 'parking')?.status).toBe('ok');
  });

  it('terrain trop étroit : le sous-sol est impossible et le contrôle échoue avec une explication', () => {
    const thin = parcelFromLocal(
      [
        [0, 0],
        [4.5, 0],
        [4.5, 30],
        [0, 30],
      ],
      [0],
    );
    const p = computeProject(thin, crit({ levels: 3, parkingStrategy: 'sous-sol', minWidth: 4 }));
    expect(p.parking.feasibleBasement).toBe(false);
    expect(p.parking.provided).toBe(0);
    const chk = p.checks.find((c) => c.id === 'parking')!;
    expect(chk.status).toBe('error');
    expect(chk.detail).toContain('Sous-sol impossible');
  });

  it('stratégie « rdc » : le RDC est affecté au parking et ne crée pas de SDP', () => {
    const p = computeProject(strip(), crit({ levels: 3, parkingStrategy: 'rdc' }));
    expect(p.levels[0].use).toBe('parking');
    expect(p.levels[0].sdp).toBe(0);
    expect(p.parking.rdc).toBeGreaterThan(0);
    expect(p.levels[0].parkingSpaces).toBeGreaterThan(0);
  });

  it('stratégie « aucun » : rien n’est prévu et un avertissement est émis', () => {
    const p = computeProject(strip(), crit({ levels: 3, parkingStrategy: 'aucun' }));
    expect(p.parking.provided).toBe(0);
    expect(p.checks.find((c) => c.id === 'parking')?.status).toBe('warn');
  });

  it('la pleine terre diminue avec le stationnement de surface', () => {
    const none = computeProject(strip(), crit({ levels: 3, parkingStrategy: 'aucun' }));
    const surf = computeProject(strip(), crit({ levels: 3, parkingStrategy: 'surface', minOpenGround: 0 }));
    expect(surf.indicators.openGround).toBeLessThanOrEqual(none.indicators.openGround);
  });
});

describe('pleine terre', () => {
  it('un sous-sol logé sous le bâtiment et les places de surface ne retire pas de pleine terre en plus', () => {
    const p = computeProject(strip(), crit({ levels: 4, parkingStrategy: 'auto' }));
    const { footprintArea, parcelArea, openGround } = p.indicators;
    const covered = Math.max(footprintArea + p.parking.surfaceArea, p.parking.basementPlate);
    expect(openGround).toBeCloseTo((parcelArea - covered) / parcelArea, 6);
    expect(p.parking.basement).toBeGreaterThan(0);
    // le sous-sol n'a pas besoin de dépasser l'emprise + les places de surface dans ce cas
    expect(p.parking.basementPlate).toBeLessThanOrEqual(footprintArea + p.parking.surfaceArea + 1e-6);
  });

  it('un grand sous-sol qui déborde sous le jardin réduit la pleine terre', () => {
    const p = computeProject(strip(), crit({ levels: 6, parkingPerDwelling: 2, parkingStrategy: 'sous-sol', maxBasementLevels: 1 }));
    expect(p.parking.basementPlate).toBeGreaterThan(p.indicators.footprintArea);
    expect(p.indicators.openGround).toBeLessThan(1 - p.indicators.coverage + 1e-9);
  });
});

describe('contrôles réglementaires', () => {
  it('hauteur maximale : erreur et R+x maximal suggéré', () => {
    const p = computeProject(strip(), crit({ levels: 5, maxHeight: 12 }));
    expect(p.checks.find((c) => c.id === 'height')?.status).toBe('error');
    expect(p.maxLevelsForHeight).toBe(3); // 3,2 + 3×2,9 = 11,9 ≤ 12
    expect(p.checks.find((c) => c.id === 'height')?.detail).toContain('R+3');
  });

  it('hauteur maximale respectée', () => {
    const p = computeProject(strip(), crit({ levels: 3, maxHeight: 12 }));
    expect(p.checks.find((c) => c.id === 'height')?.status).toBe('ok');
  });

  it('terrain dégénéré : projet vide sans exception', () => {
    const p = computeProject({ ring: [{ lon: 2, lat: 48 }, { lon: 2.0001, lat: 48 }], streetEdges: [0] }, crit());
    expect(p.footprint).toBeNull();
  });
});

describe('exports', () => {
  it('KML bien formé avec volumes extrudés', () => {
    const p = computeProject(strip(), crit({ levels: 3, attic: true }));
    const kml = buildKml(p, crit({ levels: 3, attic: true }), 'Test & <co>');
    expect(kml).toContain('<kml xmlns="http://www.opengis.net/kml/2.2">');
    expect(kml).toContain('<extrude>1</extrude>');
    expect(kml).toContain('relativeToGround');
    expect(kml).toContain('Test &amp; &lt;co&gt;');
    expect(kml).toContain('Attique');
    // chaque coordonnée a lon,lat,alt
    expect(kml.match(/<coordinates>([^<]+)<\/coordinates>/g)!.length).toBeGreaterThan(3);
  });

  it('GeoJSON : relit le terrain exporté', () => {
    const p = computeProject(strip(), crit());
    const gj = buildGeoJson(p, crit());
    const ring = parseParcelGeoJson(gj) as LonLat[];
    expect(ring).toHaveLength(4);
    expect(JSON.parse(gj).urbasim.indicateurs.dwellings).toBe(p.indicators.dwellings);
  });

  it('refuse un GeoJSON invalide', () => {
    expect(parseParcelGeoJson('pas du json')).toBeNull();
    expect(parseParcelGeoJson('{"type":"Point","coordinates":[1,2]}')).toBeNull();
  });
});

import { insertVertex, pickStreetEdgesFromRoads, removeVertex, streetHeading, toggleStreetEdge } from '../src/engine';

describe('édition du contour', () => {
  const sq = (): Parcel => parcelFromLocal([[0, 0], [10, 0], [10, 10], [0, 10]], [0]);

  it('insérer un sommet sur une arête de voie garde les deux moitiés sur rue et décale les suivantes', () => {
    const p = insertVertex({ ...sq(), streetEdges: [0, 2] }, 0);
    expect(p.ring).toHaveLength(5);
    expect(p.streetEdges).toEqual([0, 1, 3]);
  });

  it('supprimer un sommet fusionne les arêtes adjacentes', () => {
    // arêtes : 0 (rue), 1, 2, 3 ; on enlève le sommet 1 → arêtes 0+1 fusionnent
    const p = removeVertex({ ...sq(), streetEdges: [0] }, 1);
    expect(p.ring).toHaveLength(3);
    expect(p.streetEdges).toEqual([0]);
  });

  it('supprimer le sommet 0 : l’arête fusionnée prend le dernier indice', () => {
    const p = removeVertex({ ...sq(), streetEdges: [3] }, 0); // arêtes 3 (3→0) et 0 (0→1) fusionnent
    expect(p.ring).toHaveLength(3);
    expect(p.streetEdges).toEqual([2]);
    const q = removeVertex({ ...sq(), streetEdges: [2] }, 0); // l'arête 2 devient l'arête 1
    expect(q.streetEdges).toEqual([1]);
  });

  it('on ne descend jamais sous 3 sommets', () => {
    const t = parcelFromLocal([[0, 0], [10, 0], [5, 8]], [0]);
    expect(removeVertex(t, 0).ring).toHaveLength(3);
  });

  it('bascule les arêtes de voie mais en garde toujours une', () => {
    const p = toggleStreetEdge(sq(), 2);
    expect(p.streetEdges).toEqual([0, 2]);
    expect(toggleStreetEdge(toggleStreetEdge(p, 0), 2).streetEdges).toEqual([2]);
  });
});

describe('détection du côté rue', () => {
  const lot: Vec2[] = [[0, 0], [8, 0], [8, 30], [0, 30]];

  it('une voie au sud désigne le petit côté sud', () => {
    expect(pickStreetEdgesFromRoads(lot, [[[-50, -6], [60, -6]]])).toEqual([0]);
  });

  it('terrain d’angle : les deux côtés qui longent une voie', () => {
    const corner: Vec2[] = [[0, 0], [20, 0], [20, 20], [0, 20]];
    const roads: Vec2[][] = [[[-40, -6], [60, -6]], [[-6, -40], [-6, 60]]];
    expect(pickStreetEdgesFromRoads(corner, roads)).toEqual([0, 3]);
  });

  it('parcelle traversante : une voie de chaque côté', () => {
    expect(pickStreetEdgesFromRoads(lot, [[[-40, -6], [60, -6]], [[-40, 36], [60, 36]]])).toEqual([0, 2]);
  });

  it('ignore une voie trop lointaine ou aucune voie', () => {
    expect(pickStreetEdgesFromRoads(lot, [[[-50, -80], [60, -80]]])).toEqual([]);
    expect(pickStreetEdgesFromRoads(lot, [])).toEqual([]);
  });

  it('ne prend pas un côté perpendiculaire à la voie', () => {
    // route verticale à l'ouest : le côté ouest (3) est parallèle et proche, pas le côté sud perpendiculaire
    expect(pickStreetEdgesFromRoads(lot, [[[-6, -50], [-6, 80]]])).toEqual([3]);
  });

  it('azimut de la caméra : rue au sud ⇒ la caméra regarde vers le nord (0°)', () => {
    expect(streetHeading(lot, [0])).toBeCloseTo(0, 6);
    // rue à l'ouest ⇒ la caméra regarde vers l'est (90°)
    expect(streetHeading(lot, [3])).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('contours invalides', () => {
  it('détecte un contour en « 8 » (côtés qui se croisent)', () => {
    expect(isSimplePolygon([[0, 0], [10, 10], [10, 0], [0, 10]])).toBe(false);
    expect(isSimplePolygon([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(true);
  });

  it('refuse proprement un contour qui se croise', () => {
    const bow = parcelFromLocal([[0, 0], [10, 10], [10, 0], [0, 10]], [0]);
    const p = computeProject(bow, crit());
    expect(p.footprint).toBeNull();
    expect(p.checks[0].detail).toContain('se croise');
  });

  it('refuse un terrain démesuré sans planter ni saturer la mémoire', () => {
    const huge = parcelFromLocal([[0, 0], [2000, 0], [2000, 2000], [0, 2000]], [0]);
    const p = computeProject(huge, crit({ footprintShape: 'rectangle' }));
    expect(p.footprint).toBeNull();
  });

  it('un grand terrain (2 ha) reste calculable en forme rectangle', () => {
    const big = parcelFromLocal([[0, 0], [200, 0], [200, 100], [0, 100]], [0]);
    const t0 = Date.now();
    const p = computeProject(big, crit({ footprintShape: 'rectangle', maxDepth: 14, setbackFond: 5, setbackLateral: 4 }));
    expect(p.footprint).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(p.indicators.depth).toBeLessThanOrEqual(14.01);
  });
});

describe('implantation dans la profondeur du terrain (rue / fond / automatique)', () => {
  const ys = (r: number[][]) => ({ min: Math.min(...r.map((q) => q[1])), max: Math.max(...r.map((q) => q[1])) });
  const signed = (r: number[][]) => r.reduce((s, p, i) => s + (p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1]), 0) / 2;
  // lot de 8 × 30 m, rue au sud ; sans retrait de fond la zone constructible va jusqu'au bout du terrain
  const base = { setbackFond: 0, maxDepth: 12 };
  // lot qui s'élargit vers le fond : 8 m côté rue, 14 m au fond
  const widening = () =>
    parcelFromLocal(
      [
        [0, 0],
        [8, 0],
        [14, 30],
        [0, 30],
      ],
      [0],
    );

  it('par défaut, l’implantation est automatique', () => {
    expect(DEFAULT_CRITERIA.placement).toBe('auto');
  });

  it('côté rue : le bâtiment colle à la rue (comportement historique), le fond reste libre', () => {
    const p = computeProject(strip(), crit({ ...base, placement: 'rue' }));
    const t = ys(p.parcelRing), f = ys(p.footprint!);
    expect(f.min).toBeCloseTo(t.min, 1);
    expect(f.max - f.min).toBeCloseTo(12, 1);
    expect(p.placement).toBe('rue');
  });

  it('en fond de parcelle : même emprise, collée au fond, la façade sur rue donne sur une cour', () => {
    const rue = computeProject(strip(), crit({ ...base, placement: 'rue' }));
    const fond = computeProject(strip(), crit({ ...base, placement: 'fond' }));
    const t = ys(fond.parcelRing), f = ys(fond.footprint!);
    expect(f.max).toBeCloseTo(t.max, 1);
    expect(f.max - f.min).toBeCloseTo(12, 1);
    expect(fond.indicators.footprintArea).toBeCloseTo(rue.indicators.footprintArea, 1);
    expect(fond.placement).toBe('fond');
    expect(fond.footprintEdges.some((e) => e.role === 'street')).toBe(false); // plus aucune façade sur la rue
    expect(Math.sign(signed(fond.footprint!))).toBe(Math.sign(signed(rue.footprint!))); // même orientation du contour
  });

  it('retrait de fond : le bâtiment en fond de parcelle s’arrête au retrait', () => {
    const p = computeProject(strip(), crit({ setbackFond: 4, maxDepth: 12, placement: 'fond' }));
    expect(ys(p.parcelRing).max - ys(p.footprint!).max).toBeCloseTo(4, 1);
  });

  it('automatique, lot rectangulaire : à égalité, on garde la rue', () => {
    const p = computeProject(strip(), crit({ ...base, placement: 'auto' }));
    expect(ys(p.footprint!).min).toBeCloseTo(ys(p.parcelRing).min, 1);
    expect(p.placement).toBe('rue');
    expect(p.checks.some((c) => c.id === 'placement')).toBe(false);
  });

  it('automatique, lot qui s’élargit vers le fond : le bâtiment va au fond, où l’emprise est plus grande', () => {
    const rue = computeProject(widening(), crit({ ...base, placement: 'rue' }));
    const auto = computeProject(widening(), crit({ ...base, placement: 'auto' }));
    expect(auto.placement).toBe('fond');
    expect(auto.indicators.footprintArea).toBeGreaterThan(rue.indicators.footprintArea * 1.2);
    expect(ys(auto.footprint!).max).toBeCloseTo(ys(auto.parcelRing).max, 1);
    expect(auto.checks.find((c) => c.id === 'placement')?.status).toBe('info');
    // le choix « côté rue » reste possible et donne l’ancienne emprise
    expect(rue.placement).toBe('rue');
    expect(ys(rue.footprint!).min).toBeCloseTo(ys(rue.parcelRing).min, 1);
  });

  it('automatique, lot qui se rétrécit vers le fond : la rue l’emporte', () => {
    const narrowing = parcelFromLocal([[0, 0], [14, 0], [8, 30], [0, 30]], [0]);
    expect(computeProject(narrowing, crit({ ...base, placement: 'auto' })).placement).toBe('rue');
  });

  it('en fond de parcelle, le plafond d’emprise (CES) est respecté', () => {
    const p = computeProject(strip(), crit({ ...base, maxCoverage: 0.3, placement: 'fond' }));
    expect(p.indicators.footprintArea).toBeLessThanOrEqual(0.3 * p.parcelArea + 0.5);
    expect(ys(p.footprint!).max).toBeCloseTo(ys(p.parcelRing).max, 1);
  });

  it('en fond de parcelle, la forme « rectangle inscrit » donne un rectangle collé au fond', () => {
    const p = computeProject(widening(), crit({ ...base, footprintShape: 'rectangle', placement: 'fond' }));
    expect(p.footprint!.length).toBe(4);
    expect(ys(p.footprint!).max).toBeCloseTo(ys(p.parcelRing).max, 1);
    const rue = computeProject(widening(), crit({ ...base, footprintShape: 'rectangle', placement: 'rue' }));
    expect(p.indicators.footprintArea).toBeGreaterThan(rue.indicators.footprintArea);
  });

  it('l’emprise reste dans l’enveloppe constructible quel que soit le choix', () => {
    for (const placement of ['rue', 'fond', 'auto'] as const) {
      const p = computeProject(widening(), crit({ ...base, setbackLateral: 1, placement }));
      expect(multiArea(difference(toMulti(p.footprint!), p.envelope))).toBeLessThan(0.05);
    }
  });

  it('une valeur inconnue se comporte comme « côté rue »', () => {
    const a = computeProject(strip(), crit({ ...base, placement: 'ailleurs' as never }));
    const b = computeProject(strip(), crit({ ...base, placement: 'rue' }));
    expect(a.footprint).toEqual(b.footprint);
  });
});

describe('terrain d’angle : le bâtiment longe toutes les rues', () => {
  const corner = (streets = [0, 1]) => parcelFromLocal([[0, 0], [30, 0], [30, 30], [0, 30]], streets);
  const flat = { setbackVoie: 0, setbackLateral: 0, setbackFond: 0, maxDepth: 12 };

  it('emprise en L : 12 m de profondeur le long des deux rues (576 m², pas 360)', () => {
    const p = computeProject(corner(), crit({ ...flat, placement: 'rue' }));
    expect(p.indicators.footprintArea).toBeCloseTo(30 * 12 + 12 * 18, 0);
    expect(p.footprint!.length).toBe(6);
    expect(p.footprintEdges.filter((e) => e.role === 'street').length).toBeGreaterThanOrEqual(2);
  });

  it('une seule rue : inchangé (bande de 360 m²)', () => {
    expect(computeProject(corner([0]), crit({ ...flat, placement: 'rue' })).indicators.footprintArea).toBeCloseTo(360, 0);
  });

  it('le plafond d’emprise est respecté, en gardant le L', () => {
    const p = computeProject(corner(), crit({ ...flat, placement: 'rue', maxCoverage: 0.4 }));
    expect(p.indicators.footprintArea).toBeLessThanOrEqual(0.4 * 900 + 0.5);
    expect(p.footprint!.length).toBe(6);
  });

  it('un pan coupé de moins de 4,5 m n’ajoute pas de bande', () => {
    const cut = parcelFromLocal([[0, 0], [18, 0], [20, 2], [20, 30], [0, 30]], [0, 1]);
    const one = parcelFromLocal([[0, 0], [18, 0], [20, 2], [20, 30], [0, 30]], [0]);
    const a = computeProject(cut, crit({ ...flat, placement: 'rue' })).indicators.footprintArea;
    expect(a).toBeCloseTo(computeProject(one, crit({ ...flat, placement: 'rue' })).indicators.footprintArea, 1);
  });

  it('terrain bordé de rues sur ses quatre côtés : pas de cour fermée, la bande de la rue principale', () => {
    const island = parcelFromLocal([[0, 0], [20, 0], [20, 20], [0, 20]], [0, 1, 2, 3]);
    const p = computeProject(island, crit({ ...flat, maxDepth: 6, placement: 'rue' }));
    expect(p.indicators.footprintArea).toBeGreaterThan(0);
    expect(p.footprint!.length).toBeLessThanOrEqual(8);
  });

  it('en fond de parcelle ou en rectangle inscrit, pas de L', () => {
    expect(computeProject(corner(), crit({ ...flat, placement: 'fond' })).indicators.footprintArea).toBeCloseTo(360, 0);
    expect(computeProject(corner(), crit({ ...flat, placement: 'rue', footprintShape: 'rectangle' })).footprint!.length).toBe(4);
  });
});

describe('entrée du parking', () => {
  const lot = () => parcelFromLocal([[0, 0], [10, 0], [10, 30], [0, 30]], [0]);
  const sub = { parkingStrategy: 'sous-sol' as const, setbackFond: 0, levels: 4, placement: 'rue' as const };
  const w = (a: number[][]) => Math.hypot(a[1][0] - a[0][0], a[1][1] - a[0][1]);

  it('sous-sol : porte de 3,5 m dans la façade sur rue et rampe dans le bâtiment', () => {
    const p = computeProject(lot(), crit(sub));
    expect(p.parking.basementLevels).toBeGreaterThan(0);
    const ac = p.parkingAccess!;
    expect(ac).not.toBeNull();
    expect(ac.kind).toBe('sous-sol');
    expect(w(ac.door)).toBeCloseTo(3.5, 2);
    expect(ac.drive).toBeNull(); // façade sur la voie
    expect(ringArea(ac.ramp!)).toBeCloseTo(3.5 * 4.3, 1);
    const minY = Math.min(...p.parcelRing.map((q) => q[1]));
    expect(ac.door[0][1]).toBeCloseTo(minY, 1);
    expect(p.checks.find((c) => c.id === 'access')?.status).toBe('info');
  });

  it('bâtiment en retrait de 5 m : une allée relie la porte à la voie', () => {
    const p = computeProject(lot(), crit({ ...sub, setbackVoie: 5 }));
    const ac = p.parkingAccess!;
    expect(ac.drive).not.toBeNull();
    expect(ringArea(ac.drive!)).toBeCloseTo(3.5 * 5, 0);
  });

  it('bâtiment en fond de parcelle : allée jusqu’à la voie', () => {
    const p = computeProject(lot(), crit({ ...sub, placement: 'fond' }));
    expect(ringArea(p.parkingAccess!.drive!)).toBeGreaterThan(3.5 * 10);
  });

  it('parking en rez-de-chaussée : porte sans rampe', () => {
    const p = computeProject(lot(), crit({ ...sub, parkingStrategy: 'rdc' }));
    expect(p.parkingAccess?.kind).toBe('rez-de-chaussée');
    expect(p.parkingAccess?.ramp).toBeNull();
  });

  it('parking de surface seulement : pas d’entrée', () => {
    const p = computeProject(lot(), crit({ ...sub, parkingStrategy: 'surface' }));
    expect(p.parkingAccess).toBeNull();
  });

  it('façade trop étroite : pas d’entrée et un avertissement', () => {
    const narrow = parcelFromLocal([[0, 0], [4, 0], [4, 30], [0, 30]], [0]);
    const p = computeProject(narrow, crit({ ...sub, minWidth: 3, parkingStrategy: 'rdc' }));
    expect(p.parkingAccess).toBeNull();
    expect(p.checks.find((c) => c.id === 'access')?.status).toBe('warn');
  });

  it('terrain d’angle : la porte est sur une façade sur rue', () => {
    const c = parcelFromLocal([[0, 0], [30, 0], [30, 30], [0, 30]], [0, 1]);
    const p = computeProject(c, crit({ ...sub, setbackVoie: 0, setbackLateral: 0, placement: 'rue' }));
    expect(p.parkingAccess).not.toBeNull();
    const mx = (p.parkingAccess!.door[0][0] + p.parkingAccess!.door[1][0]) / 2;
    expect(mx).toBeGreaterThan(Math.min(...p.parcelRing.map((q) => q[0])));
  });
});
