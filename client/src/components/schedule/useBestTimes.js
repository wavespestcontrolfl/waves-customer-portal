// Advisory best-times hook for the admin date/time pickers — the
// drive-detour sibling of useSlotConflicts (same 300ms debounce, same
// abort-stale, same fail-open contract: any error just hides the hint).
// Backed by POST /admin/schedule/find-time with hint:true, which is gated
// server-side (GATE_BEST_TIME_HINTS) — while the gate is off the endpoint
// answers gated:true and this hook reports nothing, so every picker
// renders exactly as today. Warn-only: picking a chip only fills the
// date/time fields; consumers never disable a save button on this data.
//
// Three answers, two searches (owner spec 2026-09-07):
//   picked      — what the hour already in the picker costs on `date`: the
//                 drive INTO the stop from the previous anchor (home base
//                 for the first stop) and what it adds to the route.
//   bestTimes   — the cheapest hours on `date` (first = best that day).
//   bestInRange — the single cheapest date+hour from `rangeFrom` through
//                 RANGE_DAYS days out (the engine's sooner-day preference
//                 applies). Only searched when the consumer passes rangeFrom.

import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function authHeaders() {
  return {
    Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
    'Content-Type': 'application/json',
  };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
// The hint's third line says "next 3 days" — keep the two in step.
const RANGE_DAYS = 3;

function addDays(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mapSlot(s, scopedToTech) {
  return {
    date: s.date,
    start: s.start_time,
    end: s.end_time,
    detourMinutes: s.detour_minutes,
    // Arrival-window slots score the whole route and carry no single
    // insertion leg — driveIn stays null and the label shows the detour only.
    driveInMinutes: s.drive_in_minutes ?? null,
    fromHomeBase: s.insertion ? !s.insertion.after_stop_id : null,
    fromName: s.insertion?.after_name || null,
    stopsThatDay: s.stops_that_day,
    estimatedArrival: s.estimated_arrival || null,
    arrivalWindows: s.route_mode === 'arrival_windows',
    // Id always travels — a consumer that can assign (create modal
    // auto mode) must adopt the tech the detour was scored for.
    technicianId: s.technician?.id || null,
    technicianName: scopedToTech ? null : (s.technician?.name || null),
  };
}

// `address` / `lat` / `lng` pin the search to a specific service address (the
// create modal's property picker); the server prefers coords, then geocodes
// the address, and only falls back to the customer's primary when both are
// absent — exactly the resolveFindTimeTarget order.
export function useBestTimes({
  date, serviceId, customerId, durationMinutes, technicianId, excludeServiceIds,
  arrivalWindows = false, enabled = true, address, lat, lng,
  pickedStart, rangeFrom,
}) {
  const [bestTimes, setBestTimes] = useState([]);
  const [picked, setPicked] = useState(null);
  const [bestInRange, setBestInRange] = useState(null);
  const [checking, setChecking] = useState(false);
  // Stable dep for the (usually tiny) id array.
  const excludeKey = (excludeServiceIds || []).map(String).join(',');
  // Only a complete on-the-hour value is worth scoring; a half-typed field
  // would 400 and (fail-open) blank the whole hint.
  const pickedKey = /^\d{2}:\d{2}$/.test(String(pickedStart || '')) ? String(pickedStart) : '';
  const rangeKey = YMD.test(String(rangeFrom || '')) ? String(rangeFrom) : '';
  useEffect(() => {
    setBestTimes([]);
    setPicked(null);
    setBestInRange(null);
    if (!enabled || (!customerId && !serviceId) || !YMD.test(String(date || ''))) {
      setChecking(false);
      return undefined;
    }
    const controller = new AbortController();
    setChecking(true);
    const timer = setTimeout(async () => {
      const search = async (extra) => {
        const res = await fetch(`${API_BASE}/admin/schedule/find-time`, {
          method: 'POST',
          headers: authHeaders(),
          signal: controller.signal,
          body: JSON.stringify({
            hint: true,
            arrivalWindows,
            // Existing-visit surfaces pass serviceId so the server ranks at
            // the VISIT's stamped address (secondary/rental properties),
            // not the customer's primary home.
            serviceId: serviceId || undefined,
            customerId,
            address: address || undefined,
            lat: lat ?? undefined,
            lng: lng ?? undefined,
            durationMinutes,
            technicianId: technicianId || undefined,
            excludeServiceIds: excludeKey ? excludeKey.split(',') : undefined,
            // Appointment windows always start on the hour (owner directive),
            // so hint chips snap to it too.
            slotStepMinutes: 60,
            ...extra,
          }),
        });
        const data = await res.json().catch(() => null);
        if (controller.signal.aborted || !res.ok || data?.gated || !Array.isArray(data?.slots)) return null;
        return data;
      };
      try {
        const [day, range] = await Promise.all([
          search({ dateFrom: date, dateTo: date, topN: 3, pickedStart: pickedKey || undefined }),
          rangeKey ? search({ dateFrom: rangeKey, dateTo: addDays(rangeKey, RANGE_DAYS), topN: 1 }) : Promise.resolve(null),
        ]);
        if (!controller.signal.aborted) {
          if (day) {
            // Unscoped searches rank technician/time PAIRS, so two techs can
            // surface the same hour — keep only the best-ranked slot per
            // start (the engine sorts ascending) and carry whose route the
            // detour belongs to so the chip can say so. Scoped searches have
            // one tech; no name needed.
            const seen = new Set();
            setBestTimes(day.slots
              .filter((s) => { if (seen.has(s.start_time)) return false; seen.add(s.start_time); return true; })
              .map((s) => mapSlot(s, !!technicianId)));
            if (day.picked) {
              setPicked({
                start: day.picked.start,
                fits: !!day.picked.fits,
                detourMinutes: day.picked.detour_minutes ?? null,
                driveInMinutes: day.picked.drive_in_minutes ?? null,
                fromHomeBase: day.picked.from_home_base ?? null,
                fromName: day.picked.from_name || null,
                technicianId: day.picked.technician?.id || null,
                technicianName: technicianId ? null : (day.picked.technician?.name || null),
              });
            }
          }
          if (range?.slots?.length) setBestInRange(mapSlot(range.slots[0], !!technicianId));
        }
      } catch { /* advisory only — a failed search just shows no hint */ }
      if (!controller.signal.aborted) setChecking(false);
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, date, serviceId, customerId, durationMinutes, technicianId, excludeKey, arrivalWindows, address, lat, lng, pickedKey, rangeKey]);
  return { bestTimes, picked, bestInRange, checking };
}
