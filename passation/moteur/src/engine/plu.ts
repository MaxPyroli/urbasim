import type { LonLat } from './types';

/** Document d'urbanisme et zonage au droit d'un terrain, d'après le Géoportail de l'Urbanisme (GPU). */
export interface PluZone {
  /** Code de la zone, ex. « UG ». */
  code: string;
  /** Libellé long, ex. « Zone urbaine générale ». */
  name: string;
  /** U, AU, A, N… */
  type: string;
  /** Règlement écrit (PDF) de la zone, s'il est publié. */
  regulationUrl: string | null;
  /** Date de validation du document, JJ/MM/AAAA. */
  validated: string | null;
}

export interface PluInfo {
  /** PLU, PLUi, POS, CC… ; null si le GPU ne publie aucun document ici (RNU). */
  docType: string | null;
  docName: string | null;
  zones: PluZone[];
  /** Prescriptions graphiques (hauteur plafond, alignement, emplacement réservé…) dédoublonnées par libellé. */
  prescriptions: string[];
  viewerUrl: string;
}

const TYPE_NAMES: Record<string, string> = { U: 'Zone urbaine', AU: 'Zone à urbaniser', A: 'Zone agricole', N: 'Zone naturelle et forestière' };
export const pluTypeName = (type: string): string => TYPE_NAMES[type] ?? `Zone ${type}`;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const features = (j: unknown): Record<string, unknown>[] => {
  const f = (j as { features?: unknown })?.features;
  return Array.isArray(f) ? f.map((x) => ((x as { properties?: unknown })?.properties ?? {}) as Record<string, unknown>) : [];
};

/** Date AAAAMMJJ → JJ/MM/AAAA. */
function frDate(d: unknown): string | null {
  const s = typeof d === 'string' ? d : typeof d === 'number' ? String(d) : '';
  return /^\d{8}$/.test(s) ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : null;
}

/** Adresse du règlement : fichier publié par la Géoplateforme sous le dossier du document. */
export function regulationUrl(partition: string, docId: string, file: string): string {
  return `https://data.geopf.fr/annexes/gpu/documents/${encodeURIComponent(partition)}/${encodeURIComponent(docId)}/${encodeURIComponent(file)}`;
}

export function pluViewerUrl(c: LonLat): string {
  return `https://www.geoportail-urbanisme.gouv.fr/map/#tile=1&lon=${c.lon.toFixed(5)}&lat=${c.lat.toFixed(5)}&zoom=18`;
}

/** Assemble les réponses de l'API Carto « GPU » (zone-urba, document, prescriptions) ; tolère les réponses vides ou partielles. */
export function parsePlu(zoneJson: unknown, docJson: unknown, prescriptionJsons: unknown[], center: LonLat): PluInfo {
  const seen = new Set<string>();
  const zones: PluZone[] = [];
  for (const p of features(zoneJson)) {
    const code = str(p.libelle);
    if (!code) continue;
    const partition = str(p.partition);
    const docId = str(p.gpu_doc_id);
    const file = str(p.nomfic);
    const key = `${code}|${docId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    zones.push({
      code,
      name: str(p.libelong) ?? pluTypeName(str(p.typezone) ?? ''),
      type: str(p.typezone) ?? '',
      regulationUrl: partition && docId && file && /\.pdf$/i.test(file) ? regulationUrl(partition, docId, file) : null,
      validated: frDate(p.datvalid),
    });
  }
  const doc = features(docJson)[0];
  const prescriptions = [...new Set(prescriptionJsons.flatMap((j) => features(j).map((p) => str(p.libelle))).filter((x): x is string => x !== null))];
  return { docType: str(doc?.du_type), docName: str(doc?.name), zones, prescriptions, viewerUrl: pluViewerUrl(center) };
}
