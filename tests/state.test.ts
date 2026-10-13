import { describe, expect, it } from 'vitest';
import { defaultState, sanitize } from '../src/app/state';

// Lecture de l'état enregistré (localStorage) ou partagé (lien) : tout ce qui est invalide est ignoré, jamais de plantage.

const ring = [
  { lon: 2.375, lat: 48.865 },
  { lon: 2.3751, lat: 48.865 },
  { lon: 2.3751, lat: 48.8653 },
];

describe('lecture de l’état enregistré ou partagé', () => {
  it('une entrée qui n’est pas un objet donne l’état par défaut', () => {
    for (const bad of [null, undefined, 'x', 12, true]) expect(sanitize(bad)).toEqual(defaultState());
  });

  it('un état enregistré avant l’ajout du bâti voisin (sans « context ») le garde affiché, comme par défaut', () => {
    expect(defaultState().context).toBe(true);
    expect(sanitize({ shadows: true, sunHour: 9 }).context).toBe(true);
  });

  it('un choix explicite est conservé, une valeur invalide est ignorée', () => {
    expect(sanitize({ context: false }).context).toBe(false);
    expect(sanitize({ context: true }).context).toBe(true);
    expect(sanitize({ context: 'non' }).context).toBe(true);
    expect(sanitize({ context: 0 }).context).toBe(true);
  });

  it('un terrain valide est repris tel quel, avec ses côtés rue', () => {
    const s = sanitize({ parcel: { ring, streetEdges: [1] }, parcelLabel: 'AS 0043' });
    expect(s.parcel?.ring).toEqual(ring);
    expect(s.parcel?.streetEdges).toEqual([1]);
    expect(s.parcelLabel).toBe('AS 0043');
  });

  it('un terrain invalide (moins de 3 points, coordonnées non numériques) est ignoré', () => {
    expect(sanitize({ parcel: { ring: ring.slice(0, 2), streetEdges: [0] } }).parcel).toBeNull();
    expect(sanitize({ parcel: { ring: [...ring.slice(0, 2), { lon: 'x', lat: 1 }], streetEdges: [0] } }).parcel).toBeNull();
    expect(sanitize({ parcel: { ring: [...ring.slice(0, 2), { lon: NaN, lat: 1 }], streetEdges: [0] } }).parcel).toBeNull();
    expect(sanitize({ parcel: 'terrain' }).parcel).toBeNull();
  });

  it('les côtés rue hors limites ou non entiers sont écartés ; sans aucun côté valable, le côté 0', () => {
    expect(sanitize({ parcel: { ring, streetEdges: [0, 2, 3, -1, 1.5] } }).parcel?.streetEdges).toEqual([0, 2]);
    expect(sanitize({ parcel: { ring, streetEdges: [7, -2] } }).parcel?.streetEdges).toEqual([0]);
    expect(sanitize({ parcel: { ring } }).parcel?.streetEdges).toEqual([0]);
  });

  it('un fond de carte inconnu retombe sur OpenStreetMap, un fond valide est gardé', () => {
    expect(sanitize({ baseLayer: 'carte-secrete' }).baseLayer).toBe('osm');
    expect(sanitize({ baseLayer: 'ortho' }).baseLayer).toBe('ortho');
  });

  it('une implantation inconnue (lien ancien ou corrompu) retombe sur le défaut, une valeur valide est gardée', () => {
    expect(sanitize({ criteria: { placement: 'fond' } }).criteria.placement).toBe('fond');
    expect(sanitize({ criteria: { placement: 'ailleurs' } }).criteria.placement).toBe('auto');
    expect(sanitize({ criteria: { levels: 4 } }).criteria.placement).toBe('auto');
  });
});
