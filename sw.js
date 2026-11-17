// ALKHIDMAT PRINT PWA service worker.
// Scope: the folder this script is served from (/functions/v1/webapp/).
// Strategy: cache the app shell (HTML/CSS/JS/manifest/icons) cache-first
// so the installed shortcut opens instantly; NEVER intercept cross-origin
// traffic (Supabase Auth/REST/Storage/Functions) — those always go to the
// network, and the share-drop POST is outside this scope anyway.
const CACHE = "alkhidmat-print-v2";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return; // network only
  }
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(
      (hit) =>
        hit ??
        fetch(event.request).then((res) => {
          if (res.ok && SHELL.some((s) => url.pathname.endsWith(s.replace("./", "/")))) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        }),
    ),
  );
});
