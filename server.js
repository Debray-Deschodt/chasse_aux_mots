import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { auth } from "./auth.js";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { getMigrations } from "better-auth/db/migration";
import { createClient } from "@libsql/client";

const authHandler = toNodeHandler(auth);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8", ".svg":"image/svg+xml",
  ".png":"image/png", ".ico":"image/x-icon", ".webmanifest":"application/manifest+json" };

// ---------- Réglages ----------
const PORT = Number(process.env.PORT || 8787);
const PLAY_MS = Number(process.env.PLAY_MS || 120_000); // 2 min de jeu
const BREAK_MS = Number(process.env.BREAK_MS || 30_000); // 30 s pour voir les scores
const CYCLE_MS = PLAY_MS + BREAK_MS;
const EPOCH = 0;          // référence fixe : ne plus la changer une fois en prod
const KEEP_ROUNDS = 10;   // on ne garde que les dernières manches en mémoire
const MAX_NAME = 24;
// Retire emojis / pictogrammes / drapeaux d'un pseudo, compacte les espaces et tronque
function cleanName(s) {
  return String(s || "")
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
}

// ---------- État mémoire ----------
const players = new Map();        // id -> { username }
const scoresByRound = new Map();  // round -> Map(id -> { id, username, score, words, total })

// ---------- Scores persistants (SQLite/libsql) ----------
const scoresDb = createClient({ url: process.env.SCORES_DB || "file:./scores.db" });
const flushedRounds = new Set();

async function initScoresDb() {
  await scoresDb.execute(`CREATE TABLE IF NOT EXISTS results(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, username TEXT,
    score INTEGER, found INTEGER, total INTEGER,
    ts INTEGER)`);
  await scoresDb.execute(`CREATE INDEX IF NOT EXISTS idx_results_ts ON results(ts)`);
  await scoresDb.execute(`CREATE TABLE IF NOT EXISTS defs(mot TEXT PRIMARY KEY, def TEXT, ts INTEGER)`);
}

// ---------- Définitions (Wiktionnaire, section française, avec cache) ----------
// Gabarits qui PORTENT le texte de la définition -> on les rend en clair au lieu de les retirer
const DEFTPL = {
  "variante de": "Variante de", "variante ortho de": "Variante orthographique de", "variante orthographique de": "Variante orthographique de",
  "apocope": "Apocope de", "apocope de": "Apocope de", "aphérèse": "Aphérèse de", "aphérèse de": "Aphérèse de",
  "abréviation": "Abréviation de", "abréviation de": "Abréviation de", "ellipse": "Ellipse de", "ellipse de": "Ellipse de",
  "diminutif": "Diminutif de", "diminutif de": "Diminutif de", "augmentatif de": "Augmentatif de",
  "acronyme": "Acronyme de", "sigle": "Sigle de", "siglaison de": "Sigle de", "initialisme": "Initialisme de",
  "déverbal de": "Déverbal de", "déverbal": "Déverbal de",
};
function cleanWiki(s) {
  let out = s.replace(/\{\{([^|{}]+)\|([^|{}]+)(?:\|[^{}]*)?\}\}/g, (m, name, arg) => {
    const k = name.trim().toLowerCase();
    return DEFTPL[k] ? `${DEFTPL[k]} ${arg.trim()}.` : m;   // ex. {{apocope|université|fr}} -> "Apocope de université."
  });
  for (let i = 0; i < 5; i++) out = out.replace(/\{\{[^{}]*\}\}/g, "");   // gabarits restants (dérécursivés)
  return out
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")   // [[a|b]] -> b
    .replace(/\[\[([^\]]*)\]\]/g, "$1")              // [[a]] -> a
    .replace(/'''?/g, "")                            // gras / italique
    .replace(/<[^>]+>/g, "")                         // balises html
    .replace(/\(\s*\)/g, "")                         // parenthèses vides (gabarits retirés)
    .replace(/\.{2,}/g, ".")                         // points multiples
    .replace(/\s+([.,;:!?])/g, "$1")                 // espace avant ponctuation
    .replace(/\s+/g, " ").trim()
    .slice(0, 300);
}
// Récupère le lemme (forme de base) pointé par une définition de flexion
function lemmaOf(rawLine) {
  let m = rawLine.match(/\{\{fr-verbe-flexion\|\s*([^|}=]+)/i);              // conjugaisons : {{fr-verbe-flexion|manger|...}}
  if (m) return m[1].trim();
  m = rawLine.match(/\{\{[^|}]*\bde\|\s*([^|}=]+)/i);                       // {{pluriel de|chat|fr}}, {{féminin de|beau|fr}}
  if (m) return m[1].trim();
  const de = rawLine.toLowerCase().lastIndexOf(" de ");                     // "…de l'indicatif présent de [[manger]]" -> après le DERNIER "de"
  if (de >= 0) {
    const after = rawLine.slice(de);
    m = after.match(/\[\[([^\]|#]+)/) || after.match(/\{\{[^|}]*\|\s*([^|}=]+)/);
    if (m) return m[1].trim();
  }
  const links = [...rawLine.matchAll(/\[\[([^\]|#]+)/g)];                   // sinon : dernier lien de la ligne
  if (links.length) return links[links.length - 1][1].trim();
  return "";
}
// Étiquettes régionales / de registre : ces sens passent après les sens neutres
const MARGINAL = /\{\{\s*(suisse|belgique|québec|acadie|louisiane|afrique|familier|populaire|argot|argotique|vieilli|désuet|archaïque|vulgaire|rare|régional|dialectal)\b/i;
// Analyse la SECTION FRANÇAISE : { real: vraies définitions, base: lemme d'une flexion }
// Renvois de genre/nombre traités comme des flexions, même hors section "flexion"
const INFLECT = /\{\{\s*(?:masculin|féminin|feminin|singulier|pluriel)[a-zà-ÿ ]*\bde\s*\|/i;
// Analyse la SECTION FRANÇAISE -> liste ORDONNÉE d'items :
//   { kind:"def", text, marginal }  = vraie définition
//   { kind:"ref", lemma }           = renvoi (flexion / féminin de / pluriel de…) vers un mot de base
// Ignore les noms propres. Les sens régionaux/familiers sont repoussés (tri stable).
function parseFrench(wikitext) {
  const start = wikitext.search(/==\s*\{\{langue\|fr\}\}\s*==/);
  if (start < 0) return [];
  let sec = wikitext.slice(start);
  const nxt = sec.slice(4).search(/\n==\s*\{\{langue\|/);
  if (nxt >= 0) sec = sec.slice(0, nxt + 4);
  const SKIP = /^(nom propre|prénom|nom de famille|patronyme|toponyme)/i;
  let skip = false, flexion = false;
  const items = [];
  for (const l of sec.split("\n")) {
    const h = l.match(/^={3,}\s*\{\{S\|([^}]+)\}\}/);        // en-tête sous-section : {{S|type|fr|flexion}}
    if (h) { const p = h[1].split("|").map((x) => x.trim()); skip = SKIP.test(p[0]); flexion = p.includes("flexion"); continue; }
    if (!/^#[^#*:]/.test(l)) continue;
    if (skip) continue;
    const raw = l.replace(/^#\s*/, "");
    if (flexion || INFLECT.test(raw)) {                       // renvoi vers un lemme
      const lemma = lemmaOf(raw);
      if (lemma) items.push({ kind: "ref", lemma, marginal: 0 });
      continue;
    }
    const d = cleanWiki(raw);
    if (d && /[a-zà-ÿ]/i.test(d)) items.push({ kind: "def", text: d, marginal: MARGINAL.test(raw) ? 1 : 0 });   // au moins une lettre
  }
  items.sort((a, b) => a.marginal - b.marginal);   // sens neutres d'abord (tri stable => ordre des sections préservé)
  return items;
}
async function fetchDefinition(mot, depth = 0) {
  const S = "https://fr.wiktionary.org/w/api.php";
  const H = { headers: { "user-agent": "ChasseAuxMots/1.0 (+https://chasse-aux-mots.fr; jeu de lettres)" } };
  const s = await fetch(`${S}?action=query&list=search&srsearch=${encodeURIComponent(mot)}&srlimit=6&format=json&origin=*`, H);
  const sj = await s.json();
  const titles = [mot];   // la page au titre EXACT d'abord (fiable pour les petits mots courants)
  for (const x of (((sj.query && sj.query.search) || []).map((x) => x.title)))
    if (!titles.some((t) => t.toLowerCase() === x.toLowerCase())) titles.push(x);
  const c = await fetch(`${S}?action=query&prop=revisions&rvslots=main&rvprop=content&format=json&origin=*&titles=${encodeURIComponent(titles.join("|"))}`, H);
  const cj = await c.json();
  const pages = (cj.query && cj.query.pages) || {};
  const byTitle = {};
  for (const k in pages) {
    const p = pages[k];
    const wt = p.revisions && p.revisions[0] && p.revisions[0].slots && p.revisions[0].slots.main && p.revisions[0].slots.main["*"];
    if (p.title && wt) byTitle[p.title.toLowerCase()] = wt;
  }
  for (const t of titles) {               // 1er candidat qui produit quelque chose
    const wt = byTitle[t.toLowerCase()];
    if (!wt) continue;
    const items = parseFrench(wt);
    if (!items.length) continue;
    const out = [];
    for (const it of items) {
      if (out.length >= 3) break;
      if (it.kind === "def") { if (!out.includes(it.text)) out.push(it.text); }
      else if (depth < 1 && it.lemma && it.lemma.toLowerCase() !== mot.toLowerCase()) {   // renvoi -> définition du mot de base
        const sub = await fetchDefinition(it.lemma, depth + 1);
        for (const d of sub) { if (out.length >= 3) break; if (!out.includes(d)) out.push(d); }
      }
    }
    if (out.length) return out;
  }
  return [];
}
const DEF_VERSION = 9;   // à incrémenter quand on change l'extraction => invalide le cache
async function getDefinition(mot) {
  try {
    const r = await scoresDb.execute({ sql: "SELECT def FROM defs WHERE mot = ?", args: [mot] });
    if (r.rows.length) {
      const c = JSON.parse(r.rows[0].def || "{}");
      if (c && c.v === DEF_VERSION && Array.isArray(c.defs)) return c.defs;   // sinon : format/version périmé -> on ré-interroge
    }
  } catch {}
  let defs = [];
  try { defs = await fetchDefinition(mot); } catch {}
  // On ne met en cache QUE les résultats non vides : un échec transitoire (réseau, rate-limit)
  // ne doit pas figer un mot en "introuvable" pour toujours.
  if (defs.length) {
    try { await scoresDb.execute({ sql: "INSERT OR REPLACE INTO defs(mot, def, ts) VALUES(?,?,?)", args: [mot, JSON.stringify({ v: DEF_VERSION, defs }), Date.now()] }); } catch {}
  }
  return defs;
}

// Écrit en base les résultats des manches terminées (manche courante incluse dès la pause)
async function flushFinishedRounds() {
  const cur = currentRound();
  for (const [round, m] of scoresByRound) {
    const finished = round < cur.round || (round === cur.round && cur.phase === "break");
    if (!finished || flushedRounds.has(round)) continue;
    flushedRounds.add(round);
    const ts = Date.now();
    for (const e of m.values()) {
      if (e.score <= 0) continue;            // AFK : pas persisté
      const found = e.words ? e.words.length : 0;
      try {
        await scoresDb.execute({
          sql: "INSERT INTO results(user_id, username, score, found, total, ts) VALUES(?,?,?,?,?,?)",
          args: [e.id || "", e.username, e.score, found, e.total || 0, ts],
        });
      } catch (err) { /* on n'interrompt pas le jeu pour un souci d'écriture */ }
    }
    await captureAnimals(m);   // attribue les emojis d'animaux trouvés cette manche
  }
  if (flushedRounds.size > 200) {
    for (const r of flushedRounds) { if (r < cur.round - KEEP_ROUNDS) flushedRounds.delete(r); }
  }
}

// Top 10 par fenêtre : meilleur par joueur (le bare-column suit le MAX, donc le bon pseudo)
async function topScores(sinceMs) {
  const r = await scoresDb.execute({
    sql: `SELECT username, MAX(score) AS best FROM results WHERE ts >= ? AND score > 0 GROUP BY user_id ORDER BY best DESC LIMIT 10`,
    args: [sinceMs],
  });
  return r.rows.map((x) => ({ username: x.username, score: Number(x.best) }));
}
async function topProportion(sinceMs) {
  const r = await scoresDb.execute({
    sql: `SELECT username, found, total, MAX(CAST(found AS REAL)/total) AS prop
          FROM results WHERE ts >= ? AND total > 0 AND found > 0 GROUP BY user_id ORDER BY prop DESC LIMIT 10`,
    args: [sinceMs],
  });
  return r.rows.map((x) => ({ username: x.username, prop: Number(x.prop), found: Number(x.found), total: Number(x.total) }));
}

// Fenêtres : depuis minuit (jour) et depuis lundi (semaine), en heure de Paris ; all-time
const TZ = "Europe/Paris";
function tzOffsetMs(ts) {
  const d = new Date(ts);
  const inTz = new Date(d.toLocaleString("en-US", { timeZone: TZ }));
  const inUtc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  return inTz.getTime() - inUtc.getTime();
}
function parisYMD(ts) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(ts).split("-").map(Number); // [Y, M, D]
}
function startOfDayParis(now = Date.now()) {
  const [Y, M, D] = parisYMD(now);
  const guess = Date.UTC(Y, M - 1, D, 0, 0, 0);
  return guess - tzOffsetMs(guess);               // 00:00 Paris -> epoch UTC
}
function startOfWeekParis(now = Date.now()) {
  const [Y, M, D] = parisYMD(now);
  const dow = new Date(Date.UTC(Y, M - 1, D)).getUTCDay(); // 0=dim … 6=sam
  const sinceMonday = (dow + 6) % 7;                        // lundi=0
  const guess = Date.UTC(Y, M - 1, D - sinceMonday, 0, 0, 0);
  return guess - tzOffsetMs(guess);               // lundi 00:00 Paris -> epoch UTC
}
function windows() {
  const now = Date.now();
  return { day: startOfDayParis(now), week: startOfWeekParis(now), all: 0 };
}

// ---------- Manche dérivée de l'horloge ----------
// Tout vient du temps : la rotation "tourne toute seule", et n'importe qui
// retombe sur la bonne manche + la bonne phase sans se concerter.
function currentRound(now = Date.now()) {
  const round = Math.floor((now - EPOCH) / CYCLE_MS);
  const start = EPOCH + round * CYCLE_MS;
  const elapsed = now - start;
  const playing = elapsed < PLAY_MS;
  const phaseEndsAt = playing ? start + PLAY_MS : start + CYCLE_MS;
  return {
    round,
    seed: String(round),    // le front fait gridFromSeed(seed) -> même grille pour tous
    phase: playing ? "play" : "break",
    msLeft: phaseEndsAt - now,
    phaseEndsAt,
    serverTime: now,        // pour que le front cale son chrono sur l'horloge serveur
    playMs: PLAY_MS,
    breakMs: BREAK_MS,
  };
}

function leaderboard(round, reveal = false) {
  const m = scoresByRound.get(round);
  if (!m) return [];
  return [...m.values()]
    .filter((e) => e.score > 0)              // joueurs AFK (0 point) masqués
    .sort((a, b) => b.score - a.score)
    .map((e) => reveal
      ? { username: e.username, score: e.score, words: e.words || [], emojis: emojisFor(e.id) }
      : { username: e.username, score: e.score, emojis: emojisFor(e.id) });
}

function recordScore(id, round, score, words, total) {
  const p = players.get(id);
  if (!p) return false;
  if (!scoresByRound.has(round)) scoresByRound.set(round, new Map());
  const m = scoresByRound.get(round);
  const prev = m.get(id);
  const keptTotal = Math.max(total || 0, prev ? prev.total || 0 : 0);
  if (!prev || score > prev.score) {
    m.set(id, { id, username: p.username, score, words: words && words.length ? words : (prev ? prev.words : []), total: keptTotal });
  } else {
    prev.total = keptTotal;          // le total de la grille peut arriver après le pic de score
    prev.username = p.username;
  }
  if (scoresByRound.size > KEEP_ROUNDS) {
    const cutoff = round - KEEP_ROUNDS;
    for (const r of scoresByRound.keys()) if (r < cutoff) scoresByRound.delete(r);
  }
  return true;
}

// ---------- Usernames visiteurs (en attendant l'auth) ----------
// Adjectifs (au masculin) et animaux (avec leur genre) pour les pseudos d'invités
const ADJ = ["curieux","pantois","chétif","badin","vigoureux","stupide","rusé","robuste","vaillant","valeureux",
  "solide","aberrant","dédaigneux","repenti","résilient","affligé","ténébreux","sinistre","complaisant","hirsute",
  "trivial","grégaire","caduc","démodé","desséché","sage","rancunier","magnanime","indulgent","amer","malin","ravi",
  "sournois","dégarni","fringant","vif","sympa","timide","tordu","taiseux","fatigué","agile"];
// [nom, féminin ?]
const ANI = [["singe",0],["cheval",0],["âne",0],["chenille",1],["poisson",0],["ours",0],["aigle",0],["poussin",0],
  ["mouette",1],["goéland",0],["renard",0],["perdrix",1],["poule",1],["crapaud",0],["crevette",1],["vipère",1],
  ["pieuvre",1],["mulot",0],["seiche",1],["grillon",0],["sardine",1],["canard",0],["caille",1],["oie",1],["buse",1],
  ["loche",1],["ver",0],["écureuil",0],["chevreuil",0],["mouche",1],["antilope",1],["autruche",1],["buffle",0],
  ["toucan",0],["blaireau",0],["lièvre",0],["hérisson",0],["loir",0],["loutre",1],["hibou",0],["lynx",0],["corbeau",0],
  ["faucon",0],["castor",0],["rat",0],["mite",1],["cormoran",0],["caribou",0],["belette",1],["chouette",1],["lézard",0],
  ["moineau",0],["mésange",1],["pigeon",0],["escargot",0],["hareng",0],["anguille",1],["brochet",0]];
// Accorde un adjectif masculin au féminin
const FEM_IRR = { malin: "maligne" };
function feminize(adj) {
  if (FEM_IRR[adj]) return FEM_IRR[adj];
  if (adj === "sympa" || /e$/.test(adj)) return adj;          // -e (ou sympa) : invariable
  if (/eux$/.test(adj)) return adj.replace(/eux$/, "euse");   // curieux -> curieuse
  if (/if$/.test(adj)) return adj.replace(/if$/, "ive");      // vif -> vive
  if (/c$/.test(adj)) return adj.replace(/c$/, "que");        // caduc -> caduque
  if (/er$/.test(adj)) return adj.replace(/er$/, "ère");      // amer -> amère, rancunier -> rancunière
  return adj + "e";                                           // rusé -> rusée, vaillant -> vaillante…
}
function visitorName() {
  const [ani, fem] = ANI[(Math.random() * ANI.length) | 0];
  let adj = ADJ[(Math.random() * ADJ.length) | 0];
  if (fem) adj = feminize(adj);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return cap(adj) + cap(ani) + (100 + ((Math.random() * 900) | 0));
}

// ---------- Emojis d'animaux capturés au fil des manches ----------
// Le dernier joueur à trouver le nom d'un animal récupère son emoji ; à égalité de manche,
// c'est le meilleur score. Le détenteur garde l'emoji tant que personne d'autre ne le trouve.
const ANIMOJI = {
  singe:"🦧", cheval:"🐴", "âne":"🫏", chenille:"🐛", poisson:"🐟", ours:"🐻", aigle:"🦅",
  poussin:"🐤", mouette:"🕊️", "goéland":"🐦", renard:"🦊", perdrix:"🐦", poule:"🐔",
  crapaud:"🐸", crevette:"🦐", "vipère":"🐍", pieuvre:"🐙", mulot:"🐭", seiche:"🦑",
  grillon:"🦗", sardine:"🐟", canard:"🦆", caille:"🐦", oie:"🦢", buse:"🦅", loche:"🐟",
  ver:"🪱", "écureuil":"🐿️", chevreuil:"🦌", mouche:"🪰", antilope:"🦌", autruche:"🦤",
  buffle:"🐃", toucan:"🦜", blaireau:"🦡", "lièvre":"🐇", "hérisson":"🦔", loir:"🐭",
  loutre:"🦦", hibou:"🦉", lynx:"🐈", corbeau:"🐦", faucon:"🦅", castor:"🦫", rat:"🐀",
  mite:"🦋", cormoran:"🐦", caribou:"🦌", belette:"🐭", chouette:"🦉", "lézard":"🦎",
  moineau:"🐦", "mésange":"🐦", pigeon:"🐦", escargot:"🐌", hareng:"🐟", anguille:"🐟", brochet:"🐟",
  // Ajouts pour enrichir la collection (emojis distincts) — pas dans les pseudos, juste à collectionner
  chat:"🐱", chien:"🐶", lion:"🦁", loup:"🐺", tigre:"🐯", vache:"🐮", lapin:"🐰", souris:"🐁",
  cochon:"🐷", tortue:"🐢", crabe:"🦀", requin:"🦈", dauphin:"🐬", baleine:"🐋", girafe:"🦒",
  "zèbre":"🦓", panda:"🐼", koala:"🐨", lama:"🦙", "chèvre":"🐐", mouton:"🐑", abeille:"🐝",
  fourmi:"🐜", phoque:"🦭", crocodile:"🐊", "éléphant":"🐘", chameau:"🐫", gorille:"🦍",
  dinde:"🦃", paon:"🦚", coq:"🐓", "araignée":"🕷️", scorpion:"🦂", moustique:"🦟", "méduse":"🪼",
  bison:"🦬", sanglier:"🐗", kangourou:"🦘", paresseux:"🦥", hamster:"🐹", manchot:"🐧", flamant:"🦩",
};
const deacc = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const NORM_ANIMOJI = {};                 // "ecureuil" -> emoji (les mots trouvés sont sans accents)
for (const k in ANIMOJI) NORM_ANIMOJI[deacc(k)] = ANIMOJI[k];

const animalHolders = new Map();         // animal (normalisé) -> { id, name }
async function loadAnimals() {
  await scoresDb.execute(`CREATE TABLE IF NOT EXISTS animals(name TEXT PRIMARY KEY, holder_id TEXT, holder_name TEXT, ts INTEGER)`);
  try {
    const r = await scoresDb.execute("SELECT name, holder_id, holder_name FROM animals");
    for (const row of r.rows) animalHolders.set(String(row.name), { id: String(row.holder_id || ""), name: String(row.holder_name || "") });
  } catch {}
}
async function setAnimalHolder(animal, id, name) {
  animalHolders.set(animal, { id, name });
  try { await scoresDb.execute({ sql: "INSERT OR REPLACE INTO animals(name, holder_id, holder_name, ts) VALUES(?,?,?,?)", args: [animal, id, name, Date.now()] }); } catch {}
}

// Liste affichable (emoji + nom joli + clé normalisée)
const ANIMAL_LIST = Object.keys(ANIMOJI).map((k) => ({ key: deacc(k), name: k, emoji: ANIMOJI[k] }));

// Préférences d'affichage : chaque joueur peut masquer certains de ses emojis (pour lui ET pour les autres)
const hiddenAnimals = new Map();         // id -> Set(noms normalisés masqués)
async function loadAnimalPrefs() {
  await scoresDb.execute(`CREATE TABLE IF NOT EXISTS animal_prefs(id TEXT PRIMARY KEY, hidden TEXT, ts INTEGER)`);
  try {
    const r = await scoresDb.execute("SELECT id, hidden FROM animal_prefs");
    for (const row of r.rows) { try { hiddenAnimals.set(String(row.id), new Set(JSON.parse(row.hidden || "[]"))); } catch {} }
  } catch {}
}
async function setHiddenAnimals(id, list) {
  const set = new Set((Array.isArray(list) ? list : []).filter((n) => NORM_ANIMOJI[n]));   // seulement des animaux connus
  hiddenAnimals.set(id, set);
  try { await scoresDb.execute({ sql: "INSERT OR REPLACE INTO animal_prefs(id, hidden, ts) VALUES(?,?,?)", args: [id, JSON.stringify([...set]), Date.now()] }); } catch {}
}
// Emojis (uniques, non masqués) détenus par un joueur
function emojisFor(id) {
  if (!id) return [];
  const hidden = hiddenAnimals.get(id);
  const out = [], seen = new Set();
  for (const [animal, h] of animalHolders) {
    if (h.id === id && !(hidden && hidden.has(animal))) {
      const e = NORM_ANIMOJI[animal]; if (e && !seen.has(e)) { seen.add(e); out.push(e); }
    }
  }
  return out;
}
// Fin de manche : chaque animal trouvé va au meilleur score parmi ceux qui l'ont trouvé
async function captureAnimals(roundMap) {
  const players_ = [...roundMap.values()];
  for (const animal in NORM_ANIMOJI) {
    let best = null;
    for (const e of players_) {
      if (e.words && e.words.includes(animal) && (!best || e.score > best.score)) best = e;
    }
    if (best) {
      const cur = animalHolders.get(animal);
      if (!cur || cur.id !== (best.id || "")) await setAnimalHolder(animal, best.id || "", best.username);
    }
  }
}

// ---------- Helpers HTTP ----------
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

// Sert le site (la page du jeu) depuis ./public
async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    const noCache = ext === ".html" || ext === ".webmanifest" || filePath.endsWith("sw.js");
    const cacheControl = noCache ? "no-cache" : (ext === ".png" || ext === ".ico" ? "public, max-age=86400" : "no-cache");
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": cacheControl, ...CORS });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Page introuvable. Place le jeu dans server/public/index.html");
  }
}

// ---------- Routes ----------
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  const { pathname, searchParams } = new URL(req.url, "http://x");

  try {
    // Auth : inscription, connexion (email/Google), session, déconnexion
    if (pathname.startsWith("/api/auth/")) return authHandler(req, res);

    // État courant : seed de la manche + phase + temps restant + classement
    if (req.method === "GET" && pathname === "/api/state") {
      const st = currentRound();
      return send(res, 200, { ...st, leaderboard: leaderboard(st.round, st.phase === "break") });
    }

    // Rejoindre : si connecté -> identité du compte ; sinon -> visiteur (identité réutilisée si le client la renvoie)
    if (req.method === "POST" && pathname === "/api/join") {
      const body = await readBody(req);
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
      let id, username, authenticated = false;
      if (session?.user) {
        id = "u:" + session.user.id;                                   // identité stable du compte
        username = cleanName(session.user.name) || cleanName(session.user.email) || "Joueur";
        authenticated = true;
      } else {
        const gid = typeof body.guestId === "string" ? body.guestId.trim() : "";
        const clientId = /^[A-Za-z0-9_-]{8,64}$/.test(gid) ? gid : null;   // UUID invité (jamais un id de compte "u:…")
        const clientName = cleanName(body.guestName);
        id = clientId || randomUUID();                                  // réutilise l'identité invité si fournie
        username = clientName || visitorName();
      }
      players.set(id, { username });
      return send(res, 200, { id, username, authenticated, ...currentRound() });
    }

    // Envoyer son score + ses mots pour la manche courante
    if (req.method === "POST" && pathname === "/api/score") {
      const body = await readBody(req);
      const id = String(body.id || "");
      const score = Math.max(0, Math.floor(Number(body.score) || 0));
      const words = (Array.isArray(body.words) ? body.words : [])
        .slice(0, 400)
        .map((w) => String(w).toLowerCase().replace(/[^a-zà-ÿ]/g, "").slice(0, 24))
        .filter(Boolean);
      const total = Math.max(0, Math.floor(Number(body.total) || 0));
      const now = currentRound();
      const round = Number.isInteger(body.round) ? body.round : now.round;
      if (round !== now.round) return send(res, 409, { error: "round_closed", current: now.round });
      if (!recordScore(id, round, score, words, total)) return send(res, 401, { error: "unknown_player" });
      return send(res, 200, { ok: true, round, leaderboard: leaderboard(round) });
    }

    // Palmarès persistant : meilleurs scores + meilleure proportion (jour / semaine / all-time)
    if (req.method === "GET" && pathname === "/api/records") {
      await flushFinishedRounds().catch(() => {});   // inclut la manche qui vient de finir
      const w = windows();
      const [sd, sw, sa, pd, pw, pa] = await Promise.all([
        topScores(w.day), topScores(w.week), topScores(w.all),
        topProportion(w.day), topProportion(w.week), topProportion(w.all),
      ]);
      return send(res, 200, { scores: { day: sd, week: sw, all: sa }, props: { day: pd, week: pw, all: pa } });
    }

    // Définition d'un mot (Wiktionnaire, mise en cache)
    if (req.method === "GET" && pathname === "/api/define") {
      const mot = (searchParams.get("mot") || "").toLowerCase().replace(/[^a-zà-ÿ]/g, "").slice(0, 40);
      if (!mot || mot.length < 2) return send(res, 400, { error: "bad_word" });
      const def = await getDefinition(mot);
      return send(res, 200, { mot, defs: Array.isArray(def) ? def : [] });
    }

    // Liste des animaux (emoji + nom) + ce que ce joueur détient / masque
    if (req.method === "GET" && pathname === "/api/animals") {
      const id = searchParams.get("id") || "";
      const held = [];
      for (const [animal, h] of animalHolders) if (h.id === id) held.push(animal);
      return send(res, 200, { animals: ANIMAL_LIST, held, hidden: [...(hiddenAnimals.get(id) || [])] });
    }
    // Enregistrer les animaux masqués d'un joueur (affecte l'affichage pour tous)
    if (req.method === "POST" && pathname === "/api/animals/hide") {
      const body = await readBody(req);
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) return send(res, 400, { error: "no_id" });
      await setHiddenAnimals(id, body.hidden);
      return send(res, 200, { ok: true, hidden: [...(hiddenAnimals.get(id) || [])] });
    }

    // Classement d'une manche précise (ou la courante par défaut)
    if (req.method === "GET" && pathname === "/api/leaderboard") {
      const cur = currentRound();
      const round = searchParams.has("round") ? Number(searchParams.get("round")) : cur.round;
      const reveal = round < cur.round || (round === cur.round && cur.phase === "break");
      return send(res, 200, { round, leaderboard: leaderboard(round, reveal) });
    }

    // Tout autre GET hors /api : on sert le site statique
    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      return serveStatic(res, pathname);
    }
    return send(res, 404, { error: "not_found" });
  } catch {
    return send(res, 500, { error: "server_error" });
  }
});

// Crée/complète les tables d'auth (idempotent) puis démarre
try {
  const mig = await getMigrations(auth.options);
  await mig.runMigrations();
} catch (e) {
  console.error("⚠ Migrations auth :", e.message);
}

// Base de scores persistante + flush périodique des manches terminées
try {
  await initScoresDb();
  await loadAnimals();
  await loadAnimalPrefs();
  setInterval(() => { flushFinishedRounds().catch(() => {}); }, Number(process.env.FLUSH_MS || 10_000));
} catch (e) {
  console.error("⚠ Base de scores :", e.message);
}

server.listen(PORT, () => {
  const g = process.env.GOOGLE_CLIENT_ID ? "email + Google" : "email (Google non configuré)";
  console.log(`Chasse aux mots — serveur sur :${PORT} (manche ${PLAY_MS / 1000}s + pause ${BREAK_MS / 1000}s) — auth: ${g}`);
});
