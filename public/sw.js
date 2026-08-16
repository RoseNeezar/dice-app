/*
 * OpenScan service worker.
 *
 * Two caches, both stamped with VERSION so a new build starts from empty and
 * the old generation is deleted on activate:
 *
 *   shell   — the app entry point, the manifest and the icons, precached on
 *             install so the very first offline launch works.
 *   runtime — the hashed build assets, filled in as they are first requested.
 *             Their names change with every build, so precaching them would
 *             mean generating this file at build time.
 *
 * Navigations are network-first, so a deployed fix reaches people on their next
 * visit rather than whenever the cache happens to turn over; everything else is
 * cache-first, because a hashed asset never changes under its own name.
 *
 * Only same-origin GET requests over http(s) are touched. Scans live in
 * IndexedDB, which never travels over HTTP, so nothing here can see — let alone
 * cache — a document.
 */

const VERSION = 'v1.0.0';
const SHELL_CACHE = `openscan-shell-${VERSION}`;
const RUNTIME_CACHE = `openscan-runtime-${VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, RUNTIME_CACHE];

/** The document served for every route: this is a single-page app. */
const APP_SHELL = '/index.html';

const PRECACHE = [
  '/',
  APP_SHELL,
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-180.png',
];

const OFFLINE_FALLBACK = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenScan is offline</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
       font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       background:#f4f5f7;color:#14171c;text-align:center}
  h1{font-size:18px;margin:0 0 8px}
  p{margin:0;color:#4a515c;max-width:32ch}
  @media (prefers-color-scheme:dark){body{background:#0f1115;color:#eef1f6}p{color:#aeb6c4}}
</style></head>
<body><div><h1>OpenScan is not available offline yet</h1>
<p>Open it once with a connection and it will keep working without one.</p></div></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Added one at a time: `addAll` rejects the whole install if a single
      // entry 404s, which would leave the app with no worker at all.
      await Promise.all(
        PRECACHE.map((path) => cache.add(new Request(path, { cache: 'reload' })).catch(() => undefined)),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('openscan-') && !CURRENT_CACHES.includes(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// The page asks for the new build only when the user accepts it, so an export
// or a scan in progress is never interrupted by a silent takeover.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** Whether this response is worth keeping: a complete, same-origin, 200 body. */
function isCacheable(response) {
  return Boolean(response) && response.status === 200 && response.type === 'basic';
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    // Stored under the shell key rather than the request URL: every route in a
    // single-page app is served by the same document, and caching per-path
    // would fill the cache with copies of it.
    if (isCacheable(response)) cache.put(APP_SHELL, response.clone());
    return response;
  } catch {
    const cached = (await cache.match(APP_SHELL)) || (await cache.match('/'));
    if (cached) return cached;
    return new Response(OFFLINE_FALLBACK, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function cacheFirstAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) {
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;
  // A range request wants a slice of a file; a cached 200 would answer the
  // wrong bytes, so those go straight to the network.
  if (request.headers.has('range')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  event.respondWith(cacheFirstAsset(request));
});
