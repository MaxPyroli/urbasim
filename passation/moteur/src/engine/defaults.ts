import type { Assumptions, Criteria } from './types';

/**
 * Hypothèses de calcul de pré-faisabilité (ordres de grandeur courants en France).
 * À ajuster selon le PLU et le projet : ce ne sont pas des valeurs réglementaires.
 */
export const DEFAULT_ASSUMPTIONS: Assumptions = {
  wallThickness: 0.3,
  coreStairs: 11,
  coreLift: 4,
  landing: 3,
  liftFromLevel: 3,
  hallArea: 10,
  binRoom: 4,
  bikeSmall: 0.75,
  bikeLarge: 1.5,
  bikeMin: 3,
  bikeOfficeRatio: 0.015,
  shabRatio: 0.92,
  minFacadePerDwelling: 4,
  typologyArea: { T1: 28, T2: 45, T3: 65, T4: 85, T5: 105 },
  spaceGross: 25,
  rampArea: 45,
  basementCore: 18,
  rampEntryLoss: 15,
  minRampWidth: 5.5,
  minAtticArea: 15,
  basementShare: 0.95,
};

export const DEFAULT_CRITERIA: Criteria = {
  levels: 3,
  attic: false,
  atticSetback: 2,
  groundFloorHeight: 3.2,
  floorHeight: 2.9,
  maxHeight: null,

  setbackVoie: 0,
  setbackLateral: 0,
  setbackFond: 4,
  edgeSetbacks: {},
  prospectRatio: 0,
  maxDepth: 12,
  minWidth: 4.5,
  maxCoverage: null,
  minOpenGround: 0.2,
  maxFAR: null,
  footprintShape: 'adapte',
  placement: 'auto',

  groundFloorUse: 'logement',
  upperUse: 'logement',
  mix: { T1: 0.1, T2: 0.35, T3: 0.4, T4: 0.15, T5: 0 },

  parkingPerDwelling: 1,
  parkingPer100Commerce: 2,
  parkingPer100Office: 2,
  parkingStrategy: 'auto',
  maxBasementLevels: 2,
};
