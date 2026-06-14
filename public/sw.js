// Service worker — Chasse au mot
// Stratégie :
//  - Page (navigation) : network-first -> toujours la dernière version en ligne,
//    repli sur le cache uniquement si hors-ligne.
//  - Fichiers statiques (icônes, manifeste) : cache-first, complété par le réseau.
//  - /api/* : jamais mis en cache (état, scores, auth passent toujours par le réseau).
const CACHE = "cam-v1";
const SHELL = [
  "/", "/manifest.webmanifest",
  "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                 // POST (scores, auth) -> réseau direct
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;       // ressources tierces -> on ne touche pas
  if (url.pathname.startsWith("/api/")) return;     // API -> jamais de cache

  // Page : on tente le réseau d'abord, et on garde une copie pour le hors-ligne
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/", copy)); return res; })
        .catch(() => caches.match("/").then((r) => r || caches.match(req)))
    );
    return;
  }

  // Statiques : cache d'abord, réseau en complément
  e.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
        .catch(() => cached)
    )
  );
});
