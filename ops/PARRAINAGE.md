# Gérer les liens de parrainage à la main

Outil : `ops/parrainage.mjs` — il modifie la table `referrals` de `scores.db`, celle qui
alimente **La Basse-cour** (le bouton 🦆 dans le jeu).

---

## Pas besoin de couper le serveur

Après chaque modification, le script envoie un signal au serveur pour qu'il relise la base.
**Aucune coupure de service**, les joueurs en cours de partie ne voient rien.

```bash
cd /var/www/chasse/serveur      # là où se trouve scores.db
node ops/parrainage.mjs set "Léna" "Moulinex"
# ✓ Léna est maintenant rattaché à MoulinexTurbo100
# ↻ Serveur « chasse » rechargé, sans coupure.
```

Si ton application pm2 ne s'appelle pas `chasse` :

```bash
PM2_APP=chasse-prod node ops/parrainage.mjs set "Léna" "Moulinex"
```

Tu peux aussi le poser une fois pour toutes dans ton shell :

```bash
echo 'export PM2_APP=chasse-prod' >> ~/.bashrc
```

Si pm2 est introuvable ou le nom incorrect, le script te le dit et t'indique la commande à
lancer toi-même :

```bash
pm2 sendSignal SIGHUP chasse-prod
```

⚠️ **Ne saute pas cette étape.** Le serveur garde les liens en mémoire ; tant qu'il n'a pas
rechargé, il continue de travailler avec les anciens et peut réécrire tes modifications
lorsqu'un joueur se connecte.

---

## Les commandes

| Commande | Effet |
|---|---|
| `node ops/parrainage.mjs import` | Crée les fiches des **comptes** existants |
| `node ops/parrainage.mjs import --invites` | Y ajoute les invités ayant déjà marqué |
| `node ops/parrainage.mjs list` | Tous les joueurs : pseudo, e-mail, code, dernière visite, parrain |
| `node ops/parrainage.mjs orphelins` | Ceux qui n'ont pas encore de parrain (avec e-mail) |
| `node ops/parrainage.mjs arbre` | L'arbre complet, en indentation |
| `node ops/parrainage.mjs set "Filleul" "Parrain"` | Rattache Filleul à Parrain |
| `node ops/parrainage.mjs unset "Filleul"` | Le détache (il redevient une souche) |
| `node ops/parrainage.mjs del "Pseudo"` | Supprime sa fiche ; ses filleuls remontent à son parrain |
| `node ops/parrainage.mjs del "Pseudo" --detacher` | Idem, mais ses filleuls deviennent des souches |

L'e-mail vient de `auth.db` : il n'existe que pour les **comptes**. Les invités
apparaissent avec la mention `(invité)`, un compte sans e-mail avec `—`.

**Les pseudos peuvent être partiels**, sans accents ni respect de la casse : `"lena"`
trouve `Léna`, `"Moulinex"` trouve `MoulinexTurbo100`. Si plusieurs joueurs correspondent,
la commande s'arrête et te les liste — elle ne devine jamais.

---

## Cas d'usage

### Premier remplissage

```bash
node ops/parrainage.mjs import       # récupère les comptes existants
node ops/parrainage.mjs list         # regarde qui est là
node ops/parrainage.mjs set "Léna" "Moulinex"
node ops/parrainage.mjs set "Rafik" "Moulinex"
node ops/parrainage.mjs set "chenille" "Léna"
node ops/parrainage.mjs arbre        # vérifie le résultat
```

`import` est **rejouable sans risque** : il ne crée que les fiches manquantes. Relance-le
quand de nouveaux comptes apparaissent.

### Corriger un lien

```bash
node ops/parrainage.mjs set "Rafik" "Léna"   # il suffit de réaffecter, pas besoin de détacher
```

### Nouveau joueur à rattacher

Les joueurs qui se connectent créent leur fiche automatiquement, sans parrain.

```bash
node ops/parrainage.mjs orphelins
node ops/parrainage.mjs set "NouveauVenu" "SonParrain"
```

---

## Ce que l'outil refuse

- **L'auto-parrainage** — un joueur ne peut pas être son propre parrain.
- **Les boucles** — si A descend déjà de B, tu ne peux pas rattacher B à A.
  Message : `✗ Boucle : VifRenard903 descend déjà de MoulinexTurbo100.`
- **Les pseudos ambigus** — il affiche les candidats et s'arrête.

---

## Points de vigilance

**Les invités ne sont pas importés par défaut, et c'est voulu.** Un compte a une identité
stable, que le joueur retrouve depuis n'importe quel appareil. Un invité est identifié par
un jeton stocké dans son navigateur : s'il vide son cache, change de téléphone ou passe en
navigation privée, il revient comme un inconnu. Un lien créé vers un invité peut donc
pointer vers un fantôme, et le même joueur peut apparaître deux fois s'il joue depuis deux
appareils. La commande `list` te les montrera.

**Un compte ayant changé de pseudo n'est jamais importé deux fois** — l'identité est
l'identifiant du compte, pas le pseudo. Sa fiche porte simplement son pseudo actuel.

**Supprimer une fiche invalide le lien de partage.** À sa prochaine connexion, le joueur
en obtient une nouvelle, sans parrain et **avec un nouveau code** : l'ancien lien qu'il
aurait diffusé cesse de fonctionner.

**N'essaie pas de tout reconstituer.** Rattache les liens dont tu es sûr et laisse le reste
se faire par les liens de partage. Un arbre partiellement faux est plus gênant qu'un arbre
incomplet : les joueurs s'y reconnaissent.

---

## En cas de doute

Sauvegarde avant de te lancer :

```bash
cp scores.db scores.db.bak
```

Pour revenir en arrière :

```bash
cp scores.db.bak scores.db
pm2 sendSignal SIGHUP chasse       # le serveur relit la sauvegarde
```
