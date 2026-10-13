import * as Cesium from 'cesium';
import { buildingsCredit, type ContextBuilding, type LonLat } from '../engine';
import type { MapView } from './mapview';

const C = Cesium;

const STONE = C.Color.fromCssColorString('#d6d1c4');
/** Hauteur estimée (absente de la donnée) : teinte plus claire pour la distinguer. */
const STONE_ESTIMATED = C.Color.fromCssColorString('#e9e5db');

/** Écart d'altitude (m) du sol au-delà duquel le bâti est reconstruit (changement de fond de carte). */
const BASE_TOLERANCE = 0.5;

/** Une Primitive Cesium avec une instance par bâtiment ; `hidden` : instances présentes mais non dessinées. */
function makePrimitive(list: ContextBuilding[], base: number, show: boolean, hidden: Set<string> | null): Cesium.Primitive {
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
          show: new C.ShowGeometryInstanceAttribute(!hidden?.has(b.id)),
        },
      }),
  );
  return new C.Primitive({
    geometryInstances: instances,
    appearance: new C.PerInstanceColorAppearance({ translucent: false, closed: true }),
    asynchronous: true,
    shadows: C.ShadowMode.ENABLED,
    show,
  });
}

/**
 * Bâtiments voisins en volumes 3D. Une Primitive pour les bâtiments d'origine (masquables un à un) et une petite
 * seconde pour les morceaux restant des bâtiments que le terrain étudié entame : un appel de dessin pour des
 * centaines de bâtiments, géométrie construite hors du fil principal.
 */
export class ContextRenderer {
  private prim: Cesium.Primitive | null = null;
  private carved: Cesium.Primitive | null = null;
  private list: ContextBuilding[] = [];
  private ids: string[] = [];
  private hidden = new Set<string>();
  private remainders: ContextBuilding[] = [];
  /** Altitude du sol utilisée à la construction. */
  private base = 0;
  private visible = true;
  private waiting: (() => void) | null = null;
  /** Mention actuellement affichée à l'écran (Licence Ouverte 2.0 : source + date de mise à jour). */
  private credit: Cesium.Credit | null = null;
  creditText: string | null = null;

  constructor(private readonly map: MapView) {}

  get count(): number {
    return this.ids.length;
  }

  /** Remplace tous les bâtiments affichés. `hidden` / `remainders` : résultat du découpage par le terrain. */
  set(list: ContextBuilding[], hidden: Set<string>, remainders: ContextBuilding[]): void {
    this.dispose();
    if (list.length === 0) return;
    this.list = list;
    this.hidden = hidden;
    this.remainders = remainders;
    this.creditText = buildingsCredit(list, new Date().toISOString().slice(0, 10));
    this.build();
  }

  /** Met à jour le découpage par le terrain sans reconstruire les bâtiments d'origine. */
  setCarved(hidden: Set<string>, remainders: ContextBuilding[]): void {
    if (this.list.length === 0) return;
    this.hidden = hidden;
    this.remainders = remainders;
    this.applyHidden();
    this.buildCarved();
  }

  /** Reconstruit le bâti si l'altitude du sol a changé depuis sa construction (ex. changement de fond de carte). */
  syncBase(): void {
    if (this.list.length > 0 && Math.abs(this.map.groundBase - this.base) > BASE_TOLERANCE) this.build();
  }

  setVisible(on: boolean): void {
    this.visible = on;
    if (this.prim) this.prim.show = on;
    if (this.carved) this.carved.show = on;
    this.syncCredit();
  }

  /** L'erreur de rendu est-elle celle qu'une de nos primitives a mémorisée (construction asynchrone des géométries en échec) ? */
  ownsError(error: unknown): boolean {
    if (error === undefined) return false;
    return [this.prim, this.carved].some((p) => p !== null && (p as unknown as { _error?: unknown })._error === error);
  }

  dispose(): void {
    this.cancelWait();
    this.removePrimitives();
    this.list = [];
    this.ids = [];
    this.hidden = new Set();
    this.remainders = [];
    this.creditText = null;
    this.syncCredit();
  }

  private build(): void {
    this.cancelWait();
    this.removePrimitives();
    this.base = this.map.groundBase;
    this.ids = this.list.map((b) => b.id);
    this.prim = this.map.viewer.scene.primitives.add(makePrimitive(this.list, this.base, this.visible, this.hidden));
    this.buildCarved();
    this.syncCredit();
  }

  private buildCarved(): void {
    const prims = this.map.viewer.scene.primitives;
    if (this.carved) {
      prims.remove(this.carved);
      this.carved = null;
    }
    if (this.remainders.length > 0) this.carved = prims.add(makePrimitive(this.remainders, this.base, this.visible, null));
  }

  private removePrimitives(): void {
    const prims = this.map.viewer.scene.primitives;
    if (this.prim) prims.remove(this.prim);
    if (this.carved) prims.remove(this.carved);
    this.prim = null;
    this.carved = null;
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
