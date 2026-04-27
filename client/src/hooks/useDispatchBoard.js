/**
 * useDispatchBoard — single owner of dispatch board data + socket
 * subscription. Hydrates from GET /api/admin/dispatch/board on mount,
 * then subscribes to:
 *   - dispatch:tech_status → patches techs map (status/lat/lng/job)
 *   - dispatch:job_update  → patches jobs array (status/tech/window)
 *
 * Internal state for techs is a Map keyed by tech.id so updates are
 * O(1) and don't recreate the array. The exposed `techs` value is a
 * fresh array derived from the Map on each broadcast, so React.memo
 * on <TechCard> can rely on per-tech reference identity (only the
 * tech that actually changed gets a new object).
 *
 * Jobs is an array (DispatchMap iterates over it for pin rendering).
 * On dispatch:job_update we replace the matching slot in place; the
 * map re-renders only the affected pin because Marker keys on
 * job.id and the per-pin color recomputes from the new tech_id.
 *
 * dispatch:job_update merge rules:
 *   - Match by id; if the job isn't in today's board, skip (the
 *     broadcast carries no address / lat / lng — we can't materialize
 *     a renderable pin from it, and the row likely isn't for today).
 *   - Update fields the broadcast carries: technician_id, status,
 *     service_type, scheduled_date, window_start, window_end.
 *   - Preserve fields the broadcast does NOT carry: customer_name,
 *     address, lat, lng. Those don't change with a status flip or
 *     reassignment.
 *
 * Cleanup contract: the useEffect that wires the socket MUST return
 * a function that calls socket.off for BOTH events AND
 * socket.disconnect(). Forgetting either causes a memory leak on
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
  const [selectedJobId, setSelectedJobId] = useState(null);
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

    function handleJobUpdate(payload) {
      if (!payload || !payload.job_id) return;
      // Skip jobs not in today's board. The broadcast doesn't carry
      // the geocoded address (`address` / `lat` / `lng` / `customer_name`)
      // that the board needs to render a pin, so we can't synthesize a
      // valid stub from it. Worst case: a job created mid-session
      // doesn't appear until the next /board fetch on remount.
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === payload.job_id);
        if (idx === -1) return prev;
        const next = prev.slice();
        next[idx] = {
          ...prev[idx],
          // Fields the broadcast can change. tech_id is stored as
          // technician_id on the board row to match the /board shape.
          technician_id: payload.tech_id || null,
          status: payload.status,
          service_type: payload.service_type ?? prev[idx].service_type,
          scheduled_date: payload.scheduled_date ?? prev[idx].scheduled_date,
          window_start: payload.window_start ?? prev[idx].window_start,
          window_end: payload.window_end ?? prev[idx].window_end,
          // Preserve the rest: customer_name, address, lat, lng,
          // customer_id. The broadcast doesn't carry them; they don't
          // change on a status/assign flip.
        };
        return next;
      });
    }

    socket.on('dispatch:job_update', handleJobUpdate);

    // Cleanup: remove BOTH handlers AND disconnect. Any one missing leaks.
    return () => {
      socket.off('dispatch:tech_status', handleTechStatus);
      socket.off('dispatch:job_update', handleJobUpdate);
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
    selectedJobId,
    setSelectedJobId,
    loading,
    error,
  };
}
