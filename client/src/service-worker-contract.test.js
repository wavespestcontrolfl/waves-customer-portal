import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf8');

// Claim ids without the provisional marker: tests that only care THAT a build
// claims an entry, not whether the claim was read off a shell or inferred.
const claimIds = response => response.headers.get('x-waves-build').split(',').map(t => t.replace(/^~/, ''));

// Minimal Cache API double: URL-keyed, enough for the shell-refresh path.
function fakeCache() {
  const store = new Map();
  const asRequest = (key) => (typeof key === 'string' ? { url: `https://portal.test${key}` } : key);
  return {
    store,
    gate: null, // a test may park keys() (the prune's first step) on a promise
    // Like the browser, every match hands out a fresh Response over the
    // stored body — the caller's text()/clone() never lock the stored copy.
    matchGate: null, // a test may park match() (the asset batch's first step)
    async match(key) { if (this.matchGate) await this.matchGate; const hit = store.get(asRequest(key).url); return hit && hit.clone(); },
    deleteGate: null, // a test may park delete() (the prune's last step)
    failPut: null, // a test may make put() reject for some URLs (quota)
    putGate: null, // a test may park put() for some URLs on a promise
    async put(key, response) {
      const url = asRequest(key).url;
      if (this.putGate) { const gate = this.putGate(url); if (gate) await gate; }
      if (this.failPut && this.failPut(url)) { const e = new Error('Quota exceeded'); e.name = 'QuotaExceededError'; throw e; }
      store.set(url, response);
    },
    async delete(key) { if (this.deleteGate) await this.deleteGate; return store.delete(asRequest(key).url); },
    async keys() { if (this.gate) await this.gate; return [...store.keys()].map(url => ({ url })); },
  };
}

// Response double with the surface the worker touches: ok/status, headers,
// body, clone(), text(). `new Response(body, init)` in the sandbox builds the
// same shape, so tagWithBuild's re-wrap round-trips through it.
class FakeResponse {
  constructor(body, init = {}) {
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.statusText = init.statusText || '';
    this.headers = new Headers(init.headers);
    this.body = body;
    this.bodyUsed = false;
  }
  clone() {
    // The real Response throws once its body is locked by a consumer.
    if (this.bodyUsed) throw new TypeError('Response body is already used');
    return new this.constructor(this.body, { status: this.status, statusText: this.statusText, headers: this.headers, gate: this.gate });
  }
  async text() { if (this.gate) await this.gate; this.bodyUsed = true; return String(this.body); }
}
// A response whose body read is parked on a promise the test releases.
class GatedResponse extends FakeResponse {
  constructor(body, init = {}) { super(body, init); this.gate = init.gate; }
}
const fakeResponse = (body, ok = true) => new FakeResponse(body, { status: ok ? 200 : 500 });
const gatedResponse = (body, gate) => new GatedResponse(body, { gate });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// Evaluate the worker in a sandbox whose fetch() serves any /assets/* URL, and
// hand back the functions the shell-refresh path is built from plus a way to
// drive the fetch handler the way the browser would.
// Web Locks double shared between worker instances: one chain per name.
function fakeLocks() {
  const chains = new Map();
  return {
    request(name, fn) {
      const prev = chains.get(name) || Promise.resolve();
      const run = prev.then(fn);
      chains.set(name, run.catch(() => {}));
      return run;
    },
  };
}

function loadWorker(cache, { locks, cacheNames = [], cachesByName = {}, now } = {}) {
  const listeners = {};
  const names = new Set([...cacheNames, ...Object.keys(cachesByName)]);
  const sandbox = {
    self: {
      addEventListener(name, fn) { listeners[name] = fn; },
      navigator: locks ? { locks } : {}, location: { origin: 'https://portal.test' }, registration: {},
      skipWaiting: async () => {}, clients: { claim: async () => {} },
    },
    caches: {
      names,
      async open(name) { if (cachesByName[name]) return cachesByName[name]; names.add(name); return cache; },
      async keys() { return [...names]; },
      async delete(name) { return names.delete(name); },
    },
    Request: class { constructor(url) { this.url = url; } },
    // A test may freeze the clock the worker reads, so two instances can
    // start within the same Date.now() tick on purpose.
    Date: now ? class extends Date { static now() { return now(); } } : Date,
    Response: FakeResponse,
    Headers,
    URL,
    fetch: async (request) => fakeResponse(`asset:${request.url}`),
    clients: {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\n;this.__exports = { cacheCompleteShellResponse, pruneStaleAssets, buildIdOf, shellAssetUrls };`, sandbox);
  // Simulate the page requesting a URL: returns the handler's response after
  // its extend-lifetime work has settled (unless the caller wants to hold it).
  async function dispatchFetch(pathname, { mode = 'no-cors', settle = true } = {}) {
    const pending = [];
    let responded;
    listeners.fetch({
      request: { url: `https://portal.test${pathname}`, mode, destination: mode === 'navigate' ? 'document' : 'script' },
      respondWith(promise) { responded = promise; },
      waitUntil(promise) { pending.push(promise); },
    });
    const response = await responded;
    if (settle) await Promise.all(pending);
    return { response, settled: () => Promise.all(pending) };
  }
  const setFetch = (fn) => { sandbox.fetch = fn; };
  // Fire the install event and resolve when its extend-lifetime work settles.
  async function dispatchInstall() {
    const pending = [];
    listeners.install({ waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
  }
  return { ...sandbox.__exports, dispatchFetch, setFetch, dispatchInstall, cacheNames: names };
}

const shellHtml = (assets) => `<html><head>${assets.map(a => `<script src="${a}"></script>`).join('')}</head></html>`;
// A build's published file list, plus a fetch double that serves it for the
// named shell. `owns` defaults to exactly the shell's own hashed assets.
const manifestOf = (cache, buildId) => cache.match(`/__waves/manifest/${buildId}`);
const serveBuild = (shellAssets, owns = shellAssets) => async (request) => {
  if (request.url.includes('/build-assets.json')) return fakeResponse(JSON.stringify(owns));
  if (request.mode === 'navigate') return fakeResponse(shellHtml(shellAssets));
  return fakeResponse(`asset:${request.url}`);
};
const cachedAssets = async (cache) => (await cache.keys()).map(r => new URL(r.url).pathname).filter(p => p.startsWith('/assets/')).sort();

describe('customer service-worker update contract', () => {
  it('preloads hashed shell assets before storing the replacement HTML', () => {
    expect(source).toContain('async function cacheCompleteShellResponse(shellResponse, enqueuedSeq = navigationSeq, { supersedable = true, startedAt = Date.now() } = {})');
    expect(source).toContain('async function precacheCompleteShell()');
    expect(source).toContain("new Request(assetUrl, { cache: 'reload' })");
    expect(source).toContain('await Promise.allSettled(assetResponses.map');
    expect(source.indexOf('await Promise.allSettled(assetResponses.map'))
      .toBeLessThan(source.indexOf('await putShell(cache, shellResponse.clone(), buildId)'));
    expect(source).toContain('event.waitUntil(cacheCompleteShellResponse(response.clone(), navSeq, { startedAt }).catch(() => {}))');
    expect(source).not.toContain('cache.put(OFFLINE_URL, clone)');
    // Every write to '/' goes through putShell, so no shell write can move
    // the build the cache describes without the memo moving with it.
    expect(source.match(/cache\.put\(OFFLINE_URL/g)).toHaveLength(1); // putShell's own
  });

  it('serializes cache writes with origin-wide Web Locks so an installing worker queues behind the active one', () => {
    // Codex #4335 P1: a newer sw.js installing beside the active worker
    // shares the cache but not module globals, so a per-instance promise
    // chain cannot order its install-time prune against the active
    // worker's re-tags. Same fallback shape as the badge lock.
    expect(source).toContain("const ASSET_WRITE_LOCK = 'waves-asset-writes'");
    expect(source).toContain("const SHELL_REFRESH_LOCK = 'waves-shell-refresh'");
    expect(source).toContain('if (self.navigator.locks?.request) return self.navigator.locks.request(name, fn)');
  });

  it('does not swallow install failure or delete caches outside this app', () => {
    expect(source).toContain('event.waitUntil(precacheCompleteShell().then(() => self.skipWaiting()))');
    expect(source).not.toMatch(/precacheCompleteShell\(\).*catch\(\(\) => \{\}\)/);
    expect(source).toContain('k.startsWith(APP_CACHE_PREFIX) && k !== CACHE_NAME');
    expect(source).toContain("if (!isQuotaError(err)) throw err;");
    expect(source).toContain('await reclaimStaleCacheSpace();');
    expect(source).not.toMatch(/isQuotaError\(err\)\) throw err;\s*await sweepStaleCaches\(\)/);
  });

  it('sweeps the pre-prefix legacy buckets on activate but never the badge state', () => {
    // 'waves-v10-admin-activation-stable' outlived every update because the
    // APP_CACHE_PREFIX sweep never matched it (4.6k orphaned entries on an
    // owner phone). The badge bucket must keep surviving the sweep.
    expect(source).toContain("const LEGACY_CACHE_PATTERN = /^waves-v\\d+-/");
    expect(source).toContain('LEGACY_CACHE_PATTERN.test(k)');
    const legacy = /^waves-v\d+-/;
    expect(legacy.test('waves-v10-admin-activation-stable')).toBe(true);
    expect(legacy.test('waves-badge-state')).toBe(false);
    expect(legacy.test('waves-customer-v12-shell-pruned')).toBe(false);
  });

  it('constrains notification destinations to the portal origin', () => {
    expect(source).toContain('candidate.origin === self.location.origin');
    expect(source).toContain('data: { url: destination }');
  });

  it('mirrors the pushed unread count onto the app icon badge, gated on a numeric payload', () => {
    expect(source).toContain('if (Number.isInteger(data.badge))');
    expect(source).toContain("if (!('setAppBadge' in self.navigator)) return");
    expect(source).toContain('self.navigator.setAppBadge(count)');
    expect(source).toContain('self.navigator.clearAppBadge()');
  });

  it('drops an out-of-order badge and keeps its ordering state out of the app-cache sweep', () => {
    // Overlapping pushes carry absolute count snapshots — a late delivery of
    // an older snapshot must not overwrite a newer badge (codex #3541 P2),
    // and the compare-and-apply spans awaits, so it must run under the
    // cross-context Web Lock the page's syncAppBadge shares.
    expect(source).toContain('self.navigator.locks.request(BADGE_LOCK, fn)');
    expect(source).toContain("const BADGE_LOCK = 'waves-badge'");
    expect(source).toContain('if (prev.seq > seq) return');
    expect(source).toContain('if (prev.seq === seq && prev.count >= count) return');
    expect(source).toContain("const BADGE_STATE_CACHE = 'waves-badge-state'");
    // Must NOT start with APP_CACHE_PREFIX ('waves-customer-') or the
    // activate sweep would wipe the ordering state on every SW update.
    expect('waves-badge-state'.startsWith('waves-customer-')).toBe(false);
  });
});

describe('service-worker shell refresh keeps the asset cache bounded to two builds', () => {
  it('keeps the current and previous build, page chunks included, and prunes everything older', async () => {
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js', '/assets/index-AAA.css'])));
    // A page chunk of build AAA, loaded on use through the /assets/ branch.
    await dispatchFetch('/assets/DashboardPageV2-AAA.js');
    // An icon cached by the network-first branch — not an /assets/ entry, must survive.
    await cache.put('/waves-logo.png', fakeResponse('png'));

    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-BBB.js', '/assets/index-AAA.css'])));
    // A page chunk loaded for BBB.
    await dispatchFetch('/assets/DashboardPageV2-BBB.js');

    // Codex pre-push P1s: a tab still running AAA must keep its entry chunk
    // AND its page chunks after BBB ships, so the whole previous generation
    // is retained — chunks are tagged with their build, not guessed from HTML.
    expect(await cachedAssets(cache)).toEqual([
      '/assets/DashboardPageV2-AAA.js', '/assets/DashboardPageV2-BBB.js',
      '/assets/index-AAA.css', '/assets/index-AAA.js', '/assets/index-BBB.js',
    ]);
    expect(await cache.match('/waves-logo.png')).toBeTruthy();

    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js', '/assets/index-CCC.css'])));

    // Two deploys later AAA is dead weight (index-AAA.css was re-tagged as
    // BBB's when BBB's shell referenced it); BBB is the retained generation.
    expect(await cachedAssets(cache)).toEqual([
      '/assets/DashboardPageV2-BBB.js', '/assets/index-AAA.css', '/assets/index-BBB.js',
      '/assets/index-CCC.css', '/assets/index-CCC.js',
    ]);
  });

  it('serializes overlapping refreshes so the stored shell always has its assets', async () => {
    // Codex pre-push P1: refresh A (old build) and refresh B (new build) in
    // flight together. Unserialized, both store their shell, then A's prune
    // deletes B's assets and B's prune deletes A's — leaving '/' pointing
    // at an entry script that is gone. The gate parks both prunes so they
    // would run back-to-back after both shells were written.
    const cache = fakeCache();
    const { cacheCompleteShellResponse } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-000.js'])));
    const shellA = shellHtml(['/assets/index-AAA.js', '/assets/index-AAA.css']);
    const shellB = shellHtml(['/assets/index-BBB.js', '/assets/index-BBB.css']);

    let release;
    cache.gate = new Promise(resolve => { release = resolve; });
    const refreshes = Promise.all([
      cacheCompleteShellResponse(fakeResponse(shellA)),
      cacheCompleteShellResponse(fakeResponse(shellB)),
    ]);
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await refreshes;

    const stored = await cache.match('/');
    const referenced = [...(await stored.text()).matchAll(/src="(\/assets\/[^"]+)"/g)].map(m => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const asset of referenced) expect(await cache.match(asset), asset).toBeTruthy();
    // Whichever refresh won, the loser's build is the retained previous
    // generation; build 000 (two generations back) must be gone.
    const assetsLeft = await cachedAssets(cache);
    expect(assetsLeft).not.toContain('/assets/index-000.js');
    expect(assetsLeft.length).toBe(4);
  });

  it('re-tags a chunk shared unchanged across builds when the newer build serves it', async () => {
    // Codex pre-push P1: Shared-XYZ.js has the same hash in AAA and BBB. Loaded
    // under AAA it is tagged AAA; a cache hit under BBB must move it to BBB,
    // or CCC's prune deletes it while BBB is still the retained build.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    await dispatchFetch('/assets/Shared-XYZ.js');
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-BBB.js'])));
    const { response: hit } = await dispatchFetch('/assets/Shared-XYZ.js');
    expect(await hit.text()).toBe('asset:https://portal.test/assets/Shared-XYZ.js');
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js'])));

    expect(await cachedAssets(cache)).toEqual(['/assets/Shared-XYZ.js', '/assets/index-BBB.js', '/assets/index-CCC.js']);
  });

  it('tags chunks loaded before the new shell lands with the build the page received', async () => {
    // Codex pre-push P1: a navigation returns build B's HTML at once, but B's
    // shell refresh (asset preload + prune) runs in the background. A page
    // chunk B loads in that window belongs to B — tagging it with the still
    // cached A would let C's prune delete it while B is the retained build.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));

    let releaseAssets;
    const assetsGate = new Promise(resolve => { releaseAssets = resolve; });
    setFetch(async (request) => {
      if (request.mode === 'navigate') return fakeResponse(shellHtml(['/assets/index-BBB.js']));
      if (request.url.includes('index-BBB.js')) await assetsGate; // B's preload is still in flight
      return fakeResponse(`asset:${request.url}`);
    });

    const nav = await dispatchFetch('/admin/', { mode: 'navigate', settle: false });
    expect(await nav.response.text()).toBe(shellHtml(['/assets/index-BBB.js']));
    // Page B lazy-loads a route while its shell refresh is parked.
    await dispatchFetch('/assets/DashboardPageV2-BBB.js');
    expect((await cache.match('/assets/DashboardPageV2-BBB.js')).headers.get('x-waves-build').split(',')[0])
      .toBe(buildIdOf(['/assets/index-BBB.js']));

    releaseAssets();
    await nav.settled();
    setFetch(async (request) => fakeResponse(`asset:${request.url}`));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js'])));

    expect(await cachedAssets(cache)).toEqual(['/assets/DashboardPageV2-BBB.js', '/assets/index-BBB.js', '/assets/index-CCC.js']);
  });

  it('keeps the newest navigation as the live build when an older refresh finishes later', async () => {
    // Codex pre-push P1: navigation A's preload is still parked when
    // navigation B arrives and advances the live build to B. When A's queued
    // refresh completes afterwards it must not write A back, or a chunk B
    // loads next is tagged A and C's prune removes it while B is retained.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-000.js'])));

    const gates = {};
    const park = (name) => new Promise(resolve => { gates[name] = resolve; });
    const gateA = park('A');
    const gateB = park('B');
    let navHtml = shellHtml(['/assets/index-AAA.js']);
    setFetch(async (request) => {
      if (request.mode === 'navigate') return fakeResponse(navHtml);
      if (request.url.includes('index-AAA.js')) await gateA;
      if (request.url.includes('index-BBB.js')) await gateB;
      return fakeResponse(`asset:${request.url}`);
    });

    const navA = await dispatchFetch('/admin/', { mode: 'navigate', settle: false });
    navHtml = shellHtml(['/assets/index-BBB.js']);
    const navB = await dispatchFetch('/admin/', { mode: 'navigate', settle: false });

    gates.A();
    await navA.settled(); // A's refresh landed after B's navigation
    await dispatchFetch('/assets/DashboardPageV2-BBB.js');
    expect((await cache.match('/assets/DashboardPageV2-BBB.js')).headers.get('x-waves-build').split(',')[0])
      .toBe(buildIdOf(['/assets/index-BBB.js']));

    gates.B();
    await navB.settled();
    setFetch(async (request) => fakeResponse(`asset:${request.url}`));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js'])));

    expect(await cachedAssets(cache)).toEqual(['/assets/DashboardPageV2-BBB.js', '/assets/index-BBB.js', '/assets/index-CCC.js']);
  });

  it('lets an older refresh landing late keep the chunks the newest navigation cached', async () => {
    // Codex pre-push P1: refresh A is parked; navigation B arrives and its
    // page caches a lazy chunk tagged B. When A finally lands, its prune must
    // protect B (the live build), not just A and A's predecessor — B's own
    // queued refresh restores the shell's direct assets only.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-000.js'])));

    let releaseA;
    const gateA = new Promise(resolve => { releaseA = resolve; });
    let navHtml = shellHtml(['/assets/index-AAA.js']);
    setFetch(async (request) => {
      if (request.mode === 'navigate') return fakeResponse(navHtml);
      if (request.url.includes('index-AAA.js')) await gateA;
      return fakeResponse(`asset:${request.url}`);
    });

    const navA = await dispatchFetch('/admin/', { mode: 'navigate', settle: false });
    navHtml = shellHtml(['/assets/index-BBB.js']);
    const navB = await dispatchFetch('/admin/', { mode: 'navigate', settle: false });
    await dispatchFetch('/assets/DashboardPageV2-BBB.js'); // B's page loads a route while A is parked

    releaseA();
    await navA.settled();
    expect(await cache.match('/assets/DashboardPageV2-BBB.js')).toBeTruthy();
    await navB.settled();
    // A's refresh was superseded by B's navigation and never committed
    // (see 'skips a superseded refresh'), so 000 remains the previous build.
    expect(await cachedAssets(cache)).toEqual(['/assets/DashboardPageV2-BBB.js', '/assets/index-000.js', '/assets/index-BBB.js']);
  });

  it('does not touch cached page chunks when the same shell is refreshed', async () => {
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch } = loadWorker(cache);
    const shell = shellHtml(['/assets/index-AAA.js']);
    await cacheCompleteShellResponse(fakeResponse(shell));
    await dispatchFetch('/assets/DashboardPageV2-AAA.js');

    // Every navigation refreshes the shell in the background; an unchanged
    // build must not evict the page chunks the admin just downloaded.
    await cacheCompleteShellResponse(fakeResponse(shell));

    expect(await cache.match('/assets/DashboardPageV2-AAA.js')).toBeTruthy();
  });

  it('serves a cached chunk without refetching and tags a fresh one with the live build', async () => {
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    let fetches = 0;
    setFetch(async (request) => { fetches += 1; return fakeResponse(`asset:${request.url}`); });

    const { response: first } = await dispatchFetch('/assets/Chunk-AAA.js');
    expect(first.headers.get('x-waves-build')).toBeNull(); // the page gets the network response untouched
    const cached = await cache.match('/assets/Chunk-AAA.js');
    expect(cached.headers.get('x-waves-build')).toBe(buildIdOf(['/assets/index-AAA.js']));
    expect(await cached.text()).toBe('asset:https://portal.test/assets/Chunk-AAA.js');
    expect(fetches).toBe(1);

    const stored = cache.store.get('https://portal.test/assets/Chunk-AAA.js');
    const { response: second } = await dispatchFetch('/assets/Chunk-AAA.js');
    expect(await second.text()).toBe('asset:https://portal.test/assets/Chunk-AAA.js');
    expect(fetches).toBe(1); // served from cache
    expect(cache.store.get('https://portal.test/assets/Chunk-AAA.js')).toBe(stored); // same build → no re-stamp
  });

  it('does not let a cold-start seed overwrite a navigation that landed while it was reading', async () => {
    // Codex #4335 P1: a cold worker serves an /assets/ miss by seeding the
    // live build from the cached shell A; a navigation to B arrives while
    // that read is in flight. The seed's continuation must not write A back
    // over B, or B's chunks are tagged A and C's prune removes them.
    const cache = fakeCache();
    let releaseShell;
    const shellGate = new Promise(resolve => { releaseShell = resolve; });
    await cache.put('/', gatedResponse(shellHtml(['/assets/index-AAA.js']), shellGate));
    await cache.put('/assets/index-AAA.js', fakeResponse('a'));
    const { dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    setFetch(async (request) => {
      if (request.mode === 'navigate') return fakeResponse(shellHtml(['/assets/index-BBB.js']));
      return fakeResponse(`asset:${request.url}`);
    });

    const miss = await dispatchFetch('/assets/DashboardPageV2-BBB.js', { settle: false }); // seed parked on A's body
    const nav = await dispatchFetch('/admin/', { mode: 'navigate', settle: false });
    await tick(); // B's navigation advanced the live build
    releaseShell();
    await miss.settled();
    await nav.settled();

    const bbb = buildIdOf(['/assets/index-BBB.js']);
    expect((await cache.match('/assets/DashboardPageV2-BBB.js')).headers.get('x-waves-build').split(',')[0]).toBe(bbb);
    await dispatchFetch('/assets/Later-BBB.js');
    expect((await cache.match('/assets/Later-BBB.js')).headers.get('x-waves-build').split(',')[0]).toBe(bbb);
  });

  it('keeps a chunk that a retained build re-tagged while the prune was deleting it', async () => {
    // Codex #4335 P1: C's prune has read Shared-XYZ.js as tagged A and is
    // about to delete it; a page still on the retained build hits the same
    // chunk and re-tags it. Unserialized, the delete lands after the re-tag
    // and the retained build loses a chunk it just used.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    await dispatchFetch('/assets/Shared-XYZ.js'); // tagged A
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-BBB.js'])));
    setFetch(async (request) => fakeResponse(`asset:${request.url}`));

    let releaseDelete;
    cache.deleteGate = new Promise(resolve => { releaseDelete = resolve; });
    const refreshC = cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js'])));
    await tick(); // C's prune has read the tags and is parked on delete()
    const hit = await dispatchFetch('/assets/Shared-XYZ.js', { settle: false }); // re-tag under the live build
    await tick();
    releaseDelete();
    await refreshC;
    await hit.settled();

    expect(await cache.match('/assets/Shared-XYZ.js')).toBeTruthy();
    expect(await cachedAssets(cache)).toEqual(['/assets/Shared-XYZ.js', '/assets/index-BBB.js', '/assets/index-CCC.js']);
  });

  it('queues an installing worker\'s prune behind the active worker\'s re-tag (two instances, one lock)', async () => {
    // Codex #4335 P1 (cross-instance): the installing worker precaches C and
    // prunes while the active worker, a separate global scope on the same
    // cache, re-tags Shared-XYZ.js for the retained build. Two module-local
    // chains cannot order these; the origin-wide lock must.
    const cache = fakeCache();
    const locks = fakeLocks();
    const active = loadWorker(cache, { locks });
    await active.cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    await active.dispatchFetch('/assets/Shared-XYZ.js'); // tagged A
    await active.cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-BBB.js'])));

    const installer = loadWorker(cache, { locks });
    let releaseDelete;
    cache.deleteGate = new Promise(resolve => { releaseDelete = resolve; });
    const install = installer.cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js'])));
    await tick(); // the installer's prune read the tags and is parked on delete()
    const hit = await active.dispatchFetch('/assets/Shared-XYZ.js', { settle: false }); // active worker re-tags
    await tick();
    releaseDelete();
    await install;
    await hit.settled();

    expect(await cache.match('/assets/Shared-XYZ.js')).toBeTruthy();
    expect(await cachedAssets(cache)).toEqual(['/assets/Shared-XYZ.js', '/assets/index-BBB.js', '/assets/index-CCC.js']);
  });

  it('ignores an older navigation whose body finishes after a newer one', async () => {
    // Codex #4335 P1: navigations A then B overlap a deploy; A's HTML body
    // resolves after B's. A's callback must not reset the live build to A,
    // or B's lazy chunks are tagged A and C's prune drops them.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-000.js'])));

    let releaseA;
    const gateA = new Promise(resolve => { releaseA = resolve; });
    let navResponse = () => gatedResponse(shellHtml(['/assets/index-AAA.js']), gateA);
    setFetch(async (request) => {
      if (request.mode === 'navigate') return navResponse();
      return fakeResponse(`asset:${request.url}`);
    });

    const navA = await dispatchFetch('/admin/', { mode: 'navigate', settle: false });
    navResponse = () => fakeResponse(shellHtml(['/assets/index-BBB.js']));
    const navB = await dispatchFetch('/admin/', { mode: 'navigate', settle: false });
    await tick(); // B's body parsed; A's is still parked
    releaseA();
    await navA.settled();
    await navB.settled();

    await dispatchFetch('/assets/DashboardPageV2-BBB.js');
    expect((await cache.match('/assets/DashboardPageV2-BBB.js')).headers.get('x-waves-build').split(',')[0])
      .toBe(buildIdOf(['/assets/index-BBB.js']));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js'])));
    expect(await cachedAssets(cache)).toEqual(['/assets/DashboardPageV2-BBB.js', '/assets/index-BBB.js', '/assets/index-CCC.js']);
  });

  it('re-tags a cache hit on a cold worker even after the page has consumed the body', async () => {
    // Codex #4335 P1: on a cold worker the hit is returned to respondWith
    // before the build lookup (which reads the cached shell) resolves. The
    // page locks the body in that window; a clone() taken afterwards throws
    // and the swallowed error leaves the older tag in place.
    const cache = fakeCache();
    let releaseShell;
    const shellGate = new Promise(resolve => { releaseShell = resolve; });
    await cache.put('/', gatedResponse(shellHtml(['/assets/index-BBB.js']), shellGate));
    await cache.put('/assets/Shared-XYZ.js', new FakeResponse('shared', { headers: { 'x-waves-build': '/assets/index-AAA.js' } }));
    const { dispatchFetch, buildIdOf } = loadWorker(cache);

    const hit = await dispatchFetch('/assets/Shared-XYZ.js', { settle: false });
    expect(await hit.response.text()).toBe('shared'); // the page consumes the body first
    releaseShell();
    await hit.settled();

    expect((await cache.match('/assets/Shared-XYZ.js')).headers.get('x-waves-build'))
      .toBe(`${buildIdOf(['/assets/index-BBB.js'])},/assets/index-AAA.js`);
  });

  it('derives a short build id from the asset set regardless of order', () => {
    const { buildIdOf } = loadWorker(fakeCache());
    expect(buildIdOf(['/assets/a.js', '/assets/b.css'])).toBe(buildIdOf(['/assets/b.css', '/assets/a.js']));
    expect(buildIdOf(['/assets/a.js'])).not.toBe(buildIdOf(['/assets/a.js', '/assets/b.css']));
    // A digest, not the asset list: ~300 assets per build would otherwise put
    // megabytes of header text into the index WebKit reads on first open.
    const many = Array.from({ length: 300 }, (_, i) => `/assets/Chunk-${i.toString(36).padStart(8, 'x')}.js`);
    expect(buildIdOf(many)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps a retained build\'s claim on a chunk that a never-cached live build also used', async () => {
    // Pre-push Codex P1: shell A and its route chunk are cached. A navigation
    // to B advances the live build, but B's shell refresh fails (asset
    // preload 500), so the cached shell stays A. An A tab then hits its
    // chunk: the re-tag must ADD B, not replace A — when C ships, retention
    // is {C, A} and a chunk tagged only B would be deleted from under A.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    await dispatchFetch('/assets/DashboardPageV2-AAA.js');

    setFetch(async (request) => {
      if (request.mode === 'navigate') return fakeResponse(shellHtml(['/assets/index-BBB.js']));
      if (request.url.includes('index-BBB.js')) return fakeResponse('boom', false);
      return fakeResponse(`asset:${request.url}`);
    });
    await dispatchFetch('/admin/', { mode: 'navigate' }); // B is live; its refresh failed
    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-AAA.js']));

    await dispatchFetch('/assets/DashboardPageV2-AAA.js'); // A's tab loads its route
    // A used this chunk while it was the live build, so its claim is firm and
    // a later provisional guess must not downgrade it.
    // B is the live build and claims it firmly; the cached build A is the
    // worker's guess about which tab asked, so its claim is provisional.
    expect((await cache.match('/assets/DashboardPageV2-AAA.js')).headers.get('x-waves-build'))
      .toBe(`${buildIdOf(['/assets/index-BBB.js'])},${buildIdOf(['/assets/index-AAA.js'])}`);

    setFetch(async (request) => fakeResponse(`asset:${request.url}`));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js'])));
    expect(await cachedAssets(cache)).toEqual(['/assets/DashboardPageV2-AAA.js', '/assets/index-AAA.js', '/assets/index-CCC.js']);
  });

  it('keeps the cached build\'s claim through a run of navigations whose refreshes all fail', async () => {
    // Pre-push Codex P1: with shell A cached, navigations to B, C and D each
    // fail their shell preload, and A's tab hits its route chunk after each.
    // A bounded most-recent-first tag list would shed A after three; the
    // cached shell's build is pinned because the next prune retains it.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    await dispatchFetch('/assets/DashboardPageV2-AAA.js');

    for (const build of ['BBB', 'CCC', 'DDD']) {
      setFetch(async (request) => {
        if (request.mode === 'navigate') return fakeResponse(shellHtml([`/assets/index-${build}.js`]));
        if (request.url.includes(`index-${build}.js`)) return fakeResponse('boom', false);
        return fakeResponse(`asset:${request.url}`);
      });
      await dispatchFetch('/admin/', { mode: 'navigate' });
      await dispatchFetch('/assets/DashboardPageV2-AAA.js');
    }
    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-AAA.js']));
    expect((await cache.match('/assets/DashboardPageV2-AAA.js')).headers.get('x-waves-build').split(',').length).toBe(3);

    setFetch(async (request) => fakeResponse(`asset:${request.url}`));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-EEE.js'])));
    expect(await cachedAssets(cache)).toEqual(['/assets/DashboardPageV2-AAA.js', '/assets/index-AAA.js', '/assets/index-EEE.js']);
  });

  it('lets the cached build claim a chunk first loaded while a never-cached build is live', async () => {
    // Pre-push Codex P1: the worker cannot tell which tab requested a miss.
    // Shell A cached; a navigation to B fails its refresh (B live, never
    // cached); an A tab then loads a route for the first time. Tagged only
    // B, C's prune (retaining C and A) would delete it under the A tab.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    setFetch(async (request) => {
      if (request.mode === 'navigate') return fakeResponse(shellHtml(['/assets/index-BBB.js']));
      if (request.url.includes('index-BBB.js')) return fakeResponse('boom', false);
      return fakeResponse(`asset:${request.url}`);
    });
    await dispatchFetch('/admin/', { mode: 'navigate' });
    await dispatchFetch('/assets/DashboardPageV2-AAA.js'); // first load, from the A tab
    expect((await cache.match('/assets/DashboardPageV2-AAA.js')).headers.get('x-waves-build'))
      .toBe(`${buildIdOf(['/assets/index-BBB.js'])},~${buildIdOf(['/assets/index-AAA.js'])}`);

    setFetch(async (request) => fakeResponse(`asset:${request.url}`));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js'])));
    expect(await cachedAssets(cache)).toEqual(['/assets/DashboardPageV2-AAA.js', '/assets/index-AAA.js', '/assets/index-CCC.js']);
  });

  it('frees chunks held only by an inferred claim when the bucket is out of room', async () => {
    // Codex #4335 r12 P1 (sw.js:535): a chunk loaded by a build whose own
    // shell refresh failed is claimed by that build AND, provisionally, by
    // the cached one. The cached build is always retained, so a run of
    // never-cached builds fills the bucket with entries no retention set
    // can drop, and the device can never cache a newer shell again — the
    // exact failure this worker exists to prevent. Once the bucket is out
    // of room the inferred claim has to stop protecting them.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));

    // Three deploys in a row whose shell refresh fails; each page loads one
    // route chunk, so the cache stays on A while the bucket fills.
    for (const build of ['BBB', 'CCC', 'DDD']) {
      setFetch(async (request) => {
        if (request.mode === 'navigate') return fakeResponse(shellHtml([`/assets/index-${build}.js`]));
        if (request.url.includes(`index-${build}.js`)) return fakeResponse('boom', false);
        return fakeResponse(`asset:${request.url}`);
      });
      await dispatchFetch('/admin/', { mode: 'navigate' });
      await dispatchFetch(`/assets/Route-${build}.js`);
    }
    expect(await cachedAssets(cache)).toEqual([
      '/assets/Route-BBB.js', '/assets/Route-CCC.js', '/assets/Route-DDD.js', '/assets/index-AAA.js',
    ]);
    // Nothing but the inferred claim on A is keeping them alive.
    for (const build of ['BBB', 'CCC', 'DDD']) {
      expect((await cache.match(`/assets/Route-${build}.js`)).headers.get('x-waves-build').split(','))
        .toContain(`~${buildIdOf(['/assets/index-AAA.js'])}`);
    }

    // The bucket is full: an asset write only succeeds once the wedge clears.
    setFetch(async (request) => fakeResponse(`asset:${request.url}`));
    const assetCount = () => [...cache.store.keys()].filter(u => u.includes('/assets/')).length;
    cache.failPut = (url) => url.includes('/assets/') && assetCount() >= 4;

    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-EEE.js'])));

    // The wedge is cleared: E is cached, where the old worker could never
    // store another shell again. The chunks kept alive only by the inferred
    // claim are gone; the assets A's and E's own shells list stayed, and so
    // did D's route — D was the live build when the escalated prune ran, so
    // it still held a firm claim of its own.
    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-EEE.js']));
    expect(await cachedAssets(cache)).toEqual([
      '/assets/Route-DDD.js', '/assets/index-AAA.js', '/assets/index-EEE.js',
    ]);
  });

  it('claims a chunk firmly for the build whose file list names it', async () => {
    // With a published file list the worker no longer has to guess which
    // build a chunk belongs to, so A's claim is firm and survives the
    // quota prune that drops entries held only by a guess.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, pruneStaleAssets, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    const aaa = buildIdOf(['/assets/index-AAA.js']);
    setFetch(serveBuild(['/assets/index-AAA.js'], ['/assets/index-AAA.js', '/assets/Route-AAA.js']));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    expect(await manifestOf(cache, aaa)).toBeTruthy();

    // B goes live and its own refresh fails, so B publishes no list; an A
    // tab then loads a route A's list does name.
    setFetch(async (request) => {
      if (request.url.includes('/build-assets.json')) return fakeResponse('nope', false);
      if (request.mode === 'navigate') return fakeResponse(shellHtml(['/assets/index-BBB.js']));
      if (request.url.includes('index-BBB.js')) return fakeResponse('boom', false);
      return fakeResponse(`asset:${request.url}`);
    });
    await dispatchFetch('/admin/', { mode: 'navigate' });
    await dispatchFetch('/assets/Route-AAA.js');
    expect((await cache.match('/assets/Route-AAA.js')).headers.get('x-waves-build').split(','))
      .toContain(aaa); // firm: no '~' marker

    await pruneStaleAssets(cache, [aaa], { firmOnly: true });
    expect(await cachedAssets(cache)).toContain('/assets/Route-AAA.js');
  });

  it('upgrades a provisional claim once the build publishes a list naming the chunk', async () => {
    // Pre-push Codex P1: the hit shortcuts compared claim IDS, and a
    // provisional tag reads as the same id as a firm claim. A chunk cached
    // before its build's list existed therefore stayed a guess forever, and
    // the quota prune could drop it even though the list proves it belongs.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, pruneStaleAssets, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    const aaa = buildIdOf(['/assets/index-AAA.js']);
    const noManifest = async (request) => {
      if (request.url.includes('/build-assets.json')) return fakeResponse('nope', false);
      return fakeResponse(`asset:${request.url}`);
    };

    // A is cached before any list is published.
    setFetch(noManifest);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    // B goes live with a failed refresh; an A tab loads a route, so A's
    // claim on it is only the worker's guess.
    setFetch(async (request) => {
      if (request.mode === 'navigate') return fakeResponse(shellHtml(['/assets/index-BBB.js']));
      if (request.url.includes('index-BBB.js')) return fakeResponse('boom', false);
      return noManifest(request);
    });
    await dispatchFetch('/admin/', { mode: 'navigate' });
    await dispatchFetch('/assets/Route-AAA.js');
    expect((await cache.match('/assets/Route-AAA.js')).headers.get('x-waves-build').split(','))
      .toContain(`~${aaa}`);

    // A refresh now publishes A's list, which names that route.
    setFetch(serveBuild(['/assets/index-AAA.js'], ['/assets/index-AAA.js', '/assets/Route-AAA.js']));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    await dispatchFetch('/assets/Route-AAA.js'); // a hit must upgrade the guess

    const tags = (await cache.match('/assets/Route-AAA.js')).headers.get('x-waves-build').split(',');
    expect(tags).toContain(aaa);
    expect(tags).not.toContain(`~${aaa}`);
    await pruneStaleAssets(cache, [aaa], { firmOnly: true });
    expect(await cachedAssets(cache)).toContain('/assets/Route-AAA.js');
  });

  it('does not claim a chunk for a build whose file list leaves it out', async () => {
    // The guess used to give every chunk the cached build's claim, which
    // kept chunks that build never owned. A published list settles it.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    const aaa = buildIdOf(['/assets/index-AAA.js']);
    setFetch(serveBuild(['/assets/index-AAA.js']));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));

    setFetch(async (request) => {
      if (request.url.includes('/build-assets.json')) return fakeResponse('nope', false);
      if (request.mode === 'navigate') return fakeResponse(shellHtml(['/assets/index-BBB.js']));
      if (request.url.includes('index-BBB.js')) return fakeResponse('boom', false);
      return fakeResponse(`asset:${request.url}`);
    });
    await dispatchFetch('/admin/', { mode: 'navigate' });
    await dispatchFetch('/assets/Route-BBB.js'); // B's chunk; A's list omits it
    const tags = (await cache.match('/assets/Route-BBB.js')).headers.get('x-waves-build').split(',');
    expect(tags).not.toContain(aaa);
    expect(tags).not.toContain(`~${aaa}`);
  });

  it('ignores a file list that does not match the shell it was fetched with', async () => {
    // A deploy landing between the shell fetch and the list fetch would file
    // the NEXT build's list under this build's id. The shell's own assets are
    // in its own list by construction, so their absence proves the mismatch.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, setFetch, buildIdOf } = loadWorker(cache);
    setFetch(serveBuild(['/assets/index-AAA.js'], ['/assets/index-BBB.js', '/assets/Route-BBB.js']));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    expect(await manifestOf(cache, buildIdOf(['/assets/index-AAA.js']))).toBeFalsy();
  });

  it('drops the file list of a build it stops retaining', async () => {
    const cache = fakeCache();
    const { cacheCompleteShellResponse, setFetch, buildIdOf } = loadWorker(cache);
    const [aaa, bbb, ccc] = [['/assets/index-AAA.js'], ['/assets/index-BBB.js'], ['/assets/index-CCC.js']].map(buildIdOf);
    for (const build of ['AAA', 'BBB', 'CCC']) {
      setFetch(serveBuild([`/assets/index-${build}.js`]));
      await cacheCompleteShellResponse(fakeResponse(shellHtml([`/assets/index-${build}.js`])));
    }
    expect(await manifestOf(cache, ccc)).toBeTruthy();
    expect(await manifestOf(cache, bbb)).toBeTruthy(); // the retained previous build
    expect(await manifestOf(cache, aaa)).toBeFalsy();  // two deploys old
  });

  it('lets a hit claim the cached build for a chunk stored two builds ago', async () => {
    // Pre-push Codex P1: Shared-XYZ.js was stored under Z; the refresh to A
    // never referenced it, so it carries no A tag. B then goes live with a
    // failed refresh, and an A tab hits the chunk: the hit must claim A
    // (not just B), or C's prune — retaining C and A — deletes it under A.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-ZZZ.js'])));
    await dispatchFetch('/assets/Shared-XYZ.js'); // tagged Z
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    setFetch(async (request) => {
      if (request.mode === 'navigate') return fakeResponse(shellHtml(['/assets/index-BBB.js']));
      if (request.url.includes('index-BBB.js')) return fakeResponse('boom', false);
      return fakeResponse(`asset:${request.url}`);
    });
    await dispatchFetch('/admin/', { mode: 'navigate' }); // B live, never cached
    await dispatchFetch('/assets/Shared-XYZ.js'); // hit from the A tab
    expect(claimIds(await cache.match('/assets/Shared-XYZ.js')))
      .toContain(buildIdOf(['/assets/index-AAA.js']));

    setFetch(async (request) => fakeResponse(`asset:${request.url}`));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js'])));
    expect(await cachedAssets(cache)).toEqual(['/assets/Shared-XYZ.js', '/assets/index-AAA.js', '/assets/index-CCC.js']);
  });

  it('reclaims quota from the old bucket without taking the active shell, then retries the precache', async () => {
    // Codex #4335 P1s: on a phone whose v11 bucket holds the origin's whole
    // quota, the v12 precache rejects with QuotaExceededError and install
    // would fail forever (stale buckets are only swept at activate). The
    // recovery must not delete the active worker's bucket outright: if
    // the retry fails too, that worker still needs its offline shell.
    const cache = fakeCache();
    const v11 = fakeCache();
    await v11.put('/', fakeResponse(shellHtml(['/assets/index-OLD.js'])));
    await v11.put('/assets/index-OLD.js', fakeResponse('old'));
    for (let i = 0; i < 50; i += 1) await v11.put(`/assets/Chunk-${i}.js`, fakeResponse('bloat'));
    await v11.put('/waves-logo.png', fakeResponse('png'));
    // Codex #4335 r6 P1: a device that never ran a v11 worker still serves
    // from the pre-prefix v10 bucket, so it gets the same trim, not a delete.
    const v10 = fakeCache();
    await v10.put('/', fakeResponse(shellHtml(['/assets/index-V10.js'])));
    await v10.put('/assets/index-V10.js', fakeResponse('v10'));
    for (let i = 0; i < 20; i += 1) await v10.put(`/assets/Old-${i}.js`, fakeResponse('bloat'));
    const { dispatchInstall, cacheNames, setFetch } = loadWorker(cache, {
      cachesByName: { 'waves-customer-v11-shell-atomic': v11, 'waves-v10-admin-activation-stable': v10 },
      cacheNames: ['waves-badge-state'],
    });
    setFetch(async (request) => (request.url === '/' ? fakeResponse(shellHtml(['/assets/index-AAA.js'])) : fakeResponse(`asset:${request.url}`)));
    cache.failPut = () => v11.store.size > 3 || v10.store.size > 2; // no room until both buckets lose their bloat

    await dispatchInstall();

    expect([...cacheNames].sort()).toEqual(['waves-badge-state', 'waves-customer-v11-shell-atomic', 'waves-customer-v12-shell-pruned', 'waves-v10-admin-activation-stable']);
    expect([...v11.store.keys()].map(u => new URL(u).pathname).sort()).toEqual(['/', '/assets/index-OLD.js', '/waves-logo.png']);
    expect([...v10.store.keys()].map(u => new URL(u).pathname).sort()).toEqual(['/', '/assets/index-V10.js']);
    expect(await cache.match('/')).toBeTruthy();
    expect(await cache.match('/assets/index-AAA.js')).toBeTruthy();
  });

  it('leaves the active worker its shell when the quota retry fails as well', async () => {
    const cache = fakeCache();
    const v11 = fakeCache();
    await v11.put('/', fakeResponse(shellHtml(['/assets/index-OLD.js'])));
    await v11.put('/assets/index-OLD.js', fakeResponse('old'));
    await v11.put('/assets/Chunk-1.js', fakeResponse('bloat'));
    const { dispatchInstall, cacheNames, setFetch } = loadWorker(cache, { cachesByName: { 'waves-customer-v11-shell-atomic': v11 } });
    let shellFetches = 0;
    setFetch(async (request) => {
      if (request.url === '/') { shellFetches += 1; if (shellFetches > 1) throw new TypeError('Failed to fetch'); return fakeResponse(shellHtml(['/assets/index-AAA.js'])); }
      return fakeResponse(`asset:${request.url}`);
    });
    cache.failPut = () => shellFetches === 1; // first attempt hits the quota; the retry then loses connectivity

    await expect(dispatchInstall()).rejects.toThrow(/Failed to fetch/);
    expect(cacheNames.has('waves-customer-v11-shell-atomic')).toBe(true);
    expect(await v11.match('/')).toBeTruthy();
    expect(await v11.match('/assets/index-OLD.js')).toBeTruthy();
  });

  it('fetches the install shell under the shared refresh lock so an older installer cannot overwrite a newer commit', async () => {
    // Codex #4335 P2: the installer's shell fetch is slow; the active worker
    // (separate instance, same cache and lock) commits a newer build C
    // meanwhile. The installer's non-supersedable commit of B must not
    // then replace C. Holding the lock across the fetch orders them.
    // Both instances read a FIXED, distinct clock. installCommittedAfter
    // treats an equal timestamp as superseding (deliberately — see the
    // equal-timestamp tests below), so on the real clock this test comes
    // down to whether the installer and the navigation land in the same
    // millisecond, and the navigation correctly stands down when they do.
    // That raced ~40% of runs. Pinning the installer strictly earlier keeps
    // the ordering under test — the lock, not the tie-break — deterministic.
    const cache = fakeCache();
    const locks = fakeLocks();
    const active = loadWorker(cache, { locks, now: () => 2000 });
    await active.cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    const installer = loadWorker(cache, { locks, now: () => 1000 });
    let releaseInstall;
    const installGate = new Promise(resolve => { releaseInstall = resolve; });
    installer.setFetch(async (request) => {
      if (request.url === '/') { await installGate; return fakeResponse(shellHtml(['/assets/index-BBB.js'])); }
      return fakeResponse(`asset:${request.url}`);
    });
    active.setFetch(async (request) => {
      if (request.mode === 'navigate') return fakeResponse(shellHtml(['/assets/index-CCC.js']));
      return fakeResponse(`asset:${request.url}`);
    });

    const install = installer.dispatchInstall();
    await tick();
    const nav = await active.dispatchFetch('/admin/', { mode: 'navigate', settle: false });
    await tick();
    releaseInstall();
    await install;
    await nav.settled();

    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-CCC.js']));
  });

  it('does not sweep buckets when the precache fails for a non-quota reason', async () => {
    const cache = fakeCache();
    const { dispatchInstall, cacheNames, setFetch } = loadWorker(cache, { cacheNames: ['waves-customer-v11-shell-atomic'] });
    setFetch(async (request) => (request.url === '/' ? fakeResponse(shellHtml(['/assets/index-AAA.js'])) : fakeResponse('down', false)));
    await expect(dispatchInstall()).rejects.toThrow(/Shell asset failed/);
    expect(cacheNames.has('waves-customer-v11-shell-atomic')).toBe(true);
  });

  it('does not let a stale shell read reset the cached-build memo after a refresh', async () => {
    // Codex #4335 P1: a miss's read of shell A is still parked when a refresh
    // commits shell B. Publishing A into the memo afterwards makes the hit
    // fast path believe A is the cached build, so a chunk tagged C,A (C the
    // live build) never gains B's claim and D's prune drops it under B.
    const cache = fakeCache();
    let releaseShell;
    const shellGate = new Promise(resolve => { releaseShell = resolve; });
    await cache.put('/', gatedResponse(shellHtml(['/assets/index-AAA.js']), shellGate));
    const { cacheCompleteShellResponse, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);

    const miss = await dispatchFetch('/assets/Early-AAA.js', { settle: false }); // shell read parked
    await tick();
    cache.store.set('https://portal.test/', fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-BBB.js']))); // memo → B
    releaseShell();
    await miss.settled(); // the stale read must not publish A

    setFetch(async (request) => {
      if (request.mode === 'navigate') return fakeResponse(shellHtml(['/assets/index-CCC.js']));
      if (request.url.includes('index-CCC.js')) return fakeResponse('boom', false);
      return fakeResponse(`asset:${request.url}`);
    });
    await dispatchFetch('/admin/', { mode: 'navigate' }); // C live, never cached
    const ccc = buildIdOf(['/assets/index-CCC.js']);
    const aaa = buildIdOf(['/assets/index-AAA.js']);
    await cache.put('/assets/Shared-XYZ.js', new FakeResponse('shared', { headers: { 'x-waves-build': `${ccc},${aaa}` } }));
    await dispatchFetch('/assets/Shared-XYZ.js'); // a B tab's hit must add B
    expect(claimIds(await cache.match('/assets/Shared-XYZ.js')))
      .toContain(buildIdOf(['/assets/index-BBB.js']));

    setFetch(async (request) => fakeResponse(`asset:${request.url}`));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-DDD.js'])));
    expect(await cachedAssets(cache)).toContain('/assets/Shared-XYZ.js');
  });

  it('keeps the cached build\'s claim on a shared asset through refreshes that fail mid-write', async () => {
    // Codex #4335 P1: refreshes C1..C3 each re-write the shared asset, then
    // fail storing a new asset (quota). The shell stays B, but the shared
    // entry's tags would fill with uncommitted builds and shed B; D's prune
    // (retaining D and B) would then delete an asset B's shell needs.
    const cache = fakeCache();
    const { cacheCompleteShellResponse } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-BBB.js', '/assets/Shared-XYZ.js'])));

    cache.failPut = (url) => /index-C\d\.js$/.test(url);
    for (const build of ['C1', 'C2', 'C3']) {
      await expect(cacheCompleteShellResponse(fakeResponse(shellHtml([`/assets/index-${build}.js`, '/assets/Shared-XYZ.js']))))
        .rejects.toThrow(/Quota/);
    }
    cache.failPut = null;
    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-BBB.js', '/assets/Shared-XYZ.js']));

    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-DDD.js'])));
    expect(await cachedAssets(cache)).toEqual(['/assets/Shared-XYZ.js', '/assets/index-BBB.js', '/assets/index-DDD.js']);
  });

  it('removes the entries a failed refresh batch created and keeps prior claims on the rest', async () => {
    // Codex #4335 P1: a refresh to C stores C's new entry script, then fails
    // storing another asset (quota). Tagging the new script with the cached
    // build would make the failed generation unprunable while B stays
    // cached — and hold the quota every later refresh needs.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, buildIdOf } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-BBB.js', '/assets/Shared-XYZ.js'])));

    cache.failPut = (url) => url.endsWith('/assets/vendor-CCC.js');
    await expect(cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js', '/assets/vendor-CCC.js', '/assets/Shared-XYZ.js']))))
      .rejects.toThrow(/Quota/);
    cache.failPut = null;

    expect(await cachedAssets(cache)).toEqual(['/assets/Shared-XYZ.js', '/assets/index-BBB.js']); // index-CCC.js rolled back
    expect((await cache.match('/assets/Shared-XYZ.js')).headers.get('x-waves-build').split(','))
      .toContain(buildIdOf(['/assets/index-BBB.js', '/assets/Shared-XYZ.js']));
  });

  it('drops the older retained generation and retries when the current bucket itself is full', async () => {
    // Codex #4335 r7 P1: builds A and B are retained with A's route chunks;
    // the refresh to C hits the quota writing its own assets, before the
    // prune that would have dropped A. Without recovery every later refresh
    // and install repeats the failure (the stale-bucket reclaim never
    // touches the current bucket) until storage is cleared by hand.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    for (let i = 0; i < 5; i += 1) await dispatchFetch(`/assets/Route-A${i}.js`);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-BBB.js'])));
    expect(await cachedAssets(cache)).toHaveLength(7); // A, its five routes, B

    cache.failPut = () => cache.store.size >= 8; // no room for C while A's generation is still there
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js'])));
    cache.failPut = null;

    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-CCC.js']));
    expect(await cachedAssets(cache)).toEqual(['/assets/index-BBB.js', '/assets/index-CCC.js']);
  });

  it('removes a refresh\'s new entries when storing the shell itself hits the quota', async () => {
    // Pre-push Codex P1: the asset batch succeeds, then cache.put('/') rejects.
    // '/' still describes A, so nothing ever prunes B's, C's and D's
    // entries; they would hold the quota every later refresh needs.
    const cache = fakeCache();
    const { cacheCompleteShellResponse } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js', '/assets/Shared-XYZ.js'])));

    cache.failPut = (url) => url === 'https://portal.test/';
    for (const build of ['BBB', 'CCC', 'DDD']) {
      await expect(cacheCompleteShellResponse(fakeResponse(shellHtml([`/assets/index-${build}.js`, '/assets/Shared-XYZ.js']))))
        .rejects.toThrow(/Quota/);
    }
    cache.failPut = null;

    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-AAA.js', '/assets/Shared-XYZ.js']));
    expect(await cachedAssets(cache)).toEqual(['/assets/Shared-XYZ.js', '/assets/index-AAA.js']);
  });

  it('abandons an older refresh that is superseded while its asset batch is being written', async () => {
    // Codex #4335 r8 P1: refresh A passes the pre-commit order check, then
    // spends time in the asset-write batch; navigation B lands meanwhile
    // and advances the live build. If A still commits its shell and B's
    // own refresh then fails, the cache describes A while the page runs
    // B, and B's chunks get tagged with A's build — pruned next deploy.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch } = loadWorker(cache);
    const shell000 = shellHtml(['/assets/index-000.js']);
    await cacheCompleteShellResponse(fakeResponse(shell000));

    let navs = 0;
    setFetch(async (request) => {
      if (request.mode === 'navigate') {
        navs += 1;
        return fakeResponse(shellHtml([navs === 1 ? '/assets/index-AAA.js' : '/assets/index-BBB.js']));
      }
      if (request.url.endsWith('/assets/index-BBB.js')) return fakeResponse('gone', false); // B's refresh fails
      return fakeResponse(`asset:${request.url}`);
    });

    let releaseBatch;
    cache.matchGate = new Promise(resolve => { releaseBatch = resolve; });
    const navAPromise = dispatchFetch('/admin/', { mode: 'navigate' }); // A's batch parks on its first match()
    await tick(); await tick();
    const navBPromise = dispatchFetch('/admin/', { mode: 'navigate' }); // B lands: live build moves on
    await tick();
    cache.matchGate = null;
    releaseBatch();
    await Promise.all([navAPromise, navBPromise]);

    expect(await (await cache.match('/')).text()).toBe(shell000); // neither A (superseded) nor B (failed)
    expect(await cachedAssets(cache)).toEqual(['/assets/index-000.js']); // A's batch rolled back
  });

  it('keeps a rolled-back entry that a newer page claimed after the batch released the lock', async () => {
    // Codex #4335 r9 P1: refresh A creates Shared-XYZ, then its shell write
    // fails (quota). Between the batch and the rollback a page loaded the
    // entry and claimed it for the cached build; deleting it would leave
    // that page without the chunk offline or after the next deploy.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-000.js'])));

    let releaseShellPut;
    const shellGate = new Promise(resolve => { releaseShellPut = resolve; });
    cache.putGate = (url) => (url === 'https://portal.test/' ? shellGate : null);
    cache.failPut = (url) => url === 'https://portal.test/';
    const refreshA = cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js', '/assets/Shared-XYZ.js']))).catch(err => err);
    await tick(); await tick(); // batch committed, shell write parked
    await dispatchFetch('/assets/Shared-XYZ.js'); // a page loads A's new entry: claimed for the cached build
    releaseShellPut();
    expect((await refreshA).message).toMatch(/Quota/);

    expect(await cache.match('/assets/Shared-XYZ.js')).toBeTruthy(); // claimed since: kept
    expect(await cache.match('/assets/index-AAA.js')).toBeUndefined(); // solely A's: rolled back
  });

  it('does not let an active navigation that began before an install replace the installed shell (two instances)', async () => {
    // Codex #4335 r9 P1: the active worker's navigation fetch runs outside
    // the shell-refresh lock, so an installing worker can commit B while
    // that (older) request is still pending; its response must then not
    // replace B. Instance state cannot order this; the install leaves a
    // mark in the cache.
    const cache = fakeCache();
    const locks = fakeLocks();
    const active = loadWorker(cache, { locks });
    await active.cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-000.js'])));
    let releaseA;
    const gateA = new Promise(resolve => { releaseA = resolve; });
    active.setFetch(async (request) => {
      if (request.mode === 'navigate') { await gateA; return fakeResponse(shellHtml(['/assets/index-AAA.js'])); }
      return fakeResponse(`asset:${request.url}`);
    });
    const navA = active.dispatchFetch('/admin/', { mode: 'navigate' }); // began first, response parked
    await new Promise(resolve => setTimeout(resolve, 5)); // the install begins measurably later

    const installer = loadWorker(cache, { locks });
    installer.setFetch(async (request) => (request.url === '/' ? fakeResponse(shellHtml(['/assets/index-BBB.js'])) : fakeResponse(`asset:${request.url}`)));
    await installer.dispatchInstall(); // commits B
    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-BBB.js']));

    releaseA();
    await navA;
    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-BBB.js']));
    expect(await cachedAssets(cache)).toEqual(['/assets/index-000.js', '/assets/index-BBB.js']); // A's batch rolled back

    // A navigation that begins after the install may still move the shell on.
    await new Promise(resolve => setTimeout(resolve, 5));
    active.setFetch(async (request) => (request.mode === 'navigate' ? fakeResponse(shellHtml(['/assets/index-CCC.js'])) : fakeResponse(`asset:${request.url}`)));
    await active.dispatchFetch('/admin/', { mode: 'navigate' });
    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-CCC.js']));
  });

  it('restores the prior shell when a refresh is superseded while its shell write is pending', async () => {
    // Codex #4335 r10 P1: refresh A passes the final order check, then its
    // cache.put('/') yields; navigation B lands and advances the live
    // build before the write completes. The check and the write cannot be
    // atomic, so A must notice afterward and put the prior shell back.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch } = loadWorker(cache);
    const shell000 = shellHtml(['/assets/index-000.js']);
    await cacheCompleteShellResponse(fakeResponse(shell000));

    let navs = 0;
    setFetch(async (request) => {
      if (request.mode === 'navigate') {
        navs += 1;
        return fakeResponse(shellHtml([navs === 1 ? '/assets/index-AAA.js' : '/assets/index-BBB.js']));
      }
      if (request.url.endsWith('/assets/index-BBB.js')) return fakeResponse('gone', false); // B's refresh fails
      return fakeResponse(`asset:${request.url}`);
    });

    let releaseShellPut;
    const shellGate = new Promise(resolve => { releaseShellPut = resolve; });
    let shellPuts = 0;
    cache.putGate = (url) => (url === 'https://portal.test/' && ++shellPuts === 1 ? shellGate : null); // park A's shell write only
    const navAPromise = dispatchFetch('/admin/', { mode: 'navigate' });
    await tick(); await tick(); await tick();
    expect(shellPuts).toBe(1); // A is inside cache.put('/')
    const navBPromise = dispatchFetch('/admin/', { mode: 'navigate' }); // B lands: live build moves on
    await tick();
    releaseShellPut();
    await Promise.all([navAPromise, navBPromise]);

    expect(await (await cache.match('/')).text()).toBe(shell000); // A restored the prior shell; B failed
    expect(await cachedAssets(cache)).toEqual(['/assets/index-000.js']);
  });

  it('leaves the cached-build memo on the restored shell when a refresh is superseded mid-write', async () => {
    // Codex #4335 r11 P1: the restore that undoes a superseded shell write
    // moves the cached build back, but left the memo alone. A miss that
    // read the temporarily written shell publishes that build; after the
    // restore the memo names a generation the cache no longer holds, the
    // hit fast path stops adding the restored build's claim to a shared
    // chunk, and the next deploy's prune deletes a chunk a live tab needs.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    const shell000 = shellHtml(['/assets/index-000.js']);
    await cacheCompleteShellResponse(fakeResponse(shell000));

    let navs = 0;
    setFetch(async (request) => {
      if (request.mode === 'navigate') {
        navs += 1;
        return fakeResponse(shellHtml([navs === 1 ? '/assets/index-AAA.js' : '/assets/index-BBB.js']));
      }
      if (request.url.endsWith('/assets/index-BBB.js')) return fakeResponse('gone', false); // B live, never cached
      return fakeResponse(`asset:${request.url}`);
    });

    let releaseCommit; const commitGate = new Promise(resolve => { releaseCommit = resolve; });
    let releaseRestore; const restoreGate = new Promise(resolve => { releaseRestore = resolve; });
    let shellPuts = 0;
    cache.putGate = (url) => {
      if (url !== 'https://portal.test/') return null;
      shellPuts += 1;
      if (shellPuts === 1) return commitGate; // A commits shell AAA
      if (shellPuts === 2) return restoreGate; // A puts shell 000 back
      return null;
    };

    const navAPromise = dispatchFetch('/admin/', { mode: 'navigate' });
    await tick(); await tick(); await tick();
    expect(shellPuts).toBe(1);
    const navBPromise = dispatchFetch('/admin/', { mode: 'navigate' }); // B lands: live build moves on
    await tick();
    releaseCommit();
    await tick(); await tick(); await tick(); await tick();
    expect(shellPuts).toBe(2); // A is inside the restore, shell AAA momentarily cached
    await dispatchFetch('/assets/Temp-AAA.js'); // a miss reads the temporary shell
    releaseRestore();
    await Promise.all([navAPromise, navBPromise]);
    expect(await (await cache.match('/')).text()).toBe(shell000);

    const bbb = buildIdOf(['/assets/index-BBB.js']);
    const aaa = buildIdOf(['/assets/index-AAA.js']);
    await cache.put('/assets/Shared-XYZ.js', new FakeResponse('shared', { headers: { 'x-waves-build': `${bbb},${aaa}` } }));
    await dispatchFetch('/assets/Shared-XYZ.js'); // a hit must still claim the cached (restored) build
    expect(claimIds(await cache.match('/assets/Shared-XYZ.js')))
      .toContain(buildIdOf(['/assets/index-000.js']));

    cache.putGate = null;
    setFetch(async (request) => fakeResponse(`asset:${request.url}`));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-DDD.js'])));
    expect(await cachedAssets(cache)).toContain('/assets/Shared-XYZ.js');
  });

  it('treats an install that began in the same tick as an older navigation as superseding it (two instances)', async () => {
    // Codex #4335 r11 P1: Date.now() resolution is coarse (coarser still
    // with reduced timer precision), so an active navigation and an
    // installer can read the same value. Under a strict `>` the navigation
    // read the tie as "not superseded" and replaced the installed shell
    // with its own older one, leaving the cache on the wrong generation.
    const cache = fakeCache();
    const locks = fakeLocks();
    const clock = 1_757_000_000_000;
    const now = () => clock; // both instances start within one tick
    const active = loadWorker(cache, { locks, now });
    await active.cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-000.js'])));

    let releaseA;
    const gateA = new Promise(resolve => { releaseA = resolve; });
    active.setFetch(async (request) => {
      if (request.mode === 'navigate') { await gateA; return fakeResponse(shellHtml(['/assets/index-AAA.js'])); }
      return fakeResponse(`asset:${request.url}`);
    });
    const navA = active.dispatchFetch('/admin/', { mode: 'navigate' }); // response parked
    await tick();

    const installer = loadWorker(cache, { locks, now });
    installer.setFetch(async (request) => (request.url === '/' ? fakeResponse(shellHtml(['/assets/index-BBB.js'])) : fakeResponse(`asset:${request.url}`)));
    await installer.dispatchInstall();
    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-BBB.js']));

    releaseA();
    await navA;
    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-BBB.js'])); // the tie did not let A win
    expect(await cachedAssets(cache)).toEqual(['/assets/index-000.js', '/assets/index-BBB.js']); // A's batch rolled back
  });

  it('fails the install when its ordering marker cannot be stored, keeping the prior shell', async () => {
    // Codex #4335 r10 P1: with the marker swallowed, an install could
    // succeed without the cross-worker ordering guard, and an older
    // in-flight navigation of the active worker could overwrite the shell
    // it just stored. The marker is part of the commit.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchInstall, setFetch } = loadWorker(cache);
    const shell000 = shellHtml(['/assets/index-000.js']);
    await cacheCompleteShellResponse(fakeResponse(shell000));
    setFetch(async (request) => (request.url === '/' ? fakeResponse(shellHtml(['/assets/index-BBB.js'])) : fakeResponse(`asset:${request.url}`)));
    cache.failPut = (url) => url === 'https://portal.test/__waves/install-commit';

    await expect(dispatchInstall()).rejects.toThrow(/Quota/);

    expect(await (await cache.match('/')).text()).toBe(shell000);
    expect(await cache.match('/__waves/install-commit')).toBeUndefined();
    expect(await cachedAssets(cache)).toEqual(['/assets/index-000.js']); // B's batch rolled back
  });

  it('skips a superseded refresh: an earlier navigation whose response lands after a newer one', async () => {
    // Codex #4335 P1: navigation A begins before a deploy but its response is
    // slow; navigation B begins later, is answered by the new build and its
    // refresh commits shell B. When A's (older) response finally lands it
    // must neither replace shell B nor become the live build.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-000.js'])));

    let releaseA;
    const gateA = new Promise(resolve => { releaseA = resolve; });
    let navs = 0;
    setFetch(async (request) => {
      if (request.mode === 'navigate') {
        navs += 1;
        if (navs === 1) { await gateA; return fakeResponse(shellHtml(['/assets/index-AAA.js'])); }
        return fakeResponse(shellHtml(['/assets/index-BBB.js']));
      }
      return fakeResponse(`asset:${request.url}`);
    });

    const navAPromise = dispatchFetch('/admin/', { mode: 'navigate' }); // begins first, response parked
    await tick();
    await dispatchFetch('/admin/', { mode: 'navigate' }); // begins later, lands first, commits B
    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-BBB.js']));
    releaseA();
    await navAPromise;

    expect(await (await cache.match('/')).text()).toBe(shellHtml(['/assets/index-BBB.js']));
    await dispatchFetch('/assets/DashboardPageV2-BBB.js');
    expect((await cache.match('/assets/DashboardPageV2-BBB.js')).headers.get('x-waves-build').split(',')[0])
      .toBe(buildIdOf(['/assets/index-BBB.js']));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js'])));
    expect(await cachedAssets(cache)).toEqual(['/assets/DashboardPageV2-BBB.js', '/assets/index-BBB.js', '/assets/index-CCC.js']);
  });

  it('merges a queued re-tag into the entry a refresh re-wrote meanwhile', async () => {
    // Pre-push Codex P1: shell A cached, B live after a failed refresh. A hit
    // on Shared-XYZ.js is parked while it reads the cached shell; refresh C,
    // whose shell references that asset, re-writes the entry tagged C. The
    // resumed re-tag must merge into that entry, not overwrite it with its
    // pre-refresh copy — or D's prune deletes it although C is retained.
    const cache = fakeCache();
    const { cacheCompleteShellResponse, dispatchFetch, setFetch, buildIdOf } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    await dispatchFetch('/assets/Shared-XYZ.js'); // tagged A
    setFetch(async (request) => {
      if (request.mode === 'navigate') return fakeResponse(shellHtml(['/assets/index-BBB.js']));
      if (request.url.includes('index-BBB.js')) return fakeResponse('boom', false);
      return fakeResponse(`asset:${request.url}`);
    });
    await dispatchFetch('/admin/', { mode: 'navigate' }); // B live, never cached

    let releaseShell;
    const shellGate = new Promise(resolve => { releaseShell = resolve; });
    cache.store.set('https://portal.test/', gatedResponse(shellHtml(['/assets/index-AAA.js']), shellGate));
    const hit = await dispatchFetch('/assets/Shared-XYZ.js', { settle: false }); // parked reading the shell
    await tick();
    cache.store.set('https://portal.test/', fakeResponse(shellHtml(['/assets/index-AAA.js'])));
    setFetch(async (request) => fakeResponse(`asset:${request.url}`));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-CCC.js', '/assets/Shared-XYZ.js'])));
    releaseShell();
    await hit.settled();

    const tags = (await cache.match('/assets/Shared-XYZ.js')).headers.get('x-waves-build').split(',');
    expect(tags).toContain(buildIdOf(['/assets/index-CCC.js', '/assets/Shared-XYZ.js']));
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-DDD.js'])));
    expect(await cachedAssets(cache)).toEqual(['/assets/Shared-XYZ.js', '/assets/index-CCC.js', '/assets/index-DDD.js']);
  });
});
