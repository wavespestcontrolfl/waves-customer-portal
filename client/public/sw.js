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

// Every cached /assets/* entry carries the builds it belongs to, so pruning
// can keep whole generations — the shell's direct assets AND the page chunks
// it lazy-loads later — without a dependency manifest. The id derives from
// the shell's asset set; hashed chunk names carry no build id of their own.
// It is a short digest, not the asset list itself: ~300 assets × ~30 chars
// per entry would put megabytes of header text into the cache index that
// WebKit reads on the first open — the very cost this worker is removing.
const BUILD_HEADER = 'x-waves-build';
function buildIdOf(assets) {
  const key = [...assets].sort().join('|');
  let a = 5381; let b = 0;
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i);
    a = ((a * 33) ^ c) >>> 0; // djb2
    b = (c + (b << 6) + (b << 16) - b) >>> 0; // sdbm
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

// A chunk unchanged across builds is used by several of them at once, and a
// retained build must not lose its claim because a newer page also used the
// chunk (a navigation whose shell refresh failed is live but never cached, so
// its build is never retained). The header lists the builds that used the
// entry, newest first, capped so repeated never-cached builds cannot grow
// it without bound. The cap must never drop the cached shell's build: it is
// the "previous" generation the next prune retains, however many failed
// refreshes came between (`pinnedBuildId`, read by the caller).
const BUILD_TAGS_KEPT = 3;
function buildTagsOf(response) {
  const raw = response && response.headers.get(BUILD_HEADER);
  return raw ? raw.split(',').map(t => t.trim()).filter(Boolean) : [];
}

function tagWithBuild(response, buildIds, pinnedBuildId = null) {
  const headers = new Headers(response.headers);
  const existing = buildTagsOf(response);
  const pinned = pinnedBuildId && existing.includes(pinnedBuildId) ? [pinnedBuildId] : [];
  const tags = [...new Set([].concat(buildIds).filter(Boolean).concat(pinned, existing))].slice(0, BUILD_TAGS_KEPT);
  headers.set(BUILD_HEADER, tags.join(','));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// The build the cached shell currently describes — what a lazily loaded
// chunk fetched right now belongs to. Worker globals do not survive
// termination, so read it from the cache each time (one small parse, and
// only on an /assets/ cache miss).
async function cachedBuildId(cache) {
  const shell = await cache.match(OFFLINE_URL);
  if (!shell) return null;
  return buildIdOf(shellAssetUrls(await shell.text()));
}

// The build pages are running right now. A navigation hands the page build
// B's HTML before B's background shell refresh finishes, so chunks B loads
// in that window must not be stamped with the still-cached build A; the
// navigation handler advances this memo from the fresh HTML immediately,
// and a refresh requested before that never writes its build back over it
// (see replaceCompleteShell).
// Memoized per worker lifetime, seeded from the cached shell after a cold
// start. Never used to decide what the previous build was — that comes
// from the cached shell itself (cachedBuildId), or pruning would never fire.
let liveBuildId = null;
let navigationSeq = 0; // issued to each navigation as its HTML arrives, in order
let liveBuildSeq = 0; // token of the navigation that last advanced liveBuildId
// Navigation bodies and queued refreshes finish out of order; only the
// newest navigation's build may take the memo, never an older one that
// finished late (it would mis-tag the newer page's chunks).
function advanceLiveBuild(buildId, seq) {
  if (seq < liveBuildSeq) return;
  liveBuildSeq = seq;
  liveBuildId = buildId;
}
async function currentBuildId(cache) {
  if (liveBuildId) return liveBuildId;
  // Cold worker: seed from the cached shell. A navigation can land while
  // that read is in flight, and it is the newer truth — never overwrite it.
  const seeded = await cachedBuildId(cache);
  if (!liveBuildId) liveBuildId = seeded;
  return liveBuildId;
}

// Asset-cache writes — the prune, a cache hit's re-tag, a miss's store —
// run one at a time. Unserialized, the prune reads a chunk's old tag, a
// page of the retained build re-tags it meanwhile, and the prune's delete
// then removes an entry whose new tag it would have kept.
let assetWriteChain = Promise.resolve();
function withAssetWrites(fn) {
  const run = assetWriteChain.then(fn);
  assetWriteChain = run.catch(() => {});
  return run;
}

// Add build claims to a cached entry. Runs under the write lock and merges
// into whatever the cache holds NOW — a queued write must not carry an
// older copy's tags over an entry a shell refresh re-wrote meanwhile.
// `fallback` is stored when the entry is gone (pruned in between).
function claimBuilds(cache, request, fallback, claims, pinnedBuildId = null) {
  return withAssetWrites(async () => {
    const latest = (await cache.match(request)) || fallback;
    return cache.put(request, tagWithBuild(latest, claims, pinnedBuildId));
  });
}

// Every navigation kicks off a background shell refresh, so two can overlap
// across a deploy (old shell A and new shell B in flight together). Each
// refresh reads the previous shell, writes, then prunes — interleaved, A's
// prune deletes B's assets after B stored its shell, leaving '/' pointing
// at a missing entry script. Serialize the whole read-write-prune unit on
// a promise chain; overlap only exists within one worker lifetime, so a
// module-level chain is the right scope (Web Locks would outlive it).
let shellRefreshChain = Promise.resolve();
async function cacheCompleteShellResponse(shellResponse, enqueuedSeq = navigationSeq) {
  const run = shellRefreshChain.then(() => replaceCompleteShell(shellResponse, enqueuedSeq));
  shellRefreshChain = run.catch(() => {});
  return run;
}

async function replaceCompleteShell(shellResponse, enqueuedSeq) {
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
  const previousBuildId = await cachedBuildId(cache);
  // Under the write lock, keeping the claims an existing entry already holds.
  await withAssetWrites(() => Promise.all(assetResponses.map(async ([assetUrl, response]) => {
    const existing = await cache.match(assetUrl);
    await cache.put(assetUrl, tagWithBuild(response, [buildId, ...buildTagsOf(existing)]));
  })));
  await cache.put(OFFLINE_URL, shellResponse);
  // Refreshes are queued, so an older one can finish after a newer
  // navigation already advanced the live build — writing its own build back
  // would mis-tag the newer page's chunks. Only claim the memo if no
  // navigation moved it since this refresh was requested (install path).
  advanceLiveBuild(buildId, enqueuedSeq);
  // Keep the generation just replaced too: a tab still running the previous
  // build lazy-loads its chunks after the shell moved on, and an offline
  // navigation may read the old shell moments before its replacement. Two
  // generations bound the cache. The live build is also protected: when
  // this refresh is an older one landing late, a newer navigation may have
  // cached its own chunks already, and its queued refresh only restores the
  // shell's direct assets — not the routes that page already loaded.
  if (previousBuildId !== buildId) await pruneStaleAssets(cache, [buildId, previousBuildId, liveBuildId]);
}

// Drop every cached /assets/* entry tagged with none of the retained builds
// (or with no tag at all). Runs only when the shell's build changed (a deploy),
// never on a plain navigation, so page chunks cached on use stay with their
// build until it is two deploys old.
function pruneStaleAssets(cache, retainedBuildIds) {
  const retained = new Set(retainedBuildIds.filter(Boolean));
  return withAssetWrites(async () => {
    const requests = await cache.keys();
    await Promise.all(requests.map(async request => {
      if (!new URL(request.url).pathname.startsWith('/assets/')) return;
      const cached = await cache.match(request);
      if (!buildTagsOf(cached).some(tag => retained.has(tag))) await cache.delete(request);
    }));
  });
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
          // Advance the live build before the (serialized, possibly slow)
          // refresh lands, so chunks this page loads meanwhile are tagged
          // with its own build. A shell without assets is not a build.
          // The order token is taken now, not when the body finishes:
          // an older response's body can resolve after a newer one's.
          const navSeq = ++navigationSeq;
          event.waitUntil(response.clone().text().then(html => {
            const assets = shellAssetUrls(html);
            if (!assets.length) return;
            advanceLiveBuild(buildIdOf(assets), navSeq);
          }).catch(() => {}));
          event.waitUntil(cacheCompleteShellResponse(response.clone(), navSeq).catch(() => {}));
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
        if (cached) {
          // A chunk unchanged between builds keeps its hash, so a hit under
          // the live build may not carry its tag yet; add it (keeping the
          // older builds' claims) so the prune sees it as the live build's
          // when those older ones age out.
          const tags = buildTagsOf(cached);
          if (liveBuildId && tags.includes(liveBuildId)) return cached;
          // Clone before handing `cached` to respondWith: on a cold worker the
          // build lookup awaits the cached shell, and the page can lock the
          // body in that window, making a later clone() throw.
          const copy = cached.clone();
          const touch = currentBuildId(cache).then(async buildId => {
            if (!buildId || tags.includes(buildId)) return undefined;
            // The cached shell's build is retained by the next prune; pin it
            // so the tag cap cannot shed it behind a run of live-only builds.
            const pinned = await cachedBuildId(cache);
            return claimBuilds(cache, event.request, copy, [buildId], pinned);
          }).catch(() => {});
          try { event.waitUntil(touch); } catch { /* fire and forget */ }
          return cached;
        }
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            // Tag the chunk with the build it was loaded for, so the prune
            // keeps it with that build's shell instead of guessing from HTML.
            // The worker cannot tell which tab asked: the live build is the
            // newest navigation's, but a tab on the cached shell's build may
            // be the requester (a newer navigation whose refresh failed is
            // live yet never cached), so the cached build claims it too.
            const store = Promise.all([currentBuildId(cache), cachedBuildId(cache)])
              .then(([buildId, cachedId]) => claimBuilds(cache, event.request, clone, [buildId || 'untagged', cachedId]))
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
