// sw.js — minimal service worker for installability + an offline app shell.
// Only the static shell is cached. LLM calls (cross-origin POST to Azure) are never
// intercepted, so the review loop works offline while LLM features simply need network.

const CACHE = 'espanol-srs-v2';
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

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req)
        .then(res => {
          // Cache successful basic responses for next time.
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached); // offline and uncached → undefined (browser shows its own error)
    })
  );
});
