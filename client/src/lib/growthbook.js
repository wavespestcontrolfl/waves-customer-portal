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

// Page-lifetime fallback when persistence is blocked (private mode): the
// SAME id must serve both the GrowthBook attributes hash (set at
// construction) and every later reportExposure() call — regenerating per
// call would record exposures under a different unit than was assigned.
let memoryUid = null;

function anonId() {
  let uid = null;
  try { uid = window.localStorage.getItem(UID_STORAGE_KEY); } catch { /* blocked */ }
  if (uid && /^[A-Za-z0-9-]{8,64}$/.test(uid)) return uid;
  if (memoryUid) return memoryUid;
  uid = (window.crypto && typeof window.crypto.randomUUID === 'function')
    ? window.crypto.randomUUID()
    : `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  try { window.localStorage.setItem(UID_STORAGE_KEY, uid); } catch { /* blocked */ }
  memoryUid = uid;
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
    // MASTER GATE: GATE_GROWTHBOOK off must roll back CLIENT experiments too,
    // not just the exposure endpoint — otherwise unsetting the documented
    // kill switch would leave client variants live (and unlogged). Features
    // are only fetched after the server confirms the program is on; until
    // then (and on any failure) every flag evaluates to its safe fallback —
    // fails CLOSED, matching the dark-by-default posture.
    fetch(`${API_BASE}/public/experiments/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((status) => {
        if (status && status.enabled === true) {
          // Background feature load — the app never waits on it.
          gb.init({ timeout: 3000 }).catch(() => {});
        }
      })
      .catch(() => {});
    return gb;
  } catch {
    return null;
  }
}

// Singleton for the app lifetime; null (no key / construction failure) →
// App.jsx skips the GrowthBookProvider entirely, since GrowthBook React
// requires a real instance — passing undefined can crash the SPA.
export const growthbook = createGrowthBook();
