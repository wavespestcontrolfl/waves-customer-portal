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
 *   - Match by id; if the job isn't in today's board but the broadcast
 *     carries board_visible + address/coords, add it as a new same-day
 *     pin. Otherwise skip it.
 *   - Update fields the broadcast carries: technician_id, status,
 *     service_type, scheduled_date, window_start, window_end.
 *   - Preserve fields the broadcast does NOT carry. Assignment/status
 *     broadcasts may be narrow; create/edit broadcasts carry richer
 *     board fields.
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
 *
 * refreshTechs(): a stable callback (exposed to consumers) that re-runs
 * GET /board and merges the fresh tech rows into techsMap by id — used
 * after a tech-out mark-out/clear mutation so out_today and the roster's
 * derived status reflect the server immediately, without waiting on a
 * broadcast. It also replaces jobs[] from the same response (Codex r3 P1
 * on #4678): the server broadcasts dispatch:job_update per moved stop, but
 * this tab's own board must not depend on a socket round-trip to show the
 * stops under their new technician.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const DISPATCH_LOCATION_FRESH_MS = 24 * 60 * 60 * 1000;
const BOARD_HIDDEN_STATUSES = new Set(['cancelled', 'rescheduled']);

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

function hasFreshDispatchLocation(payload) {
  if (payload?.lat == null || payload?.lng == null || !payload?.location_updated_at) return false;
  const updatedMs = new Date(payload.location_updated_at).getTime();
  return Number.isFinite(updatedMs) && Date.now() - updatedMs <= DISPATCH_LOCATION_FRESH_MS;
}

function boardJobFromPayload(payload) {
  if (!payload?.job_id || !payload.board_visible) return null;
  const hasBoardFields = (
    'address' in payload ||
    'customer_name' in payload ||
    'lat' in payload ||
    'lng' in payload
  );
  if (!hasBoardFields) return null;
  return {
    id: payload.job_id,
    technician_id: payload.tech_id || null,
    customer_id: payload.customer_id || null,
    customer_name: payload.customer_name || payload.cust_first_name || 'Customer',
    address: payload.address || '',
    lat: payload.lat == null ? null : Number(payload.lat),
    lng: payload.lng == null ? null : Number(payload.lng),
    status: payload.status,
    service_type: payload.service_type || null,
    scheduled_date: payload.scheduled_date || null,
    window_start: payload.window_start || null,
    window_end: payload.window_end || null,
  };
}

// Window event the board hook re-emits for every dispatch:tech_absence
// broadcast, so components with their own state for one technician (the
// TechDrawer's TechOutSection) can refetch without prop threading. detail =
// the broadcast payload ({ tech_id, date, out, absence_id }).
export const TECH_ABSENCE_EVENT = 'waves:tech-absence-changed';
// Minimum gap between roster re-reads triggered by pings from a tech the
// roster does not carry (see handleTechStatus).
export const UNKNOWN_TECH_REFETCH_MS = 60_000;

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

  // ---- socket-update appliers (shared by the live handlers and the
  // post-refresh replay below) ----
  const applyTechStatus = useCallback((payload) => {
    if (!payload || !payload.tech_id) return;
    // Patch in place via a fresh Map (React notices via reference
    // change). The tech object itself is replaced so React.memo on
    // the matching <TechCard> sees a new prop reference.
    setTechsMap((prev) => {
      const existing = prev.get(payload.tech_id);
      // A tech the roster does not carry is never synthesized from this
      // stream: it has no out_today (Codex r7 P2 on #4678), so the live
      // handler re-reads /board instead (handleTechStatus below).
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(payload.tech_id, {
        ...existing,
        status: payload.status,
        lat: payload.lat == null ? null : Number(payload.lat),
        lng: payload.lng == null ? null : Number(payload.lng),
        current_job_id: payload.current_job_id || null,
        eta_minutes: payload.eta_minutes ?? null,
        updated_at: payload.updated_at,
        location_updated_at: payload.location_updated_at || existing.location_updated_at || null,
      });
      return next;
    });
  }, []);

  const applyJobUpdate = useCallback((payload) => {
    if (!payload || !payload.job_id) return;
    if (BOARD_HIDDEN_STATUSES.has(payload.status) || payload.board_visible === false) {
      setJobs((prev) => prev.filter((j) => j.id !== payload.job_id));
      return;
    }
    setJobs((prev) => {
      const idx = prev.findIndex((j) => j.id === payload.job_id);
      if (idx === -1) {
        const created = boardJobFromPayload(payload);
        return created ? [...prev, created] : prev;
      }
      const next = prev.slice();
      // Property-presence merge for nullable fields. `??` would drop
      // an explicit `null` from the broadcast (e.g., a window
      // intentionally cleared to "anytime") and keep the stale
      // value — the in-check distinguishes "field absent" from
      // "field present and null." Codex P2 on PR #322. The
      // broadcast emitters in services/job-status.js and the
      // assign route always include these keys, so the in-check is
      // mostly a forward-compat guard, but it's the correct
      // semantic.
      function pick(field) {
        return field in payload ? payload[field] : prev[idx][field];
      }
      next[idx] = {
        ...prev[idx],
        // tech_id (broadcast) → technician_id (board row shape).
        // Always present in the broadcast; coerce undefined-as-null
        // for safety even though it shouldn't happen.
        technician_id: 'tech_id' in payload ? (payload.tech_id || null) : prev[idx].technician_id,
        status: pick('status'),
        service_type: pick('service_type'),
        scheduled_date: pick('scheduled_date'),
        window_start: pick('window_start'),
        window_end: pick('window_end'),
        customer_name: pick('customer_name'),
        address: pick('address'),
        lat: pick('lat'),
        lng: pick('lng'),
        customer_id: pick('customer_id'),
      };
      return next;
    });
  }, []);

  // ---- on-demand tech refresh (see header comment) ----
  //
  // Two races the pre-push auditor named on #4678, both real once a
  // refresh can be triggered by a broadcast from another tab:
  // (1) overlapping refreshes (mark-out, then "tech is back") can settle
  //     in reverse order, so an older response would re-mark the tech
  //     Out after the clear — each refresh takes a sequence number and
  //     only the LATEST one started may apply its response;
  // (2) a refresh replaces techs/jobs wholesale, so a tech_status or
  //     job_update that arrived while the request was pending (and may
  //     post-date the server's read) would be clobbered — those payloads
  //     are buffered while the LATEST refresh is pending and replayed
  //     after its response applies. They are ALSO applied live, so the
  //     board never lags; the replay is idempotent (merge by id).
  // The buffer belongs to the latest refresh only: a new refresh starts
  // it empty (events before its request are already in its server read)
  // and only the latest one's settle drains it. A superseded refresh
  // neither buffers nor drains, so nothing is left behind for a later
  // refresh to replay over a newer snapshot.
  const refreshSeqRef = useRef(0);
  const latestRefreshPendingRef = useRef(false);
  const pendingSocketRef = useRef([]);

  const replayPendingSocket = useCallback(() => {
    const pending = pendingSocketRef.current;
    pendingSocketRef.current = [];
    for (const { type, payload } of pending) {
      if (type === 'tech_status') applyTechStatus(payload);
      else if (type === 'job_update') applyJobUpdate(payload);
    }
  }, [applyTechStatus, applyJobUpdate]);

  // ONE sequenced loader for both the initial hydration and every later
  // refresh (pre-push auditor P1 on #4678, round 4): the initial fetch is
  // just refresh #1, so a broadcast-triggered refresh that starts during
  // hydration supersedes it — an older initial response settling last
  // cannot roll back the fresher roster — and socket events that arrive
  // mid-hydration are buffered and replayed exactly like any other.
  // Whether the board has ever applied a successful read — a property of
  // the BOARD, not of any one request: a refresh that supersedes a still-
  // pending hydration and then fails must settle loading/error itself, or
  // the board stays "loading" forever (auditor P1, round 5).
  const hydratedRef = useRef(false);
  const unknownTechRefetchAtRef = useRef(new Map());

  const loadBoard = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    latestRefreshPendingRef.current = true;
    pendingSocketRef.current = [];
    try {
      const res = await fetch(`${API_BASE}/admin/dispatch/board`, {
        headers: adminAuthHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // A newer load started while this one was pending: its response is
      // the fresher server reading, so this one applies nothing.
      if (seq !== refreshSeqRef.current) return;
      // The response is the whole roster (the endpoint already excludes
      // inactive, office-only and location-stale techs), so a tech it
      // omits is gone from the board too — never retained from an earlier
      // read (Codex r5 P2 on #4678). Socket events buffered meanwhile are
      // replayed on top by the finally block.
      setTechsMap(new Map((data.techs || []).map((t) => [t.id, t])));
      setJobs(data.jobs || []);
      hydratedRef.current = true;
      setError(null);
      setLoading(false);
    } catch (err) {
      // `error` is reserved for the board never having loaded: whichever
      // request is the LATEST when the board is still unhydrated owns
      // that outcome, whether it was the initial fetch or a refresh that
      // superseded it. A failed refresh on a hydrated board just leaves
      // the roster as it was; the next broadcast or manual reopen catches
      // it up, and a later success clears any earlier error.
      if (!hydratedRef.current && seq === refreshSeqRef.current) {
        setError(err.message || 'Failed to load dispatch board');
        setLoading(false);
      }
    } finally {
      // Only the latest load stops the buffering and drains it (success
      // or failure): an older one returning last must not replay over a
      // newer read, and must not leave buffering armed.
      if (seq === refreshSeqRef.current) {
        latestRefreshPendingRef.current = false;
        replayPendingSocket();
      }
    }
  }, [replayPendingSocket]);

  const refreshTechs = loadBoard;

  // ---- initial hydration (load #1 of the sequence above) ----
  useEffect(() => {
    loadBoard();
  }, [loadBoard]);

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

    // Buffer while a refresh is pending (see refreshTechs) AND apply
    // live — the replay after the refresh re-applies the same payload.
    function handleTechStatus(payload) {
      if (!payload || !payload.tech_id) return;
      // First broadcast for a tech the board did not load (started a shift
      // after page load, or was omitted as location-stale): the stream
      // carries no out_today, so the roster is re-read from the server
      // rather than a stub row advertising a drop target the server would
      // refuse. Only a fresh location warrants it — a stale ping for an
      // unknown tech is ignored exactly as before.
      if (!techsMapRef.current.has(payload.tech_id)) {
        // Once per tech per UNKNOWN_TECH_REFETCH_MS: a tech the endpoint
        // deliberately excludes (office-only, inactive) keeps pinging with a
        // fresh location and would otherwise refetch /board on every ping
        // (pre-push auditor P1 on #4678). Their first ping re-reads; if the
        // roster still omits them, later pings wait out the window.
        if (!hasFreshDispatchLocation(payload)) return;
        const now = Date.now();
        const last = unknownTechRefetchAtRef.current.get(payload.tech_id) || 0;
        if (now - last < UNKNOWN_TECH_REFETCH_MS) return;
        unknownTechRefetchAtRef.current.set(payload.tech_id, now);
        refreshTechs();
        return;
      }
      if (latestRefreshPendingRef.current) pendingSocketRef.current.push({ type: 'tech_status', payload });
      applyTechStatus(payload);
    }

    socket.on('dispatch:tech_status', handleTechStatus);

    function handleJobUpdate(payload) {
      if (latestRefreshPendingRef.current) pendingSocketRef.current.push({ type: 'job_update', payload });
      applyJobUpdate(payload);
    }

    socket.on('dispatch:job_update', handleJobUpdate);

    // A mark-out / "tech is back" committed in ANY tab (server/services/
    // tech-out.js emits after commit). out_today is derived from
    // technician_absences and rides neither tech_status nor job_update,
    // so re-read the roster from the server rather than patching a flag
    // this tab can't compute — refreshTechs is the same path the
    // mutating tab already takes.
    function handleTechAbsence(payload) {
      if (!payload || !payload.tech_id) return;
      refreshTechs();
      // Relay to the open drawer (TechOutSection) — see TECH_ABSENCE_EVENT.
      try { window.dispatchEvent(new CustomEvent(TECH_ABSENCE_EVENT, { detail: payload })); } catch { /* non-DOM env */ }
    }

    socket.on('dispatch:tech_absence', handleTechAbsence);

    // Cleanup: remove ALL handlers AND disconnect. Any one missing leaks.
    return () => {
      socket.off('dispatch:tech_status', handleTechStatus);
      socket.off('dispatch:job_update', handleJobUpdate);
      socket.off('dispatch:tech_absence', handleTechAbsence);
      socket.disconnect();
    };
  }, [refreshTechs, applyTechStatus, applyJobUpdate]);

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
    refreshTechs,
  };
}
