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
      ? { username: e.username, score: e.score, words: e.words || [] }
      : { username: e.username, score: e.score });
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
const ADJ = ["Vif", "Malin", "Rusé", "Futé", "Agile", "Calme", "Joyeux", "Sage", "Rapide", "Discret"];
const ANI = ["Renard", "Hibou", "Lynx", "Loutre", "Faucon", "Castor", "Furet", "Corbeau", "Belette", "Martre"];
function visitorName() {
  const a = ADJ[(Math.random() * ADJ.length) | 0];
  const n = ANI[(Math.random() * ANI.length) | 0];
  return `${a}${n}${100 + ((Math.random() * 900) | 0)}`;
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

    // Rejoindre : si connecté -> identité du compte ; sinon -> visiteur
    if (req.method === "POST" && pathname === "/api/join") {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
      let id, username, authenticated = false;
      if (session?.user) {
        id = "u:" + session.user.id;                                   // identité stable du compte
        username = (session.user.name || session.user.email || "Joueur").slice(0, MAX_NAME);
        authenticated = true;
      } else {
        id = randomUUID();
        username = visitorName();
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
  setInterval(() => { flushFinishedRounds().catch(() => {}); }, Number(process.env.FLUSH_MS || 10_000));
} catch (e) {
  console.error("⚠ Base de scores :", e.message);
}

server.listen(PORT, () => {
  const g = process.env.GOOGLE_CLIENT_ID ? "email + Google" : "email (Google non configuré)";
  console.log(`Chasse au mot — serveur sur :${PORT} (manche ${PLAY_MS / 1000}s + pause ${BREAK_MS / 1000}s) — auth: ${g}`);
});
