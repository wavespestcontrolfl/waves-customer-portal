import { useCallback, useEffect, useState } from 'react';

/**
 * Is multi-discount stacking live? (GATE_DISCOUNT_STACKING, read server-side
 * at call time.) This is a DEPLOY-WIDE release gate, not a per-user
 * capability — those go through useFeatureFlag / user_feature_flags.
 *
 * Every surface with a discount picker reads this: OFF hides the added
 * controls and previews with the pre-ruling math, so what the operator sees
 * is always what the server will save. Fails closed, like useFeatureFlag —
 * an unreachable API leaves the surface exactly as it was before this lane.
 *
 * A transient probe failure (network blip, 500, ...) is NOT the same thing
 * as a confirmed answer from the server: caching `false` for the rest of
 * the SPA session would strand a surface showing single-discount preview
 * math while the real (unreachable) gate is ON and the server compounds
 * discounts on save — a silent preview/persisted-total mismatch. So a
 * failure clears the cache instead of pinning it, and callers that submit
 * multi-discount money get a `known` flag so they can refuse to compute or
 * submit stacked amounts while the gate's real state is unconfirmed,
 * instead of confidently previewing (and posting) the wrong math.
 */

// Module-scope singleton — one fetch per SPA session (until a failure clears
// it), shared by every surface that asks.
let cache = null; // null = unloaded/unknown, boolean = confirmed by the server
let inflight = null;
let lastErrorAt = null; // ms epoch of the most recent probe failure, or null
const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Don't hammer a hard-down API: a probe failure blocks re-fetching for this
// long, though `cache` itself stays null (unknown) the whole time so every
// mount in that window still reports known:false rather than a stale true/false.
const RETRY_BACKOFF_MS = 15000;

function snapshot() {
  return cache === null ? { enabled: false, known: false } : { enabled: cache, known: true };
}

async function loadStacking() {
  if (cache !== null) return snapshot();
  if (inflight) return inflight;
  if (lastErrorAt !== null && Date.now() - lastErrorAt < RETRY_BACKOFF_MS) {
    // Still backing off from the last failure — report unknown without
    // re-hitting the API.
    return snapshot();
  }
  inflight = (async () => {
    try {
      const token = localStorage.getItem('waves_admin_token');
      if (!token) {
        cache = false; // no admin session — a determinate answer, not a probe failure
        lastErrorAt = null;
        return snapshot();
      }
      const res = await fetch(`${API_BASE}/admin/discounts/stacking`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`stacking fetch failed: ${res.status}`);
      const data = await res.json();
      cache = data?.enabled === true;
      lastErrorAt = null;
      return snapshot();
    } catch {
      // Fail closed for the moment (enabled: false) but do NOT cache the
      // failure — leave cache null so the next mount (after the backoff)
      // re-probes instead of being stuck on a guess for the whole session.
      cache = null;
      lastErrorAt = Date.now();
      return snapshot();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Full state for surfaces that need to tell "confirmed off" apart from
 * "unknown" — e.g. before computing or submitting multi-discount money.
 * `retry` forces a fresh probe attempt on the next render (still subject to
 * the backoff above if the last attempt just failed).
 */
export function useDiscountStackingState() {
  const [state, setState] = useState(snapshot);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    loadStacking().then((value) => {
      if (alive) setState(value);
    });
    return () => {
      alive = false;
    };
  }, [attempt]);
  // An operator-initiated retry is an explicit "try again now" — it clears
  // the failure backoff so the next probe actually hits the API instead of
  // returning the same unknown for the rest of the window.
  const retry = useCallback(() => {
    lastErrorAt = null;
    setAttempt((n) => n + 1);
  }, []);
  return { enabled: state.enabled, known: state.known, retry };
}

/**
 * Boolean-only convenience for surfaces that just need "is stacking on"
 * (they already fail closed by treating unknown the same as off).
 */
export function useDiscountStacking() {
  return useDiscountStackingState().enabled;
}

// Test seam: reset the session cache between cases.
export function __resetDiscountStackingCache() {
  cache = null;
  inflight = null;
  lastErrorAt = null;
}

export default useDiscountStacking;
