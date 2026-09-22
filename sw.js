// Minimal service worker — mainly here to satisfy "installable app" rules
// and give a slightly faster reload. It does NOT make login/progress work
// offline (that still needs internet, since it talks to Firebase), but it
// caches the app shell so it opens instantly and looks like a real app.

const CACHE_NAME = 'letterlearner-shell-v1';
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
  // Network-first for everything (so content/login updates show up right
  // away), falling back to the cached shell only if totally offline.
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
