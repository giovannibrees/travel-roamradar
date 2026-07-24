/* Travel - service worker. Network-first for everything, cache fallback for
   offline. The app lives at /app; the marketing site is /. The sync API
   (/trips, /sync) is never cached. */
const CACHE = "travel-v5";
const SHELL = ["/app", "/manifest.webmanifest", "/icon-180.png", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.map((k) => (k === CACHE ? null : caches.delete(k))))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // let cross-origin (Wikipedia, images, fonts) go straight to network
  if (url.pathname.endsWith("/trips") || url.pathname.endsWith("/sync")) return; // always hit the network for sync
  e.respondWith(
    fetch(req)
      .then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return res; })
      .catch(() => caches.match(req).then((m) => m || caches.match("/app")))
  );
});
