/**
 * Interview self-scheduling slots for the recruiting comms lane
 * (GATE_RECRUITING_COMMS). Pure(ish) read-side computation — one DB read
 * for route conflicts, one for other-applicant conflicts, per candidate
 * day — building on the shared ET wall-clock helpers so slot boundaries
 * never drift with server-local time (Railway runs TZ=UTC).
 *
 * The owner is the only field technician: route conflicts read
 * scheduled_services with no technician filter.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etParts, parseETDateTime, addETDays, formatETTime } = require('../utils/datetime-et');
const { NOT_A_ROUTE_STOP_STATUSES } = require('./stops-ahead');

const SLOT_MINUTES = 30;
const LEAD_HOURS = 4;
const HORIZON_DAYS = 14;
const BUFFER_MINUTES = 15;

// ISO weekday keys: '1' Monday .. '7' Sunday.
const DEFAULT_WINDOWS = {
  1: [['16:00', '18:00']],
  2: [['16:00', '18:00']],
  3: [['16:00', '18:00']],
  4: [['16:00', '18:00']],
  5: [['16:00', '18:00']],
  6: [['09:00', '12:00']],
  7: [],
};

// Shares the repo's canonical "not really a route stop today" set
// (server/services/stops-ahead.js) — cancelled/skipped/no_show/rescheduled —
// plus 'completed': a visit already serviced is not a live stop the truck is
// still driving to, but stops-ahead itself must keep completed stops IN the
// route (they occupied a real slot today); interview scheduling has no such
// need, so 'completed' is added on top here rather than in the shared set.
const NOT_ROUTE_STOP_STATUSES = [...NOT_A_ROUTE_STOP_STATUSES, 'completed'];
const INTERVIEW_BLOCKING_STATUSES = ['interview', 'offer'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Strict HH:MM — HH 00-23, MM 00-59. A shape-only regex (\d{2}:\d{2}) would
// accept '24:00' or '16:60', which timeToMinutes then turns into a
// nonsensical (or wrapped) minute count.
function isValidHHMM(value) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(value));
  if (!m) return false;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

function isValidWindowsShape(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  for (const [key, windows] of Object.entries(parsed)) {
    if (!/^[1-7]$/.test(key)) return false;
    if (!Array.isArray(windows)) return false;
    for (const w of windows) {
      if (!Array.isArray(w) || w.length !== 2) return false;
      if (!isValidHHMM(w[0]) || !isValidHHMM(w[1])) return false;
      if (timeToMinutes(w[0]) >= timeToMinutes(w[1])) return false;
    }
  }
  return true;
}

function loadWindows() {
  const raw = process.env.RECRUITING_INTERVIEW_WINDOWS;
  if (!raw) return DEFAULT_WINDOWS;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(`[interview-slots] RECRUITING_INTERVIEW_WINDOWS is not valid JSON — using default windows`);
    return DEFAULT_WINDOWS;
  }
  if (!isValidWindowsShape(parsed)) {
    logger.warn(`[interview-slots] RECRUITING_INTERVIEW_WINDOWS has an invalid shape — using default windows`);
    return DEFAULT_WINDOWS;
  }
  return parsed;
}

function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map((n) => parseInt(n, 10));
  return h * 60 + m;
}

// ISO weekday: Monday=1 .. Sunday=7 (etParts.dayOfWeek is JS convention, Sun=0).
function isoWeekdayOf(dowJs) {
  return dowJs === 0 ? 7 : dowJs;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Postgres TIME columns arrive as 'HH:MM:SS' strings via the pg driver.
function hhmmFromDbTime(value) {
  if (value == null) return null;
  const s = String(value);
  const m = /^(\d{2}):(\d{2})/.exec(s);
  return m ? `${m[1]}:${m[2]}` : null;
}

function slotLabel(startDate) {
  const weekday = startDate.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
  const monthDay = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  return `${weekday} ${monthDay}, ${formatETTime(startDate)}`;
}

/**
 * @param {{ now?: Date, excludeApplicationId?: string }} opts
 * @returns {Promise<Array<{ start: string, end: string, date: string, label: string }>>}
 */
// opts.conn: a knex transaction to read through — the book route lists
// slots INSIDE its transaction (under the booking advisory lock) so two
// applicants racing for one slot are serialized against the same snapshot.
async function listInterviewSlots({ now = new Date(), excludeApplicationId, conn = db } = {}) {
  const windows = loadWindows();
  const leadCutoffMs = now.getTime() + LEAD_HOURS * 60 * 60 * 1000;
  const slots = [];

  for (let dayOffset = 0; dayOffset < HORIZON_DAYS; dayOffset++) {
    const dayAnchor = addETDays(now, dayOffset);
    const dp = etParts(dayAnchor);
    const dateStr = `${dp.year}-${pad2(dp.month)}-${pad2(dp.day)}`;
    const iso = String(isoWeekdayOf(dp.dayOfWeek));
    const dayWindows = windows[iso] || [];
    if (!dayWindows.length) continue;

     
    const routeRows = await conn('scheduled_services')
      .where('scheduled_date', dateStr)
      .whereNotIn('status', NOT_ROUTE_STOP_STATUSES)
      .whereNotNull('window_start')
      .select('window_start', 'window_end', 'estimated_duration_minutes');

     
    const appRows = await conn('job_applications')
      .whereIn('status', INTERVIEW_BLOCKING_STATUSES)
      .whereNotNull('interview_at')
      .modify((q) => {
        if (excludeApplicationId) q.whereNot('id', excludeApplicationId);
      })
      .select('id', 'interview_at', 'interview_end_at');

    const routeIntervals = routeRows.map((r) => {
      const startHHMM = hhmmFromDbTime(r.window_start);
      const startMs = parseETDateTime(`${dateStr}T${startHHMM}`).getTime();
      const endHHMM = hhmmFromDbTime(r.window_end);
      const endMs = endHHMM
        ? parseETDateTime(`${dateStr}T${endHHMM}`).getTime()
        : startMs + (Number(r.estimated_duration_minutes) > 0 ? Number(r.estimated_duration_minutes) : 60) * 60000;
      return { startMs, endMs };
    });

    const appIntervals = appRows.map((a) => {
      const startMs = new Date(a.interview_at).getTime();
      const endMs = a.interview_end_at
        ? new Date(a.interview_end_at).getTime()
        : startMs + SLOT_MINUTES * 60000;
      return { startMs, endMs };
    });

    for (const [startHHMM, endHHMM] of dayWindows) {
      const windowStartMin = timeToMinutes(startHHMM);
      const windowEndMin = timeToMinutes(endHHMM);
      for (let m = windowStartMin; m + SLOT_MINUTES <= windowEndMin; m += SLOT_MINUTES) {
        const naive = `${dateStr}T${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
        const startDate = parseETDateTime(naive);
        const startMs = startDate.getTime();
        const endMs = startMs + SLOT_MINUTES * 60000;

        if (startMs < leadCutoffMs) continue;

        const bufStart = startMs - BUFFER_MINUTES * 60000;
        const bufEnd = endMs + BUFFER_MINUTES * 60000;
        const routeConflict = routeIntervals.some((r) => overlaps(bufStart, bufEnd, r.startMs, r.endMs));
        if (routeConflict) continue;

        const appConflict = appIntervals.some((a) => overlaps(startMs, endMs, a.startMs, a.endMs));
        if (appConflict) continue;

        slots.push({
          start: startDate.toISOString(),
          end: new Date(endMs).toISOString(),
          date: dateStr,
          label: slotLabel(startDate),
        });
      }
    }
  }

  return slots;
}

/**
 * The book route MUST re-validate an applicant-supplied start against this
 * — never trust the client's chosen slot.
 */
/**
 * The reciprocal check (Codex r3 P1): booked interviews as occupied
 * intervals for ONE ET calendar date, in the shape the availability engine
 * merges into its `occupied` set ({ start, end } as 'HH:MM' wall-clock,
 * BUFFER_MINUTES either side). Customer slot building and the estimate
 * confirm path read this so a visit is never offered or confirmed over the
 * owner's interview.
 */
async function bookedInterviewWindowsForDate(dateStr, { conn = db } = {}) {
  const dayStart = parseETDateTime(`${dateStr}T00:00`);
  const dayEnd = addETDays(dayStart, 1);
  const rows = await conn('job_applications')
    .whereIn('status', INTERVIEW_BLOCKING_STATUSES)
    .whereNotNull('interview_at')
    .where('interview_at', '>=', dayStart)
    .where('interview_at', '<', dayEnd)
    .select('id', 'interview_at', 'interview_end_at');
  return rows.map((r) => {
    const startMs = new Date(r.interview_at).getTime() - BUFFER_MINUTES * 60 * 1000;
    const endMs = (r.interview_end_at ? new Date(r.interview_end_at).getTime() : new Date(r.interview_at).getTime() + SLOT_MINUTES * 60 * 1000)
      + BUFFER_MINUTES * 60 * 1000;
    const sp = etParts(new Date(Math.max(startMs, dayStart.getTime())));
    const ep = etParts(new Date(Math.min(endMs, dayEnd.getTime() - 60 * 1000)));
    return { start: `${pad2(sp.hour)}:${pad2(sp.minute)}`, end: `${pad2(ep.hour)}:${pad2(ep.minute)}`, applicationId: r.id };
  });
}

async function isOfferedSlot(startIso, opts = {}) {
  const slots = await listInterviewSlots(opts);
  return slots.some((s) => s.start === startIso);
}

module.exports = {
  SLOT_MINUTES,
  LEAD_HOURS,
  HORIZON_DAYS,
  BUFFER_MINUTES,
  DEFAULT_WINDOWS,
  listInterviewSlots,
  isOfferedSlot,
  bookedInterviewWindowsForDate,
  formatSlotLabel: slotLabel,
  _internals: { loadWindows, timeToMinutes, isoWeekdayOf, overlaps, hhmmFromDbTime, slotLabel, isValidHHMM },
};
