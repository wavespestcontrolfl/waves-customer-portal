import { useEffect, useState } from 'react';

// Module-scope singleton — lives for the lifetime of the SPA session.
// Server is source of truth; we never persist to localStorage.
let cache = null; // null = unloaded, object = loaded (empty object on error = fail-closed)
let inflight = null;
// Bumped by refetchFlags (a toggle, a login change): a read started under an
// older generation is aborted and its answer — or its failure — never
// becomes the cache, so a previous user's flags cannot win a switch.
let generation = 0;
let inflightAbort = null;
// Mounted hooks hear every successful load, so a refetch (a toggle, a login
// change, connectivity back) updates screens already showing a flag.
const listeners = new Set();
// The last load failed and failed closed (e.g. a cold start in a dead zone):
// a gate stays off until the next successful read, which the browser's
// `online` event triggers below.
let lastLoadFailed = false;
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
// `failed` marks a read that failed closed: a mounted screen turns the
// flag OFF, never back to its default (a default-on flag the server had
// switched off must not come back on because a reload failed).
function publish(flags, failed = false) {
  listeners.forEach((listener) => {
    try { listener(flags, failed); } catch { /* one screen never breaks another */ }
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (lastLoadFailed) refetchFlags().catch(() => {});
  });
}
const API_BASE = import.meta.env.VITE_API_URL || '/api';
// A flag read that never answers (a field dead zone) must not hold a gated
// screen on its loading state: give up and fail closed like any other error.
export const FLAGS_FETCH_TIMEOUT_MS = 15000;

async function loadFlags() {
  if (cache !== null) return cache;
  if (inflight) return inflight;

  const gen = generation;
  // Headers and body share the one bound.
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  inflightAbort = abort;
  const current = () => gen === generation;
  const read = (async () => {
    const timer = abort ? setTimeout(() => abort.abort(), FLAGS_FETCH_TIMEOUT_MS) : null;
    try {
      const token = localStorage.getItem('waves_admin_token');
      if (!token) {
        cache = {};
        publish(cache, true); // signed out: mounted screens fail closed
        return cache;
      }
      const res = await fetch(`${API_BASE}/admin/feature-flags`, {
        headers: { Authorization: `Bearer ${token}` },
        ...(abort ? { signal: abort.signal } : {}),
      });
      if (!res.ok) throw new Error(`flags fetch failed: ${res.status}`);
      const data = await res.json();
      if (!current()) return loadFlags();
      cache = data.flags || {};
      lastLoadFailed = false;
      publish(cache);
      return cache;
    } catch (err) {
      if (!current()) return loadFlags();
      console.warn('[useFeatureFlag] load failed — failing closed', err);
      cache = {}; // fail closed — everyone gets stable UI
      lastLoadFailed = true;
      // Screens already showing a flag fail closed too, not only new ones.
      publish(cache, true);
      return cache;
    } finally {
      if (timer) clearTimeout(timer);
      // By generation, never by `read`: with no token the body finishes
      // before `read` is assigned.
      if (current()) { inflight = null; inflightAbort = null; }
    }
  })();
  inflight = read;
  return read;
}

// `defaultValue` is returned when the user has no row for this flag (absence
// in the DB). Pass `true` to flip a flag default-on: every user gets the
// feature unless they have an explicit `enabled: false` row. Fetch errors
// still fail closed to the default — the cache entry for the key is absent,
// so the default applies.
export function useFeatureFlag(key, defaultValue = false) {
  const [enabled, setEnabled] = useState(defaultValue);
  useEffect(() => {
    let mounted = true;
    const apply = (flags, failed = false) => {
      if (mounted) setEnabled(!failed && (Object.prototype.hasOwnProperty.call(flags, key) ? !!flags[key] : defaultValue));
    };
    const unsubscribe = subscribe(apply);
    loadFlags().then(apply);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [key, defaultValue]);
  return enabled;
}

// Same as useFeatureFlag but also exposes `ready` — `false` until the flag
// fetch has resolved, `true` after. Gates use this to defer rendering
// until the flag is known, avoiding a V1→V2 remount flash (which double-
// fires any fetches the V1 component does on mount).
export function useFeatureFlagReady(key, defaultValue = false) {
  const [state, setState] = useState(() => ({
    enabled: cache
      ? (Object.prototype.hasOwnProperty.call(cache, key) ? !!cache[key] : defaultValue)
      : defaultValue,
    ready: cache !== null,
  }));
  useEffect(() => {
    let mounted = true;
    const apply = (flags, failed = false) => {
      if (!mounted) return;
      setState({
        enabled: !failed && (Object.prototype.hasOwnProperty.call(flags, key) ? !!flags[key] : defaultValue),
        ready: true,
      });
    };
    const unsubscribe = subscribe(apply);
    if (cache !== null) apply(cache);
    else loadFlags().then(apply);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [key, defaultValue]);
  return state;
}

// Call after a toggle UI mutation so the operator's own view reflects
// the change on next render without a full page reload.
export function refetchFlags() {
  generation += 1;
  inflightAbort?.abort();
  inflightAbort = null;
  cache = null;
  inflight = null;
  return loadFlags();
}

// Paired-flag gate. Returns enabled=true only when BOTH keys are on.
// If exactly one is on (mismatched rollout), logs an error and treats both
// as off — the non-obvious rule for /pay + /receipt so we never charge a
// customer and 404 their receipt link.
const pairedLoggedOnce = new Set();
export function usePairedFeatureFlag(keyA, keyB, defaultValue = false) {
  const [state, setState] = useState(() => ({
    enabled: defaultValue,
    ready: cache !== null,
    mismatched: false,
  }));
  useEffect(() => {
    let mounted = true;
    const apply = (flags, failed = false) => {
      if (!mounted) return;
      if (failed) {
        setState({ enabled: false, ready: true, mismatched: false });
        return;
      }
      const a = Object.prototype.hasOwnProperty.call(flags, keyA) ? !!flags[keyA] : defaultValue;
      const b = Object.prototype.hasOwnProperty.call(flags, keyB) ? !!flags[keyB] : defaultValue;
      const mismatched = a !== b;
      if (mismatched) {
        const tag = `${keyA}|${keyB}`;
        if (!pairedLoggedOnce.has(tag)) {
          pairedLoggedOnce.add(tag);
          console.error(
            `[usePairedFeatureFlag] Mismatched paired flags: ${keyA}=${a}, ${keyB}=${b}. ` +
            `Treating both as OFF to prevent half-rollout (e.g. /pay charges while /receipt 404s).`,
          );
        }
      }
      setState({ enabled: !mismatched && a && b, ready: true, mismatched });
    };
    const unsubscribe = subscribe(apply);
    loadFlags().then(apply);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [keyA, keyB, defaultValue]);
  return state;
}
