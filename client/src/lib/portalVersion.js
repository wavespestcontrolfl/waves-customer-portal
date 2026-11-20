// An open tab keeps running the code it loaded until the page loads again.
// The server stamps each signed-in staff API answer with the client build it
// serves (X-Portal-Build) and the time it started (X-Portal-Boot); see
// server/middleware/portal-build-header.js. This module compares that build
// with the build this page loaded (<meta name="portal-build">, written by the
// production build in vite.config.js), so an out-of-date staff tab can load
// the live code. It also counts API writes still on their way, so a reload
// can wait for them.
//
// The newest server wins while it is still answering: an answer from a
// server that started earlier (the old one, draining for 30 s during a
// deploy) never moves the tab back. Once the newest server has been quiet for
// a minute, any server's answer counts again, so a server that is gone (an
// old one that restarted during a rollout) cannot hold the tab. main.jsx
// installs the watch once, before any other fetch wrapper.

const BUILD_HEADER = 'x-portal-build';
const BOOT_HEADER = 'x-portal-boot';
const API_PATH = /^\/api\//;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const NEWEST_QUIET_MS = 60 * 1000;

let pageBuild; // undefined until first read
let live = { build: null, boot: 0, heardAt: 0 };
let writes = 0;
const listeners = new Set();

function loadedBuild() {
  if (pageBuild === undefined) {
    pageBuild = typeof document === 'undefined'
      ? null
      : document.querySelector('meta[name="portal-build"]')?.getAttribute('content') || null;
  }
  return pageBuild;
}

export function noteServerAnswer(headers, now = Date.now()) {
  const build = headers?.get?.(BUILD_HEADER);
  const boot = Number(headers?.get?.(BOOT_HEADER));
  if (!build || !Number.isFinite(boot) || boot <= 0) return;
  if (boot < live.boot && now - live.heardAt < NEWEST_QUIET_MS) return;
  const changed = build !== live.build;
  live = { build, boot, heardAt: now };
  if (changed) listeners.forEach((listener) => listener());
}

// The live build when it is not the one this page loaded, else null. A page
// without the build tag (the dev server) is never out of date.
export function newerBuild() {
  const own = loadedBuild();
  return own && live.build && live.build !== own ? live.build : null;
}

export function heardFromServerWithin(ms, now = Date.now()) {
  return live.heardAt > 0 && now - live.heardAt <= ms;
}

export function writesInFlight() {
  return writes;
}

export function subscribePortalVersion(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function apiRequest(input, init) {
  const url = typeof input === 'string' ? input : (input?.url || String(input || ''));
  const parsed = new URL(url, window.location.href);
  const api = parsed.origin === window.location.origin && API_PATH.test(parsed.pathname);
  const method = String(init?.method || input?.method || 'GET').toUpperCase();
  return { api, write: api && !READ_METHODS.has(method) };
}

export function installPortalVersionWatch({ target = globalThis } = {}) {
  const original = target.fetch;
  if (typeof original !== 'function') return () => {};
  const watched = async function watchedFetch(input, init) {
    let request = { api: false, write: false };
    try { request = apiRequest(input, init); } catch { /* never breaks the caller's request */ }
    if (request.write) writes += 1;
    try {
      const response = await original.call(this, input, init);
      if (request.api) {
        try { noteServerAnswer(response?.headers); } catch { /* the response is never altered */ }
      }
      return response;
    } finally {
      if (request.write) writes -= 1;
    }
  };
  target.fetch = watched;
  return () => {
    if (target.fetch === watched) target.fetch = original;
  };
}

export function resetPortalVersionForTests() {
  pageBuild = undefined;
  live = { build: null, boot: 0, heardAt: 0 };
  writes = 0;
  listeners.clear();
}
