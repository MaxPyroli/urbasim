import { describe, expect, it } from 'vitest';
import { parsePlu, pluViewerUrl, regulationUrl } from '../src/engine';

// Formes réelles des réponses de l'API Carto « GPU » (Paris), allégées.
const C = { lon: 2.375, lat: 48.865 };
const zone = { features: [{ properties: { libelle: 'UG', libelong: 'Zone urbaine générale', typezone: 'U', partition: 'DU_75056', gpu_doc_id: 'ab895285a1be6ca045127a6bb628cfaa', nomfic: '75056_reglement_20260616.pdf', datvalid: '20260616' } }] };
const doc = { features: [{ properties: { name: '75056_PLU_20260616', du_type: 'PLU' } }] };
const surf = { features: [{ properties: { libelle: 'Hauteur plafond' } }, { properties: { libelle: 'Fuseau de protection du site de Paris' } }, { properties: { libelle: 'Hauteur plafond' } }] };

describe('lecture du Géoportail de l’Urbanisme', () => {
  it('zone, document, règlement et prescriptions dédoublonnées', () => {
    const p = parsePlu(zone, doc, [surf, { features: [] }, null], C);
    expect(p.docType).toBe('PLU');
    expect(p.zones).toEqual([
      {
        code: 'UG',
        name: 'Zone urbaine générale',
        type: 'U',
        regulationUrl: 'https://data.geopf.fr/annexes/gpu/documents/DU_75056/ab895285a1be6ca045127a6bb628cfaa/75056_reglement_20260616.pdf',
        validated: '16/06/2026',
      },
    ]);
    expect(p.prescriptions).toEqual(['Hauteur plafond', 'Fuseau de protection du site de Paris']);
    expect(p.viewerUrl).toBe(pluViewerUrl(C));
  });

  it('sans document publié (RNU) : aucune zone, sans erreur', () => {
    const p = parsePlu({ features: [] }, { features: [] }, [], C);
    expect(p.zones).toEqual([]);
    expect(p.docType).toBeNull();
  });

  it('réponses invalides ou partielles tolérées', () => {
    for (const bad of [null, undefined, {}, { features: 'x' }, { features: [null, {}, { properties: {} }] }]) {
      expect(parsePlu(bad, bad, [bad], C).zones).toEqual([]);
    }
  });

  it('pas de lien de règlement sans fichier PDF ; zones identiques fusionnées ; plusieurs zones gardées', () => {
    const z = { features: [
      { properties: { libelle: 'UB', typezone: 'U', partition: 'P', gpu_doc_id: 'd', nomfic: 'reglement.docx' } },
      { properties: { libelle: 'UB', typezone: 'U', partition: 'P', gpu_doc_id: 'd', nomfic: 'reglement.docx' } },
      { properties: { libelle: 'N', typezone: 'N' } },
    ] };
    const p = parsePlu(z, doc, [], C);
    expect(p.zones.map((x) => x.code)).toEqual(['UB', 'N']);
    expect(p.zones[0].regulationUrl).toBeNull();
    expect(p.zones[1].name).toBe('Zone naturelle et forestière');
  });

  it('les noms de fichier sont encodés dans l’adresse', () => {
    expect(regulationUrl('DU_1', 'abc', 'règle ment.pdf')).toContain('r%C3%A8gle%20ment.pdf');
  });
});
