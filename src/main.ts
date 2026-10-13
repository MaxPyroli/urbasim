import * as Cesium from 'cesium';
import './styles.css';
import {
  LocalProjection,
  buildGeoJson,
  buildKml,
  buildingHeight,
  centroid,
  compareScenarios,
  computeProject,
  dist,
  hiddenBuildingIds,
  parcelCenter,
  parseParcelGeoJson,
  pickStreetEdgesFromRoads,
  streetHeading,
  toggleStreetEdge,
  type ContextBuilding,
  type LonLat,
  type Parcel,
  type Project,
  type Scenario,
} from './engine';
import { ContextRenderer } from './app/context3d';
import { ParcelEditor } from './app/editor';
import { MapView } from './app/mapview';
import { SceneRenderer } from './app/scene3d';
import { fetchCadastreParcel, fetchNearbyBuildings, fetchNearbyRoads, geocode } from './app/services';
import { getGoogleKey, loadInitialState, setGoogleKey, shareLink, store } from './app/state';
import { Ui, type UiHandlers } from './app/ui';

const mapEl = document.getElementById('map')!;
const uiEl = document.getElementById('ui')!;

store.replace(loadInitialState());

const map = new MapView(mapEl);
const renderer = new SceneRenderer(map);
const contextRenderer = new ContextRenderer(map);

let project: Project | null = null;
let scenarios: Scenario[] | null = null;
let hintTimer = 0;

/** Bâtiments voisins déjà chargés, avec la zone qu'ils couvrent. */
let contextData: { center: LonLat; radius: number; list: ContextBuilding[] } | null = null;
let contextToken = 0;
let renderErrors = 0;

/** Repli géométrique : le côté le plus court (hors arêtes parasites < 3 m) — la façade d'une lanière donne presque toujours sur la rue. */
function guessStreetEdge(ring: LonLat[]): number {
  const o = parcelCenter(ring);
  const proj = new LocalProjection(o.lon, o.lat);
  const pts = ring.map((p) => proj.toLocal(p));
  const lens = pts.map((a, i) => dist(a, pts[(i + 1) % pts.length]));
  const usable = lens.some((l) => l >= 3);
  let best = 0;
  let bestLen = Infinity;
  lens.forEach((l, i) => {
    if (usable && l < 3) return;
    if (l < bestLen) {
      bestLen = l;
      best = i;
    }
  });
  return best;
}

/** Affine le côté rue d'après les voies OpenStreetMap, sans écraser un choix fait entre-temps par l'utilisateur. */
async function refineStreetFromRoads(parcel: Parcel): Promise<void> {
  try {
    const c = parcelCenter(parcel.ring);
    const radius = 40 + Math.max(...parcel.ring.map((p) => Math.hypot((p.lon - c.lon) * 73000, (p.lat - c.lat) * 111000)));
    const roads = await fetchNearbyRoads(c.lon, c.lat, Math.round(radius));
    const proj = new LocalProjection(c.lon, c.lat);
    const edges = pickStreetEdgesFromRoads(
      parcel.ring.map((p) => proj.toLocal(p)),
      roads.map((r) => r.map((p) => proj.toLocal(p))),
    );
    const cur = store.get().parcel;
    if (edges.length === 0 || !cur || cur.ring !== parcel.ring || cur.streetEdges.join() !== parcel.streetEdges.join()) return;
    if (edges.join() !== parcel.streetEdges.join()) {
      store.set({ parcel: { ring: parcel.ring, streetEdges: edges } });
    }
    flashHint('Côté rue détecté d’après OpenStreetMap — vérifiez-le (en rouge) et cliquez un côté pour le changer.', 'info', 7000);
  } catch {
    /* hors ligne ou service indisponible : on garde l'heuristique géométrique */
  }
}

/** Cadre le terrain et le bâtiment, en arrivant côté rue. */
function frame(view: 'top' | 'oblique'): void {
  const { parcel, criteria } = store.get();
  if (!parcel) return;
  const heading = project ? streetHeading(project.parcelRing, parcel.streetEdges) : 0;
  map.flyToParcel(parcel.ring, view, buildingHeight(criteria), heading);
}

/** Cesium rejette parfois avec un RequestErrorEvent (statusCode) plutôt qu'une Error. */
function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') return 'délai dépassé';
  if (err instanceof TypeError) return 'connexion impossible (réseau ou service injoignable)';
  if (err instanceof Error) return err.message;
  const e = err as { statusCode?: number; message?: string } | null;
  if (e?.statusCode === 403 || e?.statusCode === 401) return `accès refusé (HTTP ${e.statusCode})`;
  if (e?.statusCode) return `HTTP ${e.statusCode}`;
  return e?.message ?? String(err);
}

/** Dernière consigne de l'outil de dessin : on la rétablit quand un message passager s'efface. */
let editorHint: string | null = null;
const LOADING_HINT = 'Chargement du bâti IGN…';

function flashHint(msg: string, tone: 'info' | 'error' = 'info', ms = 5000): void {
  ui.setHint(msg, tone);
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => ui.setHint(editor.currentMode !== 'idle' ? editorHint : null), ms);
}

/** Le message de chargement ne doit pas écraser une consigne de dessin, ni effacer un autre message à sa fin. */
function showLoadingHint(): void {
  if (editor.currentMode === 'idle') ui.setHint(LOADING_HINT);
}

function clearLoadingHint(): void {
  if (document.getElementById('hint')?.textContent === LOADING_HINT) ui.setHint(editor.currentMode !== 'idle' ? editorHint : null);
}

function center(ring: LonLat[]): LonLat {
  return parcelCenter(ring);
}

/** Distance approximative en mètres entre deux points (suffisante à l'échelle d'un quartier). */
function metersBetween(a: LonLat, b: LonLat): number {
  return Math.hypot((a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180), (a.lat - b.lat) * 110574);
}

/** Masque, parmi les bâtiments voisins, ceux situés sur le terrain étudié (ils seraient démolis par le projet). */
function applyContext(): void {
  const { parcel, context } = store.get();
  contextRenderer.setVisible(context && parcel !== null);
  if (contextData && parcel) contextRenderer.setHidden(hiddenBuildingIds(parcel.ring, contextData.list));
}

/** Charge (si besoin) le bâti IGN autour du terrain. Les requêtes périmées sont ignorées ; un cache évite de recharger. */
async function refreshContext(): Promise<void> {
  const { parcel, context } = store.get();
  if (!parcel || !context) {
    if (!parcel) {
      contextRenderer.dispose();
      contextData = null;
    }
    applyContext();
    return;
  }
  const c = center(parcel.ring);
  const spread = Math.max(...parcel.ring.map((p) => metersBetween(c, p)));
  // zone déjà couverte par les données chargées ? (terrain déplacé de peu, simple retouche du contour…)
  if (contextData && metersBetween(contextData.center, c) + spread + 40 <= contextData.radius) {
    applyContext();
    return;
  }
  const radius = Math.min(450, Math.round(150 + spread));
  const token = ++contextToken;
  showLoadingHint();
  try {
    const res = await fetchNearbyBuildings(c.lon, c.lat, radius);
    if (token !== contextToken || !store.get().context) return clearLoadingHint(); // une demande plus récente ou la désactivation a pris le relais
    contextData = { center: c, radius, list: res.buildings };
    contextRenderer.set(res.buildings, hiddenBuildingIds(parcel.ring, res.buildings));
    applyContext();
    if (res.buildings.length === 0) flashHint('Aucun bâtiment IGN ici : la BD TOPO ne couvre que la France.', 'info', 6000);
    else if (res.truncated) flashHint('Zone très dense : seuls les premiers milliers de bâtiments sont affichés.', 'info', 6000);
    else clearLoadingHint();
  } catch (err) {
    if (token === contextToken) flashHint(`Bâti IGN indisponible : ${describeError(err)}`, 'error', 6000);
    else clearLoadingHint();
  }
}

async function afterParcelChange(fly: boolean): Promise<void> {
  const { parcel } = store.get();
  if (!parcel) return;
  const c = center(parcel.ring);
  await map.sampleGround(c.lon, c.lat);
  recompute();
  void refreshContext();
  if (fly) frame('oblique');
}

function setParcel(ring: LonLat[], streetEdges: number[], label: string): void {
  const known = streetEdges.length > 0;
  const parcel: Parcel = { ring, streetEdges: known ? streetEdges : [guessStreetEdge(ring)] };
  store.set({ parcel, parcelLabel: label, criteria: { ...store.get().criteria, edgeSetbacks: {} } });
  void afterParcelChange(true);
  if (!known) void refineStreetFromRoads(parcel);
}

async function applyBaseLayer(layer: 'osm' | 'ortho' | 'google'): Promise<void> {
  try {
    if (layer === 'google') {
      const key = getGoogleKey();
      if (!key) {
        openSettings();
        return;
      }
      ui.setHint('Chargement des 3D Tiles Google…');
    }
    await map.setBaseLayer(layer, getGoogleKey());
    store.set({ baseLayer: layer });
    ui.setBaseLayer(layer);
    if (layer === 'google') ui.setHint(null);
    const { parcel } = store.get();
    if (parcel) await afterParcelChange(false);
  } catch (err) {
    ui.setBaseLayer(store.get().baseLayer);
    flashHint(`Impossible d’activer ce fond : ${describeError(err)}. Vérifiez la clé, que l’API Map Tiles est activée, et que l’adresse de facturation du projet est hors EEE (ces tuiles y sont indisponibles).`, 'error', 9000);
    if (layer === 'google') await map.setBaseLayer('osm', '').catch(() => undefined);
    store.set({ baseLayer: 'osm' });
    ui.setBaseLayer('osm');
  }
}

function openSettings(): void {
  const { dialog, input } = ui.settingsDialog();
  input.value = getGoogleKey();
  dialog.showModal();
  dialog.addEventListener(
    'close',
    () => {
      if (dialog.returnValue !== 'ok') return;
      setGoogleKey(input.value.trim());
      if (input.value.trim()) void applyBaseLayer('google');
      else if (store.get().baseLayer === 'google') void applyBaseLayer('osm');
    },
    { once: true },
  );
}

function download(name: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const handlers: UiHandlers = {
  draw: () => {
    // la hauteur du sol sert au pointage : on la mesure au centre de l'écran avant de dessiner
    const c = map.pickGround(new Cesium.Cartesian2(mapEl.clientWidth / 2, mapEl.clientHeight / 2));
    if (c && map.hasGoogle) void map.sampleGround(c.lon, c.lat);
    editor.startDraw();
  },
  cadastre: () => editor.startCadastre(),
  clear: () => {
    editor.cancel();
    store.set({ parcel: null, parcelLabel: '', criteria: { ...store.get().criteria, edgeSetbacks: {} } });
  },
  importGeoJson: (text) => {
    const ring = parseParcelGeoJson(text);
    if (!ring) {
      flashHint('Fichier non reconnu : il faut un GeoJSON contenant un polygone (WGS84, lon/lat).', 'error');
      return;
    }
    setParcel(ring, [], 'Import GeoJSON');
  },
  toggleStreet: (edge) => {
    const { parcel } = store.get();
    if (parcel) store.set({ parcel: toggleStreetEdge(parcel, edge) });
  },
  setBaseLayer: (layer) => void applyBaseLayer(layer),
  openSettings,
  view: (kind) => {
    if (store.get().parcel) frame(kind);
    else flashHint('Dessinez d’abord un terrain.');
  },
  search: async (q) => {
    try {
      ui.setHint('Recherche…');
      const res = await geocode(q, map.hasGoogle ? getGoogleKey() : null);
      if (res.length === 0) {
        flashHint('Aucun résultat pour cette adresse.', 'error');
        return;
      }
      map.flyToLonLat(res[0].lon, res[0].lat, 300);
      flashHint(res[0].label, 'info', 4000);
    } catch (err) {
      flashHint(describeError(err), 'error', 8000);
    }
  },
  exportKml: () => {
    const s = store.get();
    if (project?.footprint) download('urbasim-projet.kml', buildKml(project, s.criteria), 'application/vnd.google-earth.kml+xml');
  },
  exportGeoJson: () => {
    const s = store.get();
    if (project?.footprint) download('urbasim-projet.geojson', buildGeoJson(project, s.criteria), 'application/geo+json');
  },
  share: async () => {
    const url = shareLink();
    try {
      await navigator.clipboard.writeText(url);
      flashHint('Lien copié : il contient le terrain et tous les critères.');
    } catch {
      window.prompt('Copiez ce lien :', url);
    }
  },
  pickScenario: (levels) => store.setCriteria({ levels }),
};

const ui = new Ui(uiEl, handlers);

const editor = new ParcelEditor(map, {
  onDrawn: (ring) => setParcel(ring, [], ''),
  onEdited: (parcel, final) => {
    store.set({ parcel, parcelLabel: final ? '' : store.get().parcelLabel });
    if (final) void afterParcelChange(false);
  },
  onCadastreClick: async (lon, lat) => {
    ui.setHint('Recherche de la parcelle…');
    try {
      const found = await fetchCadastreParcel(lon, lat);
      if (!found) {
        flashHint('Aucune parcelle cadastrale à cet endroit (domaine public ? hors France ?).', 'error');
        return;
      }
      editor.cancel();
      setParcel(found.ring, found.openEdges, found.label);
      flashHint(found.openEdges.length > 0 ? 'Côté(s) sans voisin déclarés sur rue : vérifiez-les (en rouge).' : 'Choisissez le côté rue (clic sur un côté).');
    } catch (err) {
      flashHint(describeError(err), 'error', 8000);
    }
  },
  onEdgeClick: (edge) => handlers.toggleStreet(edge),
  onStatus: (msg) => {
    editorHint = msg;
    ui.setHint(msg);
  },
  onMode: (mode) => ui.setMode(mode),
});

// ---------- calcul et rendu

let raf = 0;
let scenTimer = 0;

let lastComputeMs = 0;

function recompute(): void {
  const s = store.get();
  const t0 = performance.now();
  try {
    project = s.parcel && s.parcel.ring.length >= 3 ? computeProject(s.parcel, s.criteria) : null;
  } catch (err) {
    console.error(err);
    project = null;
    flashHint('Erreur de calcul sur ce terrain (contour invalide ?).', 'error');
  }
  lastComputeMs = performance.now() - t0;
  renderer.render(project, s.parcel, s.criteria, s.groundOffset, s.shadows);
  ui.update(project, s, scenarios);
  window.clearTimeout(scenTimer);
  scenTimer = window.setTimeout(() => {
    const cur = store.get();
    // la comparaison relance dix calculs : on la saute si un seul est déjà lent (très grand terrain)
    const affordable = lastComputeMs < 200;
    scenarios = affordable && cur.parcel && cur.parcel.ring.length >= 3 ? compareScenarios(cur.parcel, cur.criteria, 9) : null;
    ui.update(project, cur, scenarios);
  }, 180);
}

function scheduleRender(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    recompute();
  });
}

store.subscribe((s, changed) => {
  if (changed.has('parcel')) editor.setParcel(s.parcel);
  // le soleil dépend de la longitude du terrain ; sans cela l'éclairage suivrait l'heure réelle (bâtiments sombres le soir)
  if (changed.has('shadows') || changed.has('sunHour') || changed.has('parcel')) map.setSun(s.shadows, s.sunHour, s.parcel ? center(s.parcel.ring).lon : 2.35);
  if (changed.has('context')) void refreshContext();
  if (changed.has('parcel') && !s.parcel) void refreshContext();
  scheduleRender();
});

// Les géométries du bâti viennent d'un service externe : si l'une d'elles faisait échouer le rendu, on retire le bâti
// et on relance la boucle de rendu plutôt que de laisser toute la carte figée.
map.viewer.scene.renderError.addEventListener((_scene, error) => {
  console.error('Erreur de rendu Cesium', error);
  contextRenderer.dispose();
  contextData = null;
  if (++renderErrors <= 2) {
    window.setTimeout(() => (map.viewer.useDefaultRenderLoop = true), 0);
    flashHint('Une erreur d’affichage 3D est survenue : le bâti voisin a été retiré. Réactivez « Voisinage » pour réessayer.', 'error', 9000);
    store.set({ context: false });
  } else {
    flashHint('Erreur d’affichage 3D répétée : rechargez la page.', 'error', 30000);
  }
});

// ---------- démarrage

const initial = store.get();
ui.setBaseLayer('osm');
editor.setParcel(initial.parcel);
map.setSun(initial.shadows, initial.sunHour, initial.parcel ? center(initial.parcel.ring).lon : 2.35);
recompute();
if (initial.parcel) {
  const c = center(initial.parcel.ring);
  map.viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 250),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
  });
  frame('oblique');
  void refreshContext();
}
if (initial.baseLayer !== 'osm') void applyBaseLayer(initial.baseLayer);

// utile pour les tests de bout en bout et le débogage
(window as unknown as Record<string, unknown>).urbasim = { store, map, getProject: () => project, centroid, frame, shareLink, contextRenderer, getContext: () => contextData, getHidden: () => { const st = store.get(); return contextData && st.parcel ? [...hiddenBuildingIds(st.parcel.ring, contextData.list)] : []; } };
