import { computeProject } from './project';
import type { Assumptions, Criteria, Parcel, Project } from './types';
import { DEFAULT_ASSUMPTIONS } from './defaults';

export interface Scenario {
  levels: number;
  project: Project;
  /** Respecte-t-il toutes les contraintes dures (hauteur, emprise, densité, stationnement) ? */
  compliant: boolean;
}

/** Compare R+0 … R+max avec les autres critères inchangés. */
export function compareScenarios(
  parcel: Parcel,
  criteria: Criteria,
  maxLevels = 9,
  assumptions: Assumptions = DEFAULT_ASSUMPTIONS,
): Scenario[] {
  const out: Scenario[] = [];
  for (let x = 0; x <= maxLevels; x++) {
    const project = computeProject(parcel, { ...criteria, levels: x }, assumptions);
    const compliant = project.footprint !== null && project.checks.every((k) => k.status !== 'error');
    out.push({ levels: x, project, compliant });
  }
  return out;
}
