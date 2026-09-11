import { useEffect, useState } from 'react';

/**
 * Is multi-discount stacking live? (GATE_DISCOUNT_STACKING, read server-side
 * at call time.) This is a DEPLOY-WIDE release gate, not a per-user
 * capability — those go through useFeatureFlag / user_feature_flags.
 *
 * Every surface with a discount picker reads this: OFF hides the added
 * controls and previews with the pre-ruling math, so what the operator sees
 * is always what the server will save. Fails closed, like useFeatureFlag —
 * an unreachable API leaves the surface exactly as it was before this lane.
 */

// Module-scope singleton — one fetch per SPA session, shared by every
// surface that asks.
let cache = null; // null = unloaded, boolean = loaded
let inflight = null;
const API_BASE = import.meta.env.VITE_API_URL || '/api';

async function loadStacking() {
  if (cache !== null) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const token = localStorage.getItem('waves_admin_token');
      if (!token) {
        cache = false;
        return cache;
      }
      const res = await fetch(`${API_BASE}/admin/discounts/stacking`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`stacking fetch failed: ${res.status}`);
      const data = await res.json();
      cache = data?.enabled === true;
      return cache;
    } catch {
      cache = false; // fail closed — single-discount behavior
      return cache;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useDiscountStacking() {
  const [enabled, setEnabled] = useState(() => cache === true);
  useEffect(() => {
    let alive = true;
    loadStacking().then((value) => {
      if (alive) setEnabled(value === true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}

// Test seam: reset the session cache between cases.
export function __resetDiscountStackingCache() {
  cache = null;
  inflight = null;
}

export default useDiscountStacking;
