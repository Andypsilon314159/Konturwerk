/* Service Worker: hält die App offline verfügbar (Netz zuerst, Cache als Rückfall). */
const CACHE = "konturwerk-1.4.0"; // muss zu APP_VERSION in app.js passen
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "vectorizer.js",
  "worker.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  // Netz zuerst, damit Updates ankommen; ohne Verbindung aus dem Cache.
  // "no-cache" umgeht den HTTP-Cache des Browsers (GitHub Pages: 10 Minuten),
  // fragt aber per ETag nach – unveränderte Dateien werden nicht neu geladen.
  event.respondWith(
    fetch(event.request, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
