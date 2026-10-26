/* Service worker: keeps a copy of the app on the device so it opens with no internet, and updates itself.
   Strategy: serve the cached files instantly, then refresh the cache in the background.
   When the refresh finds a new index.html, a flag is stored; the page asks ("check") on launch and when
   brought back to the foreground, and reloads (or offers to, mid-game) when the flag is set. */
'use strict';

const CACHE = 'bingo-v1';
const scope = self.registration.scope;
const PAGE = new URL('./index.html', scope).href;
const ASSETS = ['./index.html', './manifest.webmanifest', './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png']
  .map(p => new URL(p, scope).href);
const FLAG = new URL('./__update-ready', scope).href;   // cache entry, not a real file

/** Fetch the latest files into the cache; flag it if the page differs from the copy we had. */
async function refresh() {
  const cache = await caches.open(CACHE);
  let changed = false;
  await Promise.all(ASSETS.map(async url => {
    const res = await fetch(url, { cache: 'no-cache' }).catch(() => null);
    if (!res || !res.ok) return;
    if (url === PAGE) {
      const old = await cache.match(PAGE);
      const [fresh, prev] = await Promise.all([res.clone().text(), old ? old.text() : null]);
      if (prev !== null && fresh !== prev) changed = true;
    }
    await cache.put(url, res);
  }));
  if (changed) await cache.put(FLAG, new Response('1'));
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    await refresh();
    if (!(await caches.match(PAGE))) throw new Error('could not cache the app');
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Any page load within the app's folder (e.g. "/bingo/" or "/bingo/index.html") gets the app.
  const isPage = req.mode === 'navigate' || req.url === PAGE;
  const url = isPage ? PAGE : req.url.split('#')[0];
  if (!isPage && !ASSETS.includes(url)) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(url);
    if (cached) {
      // This load shows the newest cached page, so any pending "update ready" is now satisfied.
      if (isPage) e.waitUntil(cache.delete(FLAG).then(refresh));
      return cached;
    }
    const res = await fetch(url, { cache: 'no-cache' }).catch(() => null);
    if (res && res.ok) { await cache.put(url, res.clone()); return res; }
    return new Response('Offline — open the app once with a connection.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }));
});

// The page asks whether a newer version is waiting.
self.addEventListener('message', e => {
  if (e.data?.type !== 'check') return;
  e.waitUntil((async () => {
    await refresh();
    if (await caches.match(FLAG)) e.source?.postMessage({ type: 'update-ready' });
  })());
});
