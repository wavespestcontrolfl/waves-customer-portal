/**
 * useDispatchBoard — single owner of dispatch board data + socket
 * subscription. Hydrates from GET /api/admin/dispatch/board on mount,
 * then subscribes to dispatch:tech_status broadcasts and patches the
 * tech list in place.
 *
 * Internal state for techs is a Map keyed by tech.id so updates are
 * O(1) and don't recreate the array. The exposed `techs` value is a
 * fresh array derived from the Map on each broadcast, so React.memo
 * on <TechCard> can rely on per-tech reference identity (only the
 * tech that actually changed gets a new object).
 *
 * Cleanup contract: the useEffect that wires the socket MUST return
 * a function that calls socket.off('dispatch:tech_status', handler)
 * AND socket.disconnect(). Forgetting either causes a memory leak on
 * every navigation away from the dispatch board, plus potential
 * duplicate broadcasts if the board is re-mounted while the prior
 * socket is still alive. Verify on every edit.
 *
 * Auth: connects with the admin JWT from localStorage (waves_admin_token),
 * matching the existing adminFetch pattern across the admin app.
 * Server-side socketAuth (PR #279 + #284) verifies the token, runs
 * the staff freshness check, and joins the `dispatch:admins` room
 * automatically — we don't call socket.join() from the client.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminAuthHeaders() {
  const token = localStorage.getItem('waves_admin_token');
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

// Derive the socket origin from API_BASE. Three cases:
//   - API_BASE is a relative path (e.g. '/api') → undefined → io()
//     defaults to same-origin, which works in production where the
//     SPA and the API are served from one host. In local Vite dev,
//     vite.config.js proxies /socket.io with ws:true so this also
//     works without a different VITE_API_URL.
//   - API_BASE is a full URL (e.g. 'https://api.example.com/api') →
//     return the origin ('https://api.example.com') so the socket
//     handshake hits the same backend the HTTP fetches do, not the
//     SPA's own origin (Codex P2 on PR #296).
//   - Anything unparseable → fall back to undefined (same-origin).
function socketOrigin() {
  if (!API_BASE || API_BASE.startsWith('/')) return undefined;
  try {
    return new URL(API_BASE).origin;
  } catch {
    return undefined;
  }
}

export function useDispatchBoard() {
  const [techsMap, setTechsMap] = useState(() => new Map());
  const [jobs, setJobs] = useState([]);
  const [selectedTechId, setSelectedTechId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Track the latest techsMap in a ref so the socket handler closure
  // always sees current state without re-subscribing on every render.
  const techsMapRef = useRef(techsMap);
  techsMapRef.current = techsMap;

  // ---- initial hydration ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/dispatch/board`, {
          headers: adminAuthHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const next = new Map();
        for (const t of data.techs || []) next.set(t.id, t);
        setTechsMap(next);
        setJobs(data.jobs || []);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err.message || 'Failed to load dispatch board');
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
      ? io(origin, {
          auth: { token },
          transports: ['websocket', 'polling'],
          reconnection: true,
        })
      : io({
          // Same-origin (production + Vite dev with /socket.io proxy).
          // Server-side socketAuth verifies the token and joins
          // dispatch:admins on success.
          auth: { token },
          transports: ['websocket', 'polling'],
          reconnection: true,
        });

    function handleTechStatus(payload) {
      if (!payload || !payload.tech_id) return;
      // Patch in place via a fresh Map (React notices via reference
      // change). The tech object itself is replaced so React.memo on
      // the matching <TechCard> sees a new prop reference.
      setTechsMap((prev) => {
        const existing = prev.get(payload.tech_id);
        if (!existing) {
          // First broadcast for a tech we didn't see at hydration
          // (e.g. tech started a shift after page load). Add a stub
          // row; the next /board fetch on remount will fill in name /
          // avatar / today_total.
          const next = new Map(prev);
          next.set(payload.tech_id, {
            id: payload.tech_id,
            name: '(unknown)',
            avatar_url: null,
            role: 'technician',
            status: payload.status,
            lat: payload.lat == null ? null : Number(payload.lat),
            lng: payload.lng == null ? null : Number(payload.lng),
            current_job_id: payload.current_job_id || null,
            updated_at: payload.updated_at,
            today_total: 0,
            today_completed: 0,
          });
          return next;
        }
        const next = new Map(prev);
        next.set(payload.tech_id, {
          ...existing,
          status: payload.status,
          lat: payload.lat == null ? null : Number(payload.lat),
          lng: payload.lng == null ? null : Number(payload.lng),
          current_job_id: payload.current_job_id || null,
          updated_at: payload.updated_at,
        });
        return next;
      });
    }

    socket.on('dispatch:tech_status', handleTechStatus);

    // Cleanup: remove handler AND disconnect. Either alone leaks.
    return () => {
      socket.off('dispatch:tech_status', handleTechStatus);
      socket.disconnect();
    };
  }, []);

  // Derived: stable array snapshot for consumers. Sorted by name to
  // match the API endpoint's ORDER BY so the roster doesn't reshuffle
  // when a single tech updates.
  const techs = useMemo(() => {
    return Array.from(techsMap.values()).sort((a, b) =>
      (a.name || '').localeCompare(b.name || '')
    );
  }, [techsMap]);

  // Jobs lookup by ID, used by <TechCard> for current_job_id → address.
  const jobsById = useMemo(() => {
    const m = new Map();
    for (const j of jobs) m.set(j.id, j);
    return m;
  }, [jobs]);

  return {
    techs,
    jobs,
    jobsById,
    selectedTechId,
    setSelectedTechId,
    loading,
    error,
  };
}
