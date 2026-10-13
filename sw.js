// Minimal service worker for Alif Quran Academy.
// Caches the app shell so it opens fast and counts as an installable app.
// Login/progress still need internet (they talk to Firebase).

const CACHE_NAME = 'alif-quran-academy-shell-v10'; // bump this number whenever you deploy an update
const SHELL_FILES = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Leave Firebase, Jitsi, APIs and any non-GET request alone.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Network-first (skipping the browser's HTTP cache so updates show right away),
  // falling back to the cached shell only when offline.
  event.respondWith(
    fetch(req, { cache: 'no-cache' }).catch(() => caches.match(req))
  );
});
