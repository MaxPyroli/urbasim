import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchNearbyBuildings } from '../src/app/services';

// Le client du WFS de l'IGN est testé avec un faux `fetch` et des minuteries simulées : requête, pagination, nouvelles tentatives.

const feature = (n: number) => {
  const x = 2.3 + n * 1e-5;
  return { id: `batiment.${n}`, properties: { hauteur: 10 }, geometry: { type: 'MultiPolygon', coordinates: [[[[x, 48.86], [x + 5e-6, 48.86], [x + 5e-6, 48.8601], [x, 48.8601], [x, 48.86]]]] } };
};
const page = (count: number, from = 0) => ({ type: 'FeatureCollection', features: Array.from({ length: count }, (_, i) => feature(from + i)) });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const fail = (status: number) => new Response('', { status });

function mockFetch(responses: (Response | Error)[]) {
  const queue = [...responses];
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error('réponse non prévue par le test');
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const urlOf = (fn: ReturnType<typeof mockFetch>, call: number) => new URL(fn.mock.calls[call][0]);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('requête au WFS de la Géoplateforme', () => {
  it('demande la couche des bâtiments, triée, avec la zone en lon,lat (CRS84) autour du point', async () => {
    const fn = mockFetch([ok(page(3))]);
    const res = await fetchNearbyBuildings(2.375, 48.865, 170);
    expect(res.buildings).toHaveLength(3);
    const url = urlOf(fn, 0);
    expect(url.origin + url.pathname).toBe('https://data.geopf.fr/wfs/ows');
    expect(url.searchParams.get('TYPENAMES')).toBe('BDTOPO_V3:batiment');
    expect(url.searchParams.get('OUTPUTFORMAT')).toBe('application/json');
    expect(url.searchParams.get('SORTBY')).toBe('cleabs');
    expect(url.searchParams.get('COUNT')).toBe('1000');
    expect(url.searchParams.get('STARTINDEX')).toBe('0');
    const [x0, y0, x1, y1, crs] = url.searchParams.get('BBOX')!.split(',');
    expect(crs).toBe('urn:ogc:def:crs:OGC:1.3:CRS84');
    // ±170 m : ≈ ±0,00232° en longitude, ≈ ±0,00154° en latitude. Un ordre lat,lon donnerait 48,86… en premier.
    expect(+x0).toBeCloseTo(2.375 - 0.00232, 4);
    expect(+x1).toBeCloseTo(2.375 + 0.00232, 4);
    expect(+y0).toBeCloseTo(48.865 - 0.00154, 4);
    expect(+y1).toBeCloseTo(48.865 + 0.00154, 4);
  });

  it('ne demande que les attributs utiles, dont la date de modification (exigée par la mention de licence)', async () => {
    const fn = mockFetch([ok(page(1))]);
    await fetchNearbyBuildings(2.375, 48.865);
    const props = urlOf(fn, 0).searchParams.get('PROPERTYNAME')!.split(',');
    expect(props).toEqual(expect.arrayContaining(['geometrie', 'hauteur', 'nombre_d_etages', 'date_modification']));
  });

  it('une réponse vide ou sans liste d’objets donne zéro bâtiment, sans erreur', async () => {
    mockFetch([ok({ type: 'FeatureCollection', features: [] })]);
    expect(await fetchNearbyBuildings(2.375, 48.865)).toEqual({ buildings: [], truncated: false });
    mockFetch([ok({})]);
    expect(await fetchNearbyBuildings(2.375, 48.865)).toEqual({ buildings: [], truncated: false });
  });
});

describe('pagination', () => {
  it('lit les pages suivantes tant que la page est pleine, et s’arrête à la première page incomplète', async () => {
    const fn = mockFetch([ok(page(1000)), ok(page(1000, 1000)), ok(page(5, 2000))]);
    const res = await fetchNearbyBuildings(2.375, 48.865);
    expect(fn).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((i) => urlOf(fn, i).searchParams.get('STARTINDEX'))).toEqual(['0', '1000', '2000']);
    expect(res.buildings).toHaveLength(2005);
    expect(res.truncated).toBe(false);
  });

  it('une dernière page de 999 objets n’est pas une troncature', async () => {
    mockFetch([ok(page(1000)), ok(page(1000, 1000)), ok(page(1000, 2000)), ok(page(999, 3000))]);
    const res = await fetchNearbyBuildings(2.375, 48.865);
    expect(res.buildings).toHaveLength(3999);
    expect(res.truncated).toBe(false);
  });

  it('quatre pages pleines : on s’arrête là et on signale que la zone est tronquée', async () => {
    const fn = mockFetch([ok(page(1000)), ok(page(1000, 1000)), ok(page(1000, 2000)), ok(page(1000, 3000)), ok(page(1000, 4000))]);
    const res = await fetchNearbyBuildings(2.375, 48.865);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(res.buildings).toHaveLength(4000);
    expect(res.truncated).toBe(true);
  });
});

describe('nouvelles tentatives', () => {
  it('erreur serveur : une nouvelle tentative après 1 s, puis une autre après 5,5 s', async () => {
    const fn = mockFetch([fail(503), fail(503), ok(page(2))]);
    const p = fetchNearbyBuildings(2.375, 48.865);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5499);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);
    expect((await p).buildings).toHaveLength(2);
  });

  it('HTTP 429 (limite de débit) : on réessaie', async () => {
    const fn = mockFetch([fail(429), ok(page(1))]);
    const p = fetchNearbyBuildings(2.375, 48.865);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).buildings).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('coupure réseau, puis réponse tronquée (JSON invalide) : on réessaie à chaque fois', async () => {
    const fn = mockFetch([new TypeError('Failed to fetch'), new Response('{"features":[', { status: 200 }), ok(page(4))]);
    const p = fetchNearbyBuildings(2.375, 48.865);
    await vi.advanceTimersByTimeAsync(1000 + 5500);
    expect((await p).buildings).toHaveLength(4);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('trois échecs de suite : l’erreur est remontée', async () => {
    const fn = mockFetch([fail(503), fail(502), fail(503)]);
    const p = fetchNearbyBuildings(2.375, 48.865);
    const done = expect(p).rejects.toThrow('HTTP 503');
    await vi.advanceTimersByTimeAsync(1000 + 5500 + 10);
    await done;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('erreur 4xx hors 429 : définitive, aucune nouvelle tentative, aucune minuterie qui traîne', async () => {
    const fn = mockFetch([fail(404), ok(page(1))]);
    await expect(fetchNearbyBuildings(2.375, 48.865)).rejects.toThrow('HTTP 404');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('un échec sur la deuxième page remonte l’erreur au lieu d’afficher une zone à moitié chargée', async () => {
    mockFetch([ok(page(1000)), fail(404)]);
    await expect(fetchNearbyBuildings(2.375, 48.865)).rejects.toThrow('HTTP 404');
  });

  it('une requête déjà annulée n’envoie rien', async () => {
    const fn = mockFetch([ok(page(1))]);
    const ctl = new AbortController();
    ctl.abort();
    await expect(fetchNearbyBuildings(2.375, 48.865, 170, ctl.signal)).rejects.toThrow('Requête annulée');
    expect(fn).not.toHaveBeenCalled();
  });
});
