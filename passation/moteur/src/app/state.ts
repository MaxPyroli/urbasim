import { DEFAULT_CRITERIA, type Criteria, type Parcel } from '../engine';

export type BaseLayer = 'osm' | 'ortho' | 'google';

export interface AppState {
  parcel: Parcel | null;
  criteria: Criteria;
  /** Calage vertical manuel du bâtiment (m), s'ajoute à l'altitude du sol mesurée. */
  groundOffset: number;
  baseLayer: BaseLayer;
  shadows: boolean;
  /** Affiche les bâtiments voisins en 3D (IGN BD TOPO, France). */
  context: boolean;
  /** Heure solaire locale approximative (0–24) pour l'étude d'ombres. */
  sunHour: number;
  /** Référence cadastrale du terrain importé, pour l'affichage. */
  parcelLabel: string;
}

const KEY = 'urbasim:v1';
const KEY_GOOGLE = 'urbasim:google-key';

export function defaultState(): AppState {
  return {
    parcel: null,
    criteria: { ...DEFAULT_CRITERIA, mix: { ...DEFAULT_CRITERIA.mix }, edgeSetbacks: {} },
    groundOffset: 0,
    baseLayer: 'osm',
    shadows: false,
    context: true,
    sunHour: 15,
    parcelLabel: '',
  };
}

type Listener = (state: AppState, changed: Set<keyof AppState>) => void;

class Store {
  private state: AppState = defaultState();
  private listeners: Listener[] = [];

  get(): AppState {
    return this.state;
  }

  set(patch: Partial<AppState>): void {
    const changed = new Set<keyof AppState>();
    for (const k of Object.keys(patch) as (keyof AppState)[]) {
      if (patch[k] !== this.state[k]) changed.add(k);
    }
    if (changed.size === 0) return;
    this.state = { ...this.state, ...patch };
    this.persist();
    for (const l of this.listeners) l(this.state, changed);
  }

  setCriteria(patch: Partial<Criteria>): void {
    this.set({ criteria: { ...this.state.criteria, ...patch } });
  }

  subscribe(l: Listener): void {
    this.listeners.push(l);
  }

  /** Remplace tout l'état sans conserver l'ancien (chargement, lien partagé). */
  replace(next: AppState): void {
    const changed = new Set(Object.keys(next) as (keyof AppState)[]);
    this.state = next;
    this.persist();
    for (const l of this.listeners) l(this.state, changed);
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* stockage indisponible : on continue sans persistance */
    }
  }
}

export const store = new Store();

/** Fusionne un état partiel (stockage, lien) dans l'état par défaut, en ignorant ce qui est invalide. */
export function sanitize(raw: unknown): AppState {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<AppState>;
  const parcel = r.parcel;
  if (parcel && Array.isArray(parcel.ring) && parcel.ring.length >= 3 && parcel.ring.every((p) => Number.isFinite(p?.lon) && Number.isFinite(p?.lat))) {
    base.parcel = {
      ring: parcel.ring.map((p) => ({ lon: p.lon, lat: p.lat })),
      streetEdges: Array.isArray(parcel.streetEdges) ? parcel.streetEdges.filter((i) => Number.isInteger(i) && i >= 0 && i < parcel.ring.length) : [0],
    };
    if (base.parcel.streetEdges.length === 0) base.parcel.streetEdges = [0];
  }
  if (r.criteria && typeof r.criteria === 'object') {
    base.criteria = { ...base.criteria, ...r.criteria, mix: { ...base.criteria.mix, ...(r.criteria.mix ?? {}) }, edgeSetbacks: { ...(r.criteria.edgeSetbacks ?? {}) } };
  }
  if (!['auto', 'rue', 'fond'].includes(base.criteria.placement)) base.criteria.placement = DEFAULT_CRITERIA.placement;
  if (Number.isFinite(r.groundOffset)) base.groundOffset = r.groundOffset!;
  if (r.baseLayer === 'osm' || r.baseLayer === 'ortho' || r.baseLayer === 'google') base.baseLayer = r.baseLayer;
  if (typeof r.shadows === 'boolean') base.shadows = r.shadows;
  if (typeof r.context === 'boolean') base.context = r.context;
  if (Number.isFinite(r.sunHour)) base.sunHour = r.sunHour!;
  if (typeof r.parcelLabel === 'string') base.parcelLabel = r.parcelLabel;
  return base;
}

export function loadInitialState(): AppState {
  // 1. lien partagé (#p=...)
  try {
    const m = location.hash.match(/#p=([^&]+)/);
    if (m) {
      const json = decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))));
      const s = sanitize(JSON.parse(json));
      // une clé de fond Google n'est jamais partagée : on retombe sur OSM si elle manque
      if (s.baseLayer === 'google' && !getGoogleKey()) s.baseLayer = 'osm';
      return s;
    }
  } catch {
    /* lien invalide : on ignore */
  }
  // 2. dernière session
  try {
    const s = localStorage.getItem(KEY);
    if (s) {
      const st = sanitize(JSON.parse(s));
      if (st.baseLayer === 'google' && !getGoogleKey()) st.baseLayer = 'osm';
      return st;
    }
  } catch {
    /* ignore */
  }
  return defaultState();
}

export function shareLink(): string {
  const { parcel, criteria, groundOffset, parcelLabel } = store.get();
  const payload = JSON.stringify({ parcel, criteria, groundOffset, parcelLabel });
  const b64 = btoa(unescape(encodeURIComponent(payload))).replace(/\+/g, '-').replace(/\//g, '_');
  return `${location.origin}${location.pathname}#p=${b64}`;
}

export function getGoogleKey(): string {
  try {
    return localStorage.getItem(KEY_GOOGLE) ?? '';
  } catch {
    return '';
  }
}

export function setGoogleKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_GOOGLE, key);
    else localStorage.removeItem(KEY_GOOGLE);
  } catch {
    /* ignore */
  }
}
