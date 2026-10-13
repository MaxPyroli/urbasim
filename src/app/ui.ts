import {
  buildingHeight,
  TYPOLOGIES,
  type Check,
  type Criteria,
  type Project,
  type Typology,
} from '../engine';
import type { Scenario } from '../engine';
import { planSvg } from './plan';
import type { AppState, BaseLayer } from './state';
import { store } from './state';
import type { EditorMode } from './editor';

export interface UiHandlers {
  draw(): void;
  cadastre(): void;
  clear(): void;
  importGeoJson(text: string): void;
  toggleStreet(edge: number): void;
  setBaseLayer(layer: BaseLayer): void;
  openSettings(): void;
  view(kind: 'top' | 'oblique'): void;
  search(query: string): void;
  exportKml(): void;
  exportGeoJson(): void;
  share(): void;
  pickScenario(levels: number): void;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n0 = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 0 });
const n1 = (n: number) => n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

type K = keyof Criteria;
type FieldDef =
  | { t: 'num'; key: K; label: string; unit?: string; min: number; max: number; step: number; help?: string }
  | { t: 'opt'; key: K; label: string; unit: string; min: number; max: number; step: number; init: number; scale?: number; help?: string }
  | { t: 'sel'; key: K; label: string; options: [string, string][]; numeric?: boolean; help?: string }
  | { t: 'bool'; key: K; label: string; help?: string };

interface Group {
  id: string;
  title: string;
  open?: boolean;
  fields: FieldDef[];
}

const GROUPS: Group[] = [
  {
    id: 'gabarit',
    title: '2 · Gabarit',
    open: true,
    fields: [
      { t: 'bool', key: 'attic', label: 'Niveau en attique (en retrait)', help: 'Un niveau supplémentaire au-dessus du R+x, en retrait des façades avant et arrière.' },
      { t: 'num', key: 'atticSetback', label: 'Retrait de l’attique', unit: 'm', min: 1, max: 5, step: 0.5 },
      { t: 'opt', key: 'maxHeight', label: 'Hauteur maximale (PLU)', unit: 'm', min: 3, max: 80, step: 0.5, init: 15, help: 'Signale le dépassement et indique le R+x maximal.' },
      { t: 'num', key: 'groundFloorHeight', label: 'Hauteur du rez-de-chaussée', unit: 'm', min: 2.4, max: 6, step: 0.1 },
      { t: 'num', key: 'floorHeight', label: 'Hauteur d’un étage courant', unit: 'm', min: 2.4, max: 4, step: 0.1 },
    ],
  },
  {
    id: 'implantation',
    title: '3 · Implantation',
    open: true,
    fields: [
      { t: 'num', key: 'setbackVoie', label: 'Retrait sur rue', unit: 'm', min: 0, max: 30, step: 0.5, help: '0 = construction à l’alignement.' },
      { t: 'num', key: 'setbackLateral', label: 'Retrait sur limites latérales', unit: 'm', min: 0, max: 30, step: 0.5, help: '0 = construction en limite (mitoyenneté) : c’est ce qui permet les immeubles étroits.' },
      { t: 'num', key: 'setbackFond', label: 'Retrait en fond de parcelle', unit: 'm', min: 0, max: 40, step: 0.5 },
      {
        t: 'sel',
        key: 'prospectRatio',
        label: 'Règle de prospect',
        numeric: true,
        options: [
          ['0', 'Aucune'],
          ['0.5', 'L ≥ H/2'],
          ['0.3333', 'L ≥ H/3'],
          ['1', 'L ≥ H'],
        ],
        help: 'Retrait ≥ hauteur × ratio sur les limites non mitoyennes. Les côtés à 0 (en limite) ne sont pas touchés.',
      },
      { t: 'num', key: 'maxDepth', label: 'Profondeur maximale du bâtiment', unit: 'm', min: 5, max: 40, step: 0.5, help: 'Au-delà de ~12–14 m les logements ne sont plus traversants ni bien éclairés.' },
      { t: 'num', key: 'minWidth', label: 'Largeur minimale exploitable', unit: 'm', min: 3, max: 15, step: 0.5 },
      { t: 'opt', key: 'maxCoverage', label: 'Emprise au sol max (CES)', unit: '%', min: 5, max: 100, step: 1, init: 60, scale: 100 },
      { t: 'num', key: 'minOpenGround', label: 'Pleine terre minimale', unit: '%', min: 0, max: 100, step: 5, help: 'Part du terrain non bâtie, ni dallée, ni excavée.' },
      { t: 'opt', key: 'maxFAR', label: 'Densité max (SDP / terrain)', unit: '', min: 0.1, max: 8, step: 0.05, init: 1.5 },
      {
        t: 'sel',
        key: 'footprintShape',
        label: 'Forme de l’emprise',
        options: [
          ['adapte', 'Adaptée au terrain'],
          ['rectangle', 'Rectangle inscrit'],
        ],
      },
      {
        t: 'sel',
        key: 'placement',
        label: 'Implantation dans la profondeur',
        options: [
          ['auto', 'Automatique (emprise la plus grande)'],
          ['rue', 'Côté rue'],
          ['fond', 'En fond de parcelle'],
        ],
        help: 'En fond de parcelle, la façade sur rue donne sur une cour ou un jardin : accès et défense incendie à prévoir.',
      },
    ],
  },
  {
    id: 'programme',
    title: '4 · Programme',
    open: true,
    fields: [
      {
        t: 'sel',
        key: 'groundFloorUse',
        label: 'Rez-de-chaussée',
        options: [
          ['logement', 'Logements'],
          ['commerce', 'Commerces'],
          ['bureaux', 'Bureaux'],
          ['parking', 'Parking'],
        ],
      },
      {
        t: 'sel',
        key: 'upperUse',
        label: 'Étages',
        options: [
          ['logement', 'Logements'],
          ['bureaux', 'Bureaux'],
        ],
      },
    ],
  },
  {
    id: 'stationnement',
    title: '5 · Stationnement',
    open: true,
    fields: [
      { t: 'num', key: 'parkingPerDwelling', label: 'Places par logement', unit: 'pl.', min: 0, max: 4, step: 0.1 },
      { t: 'num', key: 'parkingPer100Commerce', label: 'Places / 100 m² de commerce', unit: 'pl.', min: 0, max: 10, step: 0.5 },
      { t: 'num', key: 'parkingPer100Office', label: 'Places / 100 m² de bureaux', unit: 'pl.', min: 0, max: 10, step: 0.5 },
      {
        t: 'sel',
        key: 'parkingStrategy',
        label: 'Où stationner ?',
        options: [
          ['auto', 'Surface puis sous-sol'],
          ['sous-sol', 'Sous-sol uniquement'],
          ['surface', 'Surface uniquement'],
          ['rdc', 'Rez-de-chaussée'],
          ['aucun', 'Aucun (non exigé)'],
        ],
      },
      { t: 'num', key: 'maxBasementLevels', label: 'Niveaux de sous-sol max', unit: '', min: 0, max: 4, step: 1 },
    ],
  },
];

const MIX_LABELS: Record<Typology, string> = { T1: 'T1', T2: 'T2', T3: 'T3', T4: 'T4', T5: 'T5+' };

const CHECK_ICON: Record<Check['status'], string> = { ok: '✓', warn: '!', error: '✕', info: 'i' };

export class Ui {
  private readonly syncers: ((s: AppState) => void)[] = [];
  private readonly el: Record<string, HTMLElement> = {};
  private edgeKey = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly h: UiHandlers,
  ) {
    this.build();
  }

  // ---------- construction

  private build(): void {
    this.root.innerHTML = `
      <div id="toolbar" class="toolbar">
        <form id="search" class="search" autocomplete="off">
          <input id="q" type="search" placeholder="Rechercher une adresse…" aria-label="Rechercher une adresse" />
          <button type="submit" title="Rechercher">⌕</button>
        </form>
        <div class="seg" role="group" aria-label="Fond de carte">
          <button data-layer="osm" title="Plan OpenStreetMap">Plan</button>
          <button data-layer="ortho" title="Orthophoto IGN (France)">Photo</button>
          <button data-layer="google" title="Google Photorealistic 3D Tiles (clé API requise)">Google 3D</button>
          <button id="btn-settings" title="Clé API Google">⚙</button>
        </div>
        <div class="seg" role="group" aria-label="Vue">
          <button data-view="top" title="Vue du dessus">Dessus</button>
          <button data-view="oblique" title="Vue oblique 3D">3D</button>
        </div>
        <div class="seg" role="group" aria-label="Contexte">
          <button id="btn-context" title="Bâtiments voisins en volumes 3D (IGN BD TOPO, France)">🏙 Voisinage</button>
        </div>
        <div class="seg sun" role="group" aria-label="Ombres">
          <button id="btn-sun" title="Étude d’ombres (jour courant)">☀ Ombres</button>
          <input id="sun-hour" type="range" min="6" max="21" step="0.25" aria-label="Heure solaire" />
          <output id="sun-out"></output>
        </div>
      </div>
      <div id="hint" class="hint" hidden></div>

      <div id="sheet">
        <aside id="left" class="panel">
          <header class="brand">
            <div class="logo" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="30" height="30"><rect x="9" y="4" width="14" height="24" rx="1.5" fill="#0f766e"/><rect x="12" y="8" width="3" height="3" fill="#fff"/><rect x="17" y="8" width="3" height="3" fill="#fff"/><rect x="12" y="14" width="3" height="3" fill="#fff"/><rect x="17" y="14" width="3" height="3" fill="#fff"/><rect x="12" y="20" width="3" height="3" fill="#fff"/><rect x="17" y="20" width="3" height="3" fill="#fff"/><rect x="3" y="26" width="26" height="2.5" rx="1" fill="#f59e0b"/></svg>
            </div>
            <div><h1>Urbasim</h1><p>Que peut-on construire sur ce terrain&nbsp;?</p></div>
          </header>

          <details class="group" open>
            <summary>1 · Terrain</summary>
            <div class="group-body">
              <div class="btn-row">
                <button id="btn-draw" class="btn primary">✏️ Dessiner</button>
                <button id="btn-cadastre" class="btn" title="France : sélectionne la parcelle cadastrale (IGN)">🗺 Cadastre</button>
                <button id="btn-import" class="btn" title="Importer un contour GeoJSON">📂 Importer</button>
                <button id="btn-clear" class="btn ghost" title="Effacer le terrain">🗑</button>
                <input id="file-import" type="file" accept=".geojson,.json,application/geo+json,application/json" hidden />
              </div>
              <div id="parcel-info" class="info"></div>
              <div id="edges"></div>
            </div>
          </details>

          <details class="group" open>
            <summary>Niveaux : R+x</summary>
            <div class="group-body">
              <div class="stepper">
                <button id="lvl-minus" class="step" aria-label="Moins un étage">−</button>
                <div class="stepper-val"><strong id="lvl-label">R+3</strong><span id="lvl-sub"></span></div>
                <button id="lvl-plus" class="step" aria-label="Plus un étage">+</button>
              </div>
            </div>
          </details>
          ${GROUPS.map((g) => `<details class="group" ${g.open ? 'open' : ''}><summary>${g.title}</summary><div class="group-body" id="g-${g.id}"></div></details>`).join('')}

          <details class="group">
            <summary>Typologies de logements</summary>
            <div class="group-body">
              <div id="mix" class="mix"></div>
              <p class="help">Répartition cible, normalisée automatiquement. Le moteur l’approche logement par logement et niveau par niveau.</p>
            </div>
          </details>
        </aside>

        <aside id="right" class="panel">
          <div id="results"></div>
        </aside>
      </div>

      <dialog id="settings">
        <form method="dialog">
          <h2>Google Photorealistic 3D Tiles</h2>
          <p class="warn"><b>Indisponible en Europe.</b> Google refuse ces tuiles (erreur 403) pour tout projet dont le compte de facturation a une adresse dans l’Espace économique européen, France comprise. Ne renseignez pas une fausse adresse pour contourner : seule une facturation réellement hors EEE fonctionne.</p>
          <p>Avec une facturation hors EEE : collez une clé API Google Maps Platform avec les API <b>Map Tiles</b> et <b>Geocoding</b> activées. La clé reste dans ce navigateur (jamais dans le lien de partage).</p>
          <input id="gkey" type="password" placeholder="AIza…" autocomplete="off" spellcheck="false" />
          <p class="help">La facturation (carte bancaire) est obligatoire et un dépassement du quota gratuit est payant. Une alerte de budget ne plafonne pas la dépense : fixez aussi des quotas (Google Maps Platform → Quotas) et limitez la clé à ces deux API. Google déconseille les restrictions « par site » pour ces API : traitez la clé comme exposée. Cesium indique que ces tuiles ne s’utilisent qu’avec le géocodeur Google : la recherche d’adresse bascule donc sur l’API Geocoding quand ce fond est actif.</p>
          <menu><button value="cancel" class="btn ghost">Annuler</button><button id="gkey-save" value="ok" class="btn primary">Enregistrer</button></menu>
        </form>
      </dialog>`;

    for (const id of ['hint', 'parcel-info', 'edges', 'results', 'mix', 'lvl-label', 'lvl-sub', 'sun-hour', 'sun-out', 'btn-sun', 'settings', 'gkey', 'file-import', 'q']) {
      this.el[id] = this.root.querySelector<HTMLElement>(`#${id}`)!;
    }

    for (const g of GROUPS) {
      const host = this.root.querySelector<HTMLElement>(`#g-${g.id}`)!;
      for (const f of g.fields) host.appendChild(this.field(f));
    }
    this.buildMix();
    this.wireStatic();
  }

  private row(label: string, help?: string): { row: HTMLElement; ctl: HTMLElement } {
    const row = document.createElement('div');
    row.className = 'field';
    const lab = document.createElement('label');
    lab.textContent = label;
    if (help) lab.title = help;
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    row.append(lab, ctl);
    if (help) {
      const p = document.createElement('p');
      p.className = 'help';
      p.textContent = help;
      row.appendChild(p);
    }
    return { row, ctl };
  }

  private field(f: FieldDef): HTMLElement {
    const { row, ctl } = this.row(f.label, f.help);
    if (f.t === 'bool') row.classList.add('inline');
    const key = f.key;
    const set = (v: unknown) => store.setCriteria({ [key]: v } as Partial<Criteria>);
    const get = () => store.get().criteria[key] as unknown;

    if (f.t === 'num') {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = String(f.min);
      input.max = String(f.max);
      input.step = String(f.step);
      const scale = f.unit === '%' ? 100 : 1;
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (Number.isFinite(v)) set(Math.min(f.max, Math.max(f.min, v)) / scale);
      });
      ctl.append(input, this.unit(f.unit));
      this.syncers.push(() => {
        if (document.activeElement !== input) input.value = String(round(((get() as number) ?? 0) * scale));
      });
    } else if (f.t === 'opt') {
      const scale = f.scale ?? 1;
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.setAttribute('aria-label', `Activer : ${f.label}`);
      const input = document.createElement('input');
      input.type = 'number';
      input.min = String(f.min);
      input.max = String(f.max);
      input.step = String(f.step);
      check.addEventListener('change', () => set(check.checked ? f.init / scale : null));
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (Number.isFinite(v)) set(Math.min(f.max, Math.max(f.min, v)) / scale);
      });
      ctl.append(check, input, this.unit(f.unit));
      this.syncers.push(() => {
        const v = get() as number | null;
        check.checked = v !== null;
        input.disabled = v === null;
        if (document.activeElement !== input) input.value = v === null ? '' : String(round(v * scale));
      });
    } else if (f.t === 'sel') {
      const sel = document.createElement('select');
      for (const [v, l] of f.options) sel.add(new Option(l, v));
      sel.addEventListener('change', () => set(f.numeric ? parseFloat(sel.value) : sel.value));
      ctl.appendChild(sel);
      this.syncers.push(() => {
        const cur = String(get());
        const match = f.options.find(([v]) => (f.numeric ? Math.abs(parseFloat(v) - parseFloat(cur)) < 1e-3 : v === cur));
        sel.value = match ? match[0] : f.options[0][0];
      });
    } else {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.addEventListener('change', () => set(check.checked));
      ctl.appendChild(check);
      this.syncers.push(() => (check.checked = Boolean(get())));
    }
    return row;
  }

  private unit(u?: string): HTMLElement {
    const s = document.createElement('span');
    s.className = 'unit';
    s.textContent = u ?? '';
    return s;
  }

  private buildMix(): void {
    const host = this.el['mix'];
    for (const t of TYPOLOGIES) {
      const cell = document.createElement('label');
      cell.className = 'mix-cell';
      cell.innerHTML = `<span>${MIX_LABELS[t]}</span>`;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '100';
      input.step = '5';
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (!Number.isFinite(v)) return;
        const mix = { ...store.get().criteria.mix, [t]: Math.max(0, v) / 100 };
        store.setCriteria({ mix });
      });
      cell.append(input, this.unit('%'));
      host.appendChild(cell);
      this.syncers.push((s) => {
        if (document.activeElement !== input) input.value = String(round(s.criteria.mix[t] * 100));
      });
    }
  }

  private wireStatic(): void {
    const $ = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    $('#btn-draw').addEventListener('click', () => this.h.draw());
    $('#btn-cadastre').addEventListener('click', () => this.h.cadastre());
    $('#btn-clear').addEventListener('click', () => this.h.clear());
    $('#btn-import').addEventListener('click', () => this.el['file-import'].click());
    this.el['file-import'].addEventListener('change', async (ev) => {
      const input = ev.target as HTMLInputElement;
      const file = input.files?.[0];
      if (file) this.h.importGeoJson(await file.text());
      input.value = '';
    });
    // mobile : un toucher sur l'en-tête replie le volet pour voir la carte
    $('.brand').addEventListener('click', () => {
      this.root.querySelector('#sheet')?.classList.toggle('collapsed');
      document.body.classList.toggle('sheet-collapsed');
      // Cesium recalcule la taille du canevas sur l'évènement resize
      window.setTimeout(() => window.dispatchEvent(new Event('resize')), 220);
    });
    $('#lvl-minus').addEventListener('click', () => store.setCriteria({ levels: Math.max(0, store.get().criteria.levels - 1) }));
    $('#lvl-plus').addEventListener('click', () => store.setCriteria({ levels: Math.min(20, store.get().criteria.levels + 1) }));

    $('#search').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const q = (this.el['q'] as HTMLInputElement).value.trim();
      if (q) this.h.search(q);
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-layer]').forEach((b) => b.addEventListener('click', () => this.h.setBaseLayer(b.dataset.layer as BaseLayer)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.addEventListener('click', () => this.h.view(b.dataset.view as 'top' | 'oblique')));
    $('#btn-settings').addEventListener('click', () => this.h.openSettings());
    $('#btn-sun').addEventListener('click', () => store.set({ shadows: !store.get().shadows }));
    $('#btn-context').addEventListener('click', () => store.set({ context: !store.get().context }));
    this.el['sun-hour'].addEventListener('input', () => store.set({ sunHour: parseFloat((this.el['sun-hour'] as HTMLInputElement).value) }));

    // clic sur une arête du plan masse ou sur une ligne du tableau d'arêtes
    this.root.addEventListener('click', (ev) => {
      const t = ev.target as Element;
      const edge = t.closest('[data-edge]') as HTMLElement | null;
      if (edge) this.h.toggleStreet(parseInt(edge.dataset.edge!, 10));
      const sc = t.closest('[data-levels]') as HTMLElement | null;
      if (sc) this.h.pickScenario(parseInt(sc.dataset.levels!, 10));
      const act = t.closest('[data-act]') as HTMLElement | null;
      if (act?.dataset.act === 'kml') this.h.exportKml();
      if (act?.dataset.act === 'geojson') this.h.exportGeoJson();
      if (act?.dataset.act === 'share') this.h.share();
    });
  }

  // ---------- mise à jour

  setHint(msg: string | null, tone: 'info' | 'error' = 'info'): void {
    const el = this.el['hint'];
    el.hidden = !msg;
    el.textContent = msg ?? '';
    el.dataset.tone = tone;
  }

  /** Chargement du bâti IGN en cours : signalé sur le bouton, pour ne jamais écraser un message de la barre d'aide. */
  setContextLoading(on: boolean): void {
    const b = this.root.querySelector<HTMLElement>('#btn-context');
    b?.classList.toggle('loading', on);
    b?.setAttribute('aria-busy', String(on));
  }

  setMode(mode: EditorMode): void {
    this.root.querySelector('#btn-draw')?.classList.toggle('active', mode === 'draw');
    this.root.querySelector('#btn-cadastre')?.classList.toggle('active', mode === 'cadastre');
  }

  setBaseLayer(layer: BaseLayer): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-layer]').forEach((b) => b.classList.toggle('active', b.dataset.layer === layer));
  }

  settingsDialog(): { dialog: HTMLDialogElement; input: HTMLInputElement } {
    return { dialog: this.el['settings'] as HTMLDialogElement, input: this.el['gkey'] as HTMLInputElement };
  }

  update(project: Project | null, state: AppState, scenarios: Scenario[] | null): void {
    for (const s of this.syncers) s(state);
    const c = state.criteria;
    this.el['lvl-label'].textContent = `R+${c.levels}${c.attic ? ' + attique' : ''}`;
    this.el['lvl-sub'].textContent = `${n1(buildingHeight(c))} m · ${c.levels + 1 + (c.attic ? 1 : 0)} niveaux`;

    const sun = this.root.querySelector<HTMLElement>('#btn-sun')!;
    sun.classList.toggle('active', state.shadows);
    this.root.querySelector('#btn-context')?.classList.toggle('active', state.context);
    (this.el['sun-hour'] as HTMLInputElement).value = String(state.sunHour);
    const hh = Math.floor(state.sunHour);
    this.el['sun-out'].textContent = `${hh} h ${String(Math.round((state.sunHour - hh) * 60)).padStart(2, '0')}`;

    this.renderParcelInfo(project, state);
    this.renderEdges(project, state);
    this.renderResults(project, state, scenarios);
  }

  private renderParcelInfo(p: Project | null, s: AppState): void {
    const el = this.el['parcel-info'];
    if (!p || !s.parcel) {
      el.innerHTML = '<p class="muted">Dessinez le terrain sur la carte, ou cliquez sur une parcelle cadastrale (France).</p>';
      return;
    }
    el.innerHTML = `<div class="chips"><span class="chip-stat"><b>${n0(p.parcelArea)} m²</b> terrain</span><span class="chip-stat"><b>${n1(p.parcelMinWidth)} m</b> largeur min.</span><span class="chip-stat"><b>${s.parcel.ring.length}</b> côtés</span></div>${s.parcelLabel ? `<p class="muted">Cadastre : ${esc(s.parcelLabel)}</p>` : ''}<p class="help">Glissez les points blancs pour ajuster, les points bleus pour ajouter un sommet, clic droit pour en supprimer. Cliquez un côté (étiquette numérotée sur la carte, plan masse ou tableau) pour le déclarer <b>sur rue</b>.</p>`;
  }

  private renderEdges(p: Project | null, s: AppState): void {
    const host = this.el['edges'];
    if (!p || !s.parcel || p.edges.length === 0) {
      host.innerHTML = '';
      this.edgeKey = '';
      return;
    }
    const key = `${p.edges.length}|${s.parcel.streetEdges.join(',')}|${p.edges.map((e) => e.kind).join(',')}`;
    if (key !== this.edgeKey) {
      this.edgeKey = key;
      host.innerHTML = `<table class="edges"><thead><tr><th>Côté</th><th>Long.</th><th>Rôle</th><th>Retrait</th></tr></thead><tbody>${p.edges
        .map((e) => {
          const role = e.kind === 'voie' ? 'Rue' : e.kind === 'fond' ? 'Fond' : 'Latéral';
          return `<tr><td>${e.index + 1}</td><td data-len="${e.index}"></td><td><button class="role role-${e.kind}" data-edge="${e.index}" title="Cliquer pour basculer sur rue / limite">${role}</button></td><td><input type="number" min="0" max="40" step="0.5" data-sb="${e.index}" aria-label="Retrait du côté ${e.index + 1}" /> m</td></tr>`;
        })
        .join('')}</tbody></table>`;
      host.querySelectorAll<HTMLInputElement>('input[data-sb]').forEach((input) =>
        input.addEventListener('input', () => {
          const i = parseInt(input.dataset.sb!, 10);
          const cur = { ...store.get().criteria.edgeSetbacks };
          const v = parseFloat(input.value);
          if (Number.isFinite(v)) cur[i] = Math.max(0, v);
          else delete cur[i];
          store.setCriteria({ edgeSetbacks: cur });
        }),
      );
    }
    p.edges.forEach((e) => {
      const len = host.querySelector(`[data-len="${e.index}"]`);
      if (len) len.textContent = `${n1(e.length)} m`;
      const input = host.querySelector<HTMLInputElement>(`input[data-sb="${e.index}"]`);
      if (input) {
        input.placeholder = n1(e.setback).replace(',0', '');
        if (document.activeElement !== input) {
          const ov = s.criteria.edgeSetbacks[e.index];
          input.value = ov === undefined ? '' : String(ov);
        }
      }
    });
  }

  private renderResults(p: Project | null, s: AppState, scenarios: Scenario[] | null): void {
    const el = this.el['results'];
    if (!p || !s.parcel) {
      el.innerHTML = `<div class="empty"><h2>Résultats</h2>
        <ol class="steps"><li><b>Choisissez un terrain</b> — dessinez-le sur la carte (outil ✏️) ou cliquez une parcelle cadastrale.</li>
        <li><b>Indiquez le côté rue</b> — le côté en rouge ; les autres sont des limites avec les voisins.</li>
        <li><b>Réglez vos critères</b> — R+x, retraits, stationnement… le bâtiment se met à jour en direct, sur la carte en 3D.</li></ol></div>`;
      return;
    }
    const i = p.indicators;
    const c = s.criteria;
    const errors = p.checks.filter((k) => k.status === 'error');
    const banner = !p.footprint ? `<div class="banner error"><b>Aucun bâtiment possible.</b> ${esc(p.checks[0]?.detail ?? '')}</div>` : '';
    const pk = p.parking;
    const parkingTxt = pk.required === 0 && c.parkingStrategy !== 'aucun' ? '—' : `${pk.provided}<small> / ${pk.required}</small>`;
    const parkingWhere = [pk.surface ? `${pk.surface} surface` : '', pk.rdc ? `${pk.rdc} RDC` : '', pk.basement ? `${pk.basement} sous-sol (${pk.basementLevels} niv.)` : ''].filter(Boolean).join(' · ');

    const kpis = p.footprint
      ? `<div class="kpis">
          ${kpi('Logements', String(i.dwellings), i.dwellings > 0 ? `${n0(i.shab)} m² habitables` : 'aucun')}
          ${kpi('Surface de plancher', `${n0(i.sdpTotal)}<small> m²</small>`, `SDP / terrain ${n1(i.far).replace(',0', '')}`)}
          ${kpi('Emprise au sol', `${n0(i.footprintArea)}<small> m²</small>`, `${n0(i.coverage * 100)} % du terrain`)}
          ${kpi('Hauteur', `${n1(i.height)}<small> m</small>`, `${i.levelsCount} niveaux${i.hasLift ? ' · ascenseur' : ''}`)}
          ${kpi('Stationnement', parkingTxt, parkingWhere || 'prévu / requis', pk.provided < pk.required && c.parkingStrategy !== 'aucun' ? 'bad' : '')}
          ${kpi('Pleine terre', `${n0(i.openGround * 100)}<small> %</small>`, `min. ${n0(c.minOpenGround * 100)} %`, i.openGround + 1e-3 < c.minOpenGround ? 'bad' : '')}
        </div>`
      : '';

    const typ = p.footprint && i.dwellings > 0 ? `<div class="typ">${TYPOLOGIES.filter((t) => p.typologyCounts[t] > 0).map((t) => `<span class="typ-chip"><b>${p.typologyCounts[t]}</b> ${MIX_LABELS[t]}</span>`).join('')}<span class="muted">moy. ${n0(i.avgDwellingArea)} m²</span></div>` : '';

    const levels = p.footprint
      ? `<table class="levels"><thead><tr><th>Niveau</th><th>Usage</th><th>SDP</th><th>Logts</th></tr></thead><tbody>${[...p.levels]
          .reverse()
          .map((l) => `<tr><td>${l.label}</td><td>${useLabel(l.use)}${l.use === 'parking' ? ` · ${l.parkingSpaces} pl.` : ''}</td><td>${l.use === 'parking' ? '—' : n0(l.sdp) + ' m²'}</td><td>${l.use === 'logement' ? l.dwellings : '—'}</td></tr>`)
          .join('')}${pk.basementLevels > 0 ? `<tr class="sub"><td>S-1…S-${pk.basementLevels}</td><td>Parking · ${pk.basement} pl.</td><td>—</td><td>—</td></tr>` : ''}</tbody></table>`
      : '';

    const checks = p.checks.filter((k) => k.id !== 'footprint').length > 0 ? `<ul class="checks">${p.checks.filter((k) => k.id !== 'footprint').map((k) => `<li class="chk ${k.status}"><span class="ic">${CHECK_ICON[k.status]}</span><div><b>${esc(k.label)}</b><span>${esc(k.detail)}</span></div></li>`).join('')}</ul>` : '';

    const sc = scenarios
      ? `<table class="scen"><thead><tr><th>Niveaux</th><th>H</th><th>SDP</th><th>Logts</th><th>Parking</th><th></th></tr></thead><tbody>${scenarios
          .map((x) => {
            const q = x.project.indicators;
            const cur = x.levels === c.levels;
            const pkx = x.project.parking;
            return `<tr data-levels="${x.levels}" class="${cur ? 'cur' : ''} ${x.compliant ? '' : 'nok'}"><td>R+${x.levels}</td><td>${n1(q.height)} m</td><td>${x.project.footprint ? n0(q.sdpTotal) : '—'}</td><td>${x.project.footprint ? q.dwellings : '—'}</td><td>${x.project.footprint ? `${pkx.provided}/${pkx.required}` : '—'}</td><td>${x.compliant ? '✓' : '✕'}</td></tr>`;
          })
          .join('')}</tbody></table><p class="help">Même terrain et mêmes critères, seul le nombre d’étages change. ✕ = au moins une contrainte dure non respectée (hauteur, emprise, densité, stationnement).</p>`
      : '';

    el.innerHTML = `
      <h2>Résultats</h2>
      ${banner}
      ${kpis}
      ${typ}
      <section><h3>Plan masse</h3>${p.footprint ? `<p class="plan-cap"><b>Emprise ${n1(i.facadeWidth)} × ${n1(i.depth)} m</b> · ${n0(i.footprintArea)} m² · ${n0(i.coverage * 100)} % du terrain</p>` : ''}<div class="plan">${planSvg(p, s.parcel)}</div>
        <div class="legend"><span class="lg parcel"></span>Terrain <span class="lg env"></span>Zone constructible <span class="lg fp"></span>Emprise <span class="lg street"></span>Rue</div></section>
      ${checks ? `<section><h3>Contrôles${errors.length ? ` <span class="badge error">${errors.length}</span>` : ''}</h3>${checks}</section>` : ''}
      ${levels ? `<section><h3>Niveaux</h3>${levels}</section>` : ''}
      ${sc ? `<section><h3>Comparer les hauteurs</h3>${sc}</section>` : ''}
      <section class="exports"><h3>Exporter</h3>
        <div class="btn-row">
          <button class="btn primary" data-act="kml" ${p.footprint ? '' : 'disabled'} title="Ouvrir dans Google Earth (Web, Pro, mobile)">⬇ KML · Google Earth</button>
          <button class="btn" data-act="geojson" ${p.footprint ? '' : 'disabled'}>⬇ GeoJSON</button>
          <button class="btn" data-act="share">🔗 Lien</button>
        </div></section>
      <p class="disclaimer">Pré-faisabilité indicative : hypothèses simplifiées (noyaux, rampes, ratios SHAB/SDP…). À confronter au PLU applicable et à un professionnel avant toute décision.</p>
      <p class="disclaimer">Données : fonds © contributeurs OpenStreetMap ou orthophotographie © IGN ; bâtiments voisins : IGN, BD TOPO® (Licence Ouverte 2.0), date de mise à jour affichée sur la carte ; cadastre © IGN / DGFiP (Licence Ouverte Etalab) ; voies © contributeurs OpenStreetMap (ODbL).</p>`;
  }
}

function kpi(label: string, value: string, sub: string, tone = ''): string {
  return `<div class="kpi ${tone}"><span class="kpi-l">${label}</span><span class="kpi-v">${value}</span><span class="kpi-s">${sub}</span></div>`;
}

function useLabel(u: string): string {
  return u === 'logement' ? 'Logements' : u === 'commerce' ? 'Commerce' : u === 'bureaux' ? 'Bureaux' : 'Parking';
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
