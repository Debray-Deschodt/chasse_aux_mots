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
node server.js
# -> Chasse au mot — serveur sur :8787 (manche 120s + pause 30s)
```

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

## Héberger

Il faut un **process Node qui tourne en continu** (Netlify/Pages ne conviennent pas, c'est du statique). Options gratuites :

- **Render / Railway / Fly.io** : déploiement direct depuis un repo.
- **Oracle Cloud Free Tier** : VM gratuite à vie, allumée en permanence.
- **Ton téléphone** : Termux + `node server.js` + tunnel Cloudflare (`cloudflared`) pour une URL publique.

À noter : les scores sont **en mémoire** → remis à zéro si le serveur redémarre (ou se met en veille sur les offres gratuites qui s'endorment). Suffisant pour le mode visiteur ; on ajoutera une persistance (SQLite/Redis) quand on fera l'auth.
