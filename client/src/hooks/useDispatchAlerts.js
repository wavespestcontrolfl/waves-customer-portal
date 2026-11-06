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
 * Recovery re-read: the server never replays a broadcast missed while the
 * socket was down (every deploy drops it), so the queue is read again on
 * socket connect, window focus, tab visible and browser online — the same
 * pattern as useDispatchBoard. Each re-read RECONCILES: a card the server no
 * longer lists is dropped, except one a broadcast added or changed after
 * that read began. The server returns at most the newest 50 open cards (the
 * default limit of GET /alerts), so the reconciled list matches a fresh
 * page load.
 *
 * Cleanup contract: same as useDispatchBoard — the useEffect that
 * wires the socket MUST return a function that calls socket.off for
 * dispatch:alert, dispatch:alert_resolved AND connect, AND
 * socket.disconnect(); the window / document listeners and the re-read
 * timer are cleared too. Missing any of those leaks on every navigation
 * away from the board.
 *
 * Auth: admin JWT from localStorage, same as useDispatchBoard. The
 * socket connection routes through the same socketAuth middleware
 * (PR #279/#284) and joins dispatch:admins automatically (admin sockets;
 * a technician socket stays out with GATE_TECH_LOGIN_PRIVACY on).
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
// Focus, visibilitychange, online and a socket connect usually arrive
// together: they collapse into one queue re-read.
export const RESYNC_DEBOUNCE_MS = 300;

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
export function mergeHydration(prev, fetched, resolvedIds = null, changedSinceRead = null) {
  const byId = new Map();
  // With a changedSinceRead predicate the read RECONCILES: only a local card
  // a broadcast added or changed after the read began (it cannot know about
  // it) survives; every other card comes from the fetched rows, so a card
  // closed elsewhere is dropped. Without it, every local card is kept.
  for (const a of prev) {
    if (!changedSinceRead || changedSinceRead(a.id)) byId.set(a.id, a);
  }
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
  // Reconcile bookkeeping. broadcastCountRef counts handled dispatch:alert
  // broadcasts; changedAtRef maps id -> the count at that card's latest one.
  // A read notes the count before its fetch: a card whose entry is higher was
  // added or changed after the read began. readSeqRef / appliedSeqRef order
  // the reads, so an older response never rolls back a newer one.
  const broadcastCountRef = useRef(0);
  const changedAtRef = useRef(new Map());
  const readSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  // Every way a card resolves — the socket broadcast, this tab's own PATCH,
  // resolve-all — records the tombstone (so a late dispatch:alert cannot
  // resurrect it, even if the socket packet was lost) and relays a tech-out
  // card change to the drawer, then drops the cards.
  const markResolved = useCallback((ids) => {
    const gone = new Set(ids);
    if (!gone.size) return;
    for (const id of gone) {
      resolvedIdsRef.current.add(id);
      changedAtRef.current.delete(id);
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

  // Read the open queue and reconcile it into state (the mount, a recovery
  // re-read, and again after a card decision). `isCancelled`: the caller's
  // unmount guard.
  const hydrate = useCallback(async (isCancelled = () => false) => {
    const seq = ++readSeqRef.current;
    const countAtStart = broadcastCountRef.current;
    const res = await fetch(
      `${API_BASE}/admin/dispatch/alerts?unresolved=true`,
      { headers: adminAuthHeaders() }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (isCancelled()) return;
    // A newer read already applied: this older one must not roll the list back.
    if (seq < appliedSeqRef.current) return;
    appliedSeqRef.current = seq;
    const fetched = Array.isArray(data.alerts) ? data.alerts : [];
    const changedSinceRead = (id) => (changedAtRef.current.get(id) || 0) > countAtStart;
    setAlerts((prev) => mergeHydration(prev, fetched, resolvedIdsRef.current, changedSinceRead));
    setError(null);
    setLoading(false);
  }, []);

  const loadAlerts = useCallback(async (isCancelled = () => false) => {
    if (isCancelled()) return;
    setLoading(true);
    setError(null);
    // hydrate takes its sequence number synchronously: this is its number.
    const mySeq = readSeqRef.current + 1;
    try {
      await hydrate(isCancelled);
      if (isCancelled()) return;
      setLoading(false);
    } catch (err) {
      if (isCancelled()) return;
      setLoading(false);
      // A newer read already loaded the list: its list stands, no error over it.
      if (appliedSeqRef.current > mySeq) return;
      setError(err.message || 'Failed to load alerts');
    }
  }, [hydrate]);
  const retryAlerts = useCallback(() => loadAlerts(), [loadAlerts]);

  // ---- initial hydration ----
  useEffect(() => {
    let cancelled = false;
    // Merge with current state instead of overwriting. The socket
    // subscription mounts concurrently with this fetch, so a
    // dispatch:alert broadcast can land while the GET is in flight.
    // Dedupe by id and preserve resolved tombstones via hydrate.
    loadAlerts(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadAlerts]);

  // ---- recovery re-read ----
  // Debounced, at most one re-read in flight; a signal that lands while one
  // runs queues exactly one more (it starts after the signal, so it cannot
  // predate it). Silent: no loading flash, and a failure keeps the list (the
  // next trigger retries).
  const resyncTimerRef = useRef(null);
  const resyncRunningRef = useRef(false);
  const resyncQueuedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);
      resyncTimerRef.current = null;
    };
  }, []);

  const runResync = useCallback(async () => {
    if (resyncRunningRef.current) {
      resyncQueuedRef.current = true;
      return;
    }
    resyncRunningRef.current = true;
    try {
      do {
        resyncQueuedRef.current = false;
        try {
          await hydrate(() => !mountedRef.current);
        } catch { /* keep the current list; the next trigger retries */ }
      } while (resyncQueuedRef.current && mountedRef.current);
    } finally {
      resyncRunningRef.current = false;
    }
  }, [hydrate]);

  const requestResync = useCallback(() => {
    if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);
    resyncTimerRef.current = setTimeout(() => {
      resyncTimerRef.current = null;
      if (mountedRef.current) runResync();
    }, RESYNC_DEBOUNCE_MS);
  }, [runResync]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    function onFocus() { requestResync(); }
    function onVisibility() {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') requestResync();
    }
    function onOnline() { requestResync(); }
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [requestResync]);

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
      broadcastCountRef.current += 1;
      changedAtRef.current.set(payload.id, broadcastCountRef.current);
      setAlerts((prev) => mergeAlertBroadcast(prev, payload, resolvedIdsRef.current));
      relayTechOutAlertChange(payload);
      // The broadcast is the bare row. A "Visit not closed out" card is told apart
      // by its customer, which only the queue read joins in: re-read for it.
      if (payload.type === 'visit_not_closed_out' && !payload.customer_first_name) hydrate().catch(() => {});
    }

    function handleResolved(payload) {
      if (!payload || !payload.id) return;
      // The PATCH caller already dropped it optimistically, so this is a
      // no-op for that session and the actual drop for everyone else.
      markResolved([payload.id]);
    }

    // The first connect counts: the mount read can finish before this
    // subscription is live, and a change in between is never delivered.
    function handleConnect() { requestResync(); }

    socket.on('dispatch:alert', handleAlert);
    socket.on('dispatch:alert_resolved', handleResolved);
    socket.on('connect', handleConnect);

    return () => {
      socket.off('dispatch:alert', handleAlert);
      socket.off('dispatch:alert_resolved', handleResolved);
      socket.off('connect', handleConnect);
      socket.disconnect();
    };
  }, [hydrate, markResolved, requestResync]);

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

  // The dispatcher's call on a "Visit not closed out" card: 'confirm_miss'
  // ("This was a miss"), 'dismiss' ("Not a miss") or 'done' (a confirmed miss
  // was dealt with). The server settles the
  // log row and closes this card (a confirmed miss comes back as a new card
  // over the socket); the card is dropped here on success either way.
  const decideNotClosedOut = useCallback(async (alert, action) => {
    const logId = alert?.payload?.log_id;
    const path = { confirm_miss: 'confirm-miss', dismiss: 'dismiss', done: 'done' }[action];
    if (!logId || !path) throw new Error('decideNotClosedOut: unknown card or action');
    const res = await fetch(
      `${API_BASE}/admin/dispatch/not-closed-out/${logId}/${path}`,
      { method: 'POST', headers: adminAuthHeaders(), body: '{}' }
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // already settled elsewhere: nothing left to decide, drop the card
      if (res.status === 404) { markResolved([alert.id]); return { ok: false }; }
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    markResolved([alert.id]);
    // A decision can put a NEW card up (a confirmed miss; the visit's other open
    // flagged row). It arrives over the socket; re-read the queue as well, so a
    // dropped socket cannot hide a card that still needs a person.
    try {
      await hydrate();
    } catch { /* the socket broadcast or the next mount still delivers it */ }
    return res.json();
  }, [markResolved, hydrate]);

  return {
    alerts,
    loading,
    error,
    retryAlerts,
    resolveAlert,
    clearAlerts,
    decideNotClosedOut,
  };
}
