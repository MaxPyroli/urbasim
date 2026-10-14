import { DEFAULT_ASSUMPTIONS } from './defaults';
import { generateFootprint } from './footprint';
import {
  Frame,
  LocalProjection,
  bbox,
  centroid,
  cleanRing,
  intersection,
  isSimplePolygon,
  minWidth,
  rectRing,
  ringArea,
  toMulti,
} from './geometry';
import { buildEnvelope, classifyFootprintEdges, computeEdges, inwardNormal, makeFrame, primaryStreetEdge } from './layout';
import { computeParkingAccess } from './access';
import { computeParking, requiredParking } from './parking';
import { buildingHeight, computeProgram, effectiveGroundUse } from './program';
import type {
  Assumptions,
  Check,
  Criteria,
  Indicators,
  LonLat,
  Parcel,
  Project,
  Ring,
  Typology,
} from './types';

const fmt = (n: number, d = 0) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

export function parcelCenter(ring: LonLat[]): LonLat {
  const lon0 = ring.reduce((s, p) => s + p.lon, 0) / ring.length;
  const lat0 = ring.reduce((s, p) => s + p.lat, 0) / ring.length;
  const proj = new LocalProjection(lon0, lat0);
  const c = centroid(ring.map((p) => proj.toLocal(p)));
  return proj.toLonLat(c);
}

function atticRing(footprint: Ring, frame: Frame, setback: number, minArea: number): Ring | null {
  const fr = frame.toRing(footprint);
  const bb = bbox(fr);
  if (bb.maxY - bb.minY - 2 * setback <= 1) return null;
  const clip = intersection(toMulti(fr), toMulti(rectRing(bb.minX - 1, bb.minY + setback, bb.maxX + 1, bb.maxY - setback)));
  if (clip.length === 0) return null;
  const best = clip.reduce((b, p) => (ringArea(p[0]) > ringArea(b[0]) ? p : b));
  const ring = cleanRing(frame.fromRing(best[0]));
  return ringArea(ring) >= minArea ? ring : null;
}

export function emptyProject(origin: LonLat, parcelRing: Ring, c: Criteria): Project {
  const zero: Record<Typology, number> = { T1: 0, T2: 0, T3: 0, T4: 0, T5: 0 };
  return {
    origin,
    parcelRing,
    parcelArea: ringArea(parcelRing),
    parcelMinWidth: minWidth(parcelRing),
    edges: [],
    envelope: [],
    footprint: null,
    parkingAccess: null,
    placement: 'rue',
    footprintEdges: [],
    atticFootprint: null,
    levels: [],
    dwellings: [],
    typologyCounts: zero,
    parking: {
      required: 0,
      provided: 0,
      surface: 0,
      rdc: 0,
      basement: 0,
      basementLevels: 0,
      basementPlate: 0,
      capacityMax: 0,
      feasibleBasement: false,
      surfaceArea: 0,
    },
    indicators: {
      parcelArea: ringArea(parcelRing),
      footprintArea: 0,
      coverage: 0,
      openGround: 1,
      sdpTotal: 0,
      sdpHousing: 0,
      sdpCommerce: 0,
      sdpOffice: 0,
      shab: 0,
      far: 0,
      height: buildingHeight(c),
      levelsCount: c.levels + 1 + (c.attic ? 1 : 0),
      dwellings: 0,
      avgDwellingArea: 0,
      hasLift: false,
      bikeRoom: 0,
      facadeWidth: 0,
      depth: 0,
      glazedLength: 0,
    },
    checks: [],
    limitedBy: [],
    maxLevelsForHeight: null,
  };
}

/** R+x maximal dont la hauteur reste sous la limite (−1 si même le RDC dépasse). */
export function maxLevelsUnderHeight(c: Criteria): number | null {
  if (c.maxHeight === null) return null;
  const rest = c.maxHeight - c.groundFloorHeight - (c.attic ? c.floorHeight : 0);
  return rest < 0 ? -1 : Math.floor(rest / c.floorHeight + 1e-9);
}

export function computeProject(parcel: Parcel, criteria: Criteria, assumptions: Assumptions = DEFAULT_ASSUMPTIONS): Project {
  const c = criteria;
  const a = assumptions;
  const origin = parcelCenter(parcel.ring);
  const proj = new LocalProjection(origin.lon, origin.lat);
  const ring = parcel.ring.map((p) => proj.toLocal(p));
  const project = emptyProject(origin, ring, c);
  if (ring.length < 3) return project;
  if (!isSimplePolygon(ring)) {
    project.checks = [{ id: 'footprint', label: 'Contour du terrain', status: 'error', detail: 'Le contour se croise lui-même : déplacez les sommets pour obtenir un polygone simple.' }];
    return project;
  }
  if (project.parcelArea < 1) return project;
  if (project.parcelArea > 250000) {
    project.checks = [{ id: 'footprint', label: 'Contour du terrain', status: 'error', detail: 'Terrain trop grand (> 25 ha) pour une étude de bâtiment unique.' }];
    return project;
  }

  const height = buildingHeight(c);
  const edges = computeEdges(ring, parcel.streetEdges, c, height);
  const envelope = buildEnvelope(ring, edges);
  const frame = makeFrame(ring, parcel.streetEdges);
  project.edges = edges;
  project.envelope = envelope;
  project.maxLevelsForHeight = maxLevelsUnderHeight(c);

  const parcelArea = project.parcelArea;
  const capCES = c.maxCoverage !== null ? c.maxCoverage * parcelArea : null;
  let areaCap = capCES;
  // autres rues du terrain (angle) : le bâtiment les longe aussi, si leur façade est exploitable
  const mainStreet = primaryStreetEdge(ring, parcel.streetEdges);
  const streetFronts = [...new Set(parcel.streetEdges)]
    .filter((i) => i !== mainStreet && edges[i] && edges[i].kind === 'voie' && edges[i].length >= c.minWidth)
    .map((i) => ({ a: edges[i].a, b: edges[i].b, n: inwardNormal(ring, i), setback: edges[i].setback }));
  const fpOptions = (cap: number | null) => ({ shape: c.footprintShape, maxDepth: c.maxDepth, minWidth: c.minWidth, areaCap: cap, placement: c.placement, streetFronts });
  let fp = generateFootprint(envelope, frame, fpOptions(areaCap));
  let limitedBy = fp.limitedBy;
  let footprint: Ring | null = fp.ring;
  const failReason = fp.reason;

  if (!footprint) {
    project.limitedBy = limitedBy;
    project.checks = [
      { id: 'footprint', label: 'Emprise constructible', status: 'error', detail: failReason ?? 'Aucune emprise constructible.' },
    ];
    return project;
  }

  const buildProgram = (rampLoss: number, fpRing: Ring) => {
    const fpEdges = classifyFootprintEdges(fpRing, edges);
    const attic = c.attic ? atticRing(fpRing, frame, c.atticSetback, a.minAtticArea) : null;
    return {
      fpEdges,
      attic,
      program: computeProgram({ footprint: fpRing, footprintEdges: fpEdges, atticFootprint: attic, criteria: c, assumptions: a, rampLoss }),
    };
  };

  // Plafond de densité (SDP / surface de parcelle) : on réduit l'emprise jusqu'à le respecter.
  let built = buildProgram(0, footprint);
  if (c.maxFAR !== null) {
    for (let it = 0; it < 6; it++) {
      const sdp = built.program.levels.reduce((s, l) => s + l.sdp, 0);
      const target = c.maxFAR * parcelArea;
      if (sdp <= target + 0.5) break;
      const fpArea = ringArea(footprint);
      areaCap = Math.min(areaCap ?? Infinity, fpArea * (target / sdp) * 0.995);
      fp = generateFootprint(envelope, frame, fpOptions(areaCap));
      if (!fp.ring) {
        project.limitedBy = [...new Set([...limitedBy, 'densité'])];
        project.checks = [
          { id: 'footprint', label: 'Emprise constructible', status: 'error', detail: `Densité maximale (${c.maxFAR}) incompatible avec une emprise viable.` },
        ];
        return project;
      }
      footprint = fp.ring;
      limitedBy = [...new Set([...limitedBy.filter((l) => l !== 'retraits'), 'emprise / densité'])];
      built = buildProgram(0, footprint);
    }
  }

  // Stationnement : le sous-sol retire de la surface au RDC (rampe), ce qui peut changer le nombre de logements.
  const compute = (rampLoss: number) => {
    const b = buildProgram(rampLoss, footprint!);
    const dw = b.program.dwellings.length;
    const required = requiredParking(c, b.program.levels, dw);
    const parking = computeParking({
      required,
      criteria: c,
      assumptions: a,
      parcelArea,
      parcelMinWidth: project.parcelMinWidth,
      footprintArea: ringArea(footprint!),
      groundCapacity: b.program.groundParkingCapacity,
    });
    return { b, parking };
  };
  let res = compute(0);
  if (res.parking.basementLevels > 0) res = compute(a.rampEntryLoss);

  const { b, parking } = res;
  const program = b.program;
  const levels = program.levels;
  const sum = (use: string) => levels.filter((l) => l.use === use).reduce((s, l) => s + l.sdp, 0);
  const sdpHousing = sum('logement');
  const sdpCommerce = sum('commerce');
  const sdpOffice = sum('bureaux');
  const sdpTotal = sdpHousing + sdpCommerce + sdpOffice;
  const fpArea = ringArea(footprint);
  const shab = program.dwellings.reduce((s, d) => s + d.area, 0);
  // Le sous-sol se loge sous le bâtiment et sous les places de surface : seule sa part excédentaire consomme de la pleine terre.
  const covered = Math.max(fpArea + parking.surfaceArea, parking.basementPlate);
  const openGround = Math.max(0, (parcelArea - covered) / parcelArea);
  const fr = frame.toRing(footprint);
  const bb = bbox(fr);

  const indicators: Indicators = {
    parcelArea,
    footprintArea: fpArea,
    coverage: fpArea / parcelArea,
    openGround,
    sdpTotal,
    sdpHousing,
    sdpCommerce,
    sdpOffice,
    shab,
    far: sdpTotal / parcelArea,
    height,
    levelsCount: levels.length,
    dwellings: program.dwellings.length,
    avgDwellingArea: program.dwellings.length > 0 ? shab / program.dwellings.length : 0,
    hasLift: program.hasLift,
    bikeRoom: program.bikeRoom,
    facadeWidth: bb.maxX - bb.minX,
    depth: bb.maxY - bb.minY,
    glazedLength: program.glazedLength,
  };

  project.footprint = footprint;
  if (parking.basementLevels > 0 || parking.rdc > 0 || effectiveGroundUse(c) === 'parking') {
    project.parkingAccess = computeParkingAccess({
      footprint,
      footprintEdges: b.fpEdges,
      edges,
      parcelRing: ring,
      kind: parking.basementLevels > 0 ? 'sous-sol' : 'rez-de-chaussée',
      levels: parking.basementLevels,
    });
  }
  project.placement = fp.at;
  project.footprintEdges = b.fpEdges;
  project.atticFootprint = b.attic;
  project.levels = levels;
  project.dwellings = program.dwellings;
  project.typologyCounts = program.typologyCounts;
  project.parking = parking;
  project.indicators = indicators;
  project.limitedBy = limitedBy;
  project.checks = buildChecks(project, c, a);
  return project;
}

function buildChecks(p: Project, c: Criteria, a: Assumptions): Check[] {
  const i = p.indicators;
  const checks: Check[] = [];
  const add = (id: string, label: string, status: Check['status'], detail: string) => checks.push({ id, label, status, detail });

  if (c.maxHeight !== null) {
    if (i.height <= c.maxHeight + 1e-6) add('height', 'Hauteur', 'ok', `${fmt(i.height, 1)} m ≤ ${fmt(c.maxHeight, 1)} m autorisés`);
    else {
      const m = p.maxLevelsForHeight;
      add('height', 'Hauteur', 'error', `${fmt(i.height, 1)} m > ${fmt(c.maxHeight, 1)} m autorisés${m !== null && m >= 0 ? ` — R+${m} maximum` : ''}`);
    }
  }
  if (c.maxCoverage !== null) {
    add('ces', 'Emprise au sol', i.coverage <= c.maxCoverage + 1e-3 ? 'ok' : 'error', `${fmt(i.coverage * 100)} % (max ${fmt(c.maxCoverage * 100)} %)`);
  }
  add('openGround', 'Pleine terre', i.openGround + 1e-3 >= c.minOpenGround ? 'ok' : 'warn', `${fmt(i.openGround * 100)} % (min ${fmt(c.minOpenGround * 100)} %)`);
  if (c.maxFAR !== null) {
    add('far', 'Densité (SDP / terrain)', i.far <= c.maxFAR + 1e-2 ? 'ok' : 'error', `${fmt(i.far, 2)} (max ${fmt(c.maxFAR, 2)})`);
  }

  const pk = p.parking;
  if (pk.required > 0) {
    if (c.parkingStrategy === 'aucun') add('parking', 'Stationnement', 'warn', `${pk.required} places requises, aucune prévue`);
    else if (pk.provided >= pk.required) {
      const where = [
        pk.surface > 0 ? `${pk.surface} en surface` : '',
        pk.rdc > 0 ? `${pk.rdc} en rez-de-chaussée` : '',
        pk.basement > 0 ? `${pk.basement} en sous-sol (${pk.basementLevels} niveau${pk.basementLevels > 1 ? 'x' : ''})` : '',
      ].filter(Boolean);
      add('parking', 'Stationnement', 'ok', `${pk.required} places requises : ${where.join(', ')}`);
    } else {
      const why =
        (c.parkingStrategy === 'sous-sol' || c.parkingStrategy === 'auto') && !pk.feasibleBasement
          ? ` Sous-sol impossible (terrain < ${fmt(a.minRampWidth, 1)} m de large ou 0 niveau autorisé).`
          : '';
      add('parking', 'Stationnement', 'error', `${pk.required} places requises, ${pk.provided} réalisables (capacité max ${pk.capacityMax}).${why}`);
    }
  }

  if (i.dwellings > 0 || p.levels.some((l) => l.use !== 'parking')) {
    add('lift', 'Ascenseur', 'info', i.hasLift ? 'Prévu (dernier niveau à partir de R+3).' : 'Non requis à cette hauteur (à vérifier selon la réglementation).');
  }
  if (i.depth > 14) add('depth', 'Profondeur', 'warn', `${fmt(i.depth, 1)} m : éclairement naturel difficile au-delà de 14 m.`);
  if (i.facadeWidth < 6.5 && i.dwellings > 0) add('narrow', 'Immeuble étroit', 'info', `Façade de ${fmt(i.facadeWidth, 1)} m : typiquement un à deux logements par niveau autour d'un noyau central.`);
  if (c.groundFloorUse === 'logement' && p.levels[0]?.use === 'logement' && p.edges.some((e) => e.kind === 'voie' && e.setback < 1)) {
    add('rdcStreet', 'Logement en RDC sur rue', 'info', 'Prévoir un traitement des vues (surélévation, rideau, haie) ou un RDC actif.');
  }
  if (effectiveGroundUse(c) === 'parking' && p.levels.length > 0) add('rdcParking', 'Parking en RDC', 'info', 'Le rez-de-chaussée est affecté au stationnement : pas de surface de plancher créée.');
  if (c.placement === 'auto' && p.placement === 'fond') {
    add('placement', 'Implantation', 'info', 'Bâtiment placé en fond de parcelle : l’emprise y est plus grande que côté rue (accès et défense incendie à prévoir).');
  }
  if (p.parking.basementLevels > 0 || p.parking.rdc > 0 || p.levels[0]?.use === 'parking') {
    const ac = p.parkingAccess;
    if (!ac) add('access', 'Entrée parking', 'warn', 'Aucune façade assez large (3,5 m + marges) tournée vers la rue : l’accès au parking reste à définir.');
    else {
      const drive = ac.drive ? `, allée de ${fmt(Math.hypot(ac.drive[3][0] - ac.drive[0][0], ac.drive[3][1] - ac.drive[0][1]), 1)} m jusqu’à la voie` : '';
      add('access', 'Entrée parking', 'info', ac.kind === 'sous-sol'
        ? `Porte de 3,5 m dans la façade sur rue${drive}, rampe vers ${ac.levels} niveau${ac.levels > 1 ? 'x' : ''} de sous-sol (≈ 15 m² pris au rez-de-chaussée).`
        : `Porte de garage de 3,5 m dans la façade sur rue${drive} (parking en rez-de-chaussée).`);
    }
  }
  if (p.limitedBy.length > 0) add('limit', 'Emprise limitée par', 'info', p.limitedBy.join(', '));
  return checks;
}
