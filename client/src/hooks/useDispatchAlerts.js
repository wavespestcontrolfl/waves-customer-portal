/**
 * useDispatchAlerts — single owner of action queue state for the
 * dispatch board's right pane. Hydrates from
 * GET /api/admin/dispatch/alerts?unresolved=true on mount, then
 * subscribes to dispatch:alert broadcasts and prepends new alerts
 * in place.
 *
 * The broadcast carries the BARE dispatch_alerts row (no joined
 * tech_name / customer / address) — see services/dispatch-alerts.js.
 * The hook prepends those bare rows; the AlertCard component
 * degrades gracefully when enriched fields are missing (e.g. shows
 * tech_id when tech_name is unset). The next /board mount cycle
 * naturally re-hydrates with enriched data.
 *
 * Cleanup contract: same as useDispatchBoard — the useEffect that
 * wires the socket MUST return a function that calls
 * socket.off('dispatch:alert', handler) AND socket.disconnect().
 * Either alone leaks on every navigation away from the board.
 *
 * Auth: admin JWT from localStorage, same as useDispatchBoard. The
 * socket connection routes through the same socketAuth middleware
 * (PR #279/#284) and joins dispatch:admins automatically.
 */
import { useEffect, useState } from 'react';
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

export function useDispatchAlerts() {
  const [alerts, setAlerts] = useState([]);
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
        // Dedupe by id. Hydration row wins on conflict because it
        // carries enriched fields (tech_name, customer, address) that
        // the bare broadcast row doesn't have. Live rows whose ids
        // aren't in the hydration response are preserved as-is.
        setAlerts((prev) => {
          const byId = new Map();
          for (const a of prev) byId.set(a.id, a);
          for (const a of fetched) byId.set(a.id, a);
          return Array.from(byId.values()).sort(
            (a, b) => new Date(b.created_at) - new Date(a.created_at)
          );
        });
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
      // Prepend new alert to the top of the list. Dedupe by id in
      // case a hydration response and a broadcast race for the same
      // row.
      setAlerts((prev) => {
        if (prev.some((a) => a.id === payload.id)) return prev;
        return [payload, ...prev];
      });
    }

    socket.on('dispatch:alert', handleAlert);

    return () => {
      socket.off('dispatch:alert', handleAlert);
      socket.disconnect();
    };
  }, []);

  return { alerts, loading, error };
}
