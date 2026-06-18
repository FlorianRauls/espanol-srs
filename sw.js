// sw.js — minimal service worker for installability + an offline app shell.
// Only the static shell is cached. LLM calls (cross-origin POST to Azure) are never
// intercepted, so the review loop works offline while LLM features simply need network.

const CACHE = 'espanol-srs-v3';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './fonts/bricolage.woff2',
  './js/app.js',
  './js/db.js',
  './js/scheduler.js',
  './js/speech.js',
  './js/llm.js',
  './js/stats.js',
  './js/exportImport.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll fails the whole install if one file 404s; add individually and ignore misses.
      .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  // Only handle same-origin GET requests; let everything else (Azure POST, etc.) pass through.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Stale-while-revalidate: serve from cache instantly (fast, offline-friendly) AND fetch
  // a fresh copy in the background so code updates propagate without a manual cache bump.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const networkPromise = fetch(req)
      .then(res => {
        if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);
    event.waitUntil(networkPromise); // keep updating the cache even after responding
    return cached || (await networkPromise);
  })());
});
