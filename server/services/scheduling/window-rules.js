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
 * Overlap (assertNoSlotOverlap) reuses the shared occupancy mechanism
 * (scheduling/occupancy.js — tech-blind findConflictingVisits under the
 * date-wide advisory lock) exactly as routes/booking.js createSelfBooking
 * does. It is behind GATE_ADMIN_SLOT_OVERLAP_GUARD (default OFF, only the
 * string 'true' enables — fail-closed parse); the hour rules above are NOT
 * gated.
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

// Kill switch: unset (or any value other than the exact string 'true') = OFF.
function adminSlotOverlapGuardEnabled() {
  return process.env.GATE_ADMIN_SLOT_OVERLAP_GUARD === 'true';
}

/**
 * Rung 1 for a writer that will insert/move rows on SEVERAL dates in one
 * trx (series create / re-seed): every date's occupancy lock, deduped and
 * sorted via occupancy.js acquireOccupancyLocks — taken up front, before any
 * row lock. No-op when the gate is off. Returns the locked date set so the
 * writer can fail CLOSED on a date it derives later that was not pre-locked.
 */
async function acquireAdminSlotLocks({ trx, dates = [] } = {}) {
  const locked = new Set();
  if (!adminSlotOverlapGuardEnabled() || !trx) return locked;
  const clean = (dates || []).filter(Boolean).map((d) => String(d).split('T')[0]);
  await acquireOccupancyLocks(trx, clean);
  for (const d of clean) locked.add(d);
  return locked;
}

/**
 * Gate-guarded overlap check for admin writes. Takes the date-wide occupancy
 * lock on `trx` first (rung 1 of occupancy.js's ORDERING CONTRACT — callers
 * must invoke this before any other lock in the transaction), then runs the
 * tech-blind findConflictingVisits probe. No-op when the gate is off.
 *
 * @throws 409 SLOT_CONFLICT { conflicts }
 */
async function assertNoSlotOverlap({ trx, date, windowStart, windowEnd, excludeServiceIds = [] } = {}) {
  if (!adminSlotOverlapGuardEnabled()) return [];
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
  if (clash.length) {
    throw httpError(409, 'That time slot overlaps another visit on the schedule', {
      code: 'SLOT_CONFLICT',
      conflicts: clash.map((row) => ({
        id: row.id,
        scheduled_date: row.scheduled_date,
        window_start: row.window_start,
        window_end: row.window_end,
        status: row.status,
        technician_id: row.technician_id || null,
        service_type: row.service_type || null,
      })),
    });
  }
  return [];
}

module.exports = {
  assertAdminAppointmentWindow,
  assertNoSlotOverlap,
  acquireAdminSlotLocks,
  adminSlotOverlapGuardEnabled,
  ADMIN_DAY_START_MINUTES,
  ADMIN_DAY_END_MINUTES,
  _internals: { parseHHMM, minutesToHHMM },
};
