// Advisory slot-conflict hooks for the admin date/time pickers — the shared
// sibling of RainOutSheet's inline live target-check effect (same 300ms
// debounce, same abort-stale, same fail-open contract: any error just hides
// the hint). Backed by POST /admin/dispatch/slot-check, which is gated
// server-side (GATE_SLOT_CONFLICT_HINTS) — while the gate is off the
// endpoint answers gated:true and these hooks report no conflicts, so every
// picker renders exactly as today. Warn-only: consumers never disable a
// save button on this data.

import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function authHeaders() {
  return {
    Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
    'Content-Type': 'application/json',
  };
}

// The engine's own default span: a start with no end occupies 60 minutes.
function deriveEnd(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const total = Math.min(23 * 60 + 59, parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + 60);
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
  if (!res.ok || !data?.ok || data.gated || !Array.isArray(data.results)) return null;
  return data.results;
}

export function useSlotConflicts({ date, windowStart, windowEnd, excludeServiceIds, enabled = true }) {
  const [conflicts, setConflicts] = useState([]);
  const [checking, setChecking] = useState(false);
  // Stable dep for the (usually tiny) id array.
  const excludeKey = (excludeServiceIds || []).map(String).join(',');
  useEffect(() => {
    setConflicts([]);
    const end = windowEnd || deriveEnd(windowStart);
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
  }, [enabled, date, windowStart, windowEnd, excludeKey]);
  return { conflicts, checking };
}

// Bulk-move variant: N selected services landing on one new date, each
// keeping its own time window. One batched call, every selected id excluded
// (so intra-selection overlap isn't reported as noise), capped at the
// endpoint's 25-target limit — beyond that only the first 25 are checked
// and `truncated` lets the bar say so.
export function useBulkSlotConflicts({ date, services, enabled = true }) {
  const [result, setResult] = useState({ conflictCount: 0, checkedCount: 0, truncated: false });
  const [checking, setChecking] = useState(false);
  const key = (services || [])
    .map((s) => `${s.id}|${s.windowStart || ''}|${s.windowEnd || ''}`)
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
      .map((s) => ({ service: s, end: s.windowEnd || deriveEnd(s.windowStart) }))
      .filter(({ service, end }) => service.windowStart && end);
    const checked = checkable.slice(0, 25);
    if (!checked.length) {
      setChecking(false);
      return undefined;
    }
    const controller = new AbortController();
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const results = await fetchSlotCheck(checked.map(({ service, end }) => ({
          date,
          window: { start: service.windowStart, end },
          excludeServiceIds: allIds,
        })), controller.signal);
        if (!controller.signal.aborted && results) {
          setResult({
            conflictCount: results.filter((r) => r?.conflicts?.length > 0).length,
            checkedCount: checked.length,
            truncated: checkable.length > 25,
          });
        }
      } catch { /* advisory only */ }
      if (!controller.signal.aborted) setChecking(false);
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
    // `key` folds the services array's identity-relevant fields.
  }, [enabled, date, key]);
  return { ...result, checking };
}
