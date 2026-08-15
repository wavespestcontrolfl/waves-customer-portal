// Advisory "Best times this day" hook for the admin date/time pickers — the
// drive-detour sibling of useSlotConflicts (same 300ms debounce, same
// abort-stale, same fail-open contract: any error just hides the hint).
// Backed by POST /admin/schedule/find-time with hint:true, which is gated
// server-side (GATE_BEST_TIME_HINTS) — while the gate is off the endpoint
// answers gated:true and this hook reports no times, so every picker
// renders exactly as today. Warn-only: picking a chip only fills the time
// fields; consumers never disable a save button on this data.

import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function authHeaders() {
  return {
    Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
    'Content-Type': 'application/json',
  };
}

export function useBestTimes({ date, serviceId, customerId, durationMinutes, technicianId, excludeServiceIds, enabled = true }) {
  const [bestTimes, setBestTimes] = useState([]);
  const [checking, setChecking] = useState(false);
  // Stable dep for the (usually tiny) id array.
  const excludeKey = (excludeServiceIds || []).map(String).join(',');
  useEffect(() => {
    setBestTimes([]);
    if (!enabled || (!customerId && !serviceId) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
      setChecking(false);
      return undefined;
    }
    const controller = new AbortController();
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/schedule/find-time`, {
          method: 'POST',
          headers: authHeaders(),
          signal: controller.signal,
          body: JSON.stringify({
            hint: true,
            // Existing-visit surfaces pass serviceId so the server ranks at
            // the VISIT's stamped address (secondary/rental properties),
            // not the customer's primary home.
            serviceId: serviceId || undefined,
            customerId,
            dateFrom: date,
            dateTo: date,
            durationMinutes,
            technicianId: technicianId || undefined,
            excludeServiceIds: excludeKey ? excludeKey.split(',') : undefined,
            // Appointment windows always start on the hour (owner directive),
            // so hint chips snap to it too.
            slotStepMinutes: 60,
            topN: 3,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!controller.signal.aborted && res.ok && !data?.gated && Array.isArray(data?.slots)) {
          // Unscoped searches rank technician/time PAIRS, so two techs can
          // surface the same hour — keep only the best-ranked slot per
          // start (the engine sorts ascending) and carry whose route the
          // detour belongs to so the chip can say so. Scoped searches have
          // one tech; no name needed.
          const seen = new Set();
          const deduped = data.slots.filter((s) => {
            if (seen.has(s.start_time)) return false;
            seen.add(s.start_time);
            return true;
          });
          setBestTimes(deduped.map((s) => ({
            start: s.start_time,
            end: s.end_time,
            detourMinutes: s.detour_minutes,
            stopsThatDay: s.stops_that_day,
            // Id always travels — a consumer that can assign (create modal
            // auto mode) must adopt the tech the detour was scored for.
            technicianId: s.technician?.id || null,
            technicianName: technicianId ? null : (s.technician?.name || null),
          })));
        }
      } catch { /* advisory only — a failed search just shows no hint */ }
      if (!controller.signal.aborted) setChecking(false);
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, date, serviceId, customerId, durationMinutes, technicianId, excludeKey]);
  return { bestTimes, checking };
}
