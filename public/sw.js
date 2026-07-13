// Minimal service worker - just enough to satisfy installability requirements.
// Network-first: always tries the live server first (so orders are always fresh),
// falling back to cache only if the network is unavailable.
const CACHE_NAME = 'order-desk-v1';
const CORE_ASSETS = ['/', '/style.css', '/app.js', '/manifest.json'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Never cache API calls - orders must always be live data
  if (event.request.url.includes('/api/') || event.request.url.includes('/webhook')) return;

  event.respondWith(
    fetch(event.request)
      .then(res => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
