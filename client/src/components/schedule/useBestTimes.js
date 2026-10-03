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
//
// Summary mode (`summary: true`, the availability strip): ONE search over
// the days around `date` (SUMMARY_BACK back, never before today, through
// SUMMARY_FORWARD forward) answers `availability` — every hour that fits on
// each of those days plus the picked hour's verdict with its reason — and
// the three-line answers above stay empty. The server only answers it
// behind GATE_RESCHEDULE_AVAILABILITY; a response with no `summary` (gate
// off, or a server that predates it) falls back to the two searches above
// and is not asked again for SUMMARY_RETRY_MS, so a dark gate costs one
// extra request per ten minutes, not one per keystroke.

import { useEffect, useRef, useState } from 'react';
import { etDateString } from '../../lib/timezone';

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
// Availability strip window around the picked date (owner default 2026-10-02).
const SUMMARY_BACK = 3;
const SUMMARY_FORWARD = 7;
const SUMMARY_RETRY_MS = 10 * 60 * 1000;
let summaryUnavailableUntil = 0;
// The parent kill switch (GATE_BEST_TIME_HINTS off answers `gated: true`):
// every search would come back empty, so none is sent for the same window.
let hintsGatedUntil = 0;
// Test seam: forget that the server declined a summary or gated the hint.
export function resetSummaryAvailability() { summaryUnavailableUntil = 0; hintsGatedUntil = 0; }

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

// The summary's rows, in the strip's own shape. `fits` on the verdict stays
// three-valued here: true, false (a verified miss) or null (could not be
// checked) — the strip must never read "unchecked" as a miss.
export function normalizeAvailability(data, { date, scopedToTech }) {
  const days = Array.isArray(data?.summary?.days) ? data.summary.days : null;
  if (!days) return null;
  const p = data.picked || null;
  return {
    pickedDate: date,
    days: days.map((day) => ({
      date: day.date,
      status: day.status || (day.hours?.length ? 'open' : 'full'),
      ...(day.closed === true ? { closed: true } : {}),
      hours: (day.hours || []).map((h) => ({
        date: day.date,
        start: h.start_time,
        end: h.end_time,
        detourMinutes: h.detour_minutes ?? null,
        technicianId: h.technician?.id || null,
        technicianName: scopedToTech ? null : (h.technician?.name || null),
      })),
    })),
    picked: p ? {
      start: p.start,
      fits: p.fits === true ? true : (p.fits === false ? false : null),
      reason: p.reason || null,
      detourMinutes: p.detour_minutes ?? null,
    } : null,
  };
}

function normalizePicked(p, scopedToTech) {
  if (!p) return null;
  return {
    start: p.start,
    fits: !!p.fits,
    detourMinutes: p.detour_minutes ?? null,
    driveInMinutes: p.drive_in_minutes ?? null,
    fromHomeBase: p.from_home_base ?? null,
    fromName: p.from_name || null,
    technicianId: p.technician?.id || null,
    technicianName: scopedToTech ? null : (p.technician?.name || null),
  };
}

// Unscoped searches rank technician/time PAIRS, so two techs can surface
// the same hour — keep only the best-ranked slot per start (the engine
// sorts ascending) and carry whose route the detour belongs to so the chip
// can say so. Scoped searches have one tech; no name needed.
function normalizeDay(day, scopedToTech) {
  if (!day) return { bestTimes: [], picked: null };
  const seen = new Set();
  const bestTimes = day.slots
    .filter((s) => { if (seen.has(s.start_time)) return false; seen.add(s.start_time); return true; })
    .map((s) => mapSlot(s, scopedToTech));
  return { bestTimes, picked: normalizePicked(day.picked, scopedToTech) };
}

// `address` / `lat` / `lng` pin the search to a specific service address (the
// create modal's property picker); the server prefers coords, then geocodes
// the address, and only falls back to the customer's primary when both are
// absent — exactly the resolveFindTimeTarget order.
export function useBestTimes({
  date, serviceId, customerId, durationMinutes, technicianId, excludeServiceIds,
  arrivalWindows = false, enabled = true, address, lat, lng, propertyId,
  pickedStart, pickedEnd, rangeFrom, sameDayFloorMin, durationEdit = false, summary = false,
}) {
  const [bestTimes, setBestTimes] = useState([]);
  const [picked, setPicked] = useState(null);
  const [bestInRange, setBestInRange] = useState(null);
  const [availability, setAvailability] = useState(null);
  const [checking, setChecking] = useState(false);
  // Stable dep for the (usually tiny) id array.
  const excludeKey = (excludeServiceIds || []).map(String).join(',');
  // Only a complete value is worth scoring; a half-typed field would 400
  // and (fail-open) blank the whole hint. Stored windows arrive as
  // PostgreSQL time values ('09:00:00') on the edit form's initial state —
  // trim to HH:MM so the current hour is scored before the operator touches
  // the field.
  const pickedKey = /^\d{2}:\d{2}(:\d{2})?$/.test(String(pickedStart || '')) ? String(pickedStart).slice(0, 5) : '';
  // The edit form's window end travels with the start so the picked hour
  // is scored over the whole window, like the live conflict check.
  const pickedEndKey = /^\d{2}:\d{2}(:\d{2})?$/.test(String(pickedEnd || '')) ? String(pickedEnd).slice(0, 5) : '';
  const rangeKey = YMD.test(String(rangeFrom || '')) ? String(rangeFrom) : '';
  // Who the last summary was for. A re-check for the SAME visit/customer and
  // place keeps the previous days on screen, marked stale, so the strip (and
  // the route warning it replaces) does not blink off and on with every pick.
  const subjectKey = [serviceId, customerId, propertyId, address, lat, lng].map((v) => v ?? '').join('|');
  const lastSubject = useRef(null);
  useEffect(() => {
    setBestTimes([]);
    setPicked(null);
    setBestInRange(null);
    if (!enabled || (!customerId && !serviceId) || !YMD.test(String(date || '')) || Date.now() < hintsGatedUntil) {
      setAvailability(null);
      setChecking(false);
      return undefined;
    }
    const summaryExpected = summary && date >= etDateString() && Date.now() >= summaryUnavailableUntil;
    const sameSubject = lastSubject.current === subjectKey;
    lastSubject.current = subjectKey;
    setAvailability((prev) => (prev && summaryExpected && sameSubject ? { ...prev, stale: true } : null));
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
            // The edit form's pending Service address selection — the
            // server scores at THAT property (what the save will stamp),
            // not the visit's stored address.
            propertyId: propertyId || undefined,
            customerId,
            address: address || undefined,
            lat: lat ?? undefined,
            lng: lng ?? undefined,
            durationMinutes,
            // Only the edit form saves `durationMinutes` as the visit's
            // estimate; a move keeps the stored one, so the arrival
            // simulation must not adopt the requested span there.
            durationEdit: durationEdit ? true : undefined,
            technicianId: technicianId || undefined,
            excludeServiceIds: excludeKey ? excludeKey.split(',') : undefined,
            // Appointment windows always start on the hour (owner directive),
            // so hint chips snap to it too.
            slotStepMinutes: 60,
            // A picker's own same-day floor (minutes from midnight) — the
            // server applies it while choosing, so a single-answer range
            // search is the best hour that clears it.
            sameDayFloorMin: Number.isInteger(sameDayFloorMin) ? sameDayFloorMin : undefined,
            ...extra,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!controller.signal.aborted && res.ok && data?.gated) hintsGatedUntil = Date.now() + SUMMARY_RETRY_MS;
        if (controller.signal.aborted || !res.ok || data?.gated || !Array.isArray(data?.slots)) return null;
        return data;
      };
      try {
        const scopedToTech = !!technicianId;
        const today = etDateString();
        // A past date has no days around it to offer (the engine never
        // searches before today) — the plain hint handles it as it always has.
        if (summary && date >= today && Date.now() >= summaryUnavailableUntil) {
          const back = addDays(date, -SUMMARY_BACK);
          const data = await search({
            summary: true,
            dateFrom: back < today ? today : back,
            dateTo: addDays(date, SUMMARY_FORWARD),
            topN: 3,
            pickedDate: date,
            pickedStart: pickedKey || undefined,
            pickedEnd: (pickedKey && pickedEndKey) || undefined,
          });
          if (controller.signal.aborted) return;
          const summarized = normalizeAvailability(data, { date, scopedToTech });
          if (summarized) {
            setAvailability(summarized);
            setChecking(false);
            return;
          }
          // Answered, but with no summary: the gate is off. A failed
          // request (null) says nothing about the gate — ask again next time.
          if (data) summaryUnavailableUntil = Date.now() + SUMMARY_RETRY_MS;
          // No summary this time: a held (stale) one must not outlive it.
          setAvailability(null);
          // Hints gated altogether: the fallbacks would be gated too.
          if (Date.now() < hintsGatedUntil) { setChecking(false); return; }
        }
        const [day, range] = await Promise.all([
          search({ dateFrom: date, dateTo: date, topN: 3, pickedStart: pickedKey || undefined, pickedEnd: (pickedKey && pickedEndKey) || undefined }),
          rangeKey ? search({ dateFrom: rangeKey, dateTo: addDays(rangeKey, RANGE_DAYS), topN: 1 }) : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return;
        const scoped = !!technicianId;
        const normalized = normalizeDay(day, scoped);
        setBestTimes(normalized.bestTimes);
        setPicked(normalized.picked);
        setBestInRange(range?.slots?.length ? mapSlot(range.slots[0], scoped) : null);
      } catch {
        // Advisory only — a failed search just shows no hint (and drops a
        // held summary, unless a newer pick already owns the state).
        if (!controller.signal.aborted) setAvailability(null);
      }
      if (!controller.signal.aborted) setChecking(false);
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, date, serviceId, customerId, durationMinutes, durationEdit, technicianId, excludeKey, arrivalWindows, address, lat, lng, propertyId, pickedKey, pickedEndKey, rangeKey, sameDayFloorMin, summary]);
  return { bestTimes, picked, bestInRange, availability, checking };
}
