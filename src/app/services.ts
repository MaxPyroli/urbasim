import { LocalProjection, cleanRing, distToSegment, type LonLat, type Ring } from '../engine';

export interface GeocodeResult {
  label: string;
  lon: number;
  lat: number;
}

/**
 * Recherche d'adresse. Les Google Photorealistic 3D Tiles ne peuvent être utilisées qu'avec le géocodeur Google :
 * quand une clé Google est active on passe donc par l'API Geocoding, sinon par Nominatim (OpenStreetMap).
 */
export async function geocode(query: string, googleKey: string | null): Promise<GeocodeResult[]> {
  if (googleKey) {
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&language=fr&key=${encodeURIComponent(googleKey)}`);
    const j = await r.json();
    if (j.status !== 'OK' && j.status !== 'ZERO_RESULTS') {
      throw new Error(`Géocodage Google : ${j.status}${j.error_message ? ` — ${j.error_message}` : ''} (l'API Geocoding doit être activée pour cette clé)`);
    }
    return (j.results ?? []).slice(0, 5).map((x: any) => ({ label: x.formatted_address, lon: x.geometry.location.lng, lat: x.geometry.location.lat }));
  }
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=fr&q=${encodeURIComponent(query)}`);
  if (!r.ok) throw new Error(`Recherche d'adresse indisponible (HTTP ${r.status})`);
  const j = await r.json();
  return j.map((x: any) => ({ label: x.display_name, lon: parseFloat(x.lon), lat: parseFloat(x.lat) }));
}

export interface CadastreParcel {
  ring: LonLat[];
  label: string;
  /** Arêtes sans parcelle voisine : voie publique ou espace non cadastré. */
  openEdges: number[];
}

const API = 'https://apicarto.ign.fr/api/cadastre/parcelle';

async function fetchFeatures(geom: object): Promise<any[]> {
  const r = await fetch(`${API}?geom=${encodeURIComponent(JSON.stringify(geom))}&_limit=200`);
  if (!r.ok) throw new Error(`API cadastre indisponible (HTTP ${r.status})`);
  const j = await r.json();
  return j.features ?? [];
}

const outerRing = (g: any): number[][] | null => (g?.type === 'Polygon' ? g.coordinates[0] : g?.type === 'MultiPolygon' ? g.coordinates[0]?.[0] : null);

/**
 * Parcelle cadastrale (Etalab/IGN, France) sous un point. On interroge aussi le voisinage : les arêtes qui ne touchent
 * aucune autre parcelle donnent sur le domaine public, ce qui permet de deviner la ou les façades sur rue.
 */
export async function fetchCadastreParcel(lon: number, lat: number): Promise<CadastreParcel | null> {
  const hits = await fetchFeatures({ type: 'Point', coordinates: [lon, lat] });
  if (hits.length === 0) return null;
  const f = hits[0];
  const coords = outerRing(f.geometry);
  if (!coords) return null;

  const proj = new LocalProjection(lon, lat);
  const raw = coords.slice(0, -1).map(([x, y]) => proj.toLocal({ lon: x, lat: y }));
  const simplified: Ring = cleanRing(raw, 0.08);
  const ring: LonLat[] = simplified.map((p) => proj.toLonLat(p));

  const p = f.properties ?? {};
  const label = [p.section && p.numero ? `${p.section} ${p.numero}` : '', p.nom_com ?? p.commune ?? '', p.contenance ? `${p.contenance} m²` : ''].filter(Boolean).join(' · ');

  // voisinage : emprise élargie de ~20 m
  const lons = ring.map((q) => q.lon);
  const lats = ring.map((q) => q.lat);
  const pad = 0.0002;
  const box = [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad];
  const openEdges: number[] = [];
  try {
    const around = await fetchFeatures({
      type: 'Polygon',
      coordinates: [[[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]]]],
    });
    const neighbours: Ring[] = [];
    for (const n of around) {
      const c = outerRing(n.geometry);
      if (!c) continue;
      const nr = c.slice(0, -1).map(([x, y]) => proj.toLocal({ lon: x, lat: y }));
      // on écarte la parcelle elle-même
      const same = n.id !== undefined && f.id !== undefined ? n.id === f.id : n.properties?.numero === p.numero && n.properties?.section === p.section;
      if (!same) neighbours.push(nr);
    }
    simplified.forEach((a, i) => {
      const b = simplified[(i + 1) % simplified.length];
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const shared = neighbours.some((nr) => nr.some((q, k) => distToSegment(mid, q, nr[(k + 1) % nr.length]) < 0.6));
      if (!shared) openEdges.push(i);
    });
  } catch {
    /* sans voisinage on laisse l'utilisateur choisir la rue */
  }
  return { ring, label, openEdges };
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

/**
 * Voies OpenStreetMap autour d'un point (Overpass), en polylignes lon/lat. Sert uniquement à deviner le côté rue d'un
 * terrain dessiné à la main ; en cas d'échec on retombe sur une heuristique géométrique.
 */
export async function fetchNearbyRoads(lon: number, lat: number, radius = 60): Promise<LonLat[][]> {
  const q = `[out:json][timeout:12];way(around:${radius},${lat},${lon})["highway"]["highway"!~"^(footway|path|steps|cycleway|track|bridleway|corridor|proposed|construction|elevator)$"];out geom;`;
  let lastError: unknown = null;
  for (const url of OVERPASS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch(url, { method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
      const j = await r.json();
      return (j.elements ?? [])
        .filter((e: any) => Array.isArray(e.geometry) && e.geometry.length >= 2)
        .map((e: any) => e.geometry.map((g: any) => ({ lon: g.lon, lat: g.lat })));
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Voies OpenStreetMap indisponibles');
}
