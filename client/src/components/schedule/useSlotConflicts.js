// Advisory slot-conflict hooks for the admin date/time pickers — the shared
// sibling of RainOutSheet's inline live target-check effect (same 300ms
// debounce, same abort-stale, same fail-open contract: any error just hides
// the hint). Backed by POST /admin/dispatch/slot-check, always on (the
// former GATE_SLOT_CONFLICT_HINTS gate was removed 2026-08-27). Warn-only:
// consumers never disable a save button on this data.

import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function authHeaders() {
  return {
    Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
    'Content-Type': 'application/json',
  };
}

// The engine's null-end derivation: start + the visit's own
// estimated_duration_minutes, falling back to 60 only when there's none —
// mirroring occupancy.js's COALESCE(NULLIF(estimated_duration_minutes,0), 60).
function deriveEnd(hhmm, durationMinutes) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const dur = Number(durationMinutes) > 0 ? Number(durationMinutes) : 60;
  const total = Math.min(23 * 60 + 59, parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + dur);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function fetchSlotCheck(targets, signal) {
  const res = await fetch(`${API_BASE}/admin/dispatch/slot-check`, {
    method: 'POST',
    headers: authHeaders(),
    signal,
    body: JSON.stringify({ targets }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok || !Array.isArray(data.results)) return null;
  return data.results;
}

export function useSlotConflicts({ date, windowStart, windowEnd, durationMinutes, excludeServiceIds, enabled = true }) {
  const [conflicts, setConflicts] = useState([]);
  const [checking, setChecking] = useState(false);
  // Stable dep for the (usually tiny) id array.
  const excludeKey = (excludeServiceIds || []).map(String).join(',');
  useEffect(() => {
    setConflicts([]);
    const end = windowEnd || deriveEnd(windowStart, durationMinutes);
    if (!enabled || !date || !windowStart || !end) {
      setChecking(false);
      return undefined;
    }
    const controller = new AbortController();
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const results = await fetchSlotCheck([{
          date,
          window: { start: windowStart, end },
          excludeServiceIds: excludeKey ? excludeKey.split(',') : [],
        }], controller.signal);
        if (!controller.signal.aborted && results) {
          setConflicts(Array.isArray(results[0]?.conflicts) ? results[0].conflicts : []);
        }
      } catch { /* advisory only — a failed check just shows no hint */ }
      if (!controller.signal.aborted) setChecking(false);
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, date, windowStart, windowEnd, durationMinutes, excludeKey]);
  return { conflicts, checking };
}

// Half-open minutes since midnight, matching the engine's overlap predicate.
function hhmmToMin(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

// Bulk-move variant: N selected services landing on one new date, each
// keeping its own time window (`durationMinutes` per service drives the
// null-end derivation, matching occupancy). Two conflict sources, unioned per visit:
// the batched server check against everything ALREADY on the landing date
// (every selected id excluded — their stored rows are the ones moving), and
// a client-side pairwise pass among the selected windows themselves, since
// landing visits from different source dates onto one date can create
// overlaps no existing row shows. The server call is capped at the
// endpoint's 25-target limit — beyond that only the first 25 are
// server-checked (`truncated` lets the bar say so); the pairwise pass
// covers ALL checkable selections either way.
export function useBulkSlotConflicts({ date, services, enabled = true }) {
  const [result, setResult] = useState({ conflictCount: 0, checkedCount: 0, truncated: false });
  const [checking, setChecking] = useState(false);
  const key = (services || [])
    .map((s) => `${s.id}|${s.windowStart || ''}|${s.windowEnd || ''}|${s.durationMinutes || ''}`)
    .join(';');
  useEffect(() => {
    setResult({ conflictCount: 0, checkedCount: 0, truncated: false });
    if (!enabled || !date || !services?.length) {
      setChecking(false);
      return undefined;
    }
    const allIds = services.map((s) => String(s.id));
    // Windowless (anytime) visits can't be checked — drop them BEFORE the
    // 25-target cap so they never crowd out timed visits behind them, and
    // so `truncated` reflects checkable visits only.
    const checkable = services
      .map((s) => ({ service: s, end: s.windowEnd || deriveEnd(s.windowStart, s.durationMinutes) }))
      .filter(({ service, end }) => service.windowStart && end);
    const checked = checkable.slice(0, 25);
    if (!checked.length) {
      setChecking(false);
      return undefined;
    }
    // Pairwise overlap among the selected windows on the landing date —
    // half-open, same predicate as the server (touching windows don't clash).
    const spans = checkable.map(({ service, end }) => ({
      start: hhmmToMin(service.windowStart), end: hhmmToMin(end),
    }));
    const intraFlags = spans.map((a, i) => spans.some((b, j) => (
      j !== i && a.start != null && a.end != null && b.start != null && b.end != null
        && a.start < b.end && a.end > b.start
    )));
    // Union per visit: server conflict OR intra-selection overlap — but only
    // when the server check actually answered. A null result means gated or
    // failed, and the kill switch must win: reporting the client-side
    // pairwise pass alone would keep hints alive with the gate off.
    const finish = (serverResults) => {
      if (!serverResults) return;
      const serverFlagged = new Set(serverResults
        .map((r, i) => (r?.conflicts?.length > 0 ? i : -1))
        .filter((i) => i >= 0));
      setResult({
        conflictCount: intraFlags.filter((intra, i) => intra || serverFlagged.has(i)).length,
        checkedCount: checked.length,
        truncated: checkable.length > 25,
      });
    };
    const controller = new AbortController();
    setChecking(true);
    const timer = setTimeout(async () => {
      let results = null;
      try {
        results = await fetchSlotCheck(checked.map(({ service, end }) => ({
          date,
          window: { start: service.windowStart, end },
          excludeServiceIds: allIds,
        })), controller.signal);
      } catch { /* advisory only */ }
      if (!controller.signal.aborted) {
        finish(results);
        setChecking(false);
      }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
    // `key` folds the services array's identity-relevant fields.
  }, [enabled, date, key]);
  return { ...result, checking };
}
