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
  carveParcel,
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
import { fetchCadastreParcel, fetchNearbyBuildings, fetchNearbyRoads, fetchPlu, geocode } from './app/services';
import { getGoogleKey, loadInitialState, setGoogleKey, shareLink, store } from './app/state';
import { Ui, type UiHandlers } from './app/ui';

const mapEl = document.getElementById('map')!;
const uiEl = document.getElementById('ui')!;

/** Toute l'application repose sur WebGL : sans lui, mieux vaut une explication qu'une page vide. */
function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

if (!webglAvailable()) {
  uiEl.innerHTML =
    '<div class="nogl"><h1>Urbasim</h1><p>Votre navigateur ne permet pas l’affichage 3D (WebGL). Essayez une version récente de Chrome, Edge ou Firefox, ou activez l’accélération matérielle dans ses réglages.</p></div>';
  throw new Error('WebGL indisponible : démarrage interrompu');
}

store.replace(loadInitialState());

const map = new MapView(mapEl);
const renderer = new SceneRenderer(map);
const contextRenderer = new ContextRenderer(map);

// La barre de mentions (Cesium, IGN…) peut passer sur plusieurs lignes en largeur réduite : la barre d'aide se place
// toujours au-dessus d'elle (variable CSS --credit-h), pour ne jamais masquer une mention obligatoire.
const creditBar = mapEl.querySelector<HTMLElement>('.cesium-viewer-bottom');
if (creditBar && typeof ResizeObserver !== 'undefined') {
  const place = () => document.documentElement.style.setProperty('--credit-h', `${creditBar.offsetHeight}px`);
  new ResizeObserver(place).observe(creditBar);
  place();
}

let project: Project | null = null;
let scenarios: Scenario[] | null = null;
let hintTimer = 0;

/** Bâtiments voisins déjà chargés, avec la zone qu'ils couvrent. */
let contextData: { center: LonLat; radius: number; list: ContextBuilding[] } | null = null;
/** Numéro de la dernière décision de chargement : une requête dont le numéro est dépassé est ignorée. */
let contextToken = 0;
let renderErrors = 0;
let lastRenderErrorAt = -Infinity;

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

function flashHint(msg: string, tone: 'info' | 'error' = 'info', ms = 5000): void {
  ui.setHint(msg, tone);
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => ui.setHint(editor.currentMode !== 'idle' ? editorHint : null), ms);
}

function center(ring: LonLat[]): LonLat {
  return parcelCenter(ring);
}

/** Distance approximative en mètres entre deux points (suffisante à l'échelle d'un quartier). */
function metersBetween(a: LonLat, b: LonLat): number {
  return Math.hypot((a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180), (a.lat - b.lat) * 110574);
}

/** Découpe le bâti voisin par le terrain ; en cas d'échec on garde tout le bâti plutôt qu'une carte vide. */
function carve(parcel: Parcel, list: ContextBuilding[]): ReturnType<typeof carveParcel> {
  try {
    return carveParcel(parcel.ring, list);
  } catch (err) {
    console.warn('Découpage du bâti impossible', err);
    return { hidden: new Set<string>(), remainders: [] };
  }
}

/**
 * Le bâti est montré si c'est demandé et qu'un terrain existe, mais pas pendant le dessin ou la sélection cadastre :
 * un clic sur un toit viserait le sol derrière lui (le pointage se fait sur le plan du sol).
 */
function applyVisibility(): void {
  const { parcel, context } = store.get();
  contextRenderer.setVisible(context && parcel !== null && editor.currentMode === 'idle');
}

/** Resynchronise le bâti avec le terrain actuel : altitude du sol, visibilité et découpage. */
function applyContext(): void {
  const { parcel } = store.get();
  contextRenderer.syncBase();
  applyVisibility();
  if (contextData && parcel) {
    const r = carve(parcel, contextData.list);
    contextRenderer.setCarved(r.hidden, r.remainders);
  }
}

let pluToken = 0;

/** Zonage et règlement du PLU au droit du terrain (Géoportail de l'Urbanisme). Les réponses périmées sont ignorées. */
async function refreshPlu(): Promise<void> {
  const token = ++pluToken;
  const { parcel } = store.get();
  if (!parcel) {
    ui.setPlu(null);
    return;
  }
  ui.setPlu('loading');
  try {
    const info = await fetchPlu(parcel.ring);
    if (token === pluToken) ui.setPlu(info);
  } catch (err) {
    if (token === pluToken) ui.setPlu({ error: describeError(err) });
  }
}

/** Charge (si besoin) le bâti IGN autour du terrain. Les requêtes périmées sont ignorées ; un cache évite de recharger. */
async function refreshContext(): Promise<void> {
  const token = ++contextToken; // toute nouvelle décision, même sans chargement, rend caduque une requête en cours
  ui.setContextLoading(false); // la requête précédente éventuelle est périmée ; seul le chargement ci-dessous rallume l'indicateur
  const { parcel, context } = store.get();
  if (!parcel) {
    contextRenderer.dispose();
    contextData = null;
    return;
  }
  if (!context) {
    applyVisibility();
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
  ui.setContextLoading(true);
  try {
    const res = await fetchNearbyBuildings(c.lon, c.lat, radius);
    const current = store.get().parcel;
    if (token !== contextToken || !store.get().context || !current) return; // une décision plus récente a pris le relais
    contextData = null; // enregistré seulement une fois l'affichage réussi : un échec ne laisse pas un cache sans affichage
    const r = carve(current, res.buildings);
    contextRenderer.set(res.buildings, r.hidden, r.remainders);
    contextData = { center: c, radius, list: res.buildings };
    applyVisibility();
    if (res.buildings.length === 0) flashHint(`Aucun bâtiment IGN dans un rayon de ${radius} m (la BD TOPO ne couvre que la France).`, 'info', 6000);
    else if (res.truncated) flashHint('Zone très dense : seuls les premiers milliers de bâtiments sont affichés.', 'info', 6000);
  } catch (err) {
    if (token === contextToken) flashHint(`Bâti IGN indisponible : ${describeError(err)}`, 'error', 6000);
  } finally {
    if (token === contextToken) ui.setContextLoading(false);
  }
}

async function afterParcelChange(fly: boolean): Promise<void> {
  const { parcel } = store.get();
  if (!parcel) return;
  const c = center(parcel.ring);
  await map.sampleGround(c.lon, c.lat);
  recompute();
  void refreshContext();
  void refreshPlu();
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
  onMode: (mode) => {
    ui.setMode(mode);
    applyVisibility();
  },
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
  if (changed.has('parcel') && !s.parcel) {
    void refreshContext();
    void refreshPlu();
  }
  scheduleRender();
});

// ---------- robustesse du rendu
//
// Cesium arrête sa boucle à la première erreur. `showRenderLoopErrors` est désactivé pour décider nous-mêmes quoi faire :
// relancer l'affichage (deux fois au plus par minute), retirer le bâti voisin s'il est en cause, ou afficher un message.

/** Vrai entre l'erreur et la relance de la boucle. */
let restarting = false;
/** Vrai une fois le panneau d'erreur affiché : plus aucune relance. */
let renderGaveUp = false;

function recoverRendering(error: unknown, fromRender: boolean): void {
  const now = performance.now();
  renderErrors = now - lastRenderErrorAt > 60000 ? 1 : renderErrors + 1; // les erreurs isolées dans le temps ne s'accumulent pas
  lastRenderErrorAt = now;
  // Les géométries du bâti viennent d'un service externe. Si l'erreur est celle que l'une d'elles a mémorisée, on retire
  // le bâti ; si la même erreur revient sans qu'on sache d'où elle vient, on le retire aussi par précaution.
  const ours = fromRender && contextRenderer.ownsError(error);
  const removed = ours || (fromRender && renderErrors >= 2 && contextRenderer.count > 0);
  if (removed) {
    contextRenderer.dispose();
    contextData = null;
    store.set({ context: false });
  }
  if (renderErrors <= 2) {
    // Cesium a déjà arrêté sa boucle, mais son ancienne chaîne d'animation tourne encore une image : on ne relance
    // qu'après deux images, sinon la scène serait dessinée deux fois par image pour le reste de la session.
    restarting = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        restarting = false;
        map.viewer.useDefaultRenderLoop = true;
      }),
    );
    flashHint(
      removed
        ? 'Une erreur d’affichage 3D est survenue : le bâti voisin a été retiré. Réactivez « Voisinage » pour réessayer.'
        : 'Une erreur d’affichage 3D est survenue ; l’affichage a été relancé.',
      'error',
      9000,
    );
  } else {
    renderGaveUp = true;
    map.viewer.cesiumWidget.showErrorPanel(
      'Erreur d’affichage 3D',
      'L’affichage 3D s’est arrêté après plusieurs erreurs. Rechargez la page.',
      error === undefined ? undefined : String(error),
    );
  }
}

map.viewer.scene.renderError.addEventListener((_scene, error) => {
  console.error('Erreur de rendu Cesium', error);
  recoverRendering(error, true);
});

// Une erreur levée hors du rendu proprement dit (horloge, entités) arrête la boucle sans passer par `renderError` :
// sans cette surveillance la carte resterait figée sans aucun message.
window.setInterval(() => {
  if (restarting || renderGaveUp || map.viewer.isDestroyed() || map.viewer.useDefaultRenderLoop) return;
  console.error('Boucle de rendu Cesium arrêtée hors du rendu');
  recoverRendering(undefined, false);
}, 1000);

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
  void refreshPlu();
}
if (initial.baseLayer !== 'osm') void applyBaseLayer(initial.baseLayer);

// utile pour les tests de bout en bout et le débogage
(window as unknown as Record<string, unknown>).urbasim = { store, map, afterParcelChange, getProject: () => project, centroid, frame, shareLink, contextRenderer, getContext: () => contextData, getCarve: () => { const st = store.get(); return contextData && st.parcel ? carve(st.parcel, contextData.list) : null; } };
