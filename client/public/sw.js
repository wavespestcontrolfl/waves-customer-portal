const APP_CACHE_PREFIX = 'waves-customer-';
// v12: v11 buckets grew without bound (one owner phone held 263 builds /
// 13.8k entries / 1.5 GB, and WebKit reads the whole index on the first
// caches.open() after a cold start — an 11 s blank screen). Bumping the
// name drops that bucket once via the activate sweep; pruneStaleAssets
// keeps the new one bounded to the current build.
const CACHE_NAME = 'waves-customer-v12-shell-pruned';
// Pre-prefix buckets (e.g. 'waves-v10-admin-activation-stable') that the
// APP_CACHE_PREFIX sweep never matched and so outlived every update.
const LEGACY_CACHE_PATTERN = /^waves-v\d+-/;
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

// Every cached /assets/* entry carries the build it belongs to, so pruning
// can keep whole generations — the shell's direct assets AND the page chunks
// it lazy-loads later — without a dependency manifest. The id is the shell's
// asset set; hashed chunk names carry no build id of their own.
const BUILD_HEADER = 'x-waves-build';
function buildIdOf(assets) {
  return [...assets].sort().join('|');
}

function tagWithBuild(response, buildId) {
  const headers = new Headers(response.headers);
  headers.set(BUILD_HEADER, buildId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// The build the cached shell currently describes — what a lazily loaded
// chunk fetched right now belongs to. Worker globals do not survive
// termination, so read it from the cache each time (one small parse, and
// only on an /assets/ cache miss).
async function currentBuildId(cache) {
  const shell = await cache.match(OFFLINE_URL);
  if (!shell) return null;
  return buildIdOf(shellAssetUrls(await shell.text()));
}

// Every navigation kicks off a background shell refresh, so two can overlap
// across a deploy (old shell A and new shell B in flight together). Each
// refresh reads the previous shell, writes, then prunes — interleaved, A's
// prune deletes B's assets after B stored its shell, leaving '/' pointing
// at a missing entry script. Serialize the whole read-write-prune unit on
// a promise chain; overlap only exists within one worker lifetime, so a
// module-level chain is the right scope (Web Locks would outlive it).
let shellRefreshChain = Promise.resolve();
async function cacheCompleteShellResponse(shellResponse) {
  const run = shellRefreshChain.then(() => replaceCompleteShell(shellResponse));
  shellRefreshChain = run.catch(() => {});
  return run;
}

async function replaceCompleteShell(shellResponse) {
  const cache = await caches.open(CACHE_NAME);
  if (!shellResponse.ok) throw new Error(`Shell request failed (${shellResponse.status})`);

  const html = await shellResponse.clone().text();
  const assets = shellAssetUrls(html);
  if (!assets.length) throw new Error('Shell contains no build assets');
  const buildId = buildIdOf(assets);

  // Fetch every hashed dependency before storing the new HTML. If any fetch
  // fails, installation rejects and the previous worker/cache remains active;
  // customers never receive an offline shell whose entry chunk is missing.
  const assetResponses = await Promise.all(assets.map(async assetUrl => {
    const response = await fetch(new Request(assetUrl, { cache: 'reload' }));
    if (!response.ok) throw new Error(`Shell asset failed (${response.status}): ${assetUrl}`);
    return [assetUrl, response];
  }));
  // Read the previous build BEFORE overwriting its shell: a different id
  // means a deploy shipped, and everything older than that build is dead weight.
  const previousBuildId = await currentBuildId(cache);
  await Promise.all(assetResponses.map(([assetUrl, response]) => cache.put(assetUrl, tagWithBuild(response, buildId))));
  await cache.put(OFFLINE_URL, shellResponse);
  // Keep the generation just replaced too: a tab still running the previous
  // build lazy-loads its chunks after the shell moved on, and an offline
  // navigation may read the old shell moments before its replacement. Two
  // generations bound the cache.
  if (previousBuildId !== buildId) await pruneStaleAssets(cache, [buildId, previousBuildId]);
}

// Drop every cached /assets/* entry tagged with neither retained build (or
// with no tag at all). Runs only when the shell's build changed (a deploy),
// never on a plain navigation, so page chunks cached on use stay with their
// build until it is two deploys old.
async function pruneStaleAssets(cache, retainedBuildIds) {
  const retained = new Set(retainedBuildIds.filter(Boolean));
  const requests = await cache.keys();
  await Promise.all(requests.map(async request => {
    if (!new URL(request.url).pathname.startsWith('/assets/')) return;
    const cached = await cache.match(request);
    const tag = cached && cached.headers.get(BUILD_HEADER);
    if (!retained.has(tag)) await cache.delete(request);
  }));
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
      keys.filter(k => (k.startsWith(APP_CACHE_PREFIX) && k !== CACHE_NAME) || LEGACY_CACHE_PATTERN.test(k))
        .map(k => caches.delete(k))
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

  // Hashed assets (/assets/index-CRewFOq2.js) — immutable, so cache on first
  // use; pruneStaleAssets evicts them once the shell moves to a newer build.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => cache.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            // Tag the chunk with the build it was loaded for, so the prune
            // keeps it with that build's shell instead of guessing from HTML.
            const store = currentBuildId(cache)
              .then(buildId => cache.put(event.request, tagWithBuild(clone, buildId || 'untagged')))
              .catch(() => {});
            // The respondWith promise is still pending here, so the event
            // can still be extended; if a browser disagrees, fall back to
            // fire-and-forget rather than failing the asset load.
            try { event.waitUntil(store); } catch { /* fire and forget */ }
          }
          return response;
        });
      }))
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

// Home-screen icon badge (Badging API — iOS 16.4+ installed PWAs):
// data.badge is the server-computed unread count; data.badgeAt orders
// overlapping pushes — counts are absolute snapshots, so a slower delivery
// carrying an older (lower) snapshot must not overwrite a newer one. The
// last-applied {seq, count} lives in the Cache API (SW scope has no
// localStorage, and worker globals don't survive termination); the cache
// name is outside APP_CACHE_PREFIX so activate's old-cache sweep never
// clears it. The whole compare-and-apply runs under a Web Lock: the check
// spans awaits, so two overlapping push handlers could otherwise both read
// the old state before either writes, and the PAGE writes the same state
// when it clears the badge on read (NotificationBell syncAppBadge, same
// lock name + key) — a delayed push must not resurrect a count the admin
// already cleared. 0 clears the badge; no numeric badge leaves it alone.
const BADGE_STATE_CACHE = 'waves-badge-state';
const BADGE_SEQ_KEY = '/__badge-seq';
const BADGE_LOCK = 'waves-badge';
function withBadgeLock(fn) {
  // Browsers without Web Locks fall back to best-effort unserialized.
  if (self.navigator.locks?.request) return self.navigator.locks.request(BADGE_LOCK, fn);
  return fn();
}
async function applyAppBadge(count, seq) {
  if (!('setAppBadge' in self.navigator)) return;
  try {
    await withBadgeLock(async () => {
      if (Number.isFinite(seq)) {
        const cache = await caches.open(BADGE_STATE_CACHE);
        const prevRes = await cache.match(BADGE_SEQ_KEY);
        let prev = { seq: 0, count: -1 };
        if (prevRes) { try { prev = await prevRes.json(); } catch { /* corrupt → treat as empty */ } }
        if (prev.seq > seq) return; // an older overlapping push arrived late — ignore it
        // Equal stamps are ms ties between concurrent snapshots: keep the
        // higher count — during a burst counts only grow; decreases come
        // from reads, which stamp strictly newer via the page path.
        if (prev.seq === seq && prev.count >= count) return;
        await cache.put(BADGE_SEQ_KEY, new Response(JSON.stringify({ seq, count })));
      }
      if (count > 0) await self.navigator.setAppBadge(count);
      else await self.navigator.clearAppBadge();
    });
  } catch { /* badge is garnish — never fail the push handler over it */ }
}

self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  const requireInteraction = data.priority === 'urgent';
  if (Number.isInteger(data.badge)) {
    event.waitUntil(applyAppBadge(data.badge, Number(data.badgeAt)));
  }
  let destination = '/';
  try {
    const candidate = new URL(data.url || '/', self.location.origin);
    if (candidate.origin === self.location.origin) {
      destination = `${candidate.pathname}${candidate.search}${candidate.hash}`;
    }
  } catch { /* default to the app root */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Waves', {
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
