#!/usr/bin/env bash
# Déploie une version (= un commit git) vers staging ou prod, puis recharge pm2.
# Source unique = le repo git. Chaque environnement est un clone sur sa branche.
#   staging -> branche develop   |   prod -> branche main
#
# Usage :
#   ./deploy.sh staging              # pull develop  -> staging,  reload
#   ./deploy.sh prod                 # pull main     -> prod,     reload
#   ./deploy.sh prod v0.2            # déploie un tag/branche précis en prod
#
# À lancer depuis /var/www/chasse/ (PAS depuis l'intérieur d'un clone, pour ne pas
# se pull soi-même en plein milieu). setup-server.sh copie ce script ici.
set -euo pipefail

ENVNAME="${1:-}"
case "$ENVNAME" in
  staging) TARGET="/var/www/chasse/staging"; PM2NAME="chasse-staging"; DEFREF="develop" ;;
  prod)    TARGET="/var/www/chasse/prod";    PM2NAME="chasse";         DEFREF="main" ;;
  *) echo "Usage: $0 <prod|staging> [branche|tag]"; exit 1 ;;
esac
REF="${2:-$DEFREF}"

[ -d "$TARGET/.git" ] || { echo "✗ $TARGET n'est pas un clone git. Lance d'abord setup-server.sh."; exit 1; }
cd "$TARGET"

echo "→ [$ENVNAME] déploiement de '$REF' dans $TARGET"
git fetch --all --prune
git checkout "$REF"
git pull --ff-only origin "$REF" 2>/dev/null || true   # no-op si REF est un tag/commit

# Dépendances (reproductible si lockfile présent). .env/auth.db/node_modules sont git-ignorés.
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Rechargement sans coupure (ou démarrage au 1er coup)
if pm2 describe "$PM2NAME" >/dev/null 2>&1; then
  pm2 reload "$PM2NAME"
else
  pm2 start server.js --name "$PM2NAME" --node-args="--env-file=.env"
  pm2 save
fi

echo "✓ [$ENVNAME] en ligne sur commit $(git rev-parse --short HEAD) (réf: $REF)"
