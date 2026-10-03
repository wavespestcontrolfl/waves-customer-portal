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
function publish(flags) {
  listeners.forEach((listener) => {
    try { listener(flags); } catch { /* one screen never breaks another */ }
  });
}
// AGENTS.md: flags fail closed. While the last read failed (or nobody is
// signed in) every flag is OFF — default-on ones included, so a failed
// reload never turns back on a flag the server had switched off. Every hook,
// mounted or new, cached or fresh, reads flags through this one rule.
function flagValue(flags, key, defaultValue) {
  if (lastLoadFailed) return false;
  return Object.prototype.hasOwnProperty.call(flags, key) ? !!flags[key] : defaultValue;
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
        lastLoadFailed = true; // signed out: fail closed like an error
        publish(cache);
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
      publish(cache);
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
// feature unless they have an explicit `enabled: false` row. A failed read
// still fails closed: every flag is off until a read succeeds (flagValue).
// refreshKey (optional): the verified staff account a long-lived shell reads
// for. A value resolved for another key/account, or read while the cache is
// unloaded (refetched for a new account), is never returned: off is, derived
// in render, until this read answers (Codex #5573 r10, r12).
export function useFeatureFlag(key, defaultValue = false, refreshKey = undefined) {
  const [state, setState] = useState(() => ({ key, refreshKey, enabled: defaultValue, resolved: false }));
  useEffect(() => {
    let mounted = true;
    const apply = (flags) => {
      if (mounted) setState({ key, refreshKey, enabled: flagValue(flags, key, defaultValue), resolved: true });
    };
    const unsubscribe = subscribe(apply);
    loadFlags().then(apply);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [key, defaultValue, refreshKey]);
  // Unresolved for this key/account, or refetching: closed, default-on flags
  // included (AGENTS.md: flags fail closed; pre-push P1).
  if (!state.resolved || state.key !== key || state.refreshKey !== refreshKey || cache === null) return false;
  return state.enabled;
}

export function useFeatureFlagReady(key, defaultValue = false, refreshKey = undefined) {
  const [state, setState] = useState(() => ({
    key,
    refreshKey,
    enabled: cache ? flagValue(cache, key, defaultValue) : defaultValue,
    ready: cache !== null,
  }));
  useEffect(() => {
    let mounted = true;
    const apply = (flags) => {
      if (!mounted) return;
      setState({ key, refreshKey, enabled: flagValue(flags, key, defaultValue), ready: true });
    };
    const unsubscribe = subscribe(apply);
    if (cache !== null) apply(cache);
    else loadFlags().then(apply);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [key, defaultValue, refreshKey]);
  // Derived in render, like useFeatureFlag: never another key/account's value,
  // never a value while the cache is unloaded (Codex #5573 r12).
  if (state.key !== key || state.refreshKey !== refreshKey || cache === null) {
    return { enabled: false, ready: false };
  }
  return { enabled: state.enabled, ready: state.ready };
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
    const apply = (flags) => {
      if (!mounted) return;
      const a = flagValue(flags, keyA, defaultValue);
      const b = flagValue(flags, keyB, defaultValue);
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
