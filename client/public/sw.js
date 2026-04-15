const CACHE_NAME = 'waves-v4';

self.addEventListener('install', event => {
  self.skipWaiting(); // Activate immediately, don't wait for old tabs to close
});

self.addEventListener('activate', event => {
  // Delete ALL old caches on activate
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept: external requests, API calls, WebSocket
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/ws/')) return;

  // HTML navigation requests: ALWAYS go to network first
  // This ensures deploys are picked up immediately
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
    return;
  }

  // Hashed assets (/assets/index-CRewFOq2.js) — cache forever, they're immutable
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else (manifest, icons, etc.) — network first, cache fallback
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});

self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  const requireInteraction = data.priority === 'urgent';
  event.waitUntil(
    self.registration.showNotification(data.title || 'Waves Pest Control', {
      body: data.body || '', icon: '/waves-logo.png', badge: '/waves-logo.png',
      tag: data.tag || 'waves', data: { url: data.url || '/' },
      actions: data.actions || [],
      vibrate: data.vibrate || [200, 100, 200],
      silent: !!data.silent,
      requireInteraction,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || '/'));
});
