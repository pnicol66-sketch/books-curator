'use strict';
const CACHE = 'bookcurator-20260924-051607';
const ASSETS = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './icon.svg', './icon-192.png', './icon-512.png', './icon-512-maskable.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  // No skipWaiting here: taking over mid-session leaves the open page running
  // the previous app.js against fresh assets. Wait until the user taps Update.
  // cache: 'reload' goes past the browser's HTTP cache (Pages marks files fresh for
  // ten minutes), so a new build never stores the old files under its new name.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate for same-origin GETs: instant offline load — this app
// gets used in basements and attics. Staleness is handled by the update prompt,
// not by making every launch wait on the network.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fresh = fetch(e.request).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
