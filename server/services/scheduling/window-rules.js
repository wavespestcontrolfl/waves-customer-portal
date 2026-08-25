/**
 * Admin appointment-window rules — the single validator every ADMIN write
 * path (schedule create / edit / bulk move / dispatch reschedule) runs a
 * window through before persisting it.
 *
 * Rules (owner rulings):
 *   - every appointment is a 60-minute slot that starts ON THE HOUR (HH:00)
 *     — same rule admin-leads' schedule-appointment route already enforces;
 *   - no client appointment before 08:00 ET;
 *   - end > start, end <= 20:00 — the admin dispatch grid's day end
 *     (TimeGridDay DAY_END_HOUR); the customer slot finder stops at 17:00
 *     but admins book evening visits the self-booking path never offers.
 *
 * Overlap (probeSlotOverlap) reuses the shared occupancy mechanism
 * (scheduling/occupancy.js — tech-blind findConflictingVisits under the
 * date-wide advisory lock) exactly as routes/booking.js createSelfBooking
 * does. It runs unconditionally: a hit is ADVISORY (owner ruling 2026-08-25
 * — staff-side saves never block on schedule conflicts), so the probe
 * returns the conflicts for the caller to surface via slotOverlapWarning
 * and never throws. (The former GATE_ADMIN_SLOT_OVERLAP_GUARD dark gate was
 * removed on PR #3486 once the probe stopped blocking.)
 */
const { findConflictingVisits, acquireOccupancyLock, acquireOccupancyLocks } = require('./occupancy');
const { DAY_START_HOUR } = require('./find-time');

// Admin day END is the dispatch grid's bound (TimeGridDay DAY_END_HOUR = 20),
// not the customer slot-finder's 17:00: operators legitimately book/move
// evening visits the self-booking path never offers. Start bound is shared.
const ADMIN_DAY_END_HOUR = 20;
const ADMIN_DAY_START_MINUTES = DAY_START_HOUR * 60;
const ADMIN_DAY_END_MINUTES = ADMIN_DAY_END_HOUR * 60;
const DEFAULT_DURATION_MINUTES = 60;

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.isOperational = true;
  return Object.assign(err, extra);
}

// Accepts H:MM / HH:MM / HH:MM:SS(.fff) (pg TIME) — anything else is null.
function parseHHMM(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

function minutesToHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function invalidWindow(message) {
  return httpError(422, message, { code: 'INVALID_APPOINTMENT_WINDOW' });
}

/**
 * @returns {{ window_start: 'HH:MM', window_end: 'HH:MM' }} normalized window
 * @throws 422 INVALID_APPOINTMENT_WINDOW
 */
function assertAdminAppointmentWindow({ windowStart, windowEnd, durationMinutes } = {}) {
  const startMin = parseHHMM(windowStart);
  if (startMin == null) {
    throw invalidWindow(`Appointment start must be a 24h HH:MM time — got "${String(windowStart ?? '')}" (use e.g. "08:00")`);
  }
  if (startMin % 60 !== 0) {
    throw invalidWindow(`Appointment windows start on the hour — got "${minutesToHHMM(startMin)}"; use "${minutesToHHMM(startMin - (startMin % 60))}"`);
  }
  if (startMin < ADMIN_DAY_START_MINUTES) {
    throw invalidWindow(`No client appointments before ${minutesToHHMM(ADMIN_DAY_START_MINUTES)} — got "${minutesToHHMM(startMin)}"`);
  }
  let endMin;
  if (windowEnd != null && windowEnd !== '') {
    endMin = parseHHMM(windowEnd);
    if (endMin == null) {
      throw invalidWindow(`Appointment end must be a 24h HH:MM time — got "${String(windowEnd)}"`);
    }
  } else {
    const dur = Number.parseInt(durationMinutes, 10);
    endMin = startMin + (Number.isInteger(dur) && dur > 0 ? dur : DEFAULT_DURATION_MINUTES);
  }
  if (endMin <= startMin) {
    throw invalidWindow(`Appointment end must be after its start — got ${minutesToHHMM(startMin)}-${minutesToHHMM(endMin)}`);
  }
  if (endMin > ADMIN_DAY_END_MINUTES) {
    throw invalidWindow(`Appointment must end by ${minutesToHHMM(ADMIN_DAY_END_MINUTES)} — got an end of ${minutesToHHMM(endMin)}`);
  }
  return { window_start: minutesToHHMM(startMin), window_end: minutesToHHMM(endMin) };
}

/**
 * Rung 1 for a writer that will insert/move rows on SEVERAL dates in one
 * trx (series create / re-seed): every date's occupancy lock, deduped and
 * sorted via occupancy.js acquireOccupancyLocks — taken up front, before any
 * row lock. Returns the locked date set so the writer can fail CLOSED on a
 * date it derives later that was not pre-locked.
 */
async function acquireAdminSlotLocks({ trx, dates = [] } = {}) {
  const locked = new Set();
  if (!trx) return locked;
  const clean = (dates || []).filter(Boolean).map((d) => String(d).split('T')[0]);
  await acquireOccupancyLocks(trx, clean);
  for (const d of clean) locked.add(d);
  return locked;
}

// One copy of the advisory-overlap warning every staff surface shows —
// dates only, no customer data.
function slotOverlapWarning(date) {
  return `Heads up: this booking overlaps another appointment on the schedule${date ? ` on ${String(date).split('T')[0]}` : ''} — both are kept on the calendar.`;
}

/**
 * Shared overlap probe for admin writes — unconditional (owner directive on
 * PR #3486: it can only warn, never block, so there is nothing left to dark-
 * ship behind a gate; the former GATE_ADMIN_SLOT_OVERLAP_GUARD is removed).
 * Takes the date-wide occupancy lock on `trx` first (rung 1 of occupancy.js's
 * ORDERING CONTRACT — callers must invoke this before any other lock in the
 * transaction), then runs the tech-blind findConflictingVisits probe. A hit
 * is ADVISORY: the conflicting rows are RETURNED for the caller to surface
 * via slotOverlapWarning; nothing throws.
 */
async function probeSlotOverlap({ trx, date, windowStart, windowEnd, excludeServiceIds = [] } = {}) {
  if (!trx || !date || !windowStart || !windowEnd) return [];
  const dateStr = String(date).split('T')[0];
  await acquireOccupancyLock(trx, dateStr);
  const clash = await findConflictingVisits({
    db: trx,
    date: dateStr,
    windowStart,
    windowEnd,
    excludeServiceIds,
  });
  return clash.map((row) => ({
    id: row.id,
    scheduled_date: row.scheduled_date,
    window_start: row.window_start,
    window_end: row.window_end,
    status: row.status,
    technician_id: row.technician_id || null,
    service_type: row.service_type || null,
  }));
}

module.exports = {
  assertAdminAppointmentWindow,
  probeSlotOverlap,
  slotOverlapWarning,
  acquireAdminSlotLocks,
  ADMIN_DAY_START_MINUTES,
  ADMIN_DAY_END_MINUTES,
  _internals: { parseHHMM, minutesToHHMM },
};
