import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8", ".svg":"image/svg+xml",
  ".png":"image/png", ".ico":"image/x-icon" };

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
const scoresByRound = new Map();  // round -> Map(id -> { username, score })

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

function leaderboard(round) {
  const m = scoresByRound.get(round);
  if (!m) return [];
  return [...m.values()]
    .sort((a, b) => b.score - a.score)
    .map((e) => ({ username: e.username, score: e.score }));
}

function recordScore(id, round, score) {
  const p = players.get(id);
  if (!p) return false;
  if (!scoresByRound.has(round)) scoresByRound.set(round, new Map());
  const m = scoresByRound.get(round);
  const prev = m.get(id);
  if (!prev || score > prev.score) m.set(id, { username: p.username, score }); // on garde le meilleur
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
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream", ...CORS });
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
    // État courant : seed de la manche + phase + temps restant + classement
    if (req.method === "GET" && pathname === "/api/state") {
      const st = currentRound();
      return send(res, 200, { ...st, leaderboard: leaderboard(st.round) });
    }

    // Rejoindre : reçoit un username visiteur (ou le sien) + un id à conserver
    if (req.method === "POST" && pathname === "/api/join") {
      const body = await readBody(req);
      const id = randomUUID();
      const username = (typeof body.name === "string" && body.name.trim())
        ? body.name.trim().slice(0, MAX_NAME) : visitorName();
      players.set(id, { username });
      return send(res, 200, { id, username, ...currentRound() });
    }

    // Envoyer son score pour la manche courante
    if (req.method === "POST" && pathname === "/api/score") {
      const body = await readBody(req);
      const id = String(body.id || "");
      const score = Math.max(0, Math.floor(Number(body.score) || 0));
      const now = currentRound();
      const round = Number.isInteger(body.round) ? body.round : now.round;
      if (round !== now.round) return send(res, 409, { error: "round_closed", current: now.round });
      if (!recordScore(id, round, score)) return send(res, 401, { error: "unknown_player" });
      return send(res, 200, { ok: true, round, leaderboard: leaderboard(round) });
    }

    // Classement d'une manche précise (ou la courante par défaut)
    if (req.method === "GET" && pathname === "/api/leaderboard") {
      const round = searchParams.has("round") ? Number(searchParams.get("round")) : currentRound().round;
      return send(res, 200, { round, leaderboard: leaderboard(round) });
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

server.listen(PORT, () => {
  console.log(`Chasse au mot — serveur sur :${PORT} (manche ${PLAY_MS / 1000}s + pause ${BREAK_MS / 1000}s)`);
});
