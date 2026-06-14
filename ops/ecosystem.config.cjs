// pm2 : démarre prod + staging en une commande.
//   pm2 start ecosystem.config.cjs
//   pm2 save
//
// Chaque instance lit SON propre .env (via --node-args="--env-file=...").
// Adapte les "cwd" à ton arborescence serveur si besoin.
module.exports = {
  apps: [
    {
      name: "chasse",                 // PROD
      script: "server.js",
      cwd: "/var/www/chasse/prod",
      node_args: "--env-file=.env",
      env: { NODE_ENV: "production" },
    },
    {
      name: "chasse-staging",         // INTÉGRATION
      script: "server.js",
      cwd: "/var/www/chasse/staging",
      node_args: "--env-file=.env",
      env: { NODE_ENV: "production" },
    },
  ],
};
