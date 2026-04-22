import { useEffect, useState } from 'react';

// Module-scope singleton — lives for the lifetime of the SPA session.
// Server is source of truth; we never persist to localStorage.
let cache = null; // null = unloaded, object = loaded (empty object on error = fail-closed)
let inflight = null;
const API_BASE = import.meta.env.VITE_API_URL || '/api';

async function loadFlags() {
  if (cache !== null) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const token = localStorage.getItem('waves_admin_token');
      if (!token) {
        cache = {};
        return cache;
      }
      const res = await fetch(`${API_BASE}/admin/feature-flags`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`flags fetch failed: ${res.status}`);
      const data = await res.json();
      cache = data.flags || {};
      return cache;
    } catch (err) {
      console.warn('[useFeatureFlag] load failed — failing closed', err);
      cache = {}; // fail closed — everyone gets stable UI
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
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
    loadFlags().then((flags) => {
      if (!mounted) return;
      setEnabled(Object.prototype.hasOwnProperty.call(flags, key) ? !!flags[key] : defaultValue);
    });
    return () => {
      mounted = false;
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
    if (cache !== null) return undefined;
    let mounted = true;
    loadFlags().then((flags) => {
      if (!mounted) return;
      setState({
        enabled: Object.prototype.hasOwnProperty.call(flags, key) ? !!flags[key] : defaultValue,
        ready: true,
      });
    });
    return () => {
      mounted = false;
    };
  }, [key, defaultValue]);
  return state;
}

// Call after a toggle UI mutation so the operator's own view reflects
// the change on next render without a full page reload.
export function refetchFlags() {
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
