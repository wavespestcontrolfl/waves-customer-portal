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
 *
 * Codex #4405 P1: even a SUCCESSFUL probe was cached for the rest of the SPA
 * session, so an open tab kept the old semantics across a mid-session
 * GATE_DISCOUNT_STACKING flip while the server's money endpoints read the
 * live env var on every request. A confirmed value now expires after
 * CACHE_TTL_MS and is treated exactly like the unconfirmed state until it is
 * revalidated — so `known` (already the flag every money submitter checks)
 * goes false again on its own, with no separate "stale" concept for callers
 * to learn.
 */

// Module-scope singleton — one fetch per TTL window (sooner if a failure
// clears it), shared by every surface that asks.
let cache = null; // null = unloaded/unknown, boolean = confirmed by the server
let cachedAt = null; // ms epoch `cache` was confirmed, or null
let inflight = null;
let lastErrorAt = null; // ms epoch of the most recent probe failure, or null
const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Don't hammer a hard-down API: a probe failure blocks re-fetching for this
// long, though `cache` itself stays null (unknown) the whole time so every
// mount in that window still reports known:false rather than a stale true/false.
const RETRY_BACKOFF_MS = 15000;

// A confirmed answer is trusted for this long before the next mount (or the
// next retry()) has to revalidate it — long enough to spare a burst of
// mounts a fetch each, short enough that a flag flip during a deploy reaches
// an open tab well within the same shift, not "whenever it's next reloaded".
const CACHE_TTL_MS = 60000;

function cacheIsFresh() {
  return cache !== null && cachedAt !== null && Date.now() - cachedAt < CACHE_TTL_MS;
}

function snapshot() {
  return cacheIsFresh() ? { enabled: cache, known: true } : { enabled: false, known: false };
}

async function loadStacking() {
  if (cacheIsFresh()) return snapshot();
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
        cachedAt = Date.now();
        lastErrorAt = null;
        return snapshot();
      }
      const res = await fetch(`${API_BASE}/admin/discounts/stacking`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`stacking fetch failed: ${res.status}`);
      const data = await res.json();
      cache = data?.enabled === true;
      cachedAt = Date.now();
      lastErrorAt = null;
      return snapshot();
    } catch {
      // Fail closed for the moment (enabled: false) but do NOT cache the
      // failure — leave cache null so the next mount (after the backoff)
      // re-probes instead of being stuck on a guess for the whole session.
      cache = null;
      cachedAt = null;
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
    const sync = () => { loadStacking().then((value) => { if (alive) setState(value); }); };
    sync();
    // A TTL alone only helps surfaces that MOUNT after it expires: this
    // effect runs on mount (and on retry), so without a timer an already-open
    // tab keeps whatever it resolved first — which is precisely the reported
    // failure, a tab surviving a mid-session gate flip while every server
    // money endpoint reads the live value. Re-probe each TTL window, and
    // immediately when the tab is focused again, so a mounted surface tracks
    // the gate instead of a snapshot of it.
    const timer = setInterval(sync, CACHE_TTL_MS);
    const onVisible = () => { if (!document.hidden) sync(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
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

/**
 * Revalidate before POSTING money. The polling above narrows the window but
 * cannot close it: a gate flip between the last probe and this click would
 * still submit under the old semantics. Money surfaces await this and compare
 * `enabled` against the value their preview used — if it moved, the totals on
 * screen are not the totals the server will save, so the submission must stop
 * rather than silently bill the other regime.
 *
 * Returns { enabled, known } exactly like the hook's state.
 */
export async function ensureStackingFresh() {
  if (cacheIsFresh()) return snapshot();
  return loadStacking();
}

// Test seam: reset the session cache between cases.
export function __resetDiscountStackingCache() {
  cache = null;
  cachedAt = null;
  inflight = null;
  lastErrorAt = null;
}

export default useDiscountStacking;
