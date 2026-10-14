export type Vec2 = [number, number];
/** Anneau ouvert : le dernier point n'est pas répété. */
export type Ring = Vec2[];
export type PolygonRings = Ring[];
export type MultiPolygon = PolygonRings[];

export interface LonLat {
  lon: number;
  lat: number;
}

import type { ParkingAccess } from './access';

export type Use = 'logement' | 'commerce' | 'bureaux' | 'parking';
export type EdgeKind = 'voie' | 'laterale' | 'fond';
export type Typology = 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
export type ParkingStrategy = 'auto' | 'sous-sol' | 'surface' | 'rdc' | 'aucun';
export type FootprintShape = 'adapte' | 'rectangle';
/** Position du bâtiment dans la profondeur du terrain : côté rue, en fond de parcelle, ou là où l'emprise est la plus grande. */
export type Placement = 'auto' | 'rue' | 'fond';

export const TYPOLOGIES: Typology[] = ['T1', 'T2', 'T3', 'T4', 'T5'];

/** Terrain tel que dessiné par l'utilisateur. */
export interface Parcel {
  /** Sommets en lon/lat, sens libre. L'arête i va du sommet i au sommet i+1. */
  ring: LonLat[];
  /** Arêtes donnant sur la voie publique (au moins une). */
  streetEdges: number[];
}

export interface Criteria {
  // Gabarit
  /** x dans « R+x » : nombre d'étages au-dessus du rez-de-chaussée. */
  levels: number;
  /** Niveau supplémentaire en attique, en retrait des façades avant/arrière. */
  attic: boolean;
  atticSetback: number;
  groundFloorHeight: number;
  floorHeight: number;
  /** Hauteur maximale autorisée (m), null = pas de limite. */
  maxHeight: number | null;

  // Implantation (m ; 0 = construction en limite, mitoyenne)
  setbackVoie: number;
  setbackLateral: number;
  setbackFond: number;
  /** Retraits spécifiques par arête (remplacent la valeur par défaut de la catégorie). */
  edgeSetbacks: Record<number, number>;
  /** Prospect : retrait ≥ ratio × H sur les limites non mitoyennes (0 = désactivé, 0.5 = H/2). */
  prospectRatio: number;
  /** Profondeur maximale du bâtiment (m) : au-delà, plus de logements traversants/éclairés. */
  maxDepth: number;
  /** Largeur minimale exploitable du bâtiment (m). */
  minWidth: number;
  /** Emprise au sol maximale, fraction de la parcelle (0–1). */
  maxCoverage: number | null;
  /** Espaces de pleine terre minimaux, fraction de la parcelle (0–1). */
  minOpenGround: number;
  /** Densité maximale : SDP / surface de parcelle. */
  maxFAR: number | null;
  footprintShape: FootprintShape;
  placement: Placement;

  // Programme
  groundFloorUse: Use;
  upperUse: 'logement' | 'bureaux';
  /** Répartition cible des typologies (somme normalisée automatiquement). */
  mix: Record<Typology, number>;

  // Stationnement
  parkingPerDwelling: number;
  parkingPer100Commerce: number;
  parkingPer100Office: number;
  parkingStrategy: ParkingStrategy;
  maxBasementLevels: number;
}

export interface Assumptions {
  wallThickness: number;
  coreStairs: number;
  coreLift: number;
  landing: number;
  /** Ascenseur dès que le dernier niveau est à plus de N étages au-dessus du RDC. */
  liftFromLevel: number;
  hallArea: number;
  binRoom: number;
  bikeSmall: number;
  bikeLarge: number;
  bikeMin: number;
  bikeOfficeRatio: number;
  shabRatio: number;
  minFacadePerDwelling: number;
  typologyArea: Record<Typology, number>;
  spaceGross: number;
  rampArea: number;
  basementCore: number;
  rampEntryLoss: number;
  minRampWidth: number;
  minAtticArea: number;
  /** Fraction de l'emprise réellement excavable en sous-sol (le reste = structure/limites). */
  basementShare: number;
}

export interface EdgeInfo {
  index: number;
  a: Vec2;
  b: Vec2;
  length: number;
  kind: EdgeKind;
  /** Retrait appliqué (m) après prospect. */
  setback: number;
  party: boolean;
}

export interface FootprintEdge {
  a: Vec2;
  b: Vec2;
  length: number;
  /** party = mur mitoyen aveugle ; street = façade sur rue ; free = façade sur jardin/cour. */
  role: 'party' | 'street' | 'free';
}

export interface LevelPlan {
  id: string;
  label: string;
  kind: 'rdc' | 'etage' | 'attique';
  use: Use;
  z0: number;
  z1: number;
  footprintArea: number;
  /** Surface de plancher (hors parkings). */
  sdp: number;
  core: number;
  /** Services du rez-de-chaussée (hall, local vélos, local poubelles). */
  services: number;
  /** Surface utile affectée à l'usage (logement/commerce/bureaux) après circulations. */
  usable: number;
  dwellings: number;
  parkingSpaces: number;
}

export interface DwellingUnit {
  levelId: string;
  typology: Typology;
  area: number;
}

export type CheckStatus = 'ok' | 'warn' | 'error' | 'info';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ParkingResult {
  required: number;
  provided: number;
  surface: number;
  rdc: number;
  basement: number;
  basementLevels: number;
  basementPlate: number;
  capacityMax: number;
  feasibleBasement: boolean;
  surfaceArea: number;
}

export interface Indicators {
  parcelArea: number;
  footprintArea: number;
  coverage: number;
  openGround: number;
  sdpTotal: number;
  sdpHousing: number;
  sdpCommerce: number;
  sdpOffice: number;
  shab: number;
  far: number;
  height: number;
  levelsCount: number;
  dwellings: number;
  avgDwellingArea: number;
  hasLift: boolean;
  bikeRoom: number;
  facadeWidth: number;
  depth: number;
  glazedLength: number;
}

export interface Project {
  /** Repère local (m) centré sur le terrain. */
  origin: LonLat;
  parcelRing: Ring;
  parcelArea: number;
  parcelMinWidth: number;
  edges: EdgeInfo[];
  envelope: MultiPolygon;
  footprint: Ring | null;
  /** Entrée du parking (porte, allée, rampe), null sans parking en sous-sol ni en rez-de-chaussée. */
  parkingAccess: ParkingAccess | null;
  /** Où l'emprise a été placée : sur rue ou en fond de parcelle. */
  placement: 'rue' | 'fond';
  footprintEdges: FootprintEdge[];
  atticFootprint: Ring | null;
  levels: LevelPlan[];
  dwellings: DwellingUnit[];
  typologyCounts: Record<Typology, number>;
  parking: ParkingResult;
  indicators: Indicators;
  checks: Check[];
  /** Contraintes qui ont limité l'emprise. */
  limitedBy: string[];
  /** R+x maximal respectant la hauteur max (null si pas de limite). */
  maxLevelsForHeight: number | null;
}
