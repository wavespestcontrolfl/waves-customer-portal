const APP_CACHE_PREFIX = 'waves-customer-';
const CACHE_NAME = 'waves-customer-v11-shell-atomic';
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

function shellAssetUrls(html) {
  const urls = new Set();
  const re = /(?:src|href)=["'](\/assets\/[^"']+)["']/g;
  let match;
  while ((match = re.exec(String(html || '')))) urls.add(match[1]);
  return [...urls];
}

async function cacheCompleteShellResponse(shellResponse) {
  const cache = await caches.open(CACHE_NAME);
  if (!shellResponse.ok) throw new Error(`Shell request failed (${shellResponse.status})`);

  const html = await shellResponse.clone().text();
  const assets = shellAssetUrls(html);
  if (!assets.length) throw new Error('Shell contains no build assets');

  // Fetch every hashed dependency before storing the new HTML. If any fetch
  // fails, installation rejects and the previous worker/cache remains active;
  // customers never receive an offline shell whose entry chunk is missing.
  const assetResponses = await Promise.all(assets.map(async assetUrl => {
    const response = await fetch(new Request(assetUrl, { cache: 'reload' }));
    if (!response.ok) throw new Error(`Shell asset failed (${response.status}): ${assetUrl}`);
    return [assetUrl, response];
  }));
  await Promise.all(assetResponses.map(([assetUrl, response]) => cache.put(assetUrl, response)));
  await cache.put(OFFLINE_URL, shellResponse);
}

async function precacheCompleteShell() {
  const shellRequest = new Request(OFFLINE_URL, { cache: 'reload' });
  const shellResponse = await fetch(shellRequest);
  await cacheCompleteShellResponse(shellResponse);
}

self.addEventListener('install', event => {
  event.waitUntil(precacheCompleteShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith(APP_CACHE_PREFIX) && k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
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
        // Refresh the offline shell only after all of the HTML's hashed assets
        // are available. Keep serving the current page immediately; if this
        // background refresh fails, the last complete shell remains intact.
        if (response && response.ok) {
          event.waitUntil(cacheCompleteShellResponse(response.clone()).catch(() => {}));
        }
        return response;
      } catch {
        const currentCache = await caches.open(CACHE_NAME);
        const cached = (await currentCache.match(OFFLINE_URL)) || (await currentCache.match(event.request));
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
      caches.open(CACHE_NAME).then(cache => cache.match(event.request)).then(cached => {
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
  let destination = '/';
  try {
    const candidate = new URL(data.url || '/', self.location.origin);
    if (candidate.origin === self.location.origin) {
      destination = `${candidate.pathname}${candidate.search}${candidate.hash}`;
    }
  } catch { /* default to the app root */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Waves Pest Control', {
      body: data.body || '', icon: '/waves-logo.png', badge: '/waves-logo.png',
      tag: data.tag || 'waves', data: { url: destination },
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

// Deliberately NO pushsubscriptionchange handler: rotating the server row
// from the SW would need an unauthenticated mutating route (the SW can't
// reach the admin JWT in localStorage), which AGENTS.md classifies as P0.
// An endpoint rotation while the app is closed is instead healed by
// syncPushSubscription (push-subscribe.js) on the next app open/resume.
