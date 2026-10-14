# Urbasim

**Que peut-on construire sur ce terrain ?** Urbasim est un simulateur de pré-faisabilité immobilière à la française
(et plus largement à l'européenne) : on dessine un terrain, on fixe ses critères (R+x, retraits, stationnement…) et
l'outil génère l'immeuble correspondant — en 3D dans son environnement, avec surfaces, nombre de logements et places
de stationnement.

Il vise le cas que les outils « à l'américaine » traitent mal : **l'immeuble étroit sur petite parcelle**, construit en
mitoyenneté, comme on en fait partout en centre-ville.

![Aperçu : un immeuble R+4 + attique sur une parcelle en lanière de 9 × 32 m](docs/apercu.jpg)

## Démarrage

Prérequis : Node.js 20 ou plus.

```bash
npm install
npm run dev        # http://localhost:5173
```

Autres commandes : `npm test` (tests du moteur), `npm run typecheck`, `npm run build` (site statique dans `dist/`,
hébergeable n'importe où).

## Version en ligne (GitHub Pages)

Le workflow `.github/workflows/pages.yml` teste, compile et publie le site à chaque push sur la **branche par défaut**
du dépôt (quel que soit son nom). À faire une seule fois :

1. Dépôt → **Settings → Pages → Build and deployment → Source : « GitHub Actions »**.
2. Dépôt → **Actions → Pages → Run workflow** (ou simplement pousser un nouveau commit).

Adresse attendue : `https://maxpyroli.github.io/urbasim/`. Le premier passage du workflow échoue tant que
l'étape 1 n'est pas faite : c'est normal, relancez-le après.

À savoir :
- GitHub Pages sur un **dépôt privé** exige un abonnement payant (Pro, Team ou Enterprise), et le site publié est
  **public** même si le dépôt reste privé. Sur l'offre gratuite, le dépôt doit être public.
- L'application ne contient aucun secret : chaque utilisateur colle sa propre clé Google dans son navigateur
  (voir la section sur le fond Google 3D, et notamment sa limite géographique).

## Utilisation

1. **Terrain** — au choix :
   - ✏️ **Dessiner** : cliquez les angles sur la carte (double-clic ou Entrée pour fermer). Ensuite, glissez les
     points blancs pour ajuster, les points bleus pour ajouter un sommet, clic droit pour en supprimer.
   - 🗺 **Cadastre** (France) : cliquez une parcelle, elle est importée avec sa référence. Les côtés sans voisin sont
     déclarés « sur rue ».
   - 📂 **Importer** un contour GeoJSON.
2. **Côté rue** — le côté en rouge. Cliquez un côté (sur la carte 3D, le plan masse ou le tableau) pour le basculer.
   Pour un terrain dessiné à la main, Urbasim le devine d'après les voies OpenStreetMap, ou à défaut le plus petit côté.
3. **Critères** — R+x avec les boutons − / +, attique, retraits, hauteur max, emprise max, pleine terre, densité,
   programme (logements / commerces / bureaux), mix de typologies, stationnement. Tout se recalcule en direct.
4. **Résultats** — logements, surface de plancher, emprise, hauteur, stationnement, pleine terre, contrôles
   réglementaires, plan masse, détail par niveau, et un **tableau comparatif R+0 … R+9** pour voir d'un coup d'œil
   jusqu'où on peut aller (cliquez une ligne pour l'appliquer).
5. **Google Earth** — deux voies :
   - le fond **Google 3D** (voir ci-dessous) place le projet dans les Photorealistic 3D Tiles de Google ;
   - **⬇ KML** exporte terrain, zone constructible et volumes extrudés, à ouvrir dans Google Earth (Web, Pro, mobile).

Le bouton **🏙 Voisinage** affiche les bâtiments alentour en volumes 3D gris (voir « Bâti voisin » plus bas) pour situer
le projet dans son quartier : c'est l'alternative gratuite, sans clé, au fond Google 3D. Ce qui existe sur le terrain
est retiré (les bâtiments sont découpés au contour du terrain), puisque le projet le remplacerait. Le bâti voisin
disparaît le temps du dessin et de la sélection cadastre : un clic sur un toit viserait sinon le sol derrière lui.

Le bouton **🔗 Lien** copie une URL qui contient le terrain et tous les critères, pour partager ou reprendre plus tard.
L'**étude d'ombres** (☀) place le soleil à l'heure choisie, le jour même, et projette les ombres du projet et des
bâtiments voisins. La vue oblique (cadrage automatique à l'arrivée sur un terrain, bouton « 3D ») est inclinée à −55°
pour passer au-dessus des immeubles d'en face ; « Dessus » cadre à la verticale.

### Fonds de carte

| Fond | Clé requise | Remarque |
| --- | --- | --- |
| Plan (OpenStreetMap) | non | par défaut |
| Photo (orthophoto IGN) | non | France uniquement |
| Google 3D (Photorealistic 3D Tiles) | **oui** | voir ci-dessous |

#### Fond Google 3D : lire avant de créer une clé

**Indisponible si l'adresse de facturation du projet Google est dans l'Espace économique européen (France
comprise).** Google renvoie une erreur 403 pour les Photorealistic 3D Tiles dans ce cas (page Google « Map Tiles API
in the EEA », mise à jour le 8 octobre 2026). La règle suit l'adresse du compte de facturation, pas la localisation de
l'utilisateur ; ne renseignez pas une fausse adresse pour la contourner. Google cite les « 3D Maps » de l'API
Maps JavaScript comme alternative possible, sans préciser leur disponibilité dans l'EEE ; Urbasim ne les utilise pas.

Si votre facturation est réellement hors EEE :

1. Console Google Cloud → créer un projet → rattacher un **compte de facturation** (carte bancaire obligatoire ; les
   nouveaux comptes Google Cloud ont 300 $ de crédit d'essai valables 90 jours).
2. Activer **Map Tiles API** et **Geocoding API** (API et services → Bibliothèque).
3. Identifiants → Créer des identifiants → **Clé API**, puis la coller dans ⚙ dans Urbasim.
4. Limiter la clé à ces deux API, **fixer des quotas** (Google Maps Platform → Quotas) et créer une **alerte de
   budget**. Une alerte seule ne plafonne pas la dépense.

Coûts (grille Google du 8 octobre 2026, à revérifier) : 1 000 requêtes de tuiles 3D gratuites par mois puis 6 $ les
1 000 jusqu'à 100 000 ; 10 000 géocodages gratuits par mois puis 5 $ les 1 000. La documentation de Google ne dit pas
clairement si c'est la requête racine ou chaque tuile qui est facturée : surveillez la consommation les premiers jours.

La clé reste dans le navigateur et n'est jamais incluse dans le lien de partage. Google range Map Tiles et Geocoding
parmi les API « web service » pour lesquelles il recommande des restrictions par adresse IP, inadaptées à un site
public : une restriction par site (référent HTTP) n'est pas garantie de fonctionner et n'est pas documentée pour ces
API. Traitez donc la clé comme **exposée** : c'est pourquoi les quotas sont la vraie protection.

Cesium indique que ces tuiles ne doivent être utilisées qu'avec le géocodeur de Google : la recherche d'adresse bascule
donc automatiquement sur l'API Geocoding quand ce fond est actif (et sur Nominatim/OpenStreetMap sinon). Google exige
aussi l'affichage de son logo et des attributions de données, ce que fait l'application avec ce fond.

## Bâti voisin (IGN BD TOPO)

Les bâtiments voisins viennent de la **BD TOPO® de l'IGN** (couche `BDTOPO_V3:batiment`), lue directement depuis votre
navigateur sur le service WFS de la Géoplateforme (`data.geopf.fr`), sans clé ni serveur intermédiaire. Elle couvre la
France ; ailleurs, aucun bâtiment n'est affiché.

- **Licence** : Licence Ouverte 2.0 (Etalab). La réutilisation, y compris commerciale, l'affichage public et les
  produits dérivés sont permis ; la seule condition est de mentionner la **source et la date de dernière mise à jour**.
  L'application affiche donc sur la carte « Bâtiments : IGN, BD TOPO® (Licence Ouverte 2.0), objets modifiés jusqu'au
  JJ/MM/AAAA », où la date est la modification la plus récente parmi les bâtiments chargés (ou, si aucune date n'est
  renseignée, la date de consultation). La BD TOPO ne propose pas de formule de mention officielle : celle-ci applique
  le texte de la licence. Pour l'agglomération lyonnaise, l'IGN précise qu'une partie des bâtiments provient des
  données ouvertes de la Métropole de Lyon ; le nombre d'étages vient des fichiers fonciers MAJIC (DGFiP).
- **Hauteurs** : celle de la BD TOPO (une valeur de 0 signifie « inconnue »). Sans hauteur (environ 6 % des bâtiments
  à Paris), on estime nombre d'étages × 2,95 m, ou 6 m sans aucune information ; ces volumes sont teintés plus clair.
- **Terrain et bâti existant** : le terrain étudié est soustrait des bâtiments voisins. Un bâtiment entièrement sur le
  terrain disparaît ; un bâtiment qui le déborde (voisin mitoyen, ou terrasse de plusieurs lots que la BD TOPO enregistre
  comme un seul polygone) est découpé : seule la partie hors du terrain reste dessinée, à la même hauteur. Un
  recouvrement de moins de 0,5 m² (écart de numérisation entre cadastre et BD TOPO) ne change rien. Si le contour du
  terrain est invalide (côtés qui se croisent, points alignés), rien n'est découpé.
- **Limites du service** : 30 requêtes par seconde et par IP (au-delà, blocage de 5 secondes), 5 000 objets par requête,
  usage prévu pour des emprises raisonnables. Urbasim demande une zone d'environ 300 à 900 m de large, par pages de
  1 000 bâtiments, avec au plus 4 pages, et réessaie après une coupure ou un blocage. Si la zone est plus dense, un
  message l'indique.
- **Avec le fond Google 3D**, qui montre déjà les bâtiments, les volumes IGN se superposent à ceux de Google : désactivez
  🏙 Voisinage pour éviter ce doublon.
- **Chargement** : un indicateur tourne sur le bouton 🏙 Voisinage pendant la requête (sans masquer les messages).
- **Volumes simples** : prismes à toit plat, sans façades ni toitures réelles, posés à l'altitude du sol du fond de carte
  actif (reconstruits si elle change, par exemple en passant de OpenStreetMap à Google 3D).

## PLU (Géoportail de l'Urbanisme)

Dès qu'un terrain est choisi, un bloc « PLU » indique le **zonage** (code, libellé, type U/AU/A/N), le type de document
(PLU, PLUi, POS, carte communale), la date de validation, un lien vers le **règlement écrit (PDF)** de la zone et la
liste des **prescriptions graphiques** qui recoupent le terrain (hauteur plafond, alignement, emplacement réservé…). Les
données viennent de l'API Carto de l'IGN (`apicarto.ign.fr/api/gpu`, sans clé, CORS ouvert) ; le PDF est servi par la
Géoportail (`data.geopf.fr/annexes/gpu`). Sans document numérisé (règlement national d'urbanisme, document non publié),
le bloc le dit et renvoie vers le Géoportail.

**Limites** : Urbasim ne lit pas le règlement — retraits, hauteur, emprise et stationnement sont du texte libre dans le
PDF. C'est à vous de les reporter dans « Gabarit ». Les prescriptions sont listées mais pas encore dessinées sur la carte
ni converties en critères. Vérifié sur Paris (zone UG) ; non testé ailleurs (PLUi, cartes communales, plusieurs zones).

## Comment le calcul fonctionne

Tout est dans `src/engine/` : du TypeScript pur, sans dépendance au navigateur, testé par `tests/engine.test.ts`.

1. **Repère local** : le terrain (lon/lat) est projeté en mètres autour de son centre.
2. **Retraits** : chaque côté a un retrait (0 = en limite, mitoyen). La zone constructible est le terrain moins, pour
   chaque côté, tous les points situés à moins de `retrait` de ce côté (distance au segment, pas à la droite — ce qui
   traite correctement les angles rentrants et les terrains en L). Le **prospect** (L ≥ H/2, H/3 ou H) relève les
   retraits des limites non mitoyennes en fonction de la hauteur ; les côtés à 0 ne sont pas touchés.
3. **Emprise** : dans un repère aligné sur la rue, on tranche la zone constructible à la profondeur maximale (formes
   « adaptée » au terrain ou « rectangle inscrit »). **Implantation** : côté rue, en fond de parcelle (même calcul depuis
   le fond, la façade sur rue donne alors sur une cour ou un jardin), ou *automatique* — le défaut — qui retient le fond
   seulement s'il offre au moins 3 % d'emprise de plus (terrain qui s'élargit vers l'arrière), la rue l'emportant à
   égalité. Sur un lot rectangulaire les deux positions sont équivalentes : choisissez « En fond de parcelle » pour
   libérer la rue. Sur un **terrain d'angle** (autre côté sur rue d'au moins la largeur minimale), l'emprise « adaptée » longe toutes les rues sur la profondeur maximale (un « L »), sauf si ces bandes refermaient une cour. **Entrée du parking** : avec un sous-sol (ou un rez-de-chaussée en parking), une porte de 3,5 m est placée à l'extrémité de la façade sur rue la plus longue, avec l'allée jusqu'à la voie si le bâtiment est en retrait, et la rampe (≈ 15 m² pris au rez-de-chaussée) ; position indicative, cheminement et visibilité non vérifiés. L'emprise est réduite si l'emprise au sol ou la densité maximales l'exigent. L'outil indique ce qui a
   limité l'emprise. Non modélisés : l'accès depuis la rue jusqu'à un bâtiment en fond (cheminement, défense incendie)
   et la possibilité de deux corps de bâtiment (sur rue et en fond).
4. **Niveaux** : hauteur = RDC + x étages (+ attique en retrait). Surface de plancher = emprise moins l'épaisseur des
   murs, **hors parkings**. Noyau escalier/ascenseur déduit à chaque niveau (ascenseur à partir de R+3).
   Rez-de-chaussée : hall, local poubelles et **local vélos** (0,75 m² par T1/T2, 1,5 m² au-delà, 3 m² minimum).
5. **Logements** : par niveau, la surface habitable est répartie en typologies T1–T5+ au plus près du mix demandé,
   avec un nombre de logements borné par la longueur de façade éclairée (4 m minimum par logement). Les murs
   mitoyens ne comptent pas comme façade.
6. **Stationnement** : places requises (par logement, par 100 m² de commerce ou de bureaux), puis capacité en surface,
   en rez-de-chaussée ou en sous-sol (rampe, noyau, niveaux nécessaires). Le sous-sol se loge sous le bâtiment et les
   places de surface avant de consommer de la pleine terre. Un terrain de moins de 5,5 m de large ne permet pas de
   rampe.
7. **Contrôles** : hauteur, emprise, pleine terre, densité, stationnement, profondeur d'éclairement… avec le R+x
   maximal compatible avec la hauteur autorisée.

Les valeurs courantes (épaisseurs, noyaux, ratios, surfaces types des logements, 25 m² par place…) sont regroupées
dans `src/engine/defaults.ts` (`DEFAULT_ASSUMPTIONS`) pour être ajustées.

## Limites à connaître

- **Pré-faisabilité, pas un dossier réglementaire.** Urbasim ne lit pas le PLU : c'est à vous de saisir les règles
  applicables (retraits, hauteur, emprise, stationnement…). Les règles plus fines — gabarit-enveloppe, hauteurs
  différentes sur rue et en fond, règles de prospect asymétriques, servitudes — ne sont pas modélisées.
- Toiture **plate** uniquement, terrain **plat** (le sol 3D est mesuré en un point), pas de plan détaillé des
  logements : leur nombre vient d'une heuristique de surface et de façade, pas d'un plan d'étage.
- Les ratios (noyaux, rampes, SHAB/SDP, ascenseur à partir de R+3…) sont des ordres de grandeur à vérifier.
- Le calage vertical sur les 3D Tiles Google mesure l'altitude du sol au centre du terrain ; si un bâtiment existant
  s'y trouve, la mesure donne son toit — ajustez alors le décalage.
- Le bâti voisin est un contexte indicatif : volumes simples, hauteurs parfois estimées, aucune vérification de
  vues ni de prospects sur ces bâtiments.
- L'affichage 3D demande **WebGL**. Sans lui (navigateur ancien, accélération matérielle coupée), la page l'explique
  au lieu de rester vide. Si le rendu plante en cours de session, Urbasim relance l'affichage, retire le bâti voisin
  quand c'est lui qui est en cause (ou si l'erreur se répète), et affiche un message après trois erreurs rapprochées
  (moins d'une minute d'écart).

## Ce qui a été vérifié, et ce qui ne l'a pas été

Vérifié (tests automatiques et captures dans un Chromium headless) : le moteur de calcul et la lecture des données du
bâti (129 tests, dont 5 vrais bâtiments de la BD TOPO, le client du service IGN avec un faux réseau — pagination, tentatives, erreurs — et la lecture de l'état enregistré), le dessin et l'édition du terrain, l'import cadastre IGN (la
surface calculée correspond à la contenance cadastrale), le rendu 3D sur fond OSM et photo IGN, l'étude d'ombres, le lien
de partage (y compris corrompu), la validité XML du KML, l'affichage mobile, le repli en cas de clé Google invalide.
Pour le bâti voisin, sur le vrai service de l'IGN : 208 à 217 bâtiments chargés autour d'une parcelle de Paris, un seul
bâtiment retiré (celui de la parcelle cadastrale AS 0043), et les cas d'échec — service coupé, erreur 503 puis succès à
la nouvelle tentative, erreur 404 sans nouvelle tentative, terrain hors de France, bascules rapides, réponse tardive d'une
autre zone ignorée, terrain effacé pendant le chargement, contour dégénéré, changement d'altitude du sol, bâti masqué
pendant le dessin et la sélection cadastre, plantage du rendu (une seule boucle d'affichage après chaque reprise ; une
géométrie invalide retire le bâti sans toucher au reste ; un message apparaît sans WebGL ou après des erreurs répétées).

**Non vérifié** (pas de clé ni d'accès réseau adaptés dans l'environnement de développement) :
- le fond **Google 3D Tiles avec une vraie clé** (et a fortiori hors EEE), le calage altimétrique qui en dépend, et
  l'affichage de l'attribution Google ;
- la détection du côté rue via **Overpass/OpenStreetMap** (le service était injoignable ; le calcul de choix du côté
  est testé, l'appel réseau retombe silencieusement sur l'heuristique « plus petit côté ») ;
- l'ouverture du **KML dans Google Earth** lui-même (le fichier est du KML 2.2 standard avec polygones extrudés).

## Architecture

```
src/engine/    moteur pur : géométrie, retraits, emprise, programme, stationnement, contrôles, exports
src/app/       interface : Cesium (carte, rendu 3D, dessin), panneaux, plan masse SVG, services (géocodage, cadastre)
src/main.ts    assemblage
tests/         tests du moteur (vitest)
```

Pile : Vite, TypeScript, CesiumJS, polygon-clipping. Aucune donnée n'est envoyée à un serveur Urbasim : l'application
est 100 % dans le navigateur. Elle appelle uniquement les services de cartes et de géocodage cités plus haut.

## Pistes

Toitures en pente et combles ; pente du terrain ; export glTF/IFC ; règles de gabarit-enveloppe et hauteurs
différenciées rue/fond ; fusion de plusieurs parcelles cadastrales ; lecture automatique de règles de PLU ; plans
d'étage et répartition réelle des logements ; estimation économique (bilan promoteur).
