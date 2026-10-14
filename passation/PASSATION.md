# Passation : d'Urbasim (outil de pré-faisabilité) au jeu « Urbasim »

Ce dossier est autonome : copiez `passation/` dans le nouveau dépôt. `moteur/` contient le moteur de calcul, ses
services réseau et ses 129 tests (`npm install && npm test` dans ce dossier). Origine : dépôt `maxpyroli/urbasim`,
branche `claude/beautiful-goldberg-1wk8jn`, commit `50ead9f`. L'outil tourne sur https://maxpyroli.github.io/urbasim/.

## 1. Le projet d'origine

Outil web (Vite + TypeScript + CesiumJS) : on choisit un terrain sur une carte 3D (dessin à la main, ou parcelle
cadastrale IGN), on saisit des critères (R+x, retraits, hauteur, emprise, stationnement, mix de typologies…) et on obtient
un bâtiment généré sur le terrain avec logements, surface de plancher, parking, contrôles, plan masse, vue 3D dans son
environnement, exports KML/GeoJSON. Cible : petits immeubles étroits, constructions mitoyennes, contexte français.

## 2. Le moteur (`moteur/src/engine/`) — TypeScript pur, sans navigateur, déterministe

| Fichier | Rôle |
|---|---|
| `types.ts`, `defaults.ts` | Types (Criteria, Parcel, Project…), critères et hypothèses par défaut (`DEFAULT_ASSUMPTIONS` : ratios noyau, rampes, SHAB/SDP, places…) |
| `geometry.ts` | Projection locale, polygones (polygon-clipping), repère de rue `Frame`, capsules, largeur minimale |
| `layout.ts` | Classement des côtés (rue / latéral / fond), retraits, enveloppe constructible, rôle des façades |
| `footprint.ts` | Emprise : « adaptée » (tranche depuis la rue, L sur terrain d'angle) ou « rectangle inscrit » ; implantation rue / fond / automatique |
| `program.ts` | Niveaux, surface de plancher, noyau, local vélos, remplissage en logements par typologie |
| `parking.ts`, `access.ts` | Places requises, surface / rez-de-chaussée / sous-sol (niveaux, rampe), entrée de parking (porte 3,5 m, allée, rampe) |
| `project.ts` | `computeProject(parcel, criteria)` : orchestre tout et rend un `Project` (indicateurs, contrôles) |
| `scenarios.ts` | Comparaison R+0 à R+9 |
| `buildings.ts` | Bâti voisin IGN BD TOPO : lecture, hauteurs, découpage par le terrain, mention de licence |
| `plu.ts` | Lecture des réponses du Géoportail de l'Urbanisme (zone, règlement PDF, prescriptions) |
| `export.ts`, `ringEdit.ts` | KML / GeoJSON ; édition de contour |

`moteur/src/app/services.ts` : appels réseau sans clé et avec CORS ouvert — cadastre IGN (`fetchCadastreParcel`),
bâtiments (`fetchNearbyBuildings`, WFS Géoplateforme), voies OSM (Overpass), PLU (`fetchPlu`, API Carto GPU), géocodage.
`state.ts` : état de l'appli (non nécessaire au jeu, gardé pour `sanitize`).

L'interface (Cesium, plan masse SVG, panneaux, `main.ts`) est restée dans le dépôt d'origine : à reprendre au besoin.

## 3. Ce qui est vérifié, ce qui ne l'est pas

Vérifié : 129 tests unitaires (dont 5 vrais bâtiments BD TOPO, le client WFS avec faux réseau, l'implantation, le terrain
d'angle, l'entrée de parking) ; parcours navigateur sur le vrai service IGN (parcelle cadastrale AS 0043, Paris : 208
bâtiments, 1 retiré) ; bloc PLU sur Paris (zone UG).

Non vérifié :
- le site en ligne après les 3 derniers envois (terrain d'angle, entrée de parking, PLU) : contrôlés en local seulement ;
- le fond Google 3D avec une vraie clé (indisponible depuis l'EEE, France comprise) ;
- Overpass/OSM (injoignable depuis l'environnement de développement) ;
- le PLU hors Paris (PLUi, cartes communales, plusieurs zones) ;
- l'ouverture du KML dans Google Earth.

Limites connues du moteur : pré-faisabilité, pas un dossier réglementaire ; toiture plate, terrain plat ; ratios
(noyaux, rampes, SHAB/SDP) = ordres de grandeur ; le règlement du PLU n'est pas lu (texte libre dans un PDF) ; un seul
bâtiment par terrain ; accès au bâtiment en fond de parcelle et défense incendie non modélisés.

## 4. L'idée du jeu (à orienter)

Un « Monopoly de la vraie vie » : une carte réelle (échelle à choisir), plusieurs joueurs, chacun promoteur en
concurrence. On achète des terrains, on construit, démolit, surélève, démolit-reconstruit, pour générer des bénéfices ;
il faut rester rentable, avec des variables ajustables. Réalisme fondé sur le moteur. Les **appels d'offres** d'une
collectivité jouent le rôle des enchères du Monopoly.

### Ce qui manque, par priorité
1. **Bilan du promoteur** (cœur du jeu) : prix du terrain, coût de construction au m² de SDP, prix de vente au m²,
   frais, crédit et taux, durée de chantier, marge. Données réelles possibles : ventes immobilières publiques (DVF, prix
   au m² par quartier), indices de coûts de construction.
2. **Serveur** (l'outil est un site statique) : base partagée (propriétés, argent), serveur qui fait foi (validation des
   actions, anti-triche). Le moteur déterministe permet de rejouer et valider.
3. **Tour de jeu** : un tour par trimestre, jouable en asynchrone.
4. **Règles d'urbanisme du jeu** : règles simplifiées par type de zone (hauteur, emprise, retraits), le zonage réel du
   Géoportail servant à choisir la règle applicable.
5. **Appels d'offres** : la commune propose un terrain avec cahier des charges (part de logement social, hauteur max,
   commerces en rez-de-chaussée…) ; offres sur prix + programme + qualité ; sélection par pondération annoncée.
6. **Aléas / événements** : hausse des taux, recours des voisins, sol pollué, fouilles archéologiques, retournement du
   marché (équivalent des cartes chance).

### Décisions à prendre
- Échelle : conseil de départ = un quartier (quelques centaines de parcelles), pas une ville entière.
- Prix réels ou seulement inspirés du réel (à Paris rien n'est rentable en vrai).
- Nombre de joueurs, synchrone ou asynchrone, concurrents gérés par l'ordinateur pour jouer seul.
- Condition de victoire (fortune au bout de N années, autre).
- Nom : le jeu reprend « Urbasim » ; l'outil d'origine peut être renommé.

### Ordre proposé
1. Bilan du promoteur au-dessus du moteur (utile aussi à l'outil de pré-faisabilité).
2. Mode solo : acheter, construire, vendre, avec concurrents gérés par l'ordinateur.
3. Serveur et multijoueur.
4. Appels d'offres et événements.

## 5. Données et licences
- Cadastre et BD TOPO : IGN, Licence Ouverte 2.0 — mention de la source **et de la date de mise à jour** obligatoire
  (`buildingsCredit` produit le texte). Voir README du dépôt d'origine.
- PLU : Géoportail de l'Urbanisme via `apicarto.ign.fr/api/gpu` ; règlements PDF sous `data.geopf.fr/annexes/gpu`.
- Limites du WFS IGN : 30 requêtes/s/IP (blocage 5 s au-delà), 5 000 objets/requête ; le client réessaie (1 s puis 5,5 s).
- Fonds de carte : OpenStreetMap (attribution), photo aérienne IGN. Google 3D Tiles : clé de l'utilisateur, quotas payants.

## 6. Pour démarrer la nouvelle session
Donnez-lui ce fichier et dites par exemple : « Reprends le moteur de `passation/moteur`, crée la structure du jeu, et
commence par le bilan du promoteur (module pur, testé), à brancher sur `computeProject`. » Vérifiez que la session a
bien accès au nouveau dépôt.
