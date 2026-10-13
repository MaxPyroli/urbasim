import * as Cesium from 'cesium';
import type { BaseLayer } from './state';
import type { LonLat } from '../engine';

const OSM = () => new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/', maximumLevel: 19 });

const IGN_ORTHO = () =>
  new Cesium.UrlTemplateImageryProvider({
    url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    maximumLevel: 19,
    credit: new Cesium.Credit('Orthophotographie © IGN', false),
  });

/** Enveloppe de la scène Cesium : fonds de carte, 3D Tiles Google, pointage du sol, hauteur du sol. */
export class MapView {
  readonly viewer: Cesium.Viewer;
  /** Altitude (ellipsoïdale) du sol sous le terrain, mesurée sur les 3D Tiles quand elles sont actives. */
  groundBase = 0;
  private google: Cesium.Cesium3DTileset | null = null;
  private layer: BaseLayer = 'osm';

  constructor(container: HTMLElement) {
    this.viewer = new Cesium.Viewer(container, {
      baseLayer: new Cesium.ImageryLayer(OSM()),
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shadows: false,
    });
    const scene = this.viewer.scene;
    scene.globe.depthTestAgainstTerrain = false;
    scene.screenSpaceCameraController.minimumZoomDistance = 3;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
    this.viewer.scene.globe.enableLighting = false;
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(2.3522, 48.8566, 900),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    });
  }

  get hasGoogle(): boolean {
    return this.google !== null;
  }

  async setBaseLayer(kind: BaseLayer, googleKey: string): Promise<void> {
    const { viewer } = this;
    const layers = viewer.imageryLayers;
    if (kind === 'google') {
      if (!googleKey) throw new Error('Clé API Google manquante.');
      const tileset = await Cesium.createGooglePhotorealistic3DTileset({ key: googleKey, onlyUsingWithGoogleGeocoder: true });
      this.removeGoogle();
      this.google = tileset;
      viewer.scene.primitives.add(tileset);
      viewer.scene.globe.show = false;
    } else {
      this.removeGoogle();
      viewer.scene.globe.show = true;
      layers.removeAll();
      layers.addImageryProvider(kind === 'ortho' ? IGN_ORTHO() : OSM());
    }
    this.layer = kind;
    this.groundBase = 0;
  }

  private removeGoogle(): void {
    if (this.google) {
      this.viewer.scene.primitives.remove(this.google);
      this.google = null;
    }
  }

  get layerKind(): BaseLayer {
    return this.layer;
  }

  /** Point du sol sous un pixel : intersection du rayon avec la surface à l'altitude `groundBase`. */
  pickGround(pos: Cesium.Cartesian2): LonLat | undefined {
    const ray = this.viewer.camera.getPickRay(pos);
    if (!ray) return undefined;
    const r = Cesium.Ellipsoid.WGS84.radii;
    const h = this.groundBase;
    const shell = new Cesium.Ellipsoid(r.x + h, r.y + h, r.z + h);
    const hit = Cesium.IntersectionTests.rayEllipsoid(ray, shell);
    if (!hit) return undefined;
    const p = Cesium.Ray.getPoint(ray, hit.start);
    const c = Cesium.Cartographic.fromCartesian(p);
    return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) };
  }

  /** Mesure l'altitude du sol à un endroit (3D Tiles Google) ; 0 si seule la carte à plat est active. */
  async sampleGround(lon: number, lat: number): Promise<number> {
    if (!this.google) {
      this.groundBase = 0;
      return 0;
    }
    try {
      const carto = Cesium.Cartographic.fromDegrees(lon, lat);
      const [res] = await this.viewer.scene.sampleHeightMostDetailed([carto]);
      if (res && Number.isFinite(res.height)) {
        this.groundBase = res.height;
        return res.height;
      }
    } catch {
      /* échantillonnage impossible (tuiles pas encore chargées) */
    }
    return this.groundBase;
  }

  /**
   * Cadre le terrain (et le bâtiment, de hauteur `top`). `heading` = azimut de la caméra en radians :
   * passer celui de la rue pour arriver face à la façade principale.
   */
  flyToParcel(ring: LonLat[], view: 'top' | 'oblique' = 'oblique', top = 0, heading = 0): void {
    const h = this.groundBase;
    const pts = ring.flatMap((p) => [Cesium.Cartesian3.fromDegrees(p.lon, p.lat, h), Cesium.Cartesian3.fromDegrees(p.lon, p.lat, h + top)]);
    const sphere = Cesium.BoundingSphere.fromPoints(pts);
    const range = Math.max(sphere.radius * 4.2, 75);
    const rot = view === 'top' ? 0 : heading + Cesium.Math.toRadians(22);
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.4,
      offset: new Cesium.HeadingPitchRange(rot, Cesium.Math.toRadians(view === 'top' ? -90 : -32), range),
    });
  }

  flyToLonLat(lon: number, lat: number, height = 350): void {
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height + this.groundBase),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 1.6,
    });
  }

  /** Étude d'ombres : place le soleil à l'heure donnée pour la date du jour au lieu du terrain. */
  setSun(enabled: boolean, hour: number, lon: number): void {
    const { viewer } = this;
    viewer.shadows = enabled;
    viewer.scene.globe.enableLighting = enabled;
    if (viewer.scene.shadowMap) {
      viewer.scene.shadowMap.softShadows = true;
      viewer.scene.shadowMap.size = 2048;
      viewer.scene.shadowMap.maximumDistance = 2500;
    }
    const now = new Date();
    // heure solaire locale -> UTC (15° de longitude = 1 h)
    const utcHours = hour - lon / 15;
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    d.setUTCMinutes(Math.round(utcHours * 60));
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(d);
    viewer.clock.shouldAnimate = false;
  }
}
