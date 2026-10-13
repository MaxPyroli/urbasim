import * as Cesium from 'cesium';
import { insertVertex, removeVertex, type LonLat, type Parcel } from '../engine';
import type { MapView } from './mapview';

const C = Cesium;

export type EditorMode = 'idle' | 'draw' | 'cadastre';

export interface EditorCallbacks {
  /** Contour terminé (dessin) : nouveau terrain. */
  onDrawn(ring: LonLat[]): void;
  /** Contour modifié par glisser/insertion/suppression. `final` = fin du geste. */
  onEdited(parcel: Parcel, final: boolean): void;
  onCadastreClick(lon: number, lat: number): void;
  /** Clic sur l'étiquette numérotée d'un côté du terrain : bascule rue / limite. */
  onEdgeClick(edge: number): void;
  onStatus(message: string | null): void;
  onMode(mode: EditorMode): void;
}

const HANDLE = '#ffffff';
/** Zone de sélection (px) : les libellés d'un chiffre n'ont que très peu de pixels opaques. */
const PICK_SIZE = 16;

/** Outil de saisie du terrain : dessin, déplacement/ajout/suppression de sommets, clic cadastre. */
export class ParcelEditor {
  private mode: EditorMode = 'idle';
  private draft: LonLat[] = [];
  private cursor: LonLat | null = null;
  private parcel: Parcel | null = null;
  private readonly ds = new C.CustomDataSource('editor');
  private readonly handler: Cesium.ScreenSpaceEventHandler;
  private dragging = -1;
  private draftLine: Cesium.Entity | null = null;

  constructor(
    private readonly map: MapView,
    private readonly cb: EditorCallbacks,
  ) {
    map.viewer.dataSources.add(this.ds);
    const canvas = map.viewer.scene.canvas;
    this.handler = new C.ScreenSpaceEventHandler(canvas);
    this.handler.setInputAction((m: { position: Cesium.Cartesian2 }) => this.onClick(m.position), C.ScreenSpaceEventType.LEFT_CLICK);
    this.handler.setInputAction((m: { position: Cesium.Cartesian2 }) => this.onDouble(m.position), C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    this.handler.setInputAction((m: { position: Cesium.Cartesian2 }) => this.onDown(m.position), C.ScreenSpaceEventType.LEFT_DOWN);
    this.handler.setInputAction((m: { endPosition: Cesium.Cartesian2 }) => this.onMove(m.endPosition), C.ScreenSpaceEventType.MOUSE_MOVE);
    this.handler.setInputAction(() => this.onUp(), C.ScreenSpaceEventType.LEFT_UP);
    this.handler.setInputAction((m: { position: Cesium.Cartesian2 }) => this.onRight(m.position), C.ScreenSpaceEventType.RIGHT_CLICK);
    // le double-clic par défaut de Cesium zoome sur l'entité suivie : on le retire pour ne pas gêner la saisie
    map.viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    document.addEventListener('keydown', (ev) => this.onKey(ev));
  }

  get currentMode(): EditorMode {
    return this.mode;
  }

  private setMode(mode: EditorMode): void {
    this.mode = mode;
    this.map.viewer.scene.canvas.style.cursor = mode === 'idle' ? '' : 'crosshair';
    this.cb.onMode(mode);
  }

  startDraw(): void {
    this.draft = [];
    this.cursor = null;
    this.setMode('draw');
    this.refreshHandles();
    this.refreshDraft();
    this.cb.onStatus('Cliquez pour poser les angles du terrain. Double-clic, Entrée ou clic sur le 1er point pour fermer. Retour arrière : annuler le dernier point.');
  }

  startCadastre(): void {
    this.draft = [];
    this.setMode('cadastre');
    this.refreshDraft();
    this.cb.onStatus('Cliquez sur une parcelle (cadastre IGN, France).');
  }

  cancel(): void {
    this.draft = [];
    this.cursor = null;
    this.setMode('idle');
    this.refreshDraft();
    this.refreshHandles();
    this.cb.onStatus(null);
  }

  /** À appeler quand le terrain change : redessine les poignées d'édition. */
  setParcel(parcel: Parcel | null): void {
    this.parcel = parcel;
    this.refreshHandles();
  }

  // --- affichage

  private height(): number {
    return this.map.groundBase + 0.6;
  }

  private refreshDraft(): void {
    const e = this.ds.entities;
    if (this.draftLine) {
      e.remove(this.draftLine);
      this.draftLine = null;
    }
    for (const ent of e.values.filter((x) => String(x.id).startsWith('draft-'))) e.remove(ent);
    if (this.mode !== 'draw' || this.draft.length === 0) return;
    const h = this.height();
    const pts = [...this.draft, ...(this.cursor ? [this.cursor] : [])];
    this.draftLine = e.add({
      id: 'draft-line',
      polyline: {
        positions: C.Cartesian3.fromDegreesArrayHeights(pts.flatMap((p) => [p.lon, p.lat, h])),
        width: 3,
        material: C.Color.fromCssColorString('#ffb703'),
        depthFailMaterial: C.Color.fromCssColorString('#ffb703'),
      },
    });
    this.draft.forEach((p, i) => {
      e.add({
        id: `draft-pt-${i}`,
        position: C.Cartesian3.fromDegrees(p.lon, p.lat, h),
        point: { pixelSize: i === 0 ? 13 : 9, color: C.Color.fromCssColorString(i === 0 ? '#06d6a0' : HANDLE), outlineColor: C.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
    });
  }

  private refreshHandles(): void {
    const e = this.ds.entities;
    for (const ent of e.values.filter((x) => String(x.id).startsWith('handle-') || String(x.id).startsWith('mid-'))) e.remove(ent);
    if (!this.parcel || this.mode !== 'idle') return;
    const h = this.height();
    const ring = this.parcel.ring;
    ring.forEach((p, i) => {
      e.add({
        id: `handle-${i}`,
        position: C.Cartesian3.fromDegrees(p.lon, p.lat, h),
        point: { pixelSize: 12, color: C.Color.fromCssColorString(HANDLE), outlineColor: C.Color.fromCssColorString('#1d3557'), outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
      const q = ring[(i + 1) % ring.length];
      e.add({
        id: `mid-${i}`,
        position: C.Cartesian3.fromDegrees((p.lon + q.lon) / 2, (p.lat + q.lat) / 2, h),
        point: { pixelSize: 7, color: C.Color.fromCssColorString('#a8dadc'), outlineColor: C.Color.fromCssColorString('#1d3557'), outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
    });
  }

  // --- interactions

  /** Identifiants (chaîne) des entités sous le curseur, du plus proche au plus lointain. */
  private pickIds(pos: Cesium.Cartesian2): string[] {
    return this.map.viewer.scene
      .drillPick(pos, 12, PICK_SIZE, PICK_SIZE)
      .map((o) => o?.id?.id)
      .filter((id): id is string => typeof id === 'string');
  }

  /** Poignée de sommet prioritaire, sinon poignée de milieu d'arête. */
  private pickHandle(pos: Cesium.Cartesian2): string | null {
    const ids = this.pickIds(pos);
    return ids.find((i) => i.startsWith('handle-')) ?? ids.find((i) => i.startsWith('mid-')) ?? null;
  }

  private closeDraft(): void {
    if (this.draft.length < 3) {
      this.cb.onStatus('Il faut au moins 3 points.');
      return;
    }
    const ring = this.draft;
    this.draft = [];
    this.cursor = null;
    this.setMode('idle');
    this.refreshDraft();
    this.cb.onStatus(null);
    this.cb.onDrawn(ring);
  }

  private onClick(pos: Cesium.Cartesian2): void {
    if (this.mode === 'idle') {
      const ids = this.pickIds(pos);
      const edge = ids.find((i) => i.startsWith('edge-'));
      // un sommet ou un point milieu sous le curseur a priorité : on ne bascule pas la rue par accident
      if (edge && !ids.some((i) => i.startsWith('handle-') || i.startsWith('mid-'))) this.cb.onEdgeClick(parseInt(edge.slice(5), 10));
      return;
    }
    if (this.mode === 'cadastre') {
      const ll = this.map.pickGround(pos);
      if (ll) this.cb.onCadastreClick(ll.lon, ll.lat);
      return;
    }
    if (this.mode !== 'draw') return;
    const ll = this.map.pickGround(pos);
    if (!ll) return;
    if (this.draft.length >= 3) {
      // clic sur le premier point => fermeture
      const first = this.draft[0];
      const sp = C.SceneTransforms.worldToWindowCoordinates(this.map.viewer.scene, C.Cartesian3.fromDegrees(first.lon, first.lat, this.height()));
      if (sp && C.Cartesian2.distance(sp, pos) < 14) {
        this.closeDraft();
        return;
      }
    }
    this.draft.push(ll);
    this.refreshDraft();
  }

  private onDouble(pos: Cesium.Cartesian2): void {
    if (this.mode !== 'draw') return;
    // les deux clics du double-clic ont déjà posé deux points quasi identiques : on retire le doublon
    if (this.draft.length >= 2) {
      const a = this.draft[this.draft.length - 1];
      const b = this.draft[this.draft.length - 2];
      if (Math.abs(a.lon - b.lon) < 1e-8 && Math.abs(a.lat - b.lat) < 1e-8) this.draft.pop();
    }
    void pos;
    this.closeDraft();
  }

  private onDown(pos: Cesium.Cartesian2): void {
    if (this.mode !== 'idle' || !this.parcel) return;
    const id = this.pickHandle(pos);
    if (!id) return;
    if (id.startsWith('mid-')) {
      const edge = parseInt(id.slice(4), 10);
      this.parcel = insertVertex(this.parcel, edge, this.map.pickGround(pos) ?? undefined);
      this.dragging = edge + 1;
      this.cb.onEdited(this.parcel, false);
    } else {
      this.dragging = parseInt(id.slice(7), 10);
    }
    this.map.viewer.scene.screenSpaceCameraController.enableInputs = false;
  }

  private onMove(pos: Cesium.Cartesian2): void {
    if (this.mode === 'draw') {
      this.cursor = this.map.pickGround(pos) ?? null;
      if (this.draft.length > 0) this.refreshDraft();
      return;
    }
    if (this.dragging < 0 || !this.parcel) return;
    const ll = this.map.pickGround(pos);
    if (!ll) return;
    const ring = this.parcel.ring.map((p, i) => (i === this.dragging ? ll : p));
    this.parcel = { ...this.parcel, ring };
    this.cb.onEdited(this.parcel, false);
    this.refreshHandles();
  }

  private onUp(): void {
    if (this.dragging < 0) return;
    this.dragging = -1;
    this.map.viewer.scene.screenSpaceCameraController.enableInputs = true;
    if (this.parcel) this.cb.onEdited(this.parcel, true);
  }

  private onRight(pos: Cesium.Cartesian2): void {
    if (this.mode !== 'idle' || !this.parcel) return;
    const id = this.pickHandle(pos);
    if (!id?.startsWith('handle-')) return;
    if (this.parcel.ring.length <= 3) {
      this.cb.onStatus('Un terrain a au moins 3 sommets.');
      return;
    }
    this.parcel = removeVertex(this.parcel, parseInt(id.slice(7), 10));
    this.cb.onEdited(this.parcel, true);
    this.refreshHandles();
  }

  private onKey(ev: KeyboardEvent): void {
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (ev.key === 'Escape' && this.mode !== 'idle') this.cancel();
    else if (this.mode === 'draw' && ev.key === 'Enter') this.closeDraft();
    else if (this.mode === 'draw' && ev.key === 'Backspace') {
      ev.preventDefault();
      this.draft.pop();
      this.refreshDraft();
    }
  }
}
