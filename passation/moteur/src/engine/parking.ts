import type { Assumptions, Criteria, LevelPlan, ParkingResult } from './types';

export function requiredParking(c: Criteria, levels: LevelPlan[], dwellings: number): number {
  const sdp = (use: LevelPlan['use']) => levels.filter((l) => l.use === use).reduce((s, l) => s + l.sdp, 0);
  return (
    Math.ceil(c.parkingPerDwelling * dwellings - 1e-9) +
    Math.ceil((c.parkingPer100Commerce * sdp('commerce')) / 100 - 1e-9) +
    Math.ceil((c.parkingPer100Office * sdp('bureaux')) / 100 - 1e-9)
  );
}

/** Places possibles sur `k` niveaux de sous-sol de surface `plate` (rampe sur chaque niveau sauf le dernier). */
export function basementCapacity(k: number, plate: number, a: Assumptions): number {
  let total = 0;
  for (let j = 1; j <= k; j++) {
    const usable = plate - a.basementCore - (j < k ? a.rampArea : 0);
    total += Math.max(0, Math.floor(usable / a.spaceGross));
  }
  return total;
}

export interface ParkingInput {
  required: number;
  criteria: Criteria;
  assumptions: Assumptions;
  parcelArea: number;
  parcelMinWidth: number;
  footprintArea: number;
  /** Capacité du rez-de-chaussée si affecté au parking (stratégie « rdc »). */
  groundCapacity: number;
}

export function computeParking(input: ParkingInput): ParkingResult {
  const { required, criteria: c, assumptions: a, parcelArea, parcelMinWidth, footprintArea, groundCapacity } = input;
  const strategy = c.parkingStrategy;
  const result: ParkingResult = {
    required,
    provided: 0,
    surface: 0,
    rdc: 0,
    basement: 0,
    basementLevels: 0,
    basementPlate: 0,
    capacityMax: 0,
    feasibleBasement: false,
    surfaceArea: 0,
  };
  if (strategy === 'aucun') return result;

  let remaining = required;

  if (strategy === 'rdc') {
    result.rdc = Math.min(remaining, groundCapacity);
    result.capacityMax = groundCapacity;
    remaining -= result.rdc;
    result.provided = result.rdc;
    return result;
  }

  const freeSurface = Math.max(0, parcelArea - footprintArea - c.minOpenGround * parcelArea);
  const surfaceCapacity = Math.floor(freeSurface / a.spaceGross);
  if (strategy === 'auto' || strategy === 'surface') {
    result.surface = Math.min(remaining, surfaceCapacity);
    result.surfaceArea = result.surface * a.spaceGross;
    remaining -= result.surface;
    result.capacityMax += surfaceCapacity;
  }

  if (strategy === 'auto' || strategy === 'sous-sol') {
    const plateMax = Math.max(footprintArea, parcelArea * (1 - c.minOpenGround)) * a.basementShare;
    result.feasibleBasement = parcelMinWidth >= a.minRampWidth && c.maxBasementLevels > 0;
    if (result.feasibleBasement) {
      const kMax = c.maxBasementLevels;
      result.capacityMax += basementCapacity(kMax, plateMax, a);
      if (remaining > 0) {
        let k = 1;
        while (k < kMax && basementCapacity(k, plateMax, a) < remaining) k++;
        if (basementCapacity(k, plateMax, a) >= remaining) {
          // surface minimale de plateau qui suffit, pour préserver la pleine terre
          let lo = 0;
          let hi = plateMax;
          for (let it = 0; it < 30; it++) {
            const mid = (lo + hi) / 2;
            if (basementCapacity(k, mid, a) >= remaining) hi = mid;
            else lo = mid;
          }
          result.basementPlate = hi;
          result.basement = remaining;
        } else {
          result.basementPlate = plateMax;
          result.basement = basementCapacity(k, plateMax, a);
        }
        result.basementLevels = k;
        remaining -= result.basement;
      }
    }
  }
  result.provided = result.surface + result.basement;
  return result;
}
