// Service worker: makes the dashboard installable, caches the
// hashed build assets and the app shell, and routes clicks on
// notifications back to the page. API, login and Socket.IO
// requests are never touched.
const CACHE = 'agent-dashboard-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Build assets have content hashes: cache first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // App shell: network first, cached copy when offline.
  if (
    req.mode === 'navigate' &&
    (url.pathname === '/' || url.pathname.startsWith('/terminal/'))
  ) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/')),
    );
  }
});

// The notification tag is the agent id: open its tab.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const agentId = event.notification.tag;
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const client = clients.find((c) => new URL(c.url).pathname === '/');
        if (client) {
          client.postMessage({ type: 'open-agent', agentId });
          return client.focus();
        }
        return self.clients.openWindow('/');
      }),
  );
});
