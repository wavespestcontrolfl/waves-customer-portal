/**
 * useDispatchAlerts — single owner of action queue state for the
 * dispatch board's right pane. Hydrates from
 * GET /api/admin/dispatch/alerts?unresolved=true on mount, then
 * subscribes to:
 *   - dispatch:alert          → prepend new alerts (dedupe by id)
 *   - dispatch:alert_resolved → drop alerts by id
 *
 * The open broadcast carries the BARE dispatch_alerts row (no joined
 * tech_name / customer / address) — see services/dispatch-alerts.js.
 * The hook prepends those bare rows; the AlertCard component
 * degrades gracefully when enriched fields are missing (e.g. shows
 * tech_id when tech_name is unset). The next /board mount cycle
 * naturally re-hydrates with enriched data.
 *
 * The resolved broadcast carries `{id, resolved_at, resolved_by}`
 * only — receivers just need to drop the id from local state. The
 * PATCH caller also drops the row optimistically on success, so its
 * own broadcast arrival becomes a no-op via the same id filter.
 *
 * Cleanup contract: same as useDispatchBoard — the useEffect that
 * wires the socket MUST return a function that calls socket.off for
 * BOTH dispatch:alert and dispatch:alert_resolved AND
 * socket.disconnect(). Missing any of those leaks on every navigation
 * away from the board.
 *
 * Auth: admin JWT from localStorage, same as useDispatchBoard. The
 * socket connection routes through the same socketAuth middleware
 * (PR #279/#284) and joins dispatch:admins automatically.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminAuthHeaders() {
  const token = localStorage.getItem('waves_admin_token');
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

// Same socketOrigin helper shape as useDispatchBoard. If API_BASE is
// a relative path, return undefined → io() defaults to same-origin
// (works in production + Vite dev with the /socket.io ws proxy). If
// API_BASE is a full URL, return its origin so the socket handshake
// hits the same backend the HTTP fetches do.
function socketOrigin() {
  if (!API_BASE || API_BASE.startsWith('/')) return undefined;
  try {
    return new URL(API_BASE).origin;
  } catch {
    return undefined;
  }
}

// Same-timestamp tie-break (one tech-out batch): lower bump_order first;
// rows without one keep their relative order.
// Window event the tech-out drawer listens to: an overflow card for
// detail.tech_id appeared, changed, or resolved (any dispatcher).
export const TECH_OUT_ALERTS_EVENT = 'waves:tech-out-alerts-changed';
const TECH_OUT_ALERT_TYPE = 'tech_out_overflow';

function relayTechOutAlertChange(alert) {
  if (!alert || alert.type !== TECH_OUT_ALERT_TYPE) return;
  try { window.dispatchEvent(new CustomEvent(TECH_OUT_ALERTS_EVENT, { detail: { tech_id: alert.tech_id } })); } catch { /* non-DOM env */ }
}

// dispatch:alert for an unknown id prepends a new card; for a card already on
// screen it is an update, merged over the existing card so hydrated join
// fields (customer / tech names) survive.
// Initial GET merged with live rows. The fetched row supplies enriched
// fields (tech_name, customer, address); a live row that arrived while the
// GET was in flight is newer and its own fields win; a card that resolved
// meanwhile is not resurrected. Newest first; a tech-out batch shares one
// created_at (one transaction), so its cards fall back to bump_order.
export function mergeHydration(prev, fetched, resolvedIds = null) {
  const byId = new Map();
  for (const a of prev) byId.set(a.id, a);
  for (const a of fetched) {
    if (resolvedIds && resolvedIds.has(a.id)) continue;
    const live = byId.get(a.id);
    byId.set(a.id, live ? { ...a, ...live } : a);
  }
  return Array.from(byId.values()).sort(
    (a, b) => (new Date(b.created_at) - new Date(a.created_at)) || bumpOrderTieBreak(a, b)
  );
}

// A broadcast for an id this board already saw resolve (or a row that is
// itself resolved) is stale — e.g. an auto-move annotation delivered after a
// concurrent dispatcher resolve — and must never resurrect a phantom card.
export function mergeAlertBroadcast(prev, payload, resolvedIds = null) {
  if (payload.resolved_at || (resolvedIds && resolvedIds.has(payload.id))) return prev;
  if (!prev.some((a) => a.id === payload.id)) return [payload, ...prev];
  return prev.map((a) => (a.id === payload.id ? { ...a, ...payload } : a));
}

export function bumpOrderTieBreak(a, b) {
  const ao = Number(a?.payload?.bump_order);
  const bo = Number(b?.payload?.bump_order);
  if (Number.isFinite(ao) && Number.isFinite(bo)) return ao - bo;
  if (Number.isFinite(ao)) return -1;
  if (Number.isFinite(bo)) return 1;
  return 0;
}

export function useDispatchAlerts() {
  const [alerts, setAlerts] = useState([]);
  // Mirror for socket handlers (type / tech_id of a card being resolved —
  // the resolved broadcast carries only the id) and the ids seen resolving.
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  const resolvedIdsRef = useRef(new Set());

  // Every way a card resolves — the socket broadcast, this tab's own PATCH,
  // resolve-all — records the tombstone (so a late dispatch:alert cannot
  // resurrect it, even if the socket packet was lost) and relays a tech-out
  // card change to the drawer, then drops the cards.
  const markResolved = useCallback((ids) => {
    const gone = new Set(ids);
    if (!gone.size) return;
    for (const id of gone) {
      resolvedIdsRef.current.add(id);
      const known = alertsRef.current.find((a) => a.id === id);
      // A card this board never saw (resolved before hydration landed) could
      // be anyone's tech-out card: relay it as tech_id null so an open drawer
      // re-reads its count rather than keep a stale one.
      if (known) relayTechOutAlertChange(known);
      else relayTechOutAlertChange({ type: TECH_OUT_ALERT_TYPE, tech_id: null });
    }
    setAlerts((prev) => prev.filter((a) => !gone.has(a.id)));
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ---- initial hydration ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/admin/dispatch/alerts?unresolved=true`,
          { headers: adminAuthHeaders() }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const fetched = Array.isArray(data.alerts) ? data.alerts : [];
        // Merge with current state instead of overwriting. The socket
        // subscription mounts concurrently with this fetch, so a
        // dispatch:alert broadcast can land while the GET is in
        // flight. If we just setAlerts(fetched), that broadcast's
        // row gets dropped — the GET response was generated from an
        // earlier DB snapshot. Codex P1 on PR #306.
        //
        // Dedupe by id — see mergeHydration (live fields win over the
        // enriched snapshot; resolved cards stay gone).
        setAlerts((prev) => mergeHydration(prev, fetched, resolvedIdsRef.current));
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err.message || 'Failed to load alerts');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- socket subscription ----
  useEffect(() => {
    const token = localStorage.getItem('waves_admin_token');
    if (!token) return undefined;

    const origin = socketOrigin();
    const socket = origin
      ? io(origin, { auth: { token }, transports: ['websocket', 'polling'], reconnection: true })
      : io({ auth: { token }, transports: ['websocket', 'polling'], reconnection: true });

    function handleAlert(payload) {
      if (!payload || !payload.id) return;
      // Prepend new alert to the top of the list. A broadcast for a card
      // already on screen is an UPDATE (e.g. tech-out auto-assign stamping
      // payload.auto_attempt): merge it over the existing card so hydrated
      // join fields (customer/tech names) survive — which also dedupes a
      // hydration response racing the create broadcast for the same row.
      if (payload.resolved_at || resolvedIdsRef.current.has(payload.id)) return;
      setAlerts((prev) => mergeAlertBroadcast(prev, payload, resolvedIdsRef.current));
      relayTechOutAlertChange(payload);
    }

    function handleResolved(payload) {
      if (!payload || !payload.id) return;
      // The PATCH caller already dropped it optimistically, so this is a
      // no-op for that session and the actual drop for everyone else.
      markResolved([payload.id]);
    }

    socket.on('dispatch:alert', handleAlert);
    socket.on('dispatch:alert_resolved', handleResolved);

    return () => {
      socket.off('dispatch:alert', handleAlert);
      socket.off('dispatch:alert_resolved', handleResolved);
      socket.disconnect();
    };
  }, []);

  // ---- resolve action ----
  // Optimistic removal: drop the row locally on success and let the
  // server's dispatch:alert_resolved broadcast confirm (which becomes
  // a no-op for this session via the same id filter). Other connected
  // dispatchers learn from the broadcast.
  //
  // On HTTP failure, throw so the caller can re-enable its button —
  // the hook does NOT roll back optimistic state because there's no
  // optimistic state until success.
  const resolveAlert = useCallback(async (id) => {
    if (!id) throw new Error('resolveAlert: id is required');
    const res = await fetch(
      `${API_BASE}/admin/dispatch/alerts/${id}/resolve`,
      { method: 'PATCH', headers: adminAuthHeaders() }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    markResolved([id]);
    return res.json();
  }, [markResolved]);

  const clearAlerts = useCallback(async () => {
    const res = await fetch(
      `${API_BASE}/admin/dispatch/alerts/resolve-all`,
      { method: 'POST', headers: adminAuthHeaders() }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    markResolved(Array.isArray(data.alert_ids) ? data.alert_ids : []);
    return data;
  }, [markResolved]);

  return { alerts, loading, error, resolveAlert, clearAlerts };
}
