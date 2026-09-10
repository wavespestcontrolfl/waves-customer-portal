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
    async match(key) { return store.get(asRequest(key).url); },
    async put(key, response) { store.set(asRequest(key).url, response); },
    async delete(key) { return store.delete(asRequest(key).url); },
    async keys() { return [...store.keys()].map(url => ({ url })); },
  };
}

function fakeResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 500, clone() { return fakeResponse(body, ok); }, async text() { return body; } };
}

// Evaluate the worker in a sandbox whose fetch() serves any /assets/* URL, and
// hand back the functions the shell-refresh path is built from.
function loadWorker(cache) {
  const sandbox = {
    self: { addEventListener() {}, navigator: {}, location: { origin: 'https://portal.test' }, registration: {} },
    caches: { async open() { return cache; }, async keys() { return []; }, async delete() { return true; } },
    Request: class { constructor(url) { this.url = url; } },
    Response: class {},
    URL,
    fetch: async (request) => fakeResponse(`asset:${request.url}`),
    clients: {},
    console,
  };
  sandbox.self.navigator = {};
  vm.createContext(sandbox);
  vm.runInContext(`${source}\n;this.__exports = { cacheCompleteShellResponse, pruneStaleAssets, sameAssetSet, shellAssetUrls };`, sandbox);
  return sandbox.__exports;
}

const shellHtml = (assets) => `<html><head>${assets.map(a => `<script src="${a}"></script>`).join('')}</head></html>`;

describe('customer service-worker update contract', () => {
  it('preloads hashed shell assets before storing the replacement HTML', () => {
    expect(source).toContain('async function cacheCompleteShellResponse(shellResponse)');
    expect(source).toContain('async function precacheCompleteShell()');
    expect(source).toContain("new Request(assetUrl, { cache: 'reload' })");
    expect(source).toContain('await Promise.all(assetResponses.map');
    expect(source.indexOf('await Promise.all(assetResponses.map'))
      .toBeLessThan(source.indexOf('await cache.put(OFFLINE_URL, shellResponse)'));
    expect(source).toContain('event.waitUntil(cacheCompleteShellResponse(response.clone()).catch(() => {}))');
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

describe('service-worker shell refresh keeps the asset cache bounded to the current build', () => {
  it('prunes hashed assets from superseded builds when the shell changes', async () => {
    const cache = fakeCache();
    const { cacheCompleteShellResponse } = loadWorker(cache);
    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-AAA.js', '/assets/index-AAA.css'])));
    // A lazily loaded page chunk of build AAA, cached on use by the /assets/ branch.
    await cache.put('/assets/DashboardPageV2-AAA.js', fakeResponse('chunk'));
    // An icon cached by the network-first branch — not an /assets/ entry, must survive.
    await cache.put('/waves-logo.png', fakeResponse('png'));

    await cacheCompleteShellResponse(fakeResponse(shellHtml(['/assets/index-BBB.js', '/assets/index-AAA.css'])));

    const kept = [...cache.store.keys()].map(u => new URL(u).pathname).sort();
    expect(kept).toEqual(['/', '/assets/index-AAA.css', '/assets/index-BBB.js', '/waves-logo.png']);
  });

  it('does not touch lazily cached chunks when the same shell is refreshed', async () => {
    const cache = fakeCache();
    const { cacheCompleteShellResponse } = loadWorker(cache);
    const shell = shellHtml(['/assets/index-AAA.js']);
    await cacheCompleteShellResponse(fakeResponse(shell));
    await cache.put('/assets/DashboardPageV2-AAA.js', fakeResponse('chunk'));

    // Every navigation refreshes the shell in the background; an unchanged
    // build must not evict the page chunks the admin just downloaded.
    await cacheCompleteShellResponse(fakeResponse(shell));

    expect(await cache.match('/assets/DashboardPageV2-AAA.js')).toBeTruthy();
  });

  it('treats the same assets in a different order as an unchanged build', () => {
    const { sameAssetSet } = loadWorker(fakeCache());
    expect(sameAssetSet(['/assets/a.js', '/assets/b.css'], ['/assets/b.css', '/assets/a.js'])).toBe(true);
    expect(sameAssetSet(['/assets/a.js'], ['/assets/a.js', '/assets/b.css'])).toBe(false);
    expect(sameAssetSet(['/assets/a.js', '/assets/a.js'], ['/assets/a.js', '/assets/b.css'])).toBe(false);
  });
});
