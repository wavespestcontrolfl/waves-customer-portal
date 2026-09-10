import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf8');

// Minimal Cache API double: URL-keyed, enough for the shell-refresh path.
function fakeCache() {
  const store = new Map();
  const asRequest = (key) => (typeof key === 'string' ? { url: `https://portal.test${key}` } : key);
  return {
    store,
    gate: null, // a test may park keys() (the prune's first step) on a promise
    // Like the browser, every match hands out a fresh Response over the
    // stored body — the caller's text()/clone() never lock the stored copy.
    async match(key) { const hit = store.get(asRequest(key).url); return hit && hit.clone(); },
    deleteGate: null, // a test may park delete() (the prune's last step)
    async put(key, response) { store.set(asRequest(key).url, response); },
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
function loadWorker(cache) {
  const listeners = {};
  const sandbox = {
    self: {
      addEventListener(name, fn) { listeners[name] = fn; },
      navigator: {}, location: { origin: 'https://portal.test' }, registration: {},
    },
    caches: { async open() { return cache; }, async keys() { return []; }, async delete() { return true; } },
    Request: class { constructor(url) { this.url = url; } },
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
  return { ...sandbox.__exports, dispatchFetch, setFetch };
}

const shellHtml = (assets) => `<html><head>${assets.map(a => `<script src="${a}"></script>`).join('')}</head></html>`;
const cachedAssets = async (cache) => (await cache.keys()).map(r => new URL(r.url).pathname).filter(p => p.startsWith('/assets/')).sort();

describe('customer service-worker update contract', () => {
  it('preloads hashed shell assets before storing the replacement HTML', () => {
    expect(source).toContain('async function cacheCompleteShellResponse(shellResponse, enqueuedSeq = navigationSeq)');
    expect(source).toContain('async function precacheCompleteShell()');
    expect(source).toContain("new Request(assetUrl, { cache: 'reload' })");
    expect(source).toContain('await Promise.all(assetResponses.map');
    expect(source.indexOf('await Promise.all(assetResponses.map'))
      .toBeLessThan(source.indexOf('await cache.put(OFFLINE_URL, shellResponse)'));
    expect(source).toContain('event.waitUntil(cacheCompleteShellResponse(response.clone(), navSeq).catch(() => {}))');
    expect(source).not.toContain('cache.put(OFFLINE_URL, clone)');
  });

  it('does not swallow install failure or delete caches outside this app', () => {
    expect(source).toContain('event.waitUntil(precacheCompleteShell().then(() => self.skipWaiting()))');
    expect(source).not.toMatch(/precacheCompleteShell\(\).*catch\(\(\) => \{\}\)/);
    expect(source).toContain('k.startsWith(APP_CACHE_PREFIX) && k !== CACHE_NAME');
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
    expect((await cache.match('/assets/DashboardPageV2-BBB.js')).headers.get('x-waves-build'))
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
    expect((await cache.match('/assets/DashboardPageV2-BBB.js')).headers.get('x-waves-build'))
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
    expect(await cachedAssets(cache)).toEqual(['/assets/DashboardPageV2-BBB.js', '/assets/index-AAA.js', '/assets/index-BBB.js']);
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
    expect((await cache.match('/assets/DashboardPageV2-BBB.js')).headers.get('x-waves-build')).toBe(bbb);
    await dispatchFetch('/assets/Later-BBB.js');
    expect((await cache.match('/assets/Later-BBB.js')).headers.get('x-waves-build')).toBe(bbb);
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
    expect((await cache.match('/assets/DashboardPageV2-BBB.js')).headers.get('x-waves-build'))
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

    expect((await cache.match('/assets/Shared-XYZ.js')).headers.get('x-waves-build')).toBe(buildIdOf(['/assets/index-BBB.js']));
  });

  it('derives the build id from the asset set regardless of order', () => {
    const { buildIdOf } = loadWorker(fakeCache());
    expect(buildIdOf(['/assets/a.js', '/assets/b.css'])).toBe(buildIdOf(['/assets/b.css', '/assets/a.js']));
    expect(buildIdOf(['/assets/a.js'])).not.toBe(buildIdOf(['/assets/a.js', '/assets/b.css']));
  });
});
