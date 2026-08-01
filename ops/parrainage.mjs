#!/usr/bin/env node
// Gestion manuelle des liens de parrainage (La Basse-cour).
//
//   node ops/parrainage.mjs import                    -> crée les fiches des COMPTES existants
//                                                        (avant même qu'ils se reconnectent)
//   node ops/parrainage.mjs import --invites          -> y ajoute les invités ayant déjà joué
//   node ops/parrainage.mjs invite "Pseudo"           -> importe UN invité précis
//   node ops/parrainage.mjs invite --id "<user_id>"   -> idem, quand le pseudo est ambigu
//   node ops/parrainage.mjs list                      -> tous les joueurs connus
//   node ops/parrainage.mjs orphelins                 -> ceux qui n'ont pas encore de parrain
//   node ops/parrainage.mjs set "Filleul" "Parrain"   -> rattache Filleul à Parrain
//   node ops/parrainage.mjs unset "Filleul"           -> détache (le remet en souche)
//   node ops/parrainage.mjs del "Pseudo"              -> supprime la fiche (ses filleuls passent
//                                                        à son propre parrain)
//   node ops/parrainage.mjs del "Pseudo" --detacher   -> idem, mais ses filleuls deviennent souches
//   node ops/parrainage.mjs arbre                     -> affiche l'arbre
//   node ops/parrainage.mjs stats "Pseudo"            -> parties jouées et records d'un joueur
//
// Les pseudos peuvent être partiels (recherche insensible à la casse et aux accents),
// mais doivent désigner UN SEUL joueur, sinon la commande s'arrête et liste les candidats.
//
// Pas besoin de couper le serveur : après chaque modification, le script lui envoie un
// signal pour qu'il relise la base (pm2 sendSignal SIGHUP). Précise le nom du service
// s'il ne s'appelle pas "chasse" :  PM2_APP=chasse-prod node ops/parrainage.mjs …

import { createClient } from "@libsql/client";
import { execFile } from "node:child_process";

const db = createClient({ url: process.env.SCORES_DB || "file:./scores.db" });
const deacc = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Emails des comptes (auth.db). Les invités n'en ont pas.
async function emails() {
  const m = new Map();
  try {
    const authDb = createClient({ url: process.env.AUTH_DB || "file:./auth.db" });
    const r = await authDb.execute("SELECT id, email FROM user");
    for (const x of r.rows) if (x.email) m.set("u:" + String(x.id), String(x.email));
  } catch {}                                                   // auth.db absente : on affiche sans
  return m;
}

async function all() {
  const r = await db.execute("SELECT id, code, name, parent, seen FROM referrals");
  return r.rows.map((x) => ({
    id: String(x.id), code: String(x.code), name: String(x.name || ""),
    parent: String(x.parent || ""), seen: Number(x.seen || 0),
  }));
}

// Retrouve UNE fiche à partir d'un pseudo (même partiel) ou d'un code exact.
// Le code sert justement à départager les doublons (même pseudo, deux appareils).
function trouver(gens, q, verbe = "") {
  const t = deacc(q).trim();
  const parCode = gens.filter((g) => g.code.toLowerCase() === t);
  if (parCode.length === 1) return parCode[0];
  const exact = gens.filter((g) => deacc(g.name) === t);
  const hits = exact.length ? exact : gens.filter((g) => deacc(g.name).includes(t));
  if (!hits.length) { console.error(`✗ Aucun joueur ne correspond à « ${q} »`); process.exit(1); }
  if (hits.length > 1) {
    const byId = new Map(gens.map((g) => [g.id, g]));
    console.error(`✗ ${hits.length} fiches correspondent à « ${q} ». Reprends la commande avec le code :\n`);
    for (const h of hits.sort((x, y) => y.seen - x.seen)) {
      const vu = h.seen ? new Date(h.seen).toLocaleDateString("fr-FR") : "?";
      const filleuls = gens.filter((g) => g.parent === h.id).length;
      const parrain = h.parent && byId.get(h.parent);
      console.error(`    ${h.name.padEnd(22)} vu le ${vu}   ${filleuls} filleul(s)   ${parrain ? "← " + parrain.name : "(souche)"}`);
      console.error(`      node ops/parrainage.mjs ${verbe || "<commande>"} "${h.code}"`);
    }
    process.exit(1);
  }
  return hits[0];
}

function afficherArbre(gens) {
  const byId = new Map(gens.map((g) => [g.id, g]));
  const kids = new Map();
  const souches = [];
  for (const g of gens) {
    if (g.parent && byId.has(g.parent)) { if (!kids.has(g.parent)) kids.set(g.parent, []); kids.get(g.parent).push(g.id); }
    else souches.push(g.id);
  }
  const vus = new Set();
  const ligne = (id, prefixe, dernier, racine) => {
    if (vus.has(id)) return;
    vus.add(id);
    const g = byId.get(id);
    console.log(racine ? g.name : prefixe + (dernier ? "└─ " : "├─ ") + g.name);
    const enfants = (kids.get(id) || []).sort((x, y) => byId.get(x).name.localeCompare(byId.get(y).name, "fr"));
    const suite = racine ? "" : prefixe + (dernier ? "   " : "│  ");
    enfants.forEach((c, i) => ligne(c, suite, i === enfants.length - 1, false));
  };
  for (const s of souches.sort((x, y) => byId.get(x).name.localeCompare(byId.get(y).name, "fr"))) {
    ligne(s, "", true, true);
    console.log("");
  }
}

// Code court, même alphabet que le serveur (sans I/O/0/1, ambigus à l'oral)
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function nouveauCode(pris) {
  for (let i = 0; i < 200; i++) {
    let c = "";
    for (let j = 0; j < 6; j++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    if (!pris.has(c)) { pris.add(c); return c; }
  }
  return "P" + Date.now().toString(36).toUpperCase().slice(-5);
}

// Crée les fiches manquantes à partir des identités DÉJÀ connues.
// Par défaut : uniquement les COMPTES (identité stable). Les invités sont liés à un
// appareil (identifiant du navigateur) : ils apparaîtront d'eux-mêmes à leur prochaine visite.
// Avec --invites : y ajoute les invités ayant marqué au moins un point.
async function importer(avecInvites) {
  const existants = await all();
  const connus = new Set(existants.map((g) => g.id));
  const codes = new Set(existants.map((g) => g.code));
  const trouves = new Map();                                   // id -> { name, seen }

  try {                                                        // comptes (id préfixé u: côté serveur)
    const authDb = createClient({ url: process.env.AUTH_DB || "file:./auth.db" });
    const r = await authDb.execute(`SELECT id, name, email FROM user`);
    for (const x of r.rows) {
      trouves.set("u:" + String(x.id), { name: String(x.name || x.email || "Joueur"), seen: Date.now() });
    }
    console.log(`  ${r.rows.length} compte(s) trouvé(s) dans auth.db`);
  } catch (e) { console.error("! auth.db non lue :", e.message); }

  if (avecInvites) {                                           // invités ayant marqué
    try {
      const r = await db.execute(
        `SELECT user_id AS id, username AS name, MAX(ts) AS seen FROM results
         WHERE user_id IS NOT NULL AND user_id <> '' AND user_id NOT LIKE 'u:%' GROUP BY user_id`);
      for (const x of r.rows) trouves.set(String(x.id), { name: String(x.name || "Joueur"), seen: Number(x.seen || 0) });
      console.log(`  ${r.rows.length} invité(s) ayant déjà joué`);
    } catch (e) { console.error("! lecture de results impossible :", e.message); }
  }

  let ajoutes = 0;
  for (const [id, info] of trouves) {
    if (connus.has(id)) continue;
    const code = nouveauCode(codes);
    await db.execute({
      sql: "INSERT INTO referrals(id, code, name, parent, ts, seen) VALUES(?,?,?,?,?,?)",
      args: [id, code, info.name, "", Date.now(), info.seen || Date.now()],
    });
    ajoutes++;
  }
  console.log(`✓ ${ajoutes} fiche(s) créée(s), ${existants.length} déjà présente(s)`);
  if (ajoutes) console.log("  Tu peux maintenant utiliser « set » sans attendre leur reconnexion.");
  if (!avecInvites) console.log("  (invités non importés — relance avec --invites si tu les veux)");
}

// Prévient le serveur qu'il doit relire la base (aucune coupure de service).
function rechargerServeur() {
  const app = process.env.PM2_APP || "chasse";
  return new Promise((resolve) => {
    execFile("pm2", ["sendSignal", "SIGHUP", app], (err, stdout, stderr) => {
      if (err) {
        console.log(`  ! Serveur non prévenu (${err.code === "ENOENT" ? "pm2 introuvable" : "app « " + app + " » ?"}).`);
        console.log(`    Recharge-le à la main :  pm2 sendSignal SIGHUP <nom-de-l-app>`);
      } else {
        console.log(`  ↻ Serveur « ${app} » rechargé, sans coupure.`);
      }
      resolve();
    });
  });
}

// Importe un seul invité, désigné par son pseudo (ou son identifiant si ambigu).
async function importerInvite(q, parId) {
  const existants = await all();
  const connus = new Set(existants.map((g) => g.id));
  const codes = new Set(existants.map((g) => g.code));
  let cands = [];
  try {
    const r = await db.execute(
      `SELECT user_id AS id, username AS name, COUNT(*) AS parties, MAX(ts) AS seen FROM results
       WHERE user_id IS NOT NULL AND user_id <> '' AND user_id NOT LIKE 'u:%' GROUP BY user_id`);
    cands = r.rows.map((x) => ({ id: String(x.id), name: String(x.name || "Joueur"),
      parties: Number(x.parties || 0), seen: Number(x.seen || 0) }));
  } catch (e) { console.error("✗ Lecture de results impossible :", e.message); process.exit(1); }

  let hits;
  if (parId) hits = cands.filter((c) => c.id === q);
  else {
    const t = deacc(q).trim();
    const exact = cands.filter((c) => deacc(c.name) === t);
    hits = exact.length ? exact : cands.filter((c) => deacc(c.name).includes(t));
  }
  if (!hits.length) {
    console.error(`✗ Aucun invité ne correspond à « ${q} ».`);
    console.error("  (un invité n'apparaît qu'après avoir marqué au moins un point)");
    process.exit(1);
  }
  if (hits.length > 1) {
    // Même pseudo sur plusieurs appareils : à toi de choisir lequel garder.
    console.error(`✗ ${hits.length} invités correspondent à « ${q} ». Précise avec --id :\n`);
    for (const h of hits.sort((x, y) => y.seen - x.seen)) {
      const vu = h.seen ? new Date(h.seen).toLocaleDateString("fr-FR") : "?";
      console.error(`    ${h.name.padEnd(24)} ${h.parties} partie(s), vu le ${vu}`);
      console.error(`      node ops/parrainage.mjs invite --id "${h.id}"`);
    }
    process.exit(1);
  }
  const inv = hits[0];
  if (connus.has(inv.id)) { console.log(`• ${inv.name} a déjà une fiche, rien à faire.`); return; }
  const code = nouveauCode(codes);
  await db.execute({
    sql: "INSERT INTO referrals(id, code, name, parent, ts, seen) VALUES(?,?,?,?,?,?)",
    args: [inv.id, code, inv.name, "", Date.now(), inv.seen || Date.now()],
  });
  console.log(`✓ Invité « ${inv.name} » importé (code ${code}, ${inv.parties} partie(s))`);
  await rechargerServeur();
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "invite") {
  const parId = process.argv.includes("--id");
  const q = parId ? process.argv[process.argv.indexOf("--id") + 1] : a;
  if (!q) { console.error('Usage : node ops/parrainage.mjs invite "Pseudo"   |   invite --id "<user_id>"'); process.exit(1); }
  await importerInvite(q, parId);
  process.exit(0);
}
if (cmd === "import") { await importer(process.argv.includes("--invites")); await rechargerServeur(); process.exit(0); }
const gens = await all();

if (!cmd || cmd === "list") {
  const mails = await emails();
  console.log(`${gens.length} joueur(s) :\n`);
  const byId = new Map(gens.map((g) => [g.id, g]));
  for (const g of gens.sort((x, y) => x.name.localeCompare(y.name, "fr"))) {
    const p = g.parent && byId.get(g.parent);
    const vu = g.seen ? new Date(g.seen).toLocaleDateString("fr-FR") : "?";
    const mail = mails.get(g.id) || (g.id.startsWith("u:") ? "—" : "(invité)");
    console.log(`  ${g.name.padEnd(24)} ${mail.padEnd(28)} code ${g.code}   vu le ${vu}   ${p ? "← " + p.name : "(souche)"}`);
  }
} else if (cmd === "orphelins") {
  const mails = await emails();
  const byId = new Map(gens.map((g) => [g.id, g]));
  const orph = gens.filter((g) => !g.parent || !byId.has(g.parent));
  console.log(`${orph.length} joueur(s) sans parrain :\n`);
  for (const g of orph.sort((x, y) => x.name.localeCompare(y.name, "fr"))) {
    const mail = mails.get(g.id) || (g.id.startsWith("u:") ? "—" : "(invité)");
    console.log(`  ${g.name.padEnd(24)} ${mail.padEnd(28)} code ${g.code}`);
  }
} else if (cmd === "arbre") {
  afficherArbre(gens);
} else if (cmd === "set") {
  if (!a || !b) { console.error("Usage : node ops/parrainage.mjs set \"Filleul\" \"Parrain\""); process.exit(1); }
  const filleul = trouver(gens, a, "set"), parrain = trouver(gens, b, "set");
  if (filleul.id === parrain.id) { console.error("✗ Un joueur ne peut pas être son propre parrain."); process.exit(1); }
  // anti-boucle : le parrain ne doit pas déjà descendre du filleul
  const byId = new Map(gens.map((g) => [g.id, g]));
  for (let p = parrain.parent, n = 0; p && n < 500; n++) {
    if (p === filleul.id) { console.error(`✗ Boucle : ${parrain.name} descend déjà de ${filleul.name}.`); process.exit(1); }
    p = (byId.get(p) || {}).parent || "";
  }
  await db.execute({ sql: "UPDATE referrals SET parent = ? WHERE id = ?", args: [parrain.id, filleul.id] });
  console.log(`✓ ${filleul.name} est maintenant rattaché à ${parrain.name}`);
  await rechargerServeur();
} else if (cmd === "unset") {
  if (!a) { console.error("Usage : node ops/parrainage.mjs unset \"Filleul\""); process.exit(1); }
  const filleul = trouver(gens, a, "unset");
  await db.execute({ sql: "UPDATE referrals SET parent = '' WHERE id = ?", args: [filleul.id] });
  console.log(`✓ ${filleul.name} n'a plus de parrain (souche)`);
  await rechargerServeur();
} else if (cmd === "stats") {
  if (!a) { console.error('Usage : node ops/parrainage.mjs stats "Pseudo"'); process.exit(1); }
  const j = trouver(gens, a, "stats");
  const mails = await emails();
  const jour = new Date(); jour.setHours(0, 0, 0, 0);
  const lundi = new Date(jour); lundi.setDate(jour.getDate() - ((jour.getDay() + 6) % 7));
  const bloc = async (titre, depuis) => {
    const r = await db.execute({
      sql: `SELECT COUNT(*) AS n, MAX(score) AS best, AVG(score) AS moy, SUM(found) AS mots
            FROM results WHERE user_id = ? AND ts >= ? AND score > 0`,
      args: [j.id, depuis],
    });
    const x = r.rows[0] || {};
    const n = Number(x.n || 0);
    console.log(`  ${titre.padEnd(16)} ${String(n).padStart(4)} partie(s)` +
      (n ? `   record ${String(Number(x.best)).padStart(4)}   moyenne ${String(Math.round(Number(x.moy))).padStart(4)}   ${Number(x.mots || 0)} mots trouvés` : ""));
  };
  const bornes = await db.execute({
    sql: `SELECT MIN(ts) AS first, MAX(ts) AS last FROM results WHERE user_id = ? AND score > 0`,
    args: [j.id],
  });
  const b = bornes.rows[0] || {};
  const mail = mails.get(j.id) || (j.id.startsWith("u:") ? "—" : "(invité)");
  const parrain = j.parent && gens.find((g) => g.id === j.parent);
  const filleuls = gens.filter((g) => g.parent === j.id);
  console.log(`\n${j.name}   ${mail}   code ${j.code}`);
  console.log(`${parrain ? "invité par " + parrain.name : "sans parrain"}` +
    (filleuls.length ? `   ·   a invité ${filleuls.map((f) => f.name).join(", ")}` : "   ·   n'a invité personne"));
  console.log("");
  await bloc("Aujourd'hui", jour.getTime());
  await bloc("Cette semaine", lundi.getTime());
  await bloc("Depuis toujours", 0);
  if (b.first) {
    console.log(`\n  première partie : ${new Date(Number(b.first)).toLocaleDateString("fr-FR")}` +
      `   ·   dernière : ${new Date(Number(b.last)).toLocaleDateString("fr-FR")}`);
  } else {
    console.log("\n  (aucune partie enregistrée)");
  }
} else if (cmd === "del" || cmd === "supprimer") {
  if (!a) { console.error("Usage : node ops/parrainage.mjs del \"Pseudo\" [--detacher]"); process.exit(1); }
  const cible = trouver(gens, a, "del");
  const filleuls = gens.filter((g) => g.parent === cible.id);
  const detacher = process.argv.includes("--detacher");
  // Ses filleuls ne doivent pas rester accrochés à une fiche disparue :
  // par défaut on les remonte d'un cran (au parrain du supprimé), sinon ils deviennent souches.
  const repreneur = detacher ? "" : cible.parent;
  if (filleuls.length) {
    await db.execute({ sql: "UPDATE referrals SET parent = ? WHERE parent = ?", args: [repreneur, cible.id] });
    const nom = repreneur ? (gens.find((g) => g.id === repreneur) || {}).name : null;
    console.log(`  ${filleuls.length} filleul(s) ${nom ? "rattaché(s) à " + nom : "devenu(s) souches"} : ${filleuls.map((f) => f.name).join(", ")}`);
  }
  await db.execute({ sql: "DELETE FROM referrals WHERE id = ?", args: [cible.id] });
  console.log(`✓ Fiche de ${cible.name} supprimée (code ${cible.code})`);
  console.log("  Note : elle sera recréée automatiquement, sans parrain, à sa prochaine connexion.");
  await rechargerServeur();
} else {
  console.error(`Commande inconnue : ${cmd}\nUtilise : import | invite | list | orphelins | arbre | stats | set | unset | del`);
  process.exit(1);
}
