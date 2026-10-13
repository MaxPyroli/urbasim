import * as Cesium from 'cesium';
import { buildingsCredit, type ContextBuilding, type LonLat } from '../engine';
import type { MapView } from './mapview';

const C = Cesium;

const STONE = C.Color.fromCssColorString('#d6d1c4');
/** Hauteur estimée (absente de la donnée) : teinte plus claire pour la distinguer. */
const STONE_ESTIMATED = C.Color.fromCssColorString('#e9e5db');

/**
 * Bâtiments voisins en volumes 3D : une seule Primitive Cesium avec une instance par bâtiment.
 * Un appel de dessin pour des centaines de bâtiments, géométrie construite hors du fil principal.
 */
export class ContextRenderer {
  private prim: Cesium.Primitive | null = null;
  private ids: string[] = [];
  private hidden = new Set<string>();
  private visible = true;
  private waiting: (() => void) | null = null;
  /** Mention actuellement affichée à l'écran (Licence Ouverte 2.0 : source + date de mise à jour). */
  private credit: Cesium.Credit | null = null;
  creditText: string | null = null;

  constructor(private readonly map: MapView) {}

  get count(): number {
    return this.ids.length;
  }

  /** Remplace tous les bâtiments affichés. `hidden` : ceux situés sur le terrain étudié. */
  set(list: ContextBuilding[], hidden: Set<string>): void {
    this.dispose();
    if (list.length === 0) return;
    const base = this.map.groundBase;
    const pos = (ring: LonLat[]) => C.Cartesian3.fromDegreesArray(ring.flatMap((p) => [p.lon, p.lat]));
    const instances = list.map(
      (b) =>
        new C.GeometryInstance({
          id: b.id,
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(
              pos(b.outer),
              b.holes.map((h) => new C.PolygonHierarchy(pos(h))),
            ),
            height: base,
            extrudedHeight: base + b.height,
            vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(b.estimated ? STONE_ESTIMATED : STONE),
            show: new C.ShowGeometryInstanceAttribute(!hidden.has(b.id)),
          },
        }),
    );
    this.ids = list.map((b) => b.id);
    this.hidden = hidden;
    this.creditText = buildingsCredit(list, new Date().toISOString().slice(0, 10));
    this.prim = this.map.viewer.scene.primitives.add(
      new C.Primitive({
        geometryInstances: instances,
        appearance: new C.PerInstanceColorAppearance({ translucent: false, closed: true }),
        asynchronous: true,
        shadows: C.ShadowMode.ENABLED,
        show: this.visible,
      }),
    );
    this.syncCredit();
  }

  /** Masque (ou ré-affiche) des bâtiments sans reconstruire la géométrie. */
  setHidden(hidden: Set<string>): void {
    this.hidden = hidden;
    this.applyHidden();
  }

  setVisible(on: boolean): void {
    this.visible = on;
    if (this.prim) this.prim.show = on;
    this.syncCredit();
  }

  dispose(): void {
    this.cancelWait();
    if (this.prim) {
      this.map.viewer.scene.primitives.remove(this.prim);
      this.prim = null;
    }
    this.ids = [];
    this.hidden = new Set();
    this.creditText = null;
    this.syncCredit();
  }

  /** La mention est affichée tant que des bâtiments sont visibles à l'écran, et seulement alors. */
  private syncCredit(): void {
    const display = this.map.viewer.creditDisplay;
    const want = this.visible && this.prim !== null ? this.creditText : null;
    if (this.credit && (want === null || this.credit.html !== want)) {
      display.removeStaticCredit(this.credit);
      this.credit = null;
    }
    if (want !== null && !this.credit) {
      this.credit = new C.Credit(want, true);
      display.addStaticCredit(this.credit);
    }
  }

  private applyHidden(): void {
    const p = this.prim;
    if (!p) return;
    if (!p.ready) {
      this.waitReady();
      return;
    }
    for (const id of this.ids) {
      const attrs = p.getGeometryInstanceAttributes(id);
      if (attrs) attrs.show = C.ShowGeometryInstanceAttribute.toValue(!this.hidden.has(id));
    }
  }

  /** La construction est asynchrone : on applique le masquage dès que la géométrie est prête. */
  private waitReady(): void {
    if (this.waiting) return;
    const post = this.map.viewer.scene.postRender;
    const cb = () => {
      if (!this.prim) return this.cancelWait();
      if (this.prim.ready) {
        this.cancelWait();
        this.applyHidden();
      }
    };
    post.addEventListener(cb);
    this.waiting = () => post.removeEventListener(cb);
  }

  private cancelWait(): void {
    this.waiting?.();
    this.waiting = null;
  }
}
