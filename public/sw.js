// D-96: the installable signer app's service worker. It keeps exactly three things on the device: the offline page
// and two icons. It never stores a page, a document, a signature, a session or any answer from the app: signing pages
// always come from the network, and only when the network fails is the stored offline page shown instead. Everything
// else (other pages, the API, files, the sender's app) passes straight through, untouched.
const CACHE = 'ynms-signer-shell-v1';
const OFFLINE = '/offline.html';
const SHELL = [OFFLINE, '/icons/icon-192.png', '/icons/icon-512.png'];
const SIGNER_PAGE = /^\/(s|sign)(\/|$)|^\/f\/[^/]+$/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  // remove anything an older version kept
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && SIGNER_PAGE.test(url.pathname)) {
    // network only; the response is not stored
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
    return;
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then((hit) => hit || fetch(request)));
  }
  // anything else: not handled here, so the browser fetches it as usual
});
