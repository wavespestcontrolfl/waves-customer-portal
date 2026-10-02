import { useEffect, useState } from 'react';

// Module-scope singleton — lives for the lifetime of the SPA session.
// Server is source of truth; we never persist to localStorage.
let cache = null; // null = unloaded, object = loaded (empty object on error = fail-closed)
let inflight = null;
// Bumped by refetchFlags (a toggle, a login change): a read started under an
// older generation is aborted and its answer — or its failure — never
// becomes the cache, so a previous user's flags cannot win a switch.
let generation = 0;
// Mounted flag hooks re-read after refetchFlags() (a toggle or a login
// switch), so long-lived readers (the admin shell) and newly mounted ones
// (the field shell) never disagree on the same account (Codex #5573 r15).
const refetchListeners = new Set();
function useFlagGeneration() {
  const [gen, setGen] = useState(generation);
  useEffect(() => {
    refetchListeners.add(setGen);
    return () => { refetchListeners.delete(setGen); };
  }, []);
  return gen;
}
let inflightAbort = null;
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
      return cache;
    } catch (err) {
      if (!current()) return loadFlags();
      console.warn('[useFeatureFlag] load failed — failing closed', err);
      cache = {}; // fail closed — everyone gets stable UI
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
// refreshKey: see useFeatureFlagReady (a long-lived shell re-reads per account).
export function useFeatureFlag(key, defaultValue = false, refreshKey = undefined) {
  const gen = useFlagGeneration();
  const [state, setState] = useState(() => ({ key, refreshKey, gen, enabled: defaultValue, resolved: false }));
  useEffect(() => {
    let mounted = true;
    loadFlags().then((flags) => {
      if (!mounted) return;
      setState({ key, refreshKey, gen, enabled: Object.prototype.hasOwnProperty.call(flags, key) ? !!flags[key] : defaultValue, resolved: true });
    });
    return () => {
      mounted = false;
    };
  }, [key, defaultValue, refreshKey, gen]);
  // Derived in render (Codex #5573 r10, r12): a value resolved for another
  // key/account, or while the cache is unloaded (refetched for a new
  // account), never shows; the default does until this read answers.
  if (!state.resolved || state.key !== key || state.refreshKey !== refreshKey || state.gen !== gen || cache === null) return defaultValue;
  return state.enabled;
}

// Same as useFeatureFlag but also exposes `ready` — `false` until the flag
// fetch has resolved, `true` after. Gates use this to defer rendering
// until the flag is known, avoiding a V1→V2 remount flash (which double-
// fires any fetches the V1 component does on mount).
// refreshKey (optional): re-read when it changes, e.g. the verified staff
// account, so a long-lived shell follows refetchFlags() after a login switch.
export function useFeatureFlagReady(key, defaultValue = false, refreshKey = undefined) {
  const gen = useFlagGeneration();
  const fromCache = () => (Object.prototype.hasOwnProperty.call(cache, key) ? !!cache[key] : defaultValue);
  const [state, setState] = useState(() => ({
    key,
    refreshKey,
    gen,
    enabled: cache ? fromCache() : defaultValue,
    ready: cache !== null,
  }));
  useEffect(() => {
    let mounted = true;
    if (cache !== null) {
      setState({ key, refreshKey, gen, enabled: fromCache(), ready: true });
      return undefined;
    }
    loadFlags().then((flags) => {
      if (!mounted) return;
      setState({
        key,
        refreshKey,
        gen,
        enabled: Object.prototype.hasOwnProperty.call(flags, key) ? !!flags[key] : defaultValue,
        ready: true,
      });
    });
    return () => {
      mounted = false;
    };
  }, [key, defaultValue, refreshKey, gen]);
  // Derived in render: a value resolved for another key/account, or while the
  // cache is unloaded (refetched for a new account), is never returned; the
  // default and not-ready are, until this read answers (Codex #5573 r12).
  if (state.key !== key || state.refreshKey !== refreshKey || state.gen !== gen || cache === null) {
    return { enabled: defaultValue, ready: false };
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
  refetchListeners.forEach((notify) => notify(generation));
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
    loadFlags().then((flags) => {
      if (!mounted) return;
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
    });
    return () => {
      mounted = false;
    };
  }, [keyA, keyB, defaultValue]);
  return state;
}
