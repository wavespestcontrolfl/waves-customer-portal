const CACHE_NAME = 'waves-v6-admin-customers-tdz';
const OFFLINE_URL = '/';

const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reconnecting…</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:#0f1923;color:#e2e8f0;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{min-height:100%;display:flex;flex-direction:column;align-items:center;
    justify-content:center;padding:24px;text-align:center}
  .logo{width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#0ea5e9,#38bdf8);
    display:flex;align-items:center;justify-content:center;font-weight:800;font-size:26px;color:#fff;margin-bottom:18px}
  h1{font-size:18px;margin:0 0 6px;font-weight:700}
  p{font-size:13px;margin:0 0 18px;color:#94a3b8;max-width:320px;line-height:1.5}
  button{padding:10px 22px;background:#0ea5e9;color:#fff;border:0;border-radius:8px;
    font-size:14px;font-weight:600;cursor:pointer}
</style></head>
<body><div class="wrap">
  <div class="logo">W</div>
  <h1>Reconnecting…</h1>
  <p>Waves needs a connection to load. We'll reload automatically when you're back online.</p>
  <button onclick="location.reload()">Try again</button>
</div>
<script>
  addEventListener('online', () => location.reload());
  // Re-attempt periodically in case the offline event misses (iOS sometimes does).
  setTimeout(() => { if (navigator.onLine) location.reload(); }, 4000);
</script></body></html>`;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.add(new Request(OFFLINE_URL, { cache: 'reload' }))).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim()).then(() => (
      self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    )).then(clients => Promise.all(
      clients
        .filter(client => {
          try {
            return client.url && new URL(client.url).pathname.startsWith('/admin');
          } catch {
            return false;
          }
        })
        .map(client => client.navigate(client.url))
    ))
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept: external requests, API calls, WebSocket
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/ws/')) return;

  // HTML navigation requests: network-first with offline fallback.
  // ALWAYS return a Response (never undefined) so iOS standalone PWAs
  // never render a blank screen on flaky cellular.
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        // Stash a copy of the SPA shell so we have an offline fallback that
        // references the same hashed assets we already have cached.
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(OFFLINE_URL, clone)).catch(() => {});
        }
        return response;
      } catch {
        const cached = (await caches.match(OFFLINE_URL)) || (await caches.match(event.request));
        if (cached) return cached;
        return new Response(OFFLINE_FALLBACK_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    })());
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
      renotify: !!data.renotify,
      requireInteraction,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || '/'));
});
