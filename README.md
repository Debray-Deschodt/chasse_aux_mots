# Chasse au mot — serveur de manches synchronisées

Petit serveur Node **sans aucune dépendance** (module `http` natif). Il sert à quatre choses :

1. **distribuer le site** : la page du jeu est servie sur `/` (depuis `public/index.html`) ;
2. donner la **seed de la manche en cours** pour que tout le monde joue la même grille sans se concerter ;
3. cadencer les parties : **2 min de jeu + 30 s de pause** pour voir les scores, en boucle ;
4. **partager les scores**. En attendant l'authentification, chaque joueur reçoit un **username visiteur**.

La rotation est **dérivée de l'horloge** : aucune partie n'est « lancée » côté serveur, le numéro de manche et la phase se calculent à partir du temps. Résultat : ça tourne tout seul même sans joueurs, et n'importe qui retombe sur la bonne manche au bon moment. Seuls les scores sont gardés en mémoire.

## Lancer

Structure attendue :

```
server/
  server.js
  package.json
  public/
    index.html      <- le jeu (chasse-au-mot.html renommé en index.html)
```

```bash
cd server
npm install
node --env-file=.env server.js     # ou: node server.js si tu exportes les variables autrement
# -> Chasse au mot — serveur sur :8787 (... ) — auth: email + Google
```

Crée d'abord ton `.env` à partir de `.env.example` (voir « Comptes & connexion » plus bas).

Puis ouvre **http://localhost:8787/** : la page se charge depuis le serveur et se connecte automatiquement (même origine). Tes potes ouvrent la même URL et tombent sur la même manche.

Réglages par variables d'environnement : `PORT` (8787), `PLAY_MS` (120000), `BREAK_MS` (30000).

## Endpoints (JSON, CORS ouvert)

### `GET /api/state`
État courant + classement de la manche.
```json
{
  "round": 412,
  "seed": "412",
  "phase": "play",          // "play" ou "break"
  "msLeft": 78342,           // temps restant dans la phase
  "phaseEndsAt": 1750000000000,
  "serverTime": 1749999921658,
  "playMs": 120000,
  "breakMs": 30000,
  "leaderboard": [ { "username": "FutéCastor191", "score": 60 } ]
}
```

### `POST /api/join`
Body optionnel `{ "name": "Paul" }`. Sans nom, un username visiteur est généré.
```json
{ "id": "uuid-à-conserver", "username": "FutéCastor191", "round": 412, "seed": "412", ... }
```

### `POST /api/score`
Body `{ "id": "...", "score": 42, "round": 412 }` (`round` optionnel = manche courante).
On garde le **meilleur** score du joueur pour la manche. Renvoie le classement à jour.
Refusé si la manche est terminée (`409`) ou l'`id` inconnu (`401`).

### `GET /api/leaderboard?round=412`
Classement d'une manche précise (ou la courante par défaut).

## Le front est déjà branché

Quand la page est servie par le serveur, le jeu se connecte tout seul :

- **Connexion auto** : au chargement il appelle `/api/state` (même origine). S'il y a un serveur → mode multijoueur synchronisé ; sinon → repli en **mode solo** (graine locale), donc le fichier reste jouable seul.
- **Même grille** : la `seed` du serveur alimente `gridFromSeed(seed)`.
- **Chrono synchro** : le décompte est calé sur `phaseEndsAt` corrigé par `serverTime` (pas l'horloge locale).
- **Scores live** : chaque mot trouvé envoie le score via `/api/score` ; en pause, l'écran affiche le classement partagé + tous les mots de la grille + le décompte avant la manche suivante.
- **Username visiteur** affiché en haut à droite.
- Pour tester le front ouvert en local contre un serveur distant : `index.html?api=http://mon-serveur:8787`.

## Comptes & connexion (Better Auth + SQLite)

Les joueurs peuvent jouer **en invité** (pseudo aléatoire) ou **se connecter** pour garder leur pseudo et leurs scores. Géré par **Better Auth**, comptes stockés dans **SQLite** (fichier `auth.db`, créé/migré automatiquement au démarrage). Sessions par cookie `httpOnly` + `Secure`, 30 jours : on reste connecté.

Méthodes actives : **email/mot de passe** et **Google**. Les routes d'auth sont sous `/api/auth/*`.

### Variables d'environnement (`.env`)
- `BASE_URL` — l'origine publique **exacte** (`https://chasse-aux-mots.fr`). Cruciale : sert au contrôle d'origine, aux cookies et au retour OAuth.
- `AUTH_SECRET` — secret de session : `openssl rand -base64 32`.
- `AUTH_DB` — `file:./auth.db` par défaut.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — laisse vide pour désactiver Google (le bouton affichera « non configuré »).

### Activer « Se connecter avec Google »
Dans **Google Cloud Console** → *APIs & Services → Credentials* :
1. *Create credentials → OAuth client ID → Web application*.
2. **Authorized redirect URI** (exactement) :
   `https://chasse-aux-mots.fr/api/auth/callback/google`
3. (Authorized JavaScript origin : `https://chasse-aux-mots.fr`.)
4. Récupère le *Client ID* + *Client secret* → mets-les dans `.env`, relance pm2.

D'autres fournisseurs (GitHub, Discord…) s'ajoutent de la même façon : enregistrer l'appli chez eux + 2 lignes dans `auth.js`.

### Avec pm2
pm2 ne lit pas `.env` tout seul. Le plus simple :
```bash
pm2 start server.js --name chasse --node-args="--env-file=.env"
pm2 save
```
(ou mets les variables dans un `ecosystem.config.cjs`.)

## Héberger

Il faut un **process Node qui tourne en continu** (Netlify/Pages ne conviennent pas, c'est du statique). Options gratuites :

- **Render / Railway / Fly.io** : déploiement direct depuis un repo.
- **Oracle Cloud Free Tier** : VM gratuite à vie, allumée en permanence.
- **Ton téléphone** : Termux + `node server.js` + tunnel Cloudflare (`cloudflared`) pour une URL publique.

À noter : les scores sont **en mémoire** → remis à zéro si le serveur redémarre. Les **comptes**, eux, persistent dans `auth.db`.

## Deux environnements (staging + prod) via git

Source unique = **ce repo**. Chaque environnement est un **clone git** sur sa branche, sur le même serveur :

```
develop  ──>  /var/www/chasse/staging   (port 8788, staging.chasse-aux-mots.fr)
main     ──>  /var/www/chasse/prod      (port 8787, chasse-aux-mots.fr)
```

Seule différence entre les deux : leur `.env` (port, BASE_URL, secret) et leur `auth.db` — tout deux **hors git**. Le code est strictement identique à un commit près.

### Mise en place (une fois)
```bash
sudo bash ops/setup-server.sh        # clone main->prod et develop->staging, npm ci
# puis crée les 2 .env (modèles : .env.example et ops/.env.staging.example)
cd /var/www/chasse && pm2 start ecosystem.config.cjs && pm2 save
```
nginx + HTTPS : voir `ops/chasse-aux-mots.nginx.conf` (apex + www + staging, puis `certbot --nginx -d ... -d staging...`).

### Boucle de travail
```bash
# 1. tu bosses en local, tu commites, tu pousses sur develop
# 2. déploie + teste sur staging
cd /var/www/chasse && ./deploy.sh staging
#    -> valider sur https://staging.chasse-aux-mots.fr
# 3. quand c'est bon : merge develop -> main (SourceTree), push, puis :
./deploy.sh prod
```

`deploy.sh <env>` fait : `git pull` la bonne branche → `npm ci` → `pm2 reload` (sans coupure). Pour figer la prod sur un tag : `./deploy.sh prod v0.2`.

Pré-requis git : les branches **`main`** et **`develop`** doivent exister et être poussées avant le premier `setup-server.sh`.
