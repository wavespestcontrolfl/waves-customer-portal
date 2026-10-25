// Availability hook for the admin date/time pickers — the drive-detour
// sibling of useSlotConflicts (same 300ms debounce, same abort-stale, same
// fail-open contract: any error just hides the strip). Backed by POST
// /admin/schedule/find-time with hint:true and summary:true, which is gated
// server-side (GATE_BEST_TIME_HINTS) — while that gate is off the endpoint
// answers gated:true and this hook reports nothing, so every picker renders
// without the strip. Warn-only: picking a chip only fills the date/time
// fields; consumers never disable a save button on this data.
//
// ONE search over the days around `date` (SUMMARY_BACK back, never before
// today, through SUMMARY_FORWARD forward) answers `availability` — every hour
// that fits on each of those days plus the picked hour's verdict with its
// reason. A date before today has no days around it to offer, so nothing is
// searched for it. Also answered:
//   pickedByTech — with `compareTechsAt` (an HH:MM, all-tech searches only):
//                 that hour on every technician's route that fits it, least
//                 added drive first (owner 2026-10-05).

import { useEffect, useMemo, useState } from 'react';
import { etDateString } from '../../lib/timezone';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function authHeaders() {
  return {
    Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
    'Content-Type': 'application/json',
  };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
// Availability strip window around the picked date (owner default 2026-10-02).
const SUMMARY_BACK = 3;
const SUMMARY_FORWARD = 7;
// The best-times week row: today and the six days after it.
const WEEK_DAYS = 7;
const HINTS_GATED_RETRY_MS = 10 * 60 * 1000;
// The kill switch (GATE_BEST_TIME_HINTS off answers `gated: true`): every
// search would come back empty, so none is sent for the same window.
let hintsGatedUntil = 0;
// Test seam: forget that the server gated the hint.
export function resetHintsGated() { hintsGatedUntil = 0; }

// What a search can stand on: a customer, a visit, or (addressOnly) a bare address.
function hasSearchSubject({ customerId, serviceId, addressOnly, address, lat, lng }) {
  return !!customerId || !!serviceId || (addressOnly && (!!address || (lat != null && lng != null)));
}

function addDays(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
      hours: (day.hours || []).map((h) => summaryHour({ ...h, date: day.date }, scopedToTech)),
    })),
    // The best-times rows (owner 2026-10-06): 4 hours on the picked date, 4
    // date + hours in the 7 days from today. Absent from an older server.
    best: data.summary.best ? {
      day: (data.summary.best.day || []).map((h) => summaryHour(h, scopedToTech)),
      week: (data.summary.best.week || []).map((h) => summaryHour(h, scopedToTech)),
      weekCovered: data.summary.best.week_covered !== false,
    } : null,
    picked: p ? {
      start: p.start,
      fits: p.fits === true ? true : (p.fits === false ? false : null),
      reason: p.reason || null,
      detourMinutes: p.detour_minutes ?? null,
      driveInMinutes: p.drive_in_minutes ?? null,
      fromHomeBase: p.from_home_base ?? null,
      fromName: p.from_name || null,
      driveSource: p.drive_source || null,
      rainChance: p.rain_chance ?? null,
    } : null,
  };
}

// One summary hour (a day's row or a best-times chip) in the strip's shape.
function summaryHour(h, scopedToTech) {
  return {
    date: h.date,
    start: h.start_time,
    end: h.end_time,
    detourMinutes: h.detour_minutes ?? null,
    driveInMinutes: h.drive_in_minutes ?? null,
    fromHomeBase: h.from_home_base ?? null,
    fromName: h.from_name || null,
    driveSource: h.drive_source || null,
    rainChance: h.rain_chance ?? null,
    stopsThatDay: h.stops_that_day ?? null,
    technicianId: h.technician?.id || null,
    technicianName: scopedToTech ? null : (h.technician?.name || null),
  };
}

// One row of the per-technician list for the compared hour.
export function normalizePickedByTech(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => r?.fits && r.technician?.id).map((r) => ({
    start: r.start,
    technicianId: r.technician.id,
    technicianName: r.technician.name || null,
    detourMinutes: r.detour_minutes ?? null,
    driveInMinutes: r.drive_in_minutes ?? null,
    fromHomeBase: r.from_home_base ?? null,
    fromName: r.from_name || null,
  }));
}

// The summary search: the days around `date` (SUMMARY_BACK back, never
// before today, through SUMMARY_FORWARD forward). With `bestRows` (New
// Appointment) the server also answers the best-times rows; when that window
// does not start today, the "best in the next 7 days" row gets its own
// search from today (Codex #6045 r1/r2). Fail-open: no week row, never a
// false one.
// `rainArgs` carries the booking's services on every best-rows request, the
// week fallback included, so the server's rain ranking
// (GATE_BOOKING_RAIN_RANK) classifies each one (Codex #6102 r1).
async function searchSummary(search, { date, today, pickedArgs, bestRows, rainArgs = {} }) {
  const back = addDays(date, -SUMMARY_BACK);
  const data = await search({
    summary: true,
    bestRows: bestRows || undefined,
    dateFrom: back < today ? today : back,
    dateTo: addDays(date, SUMMARY_FORWARD),
    topN: 3,
    pickedDate: date,
    ...rainArgs,
    ...pickedArgs,
  });
  if (data?.summary?.best?.week_covered !== false) return data;
  const week = await search({
    summary: true, bestRows: true, dateFrom: today, dateTo: addDays(today, WEEK_DAYS - 1), topN: 3, pickedDate: date,
    ...rainArgs,
  }).catch(() => null);
  const weekRow = week?.summary?.best;
  if (!weekRow || weekRow.week_covered === false) return data;
  return { ...data, summary: { ...data.summary, best: { ...data.summary.best, week: weekRow.week || [], week_covered: true } } };
}

// The request fields every find-time hint search shares; `undefined` drops
// a field from the JSON.
function hintRequestBody({
  arrivalWindows, moveScope, serviceId, propertyId, customerId, address, lat, lng,
  durationMinutes, durationEdit, technicianId, excludeKey, sameDayFloorMin,
}) {
  return {
    hint: true,
    arrivalWindows,
    moveScope: moveScope || undefined,
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
  };
}

// `address` / `lat` / `lng` pin the search to a specific service address (the
// create modal's property picker); the server prefers coords, then geocodes
// the address, and only falls back to the customer's primary when both are
// absent — exactly the resolveFindTimeTarget order.
export function useBestTimes({
  date, serviceId, customerId, durationMinutes, technicianId, excludeServiceIds,
  arrivalWindows = false, enabled = true, address, lat, lng, propertyId,
  pickedStart, pickedEnd, sameDayFloorMin, durationEdit = false, compareTechsAt, serviceTypes, serviceKeys,
  // The two best-times rows (New Appointment, Quick Move, Edit and the
  // reschedule dialogs): asked for only by a consumer that shows them (the
  // server skips the rain and road-time work otherwise).
  bestRows = false,
  // Edit appointment's choice on a shared stop ('together' | 'separate'):
  // the route check answers for the move the save will make.
  moveScope,
  // The Dispatch "Find a time" panel (a new caller, no record yet): a search
  // may stand on `address` / `lat` / `lng` alone, with no customer or visit.
  addressOnly = false,
}) {
  const [pickedByTech, setPickedByTech] = useState([]);
  // The last summary answer, with the request it answered: { data, requestKey, subjectKey }.
  const [answer, setAnswer] = useState(null);
  const setAvailability = (data, keys) => setAnswer(data ? { data, ...keys } : null);
  const [checking, setChecking] = useState(false);
  // The server declined to answer (hints are off), as opposed to a search
  // that failed or found nothing.
  const [gated, setGated] = useState(false);
  // Stable dep for the (usually tiny) id array.
  const excludeKey = (excludeServiceIds || []).map(String).join(',');
  // Only a complete value is worth scoring; a half-typed field would 400
  // and (fail-open) blank the whole strip. Stored windows arrive as
  // PostgreSQL time values ('09:00:00') on the edit form's initial state —
  // trim to HH:MM so the current hour is scored before the operator touches
  // the field.
  const pickedKey = /^\d{2}:\d{2}(:\d{2})?$/.test(String(pickedStart || '')) ? String(pickedStart).slice(0, 5) : '';
  // The edit form's window end travels with the start so the picked hour
  // is scored over the whole window, like the live conflict check.
  const pickedEndKey = /^\d{2}:\d{2}(:\d{2})?$/.test(String(pickedEnd || '')) ? String(pickedEnd).slice(0, 5) : '';
  // The hour to price on every route: all-tech searches with no single
  // picked hour of their own.
  // The booking's services, so the compared list leaves out a tech who
  // cannot perform one of them.
  const serviceTypesKey = (serviceTypes || []).filter(Boolean).map(String).join('\n');
  // Catalog key of each service, parallel to serviceTypes ('' when a line has
  // none): the rain ranking reads the selected row's identity, not its name.
  const serviceKeysKey = (serviceKeys || []).map((k) => String(k || '')).join('\n');
  const compareKey = !technicianId && !pickedKey && /^\d{2}:\d{2}(:\d{2})?$/.test(String(compareTechsAt || ''))
    ? String(compareTechsAt).slice(0, 5) : '';

  // Who a summary is for, and exactly which request it answered. A re-check
  // for the SAME visit/customer and place keeps the previous days on screen,
  // marked stale, so the strip (and the route warning it replaces) does not
  // blink off and on with every pick. Staleness is derived in RENDER from
  // these keys, not set in the effect: the first paint after an input
  // changes must already treat the old answer as stale (Codex #5746 r1).
  const subjectKey = [serviceId, customerId, propertyId, address, lat, lng].map((v) => v ?? '').join('|');
  const requestKey = [
    enabled, date, serviceId, customerId, durationMinutes, durationEdit, technicianId, excludeKey, arrivalWindows,
    address, lat, lng, propertyId, pickedKey, pickedEndKey, sameDayFloorMin, moveScope, compareKey, serviceTypesKey, serviceKeysKey, bestRows, addressOnly,
  ].map((v) => v ?? '').join('|');
  const availability = useMemo(() => {
    if (!answer || !enabled) return null;
    if (answer.requestKey === requestKey) return answer.data;
    return answer.subjectKey === subjectKey ? { ...answer.data, stale: true } : null;
  }, [answer, enabled, requestKey, subjectKey]);
  useEffect(() => {
    setPickedByTech([]);
    const hasSubject = hasSearchSubject({ customerId, serviceId, addressOnly, address, lat, lng });
    const hintsGated = () => Date.now() < hintsGatedUntil;
    // A summary starts today at the earliest (the engine never searches
    // before today), so a past date has no days around it to offer.
    if (!enabled || !hasSubject || !YMD.test(String(date || '')) || date < etDateString() || hintsGated()) {
      setAvailability(null);
      setChecking(false);
      setGated(enabled && hasSubject && hintsGated());
      return undefined;
    }
    const controller = new AbortController();
    const pickedArgs = compareKey
      ? { pickedStart: compareKey, compareTechs: true, serviceTypes: serviceTypesKey ? serviceTypesKey.split('\n') : undefined }
      : { pickedStart: pickedKey || undefined, pickedEnd: (pickedKey && pickedEndKey) || undefined };
    setChecking(true);
    const timer = setTimeout(async () => {
      const search = async (extra) => {
        const res = await fetch(`${API_BASE}/admin/schedule/find-time`, {
          method: 'POST',
          headers: authHeaders(),
          signal: controller.signal,
          body: JSON.stringify({
            ...hintRequestBody({
              arrivalWindows, moveScope, serviceId, propertyId, customerId, address, lat, lng,
              durationMinutes, durationEdit, technicianId, excludeKey, sameDayFloorMin,
            }),
            ...extra,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!controller.signal.aborted && res.ok && data?.gated) hintsGatedUntil = Date.now() + HINTS_GATED_RETRY_MS;
        if (controller.signal.aborted || !res.ok || data?.gated || !Array.isArray(data?.slots)) return null;
        return data;
      };
      try {
        const scopedToTech = !!technicianId;
        const today = etDateString();
        const rainArgs = bestRows && serviceTypesKey ? {
          serviceTypes: serviceTypesKey.split('\n'),
          serviceKeys: serviceKeysKey.split('\n').some(Boolean) ? serviceKeysKey.split('\n') : undefined,
        } : {};
        const data = await searchSummary(search, { date, today, pickedArgs, bestRows, rainArgs });
        if (controller.signal.aborted) return;
        const summarized = normalizeAvailability(data, { date, scopedToTech });
        if (summarized) setPickedByTech(normalizePickedByTech(data?.pickedByTech));
        // A search that failed or answered with no summary clears the strip:
        // a held (stale) answer must not outlive it.
        setAvailability(summarized, { requestKey, subjectKey });
        setGated(hintsGated());
      } catch {
        // Advisory only — a failed search just shows no strip (and drops a
        // held summary, unless a newer pick already owns the state).
        if (!controller.signal.aborted) setAvailability(null);
      }
      if (!controller.signal.aborted) setChecking(false);
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, date, serviceId, customerId, durationMinutes, durationEdit, technicianId, excludeKey, arrivalWindows, address, lat, lng, propertyId, pickedKey, pickedEndKey, sameDayFloorMin, moveScope, compareKey, serviceTypesKey, serviceKeysKey, bestRows, addressOnly]);
  return { pickedByTech, availability, checking, gated };
}
