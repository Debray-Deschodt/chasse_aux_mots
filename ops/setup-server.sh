#!/usr/bin/env bash
# Mise en place INITIALE des deux environnements (à lancer UNE seule fois).
# Clone le repo dans /var/www/chasse/{prod,staging} sur leurs branches,
# puis copie deploy.sh + ecosystem.config.cjs à la racine pour les lancer.
#
# Pré-requis : git, node, npm, pm2 installés ; branches 'main' et 'develop' poussées.
set -euo pipefail

REPO="https://github.com/Debray-Deschodt/chasse_aux_mots.git"
BASE="/var/www/chasse"

sudo mkdir -p "$BASE"
sudo chown -R "$USER":"$USER" "$BASE"

clone_env () {
  local dir="$1" branch="$2"
  if [ -d "$dir/.git" ]; then
    echo "= $dir existe déjà, skip clone"
  else
    echo "= clone $branch -> $dir"
    git clone --branch "$branch" "$REPO" "$dir"
  fi
  cd "$dir"
  npm ci --omit=dev || npm install --omit=dev
}

clone_env "$BASE/prod"    "main"
clone_env "$BASE/staging" "develop"

# Outils d'exploitation à la racine (stables, hors des clones qui se pull)
cp "$BASE/prod/ops/deploy.sh"            "$BASE/deploy.sh"
cp "$BASE/prod/ops/ecosystem.config.cjs" "$BASE/ecosystem.config.cjs"
chmod +x "$BASE/deploy.sh"

echo
echo "ÉTAPES MANUELLES RESTANTES :"
echo "  1) Crée $BASE/prod/.env     (modèle : $BASE/prod/.env.example)"
echo "  2) Crée $BASE/staging/.env  (modèle : $BASE/staging/ops/.env.staging.example)"
echo "     -> AUTH_SECRET différent dans chaque (openssl rand -base64 32)"
echo "  3) cd $BASE && pm2 start ecosystem.config.cjs && pm2 save"
echo
echo "Ensuite, déploiements : cd $BASE && ./deploy.sh staging   puis   ./deploy.sh prod"
