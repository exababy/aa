/* SAS Smart PWA service worker: uygulama kabuğunu çevrimdışı açılış için saklar, /api isteklerine dokunmaz.
   Her şey önce ağdan alınır; önbellek yalnızca bağlantı yokken kullanılır. */
const CACHE = 'sas-smart-v10';
const STATIC = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    const res = await fetch('/', { cache: 'no-store' });
    const html = await res.clone().text();
    await c.put('/', res);
    // index.html'deki sürümlü dosyalar (app.js?v=..., styles.css?v=...)
    const assets = [...html.matchAll(/(?:href|src)="(\/[^"]+\.(?:css|js)\?v=[^"]+)"/g)].map((m) => m[1]);
    await c.addAll([...assets, ...STATIC]);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const nav = req.mode === 'navigate';

  e.respondWith(
    fetch(nav ? '/' : req, { cache: 'no-store' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(async (c) => {
            // aynı dosyanın eski sürümlerini sil
            for (const k of await c.keys()) {
              const ku = new URL(k.url);
              if (ku.pathname === (nav ? '/' : url.pathname) && ku.search !== (nav ? '' : url.search)) await c.delete(k);
            }
            await c.put(nav ? '/' : req, copy);
          });
        }
        return res;
      })
      .catch(() => caches.match(nav ? '/' : req).then((hit) => hit || Response.error()))
  );
});
