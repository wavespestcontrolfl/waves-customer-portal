import { TECH_ROUTE_SNAPSHOT_KEY } from '../../lib/adminAuth';

// Last-good route snapshot for the technician home page.
//
// The service worker never caches /api/ responses (client/public/sw.js), so
// a tech who reopens the app in a dead zone gets the cached shell and then a
// red "route could not be loaded" banner. This module keeps the most recent
// successful /api/admin/schedule payload in localStorage so that page can
// still show the route it last saw — clearly labelled as saved, never as
// live.
//
// Scope rules:
//   - One snapshot per device, keyed by technician id + ET date. A snapshot
//     from another login or another day is never restored: yesterday's
//     route must not render as today's, and a second tech on the same phone
//     must not see the first tech's stops.
//   - Read-only fallback. Nothing here replays writes; en-route / on-site
//     taps still need signal and keep their own inline errors.
//   - Deleted when the staff session ends (lib/adminAuth clearStaffDeviceData,
//     called by every logout / 401 / forced-reset path), and swept here the
//     moment a different login or a different day finds it.
export const ROUTE_SNAPSHOT_KEY = TECH_ROUTE_SNAPSHOT_KEY;
// A hung request in a dead zone can take a minute to fail. Give up sooner so
// the saved route appears while the tech still has the phone in hand.
export const ROUTE_FETCH_TIMEOUT_MS = 15000;

export function saveRouteSnapshot({ techId, date, data }, storage = defaultStorage()) {
  if (!storage || !techId || !date) return;
  try {
    storage.setItem(ROUTE_SNAPSHOT_KEY, JSON.stringify({ techId: String(techId), date, savedAt: new Date().toISOString(), data }));
  } catch { /* quota or private mode — the live path is unaffected */ }
}

export function loadRouteSnapshot({ techId, date }, storage = defaultStorage()) {
  if (!storage || !techId || !date) return null;
  try {
    const raw = storage.getItem(ROUTE_SNAPSHOT_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    const usable = snapshot?.techId === String(techId) && snapshot?.date === date
      && typeof snapshot.savedAt === 'string' && !!snapshot.data && typeof snapshot.data === 'object';
    // Another login's, another day's or a corrupt copy is never restored —
    // and never left sitting on the device either.
    if (!usable) { storage.removeItem(ROUTE_SNAPSHOT_KEY); return null; }
    return snapshot;
  } catch {
    try { storage.removeItem(ROUTE_SNAPSHOT_KEY); } catch { /* ignore */ }
    return null;
  }
}

export function clearRouteSnapshot(storage = defaultStorage()) {
  try { storage?.removeItem(ROUTE_SNAPSHOT_KEY); } catch { /* ignore */ }
}

// "7:42 AM" in Eastern time — the tech reads this against the clock on the
// same phone, so the saved time must be in the route's own timezone.
export function formatSnapshotTime(savedAt) {
  const when = new Date(savedAt);
  if (Number.isNaN(when.getTime())) return '';
  return when.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
}

export function savedRouteNotice(savedAt) {
  const time = formatSnapshotTime(savedAt);
  return `No connection — showing your route as saved${time ? ` at ${time}` : ''}. Changes since then are not shown.`;
}

function defaultStorage() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
