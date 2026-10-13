import * as Cesium from 'cesium';
import { LocalProjection, centroid, classifyFootprintEdges, multiArea, type Criteria, type FootprintEdge, type Parcel, type Project, type Ring } from '../engine';
import type { MapView } from './mapview';
import { facadeTexture, type FacadeKind } from './textures';

const BAY = 3.2; // largeur de travée visée (m)
const C = Cesium;
const css = (hex: string, a = 1) => C.Color.fromCssColorString(hex).withAlpha(a);

/** Dessine terrain, retraits et bâtiment dans la scène Cesium. */
export class SceneRenderer {
  private readonly ds = new C.CustomDataSource('urbasim');

  constructor(private readonly map: MapView) {
    map.viewer.dataSources.add(this.ds);
  }

  clear(): void {
    this.ds.entities.removeAll();
  }

  render(project: Project | null, parcel: Parcel | null, criteria: Criteria, groundOffset: number, shadows: boolean): void {
    const e = this.ds.entities;
    e.suspendEvents();
    e.removeAll();
    try {
      if (project && parcel && parcel.ring.length >= 3) this.draw(project, parcel, criteria, this.map.groundBase + groundOffset, shadows);
    } finally {
      e.resumeEvents();
    }
  }

  private draw(p: Project, parcel: Parcel, c: Criteria, base: number, shadows: boolean): void {
    const proj = new LocalProjection(p.origin.lon, p.origin.lat);
    const ll = (v: [number, number]) => proj.toLonLat(v);
    const flat = (ring: Ring, h: number) => ring.flatMap((v) => {
      const q = ll(v);
      return [q.lon, q.lat, h];
    });
    const deg = (ring: Ring) => ring.flatMap((v) => {
      const q = ll(v);
      return [q.lon, q.lat];
    });
    const loop = (ring: Ring, h: number) => C.Cartesian3.fromDegreesArrayHeights(flat([...ring, ring[0]], h));
    const mode = shadows ? C.ShadowMode.ENABLED : C.ShadowMode.DISABLED;
    const e = this.ds.entities;

    // --- terrain
    e.add({
      polygon: { hierarchy: C.Cartesian3.fromDegreesArray(deg(p.parcelRing)), height: base + 0.05, material: css('#ffd166', 0.16), perPositionHeight: false },
    });
    e.add({
      polyline: { positions: loop(p.parcelRing, base + 0.2), width: 3, material: css('#ffb703'), depthFailMaterial: css('#ffb703', 0.8) },
    });
    p.edges.forEach((edge, i) => {
      const isStreet = parcel.streetEdges.includes(i);
      const a = ll(edge.a);
      const b = ll(edge.b);
      if (isStreet) {
        e.add({
          polyline: {
            positions: C.Cartesian3.fromDegreesArrayHeights([a.lon, a.lat, base + 0.3, b.lon, b.lat, base + 0.3]),
            width: 7,
            material: css('#e63946'),
            depthFailMaterial: css('#e63946', 0.8),
          },
        });
      }
      const mid = ll([(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2]);
      e.add({
        id: `edge-${i}`,
        position: C.Cartesian3.fromDegrees(mid.lon, mid.lat, base + 0.6),
        label: {
          text: isStreet ? `${i + 1} · rue` : String(i + 1),
          font: '600 12px system-ui, sans-serif',
          fillColor: C.Color.WHITE,
          showBackground: true,
          backgroundColor: isStreet ? css('#e63946', 0.95) : css('#1f2937', 0.82),
          backgroundPadding: new C.Cartesian2(7, 4),
          // au-dessus du côté : le point milieu d'ajout de sommet occupe le milieu exact
          verticalOrigin: C.VerticalOrigin.BOTTOM,
          pixelOffset: new C.Cartesian2(0, -16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new C.DistanceDisplayCondition(0, 1200),
        },
      });
    });

    // --- zone constructible (visible seulement si des retraits la réduisent)
    if (multiArea(p.envelope) < p.parcelArea - 0.5) {
      for (const poly of p.envelope) {
        const holes = poly.slice(1).map((h) => new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(deg(h))));
        e.add({
          polygon: {
            hierarchy: new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(deg(poly[0])), holes),
            height: base + 0.1,
            material: css('#06d6a0', 0.2),
            perPositionHeight: false,
          },
        });
        e.add({ polyline: { positions: loop(poly[0], base + 0.25), width: 2, material: css('#06d6a0'), depthFailMaterial: css('#06d6a0', 0.7) } });
      }
    }

    if (!p.footprint) return;

    // --- bâtiment
    const groundUse = p.levels[0]?.use ?? 'logement';
    const upperKind: FacadeKind = c.upperUse === 'bureaux' ? 'bureaux' : 'logement';
    const mainTop = c.groundFloorHeight + c.levels * c.floorHeight;

    const wall = (edge: FootprintEdge, z0: number, z1: number, kind: FacadeKind, floors: number) => {
      if (z1 - z0 < 0.05) return;
      const a = ll(edge.a);
      const b = ll(edge.b);
      const nx = Math.max(1, Math.round(edge.length / BAY));
      e.add({
        wall: {
          positions: C.Cartesian3.fromDegreesArray([a.lon, a.lat, b.lon, b.lat]),
          minimumHeights: [base + z0, base + z0],
          maximumHeights: [base + z1, base + z1],
          material: new C.ImageMaterialProperty({ image: facadeTexture(kind), repeat: new C.Cartesian2(nx, Math.max(1, floors)), transparent: false }),
          shadows: mode,
        },
      });
    };

    for (const edge of p.footprintEdges) {
      const party = edge.role === 'party';
      const groundKind: FacadeKind = party ? 'mitoyen' : groundUse === 'commerce' && edge.role === 'street' ? 'commerce' : groundUse === 'parking' && edge.role === 'street' ? 'parking' : groundUse === 'bureaux' ? 'bureaux' : groundUse === 'parking' ? 'mitoyen' : 'logement';
      wall(edge, 0, c.groundFloorHeight, groundKind, 1);
      if (c.levels > 0) wall(edge, c.groundFloorHeight, mainTop, party ? 'mitoyen' : upperKind, c.levels);
    }
    e.add({
      polygon: {
        hierarchy: C.Cartesian3.fromDegreesArray(deg(p.footprint)),
        height: base + mainTop,
        material: css('#6b7075'),
        perPositionHeight: false,
        shadows: mode,
      },
    });
    e.add({ polyline: { positions: loop(p.footprint, base + mainTop + 0.05), width: 2, material: css('#3c4043') } });

    let top = mainTop;
    if (p.atticFootprint) {
      top = p.indicators.height;
      for (const edge of classifyFootprintEdges(p.atticFootprint, p.edges)) {
        wall(edge, mainTop, top, edge.role === 'party' ? 'mitoyen' : 'attique', 1);
      }
      e.add({
        polygon: {
          hierarchy: C.Cartesian3.fromDegreesArray(deg(p.atticFootprint)),
          height: base + top,
          material: css('#7b858c'),
          perPositionHeight: false,
          shadows: mode,
        },
      });
    }

    // --- étiquette
    const cen = ll(centroid(p.footprint));
    const i = p.indicators;
    const parts = [`R+${c.levels}${c.attic ? ' + attique' : ''}`, `${i.dwellings} logt${i.dwellings > 1 ? 's' : ''}`, `${i.height.toFixed(1).replace('.', ',')} m`];
    e.add({
      position: C.Cartesian3.fromDegrees(cen.lon, cen.lat, base + top + 3),
      label: {
        text: parts.join(' · '),
        font: '600 14px system-ui, sans-serif',
        fillColor: C.Color.WHITE,
        showBackground: true,
        backgroundColor: css('#15202b', 0.85),
        backgroundPadding: new C.Cartesian2(9, 6),
        verticalOrigin: C.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new C.DistanceDisplayCondition(0, 1500),
      },
    });
  }
}
