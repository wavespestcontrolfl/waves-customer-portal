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

export function useFeatureFlag(key) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let mounted = true;
    loadFlags().then((flags) => {
      if (mounted) setEnabled(!!flags[key]);
    });
    return () => {
      mounted = false;
    };
  }, [key]);
  return enabled;
}

// Call after a toggle UI mutation so the operator's own view reflects
// the change on next render without a full page reload.
export function refetchFlags() {
  cache = null;
  inflight = null;
  return loadFlags();
}
