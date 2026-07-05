/**
 * Client-side GrowthBook instance (experimentation initiative, Phase 2).
 *
 * DARK BY DEFAULT: `growthbook` is null unless the build has
 * VITE_GROWTHBOOK_CLIENT_KEY set (same convention as VITE_TURNSTILE_SITE_KEY —
 * unset in local dev/preview → everything renders exactly as before). The key
 * is an SDK Connection *Client Key* (sdk-…), safe to embed in the public
 * bundle; it can only READ plaintext feature definitions.
 *
 * Unit: an anonymous visitor id persisted in localStorage, hashed on the same
 * `id` attribute the server-side experiments use. Exposures POST to
 * /api/public/experiments/exposure so they land in the experiment_exposures
 * warehouse table (unit_type 'anon') — GrowthBook analyzes from Postgres, not
 * an event store. Server-owned experiments (estimate-view,
 * booking-abandon-recovery) are evaluated server-side only; that endpoint
 * refuses their keys.
 */
import { GrowthBook } from '@growthbook/growthbook-react';

const CLIENT_KEY = import.meta.env.VITE_GROWTHBOOK_CLIENT_KEY || '';
const API_HOST = import.meta.env.VITE_GROWTHBOOK_API_HOST || 'https://cdn.growthbook.io';
const API_BASE = import.meta.env.VITE_API_URL || '/api';

const UID_STORAGE_KEY = 'waves_exp_uid';

function anonId() {
  // Private-mode / blocked storage must never break the app: fall back to a
  // session-lifetime id (a fresh unit per load is acceptable, storage loss is
  // rare and first-exposure-wins dedups server-side).
  let uid = null;
  try { uid = window.localStorage.getItem(UID_STORAGE_KEY); } catch { /* blocked */ }
  if (uid && /^[A-Za-z0-9-]{8,64}$/.test(uid)) return uid;
  uid = (window.crypto && typeof window.crypto.randomUUID === 'function')
    ? window.crypto.randomUUID()
    : `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  try { window.localStorage.setItem(UID_STORAGE_KEY, uid); } catch { /* blocked */ }
  return uid;
}

function reportExposure(experiment, result) {
  if (!result || !result.inExperiment) return;
  try {
    // Fire-and-forget; keepalive so a navigation right after assignment
    // doesn't drop the exposure. Failures are silent — losing an exposure
    // beat breaking the page.
    fetch(`${API_BASE}/public/experiments/exposure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        experimentKey: experiment && experiment.key,
        variationId: result.variationId,
        variationKey: result.key || null,
        unitId: anonId(),
        value: result.value,
      }),
    }).catch(() => {});
  } catch { /* never throw into render */ }
}

function createGrowthBook() {
  if (!CLIENT_KEY) return null;
  try {
    const gb = new GrowthBook({
      apiHost: API_HOST,
      clientKey: CLIENT_KEY,
      attributes: { id: anonId() },
      trackingCallback: reportExposure,
    });
    // Background feature load — the app never waits on it; until features
    // arrive every flag evaluates to its safe fallback.
    gb.init({ timeout: 3000 }).catch(() => {});
    return gb;
  } catch {
    return null;
  }
}

// Singleton for the app lifetime; null → GrowthBookProvider still renders
// children normally and all feature hooks return their fallbacks.
export const growthbook = createGrowthBook();
