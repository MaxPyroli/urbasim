import { LocalProjection, centroid } from './geometry';
import type { Criteria, LonLat, MultiPolygon, Project, Ring, Vec2 } from './types';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n1 = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

/** KML attend aabbggrr. */
function kmlColor(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0');
  return `${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

function scaleAround(ring: Ring, k: number): Ring {
  const c = centroid(ring);
  return ring.map(([x, y]) => [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k] as Vec2);
}

function coordString(proj: LocalProjection, ring: Ring, alt: number): string {
  const pts = [...ring, ring[0]].map((p) => {
    const ll = proj.toLonLat(p);
    return `${ll.lon.toFixed(8)},${ll.lat.toFixed(8)},${alt.toFixed(2)}`;
  });
  return pts.join(' ');
}

function polygonKml(proj: LocalProjection, outer: Ring, holes: Ring[], alt: number, mode: 'clampToGround' | 'relativeToGround', extrude: boolean): string {
  const inner = holes.map((h) => `<innerBoundaryIs><LinearRing><coordinates>${coordString(proj, h, alt)}</coordinates></LinearRing></innerBoundaryIs>`).join('');
  return `<Polygon>${extrude ? '<extrude>1</extrude>' : ''}<altitudeMode>${mode}</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${coordString(proj, outer, alt)}</coordinates></LinearRing></outerBoundaryIs>${inner}</Polygon>`;
}

function description(p: Project, c: Criteria): string {
  const i = p.indicators;
  const rows: [string, string][] = [
    ['Niveaux', `R+${c.levels}${c.attic ? ' + attique' : ''} (${n1(i.height)} m)`],
    ['Emprise au sol', `${n1(i.footprintArea)} m² (${n1(i.coverage * 100)} %)`],
    ['Surface de plancher', `${n1(i.sdpTotal)} m²`],
    ['Logements', `${i.dwellings} (surface habitable ${n1(i.shab)} m²)`],
    ['Stationnement', `${p.parking.provided} / ${p.parking.required} places`],
    ['Pleine terre', `${n1(i.openGround * 100)} %`],
  ];
  const table = rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('');
  return `<![CDATA[<table>${table}</table><p><i>Pré-faisabilité indicative générée par Urbasim.</i></p>]]>`;
}

/** KML ouvrable dans Google Earth (Web, Pro, mobile) : terrain, zone constructible et volumes extrudés. */
export function buildKml(p: Project, c: Criteria, name = 'Projet Urbasim'): string {
  const proj = new LocalProjection(p.origin.lon, p.origin.lat);
  const i = p.indicators;
  const groundH = c.groundFloorHeight;
  const mainTop = groundH + c.levels * c.floorHeight;
  const parts: string[] = [];

  parts.push(`<Placemark><name>Terrain</name><styleUrl>#parcel</styleUrl>${polygonKml(proj, p.parcelRing, [], 0, 'clampToGround', false)}</Placemark>`);

  const env = (p.envelope as MultiPolygon)
    .map((poly) => `<Placemark><name>Zone constructible</name><styleUrl>#envelope</styleUrl>${polygonKml(proj, poly[0], poly.slice(1), 0, 'clampToGround', false)}</Placemark>`)
    .join('');
  parts.push(`<Folder><name>Zone constructible (après retraits)</name><visibility>0</visibility>${env}</Folder>`);

  if (p.footprint) {
    const volumes: string[] = [];
    volumes.push(
      `<Placemark><name>Rez-de-chaussée</name><styleUrl>#ground</styleUrl>${polygonKml(proj, scaleAround(p.footprint, 1.003), [], groundH, 'relativeToGround', true)}</Placemark>`,
    );
    volumes.push(
      `<Placemark><name>${esc(name)}</name><description>${description(p, c)}</description><styleUrl>#building</styleUrl>${polygonKml(proj, p.footprint, [], mainTop, 'relativeToGround', true)}</Placemark>`,
    );
    if (p.atticFootprint) {
      volumes.push(
        `<Placemark><name>Attique</name><styleUrl>#attic</styleUrl>${polygonKml(proj, p.atticFootprint, [], i.height, 'relativeToGround', true)}</Placemark>`,
      );
    }
    parts.push(`<Folder><name>Bâtiment</name><open>1</open>${volumes.join('')}</Folder>`);
  }

  const style = (id: string, fill: string, fillA: number, line: string, lineW: number, extra = '') =>
    `<Style id="${id}"><PolyStyle><color>${kmlColor(fill, fillA)}</color>${extra}</PolyStyle><LineStyle><color>${kmlColor(line, 1)}</color><width>${lineW}</width></LineStyle></Style>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>
${style('parcel', '#ffd166', 0.25, '#ffb703', 3)}
${style('envelope', '#06d6a0', 0.3, '#06d6a0', 2)}
${style('ground', '#b08968', 1, '#7f5539', 1)}
${style('building', '#e9e2d0', 1, '#8d8570', 1)}
${style('attic', '#c9d3d8', 1, '#7a8a91', 1)}
${parts.join('\n')}
</Document></kml>`;
}

export function buildGeoJson(p: Project, c: Criteria): string {
  const proj = new LocalProjection(p.origin.lon, p.origin.lat);
  const ll = (ring: Ring): number[][] => [...ring, ring[0]].map((v) => {
    const q = proj.toLonLat(v);
    return [q.lon, q.lat];
  });
  const feature = (kind: string, geometry: object, properties: object = {}) => ({
    type: 'Feature',
    properties: { kind, ...properties },
    geometry,
  });
  const features = [
    feature('terrain', { type: 'Polygon', coordinates: [ll(p.parcelRing)] }, { surface_m2: p.parcelArea }),
    ...p.envelope.map((poly) => feature('zone_constructible', { type: 'Polygon', coordinates: poly.map(ll) })),
  ];
  if (p.footprint) {
    features.push(
      feature('emprise', { type: 'Polygon', coordinates: [ll(p.footprint)] }, { hauteur_m: p.indicators.height, niveaux: p.indicators.levelsCount, surface_m2: p.indicators.footprintArea }),
    );
  }
  if (p.parkingAccess) {
    const ac = p.parkingAccess;
    features.push(feature('entree_parking', { type: 'LineString', coordinates: ac.door.map((v) => ll([v])[0]) }, { type: ac.kind, niveaux_sous_sol: ac.levels }));
    if (ac.drive) features.push(feature('allee_parking', { type: 'Polygon', coordinates: [ll(ac.drive)] }));
  }
  if (p.atticFootprint) features.push(feature('attique', { type: 'Polygon', coordinates: [ll(p.atticFootprint)] }));
  return JSON.stringify({ type: 'FeatureCollection', features, urbasim: { criteres: c, indicateurs: p.indicators, stationnement: p.parking, logements: p.typologyCounts } }, null, 2);
}

/** Extrait le premier anneau extérieur d'un GeoJSON (Feature, FeatureCollection, Polygon ou MultiPolygon). */
export function parseParcelGeoJson(text: string): LonLat[] | null {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const geom = (g: any): number[][] | null => {
    if (!g) return null;
    if (g.type === 'Polygon') return g.coordinates[0];
    if (g.type === 'MultiPolygon') return g.coordinates[0]?.[0] ?? null;
    if (g.type === 'Feature') return geom(g.geometry);
    if (g.type === 'FeatureCollection') {
      for (const f of g.features ?? []) {
        const r = geom(f);
        if (r) return r;
      }
    }
    return null;
  };
  const coords = geom(data);
  if (!coords || coords.length < 4) return null;
  const pts = coords.slice(0, -1).map(([lon, lat]) => ({ lon, lat }));
  return pts.length >= 3 && pts.every((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat)) ? pts : null;
}
