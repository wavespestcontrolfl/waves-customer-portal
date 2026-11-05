const express = require('express');
const router = express.Router();
const db = require('../models/db');
const timeTracking = require('../services/time-tracking');
const timesheetApproval = require('../services/timesheet-approval');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { etDateString, addETDays, parseETDateTime, etWeekStart } = require('../utils/datetime-et');
const { STAFF_WORK_DATE_SQL, staffWorkDate } = require('../utils/staff-time-work-date');
const { validDateOnly } = require('../utils/date-only');

router.use(adminAuthenticate, requireTechOrAdmin);

// ET-anchored Monday for a YYYY-MM-DD reference (or "today in ET" if
// dateStr is missing). Delegates to the shared etWeekStart helper so
// we don't reinvent DST-safe week math here. parseETDateTime treats
// the date string as ET wall-clock (not server-local UTC), which is
// the whole point on Railway.
function mondayOfET(dateStr) {
  const ref = dateStr ? parseETDateTime(`${dateStr}T00:00`) : new Date();
  return etWeekStart(ref);
}

// Convert whatever a SQL DATE column gives us (JS Date at UTC
// midnight per pg+knex, or a YYYY-MM-DD string in some drivers) into
// a YYYY-MM-DD string WITHOUT shifting through ET. etDateString on a
// UTC-midnight Date drops to the prior ET day (e.g., Mon UTC midnight
// is Sun 8pm EDT) which is the wrong calendar day for a DATE column
// — DATE has no time, the calendar day is the entire field.
function dateColumnToYMD(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// ---------------------------------------------------------------------------
// POST /clock-in
// ---------------------------------------------------------------------------
router.post('/clock-in', async (req, res, next) => {
  try {
    const { lat, lng, notes } = req.body;
    const entry = await timeTracking.clockIn(req.technicianId, { lat, lng, notes, source: 'app' });
    res.json(entry);
  } catch (err) {
    if (err.message.includes('Already clocked in')) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /clock-out
// ---------------------------------------------------------------------------
router.post('/clock-out', async (req, res, next) => {
  try {
    const { lat, lng, notes } = req.body;
    const entry = await timeTracking.clockOut(req.technicianId, { lat, lng, notes });
    res.json(entry);
  } catch (err) {
    if (err.message.includes('Not currently clocked in')) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /start-job/:jobId
// ---------------------------------------------------------------------------
router.post('/start-job/:jobId', async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    const entry = await timeTracking.startJob(req.technicianId, req.params.jobId, { lat, lng, scopeReq: req });
    res.json(entry);
  } catch (err) {
    if (err.message.includes('Must be clocked in')) return res.status(409).json({ error: err.message });
    if (err.code === 'job_not_assigned') return res.status(404).json({ error: err.message });
    if (err.code === 'street_level_hold') return res.status(409).json({ error: err.message, code: 'street_level_hold' });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /end-job
// ---------------------------------------------------------------------------
router.post('/end-job', async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    const entry = await timeTracking.endJob(req.technicianId, { lat, lng });
    res.json(entry);
  } catch (err) {
    if (err.message.includes('No active job')) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /start-break
// ---------------------------------------------------------------------------
router.post('/start-break', async (req, res, next) => {
  try {
    const entry = await timeTracking.startBreak(req.technicianId);
    res.json(entry);
  } catch (err) {
    if (
      err.message.includes('Must be clocked in')
      || err.message.includes('Already on break')
    ) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /end-break
// ---------------------------------------------------------------------------
router.post('/end-break', async (req, res, next) => {
  try {
    const entry = await timeTracking.endBreak(req.technicianId);
    res.json(entry);
  } catch (err) {
    if (err.message.includes('No active break')) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /no-lunch { noLunch: boolean }
//
// "No lunch today": skip the 30-minute auto lunch (GATE_AUTO_LUNCH) for the
// caller's own CURRENT ET work day. Past days are an admin correction. An
// approved day or week is refused with 409. The day and week are recomputed
// under the staff week lock.
// ---------------------------------------------------------------------------
router.post('/no-lunch', async (req, res, next) => {
  try {
    const { noLunch } = req.body || {};
    if (typeof noLunch !== 'boolean') {
      return res.status(400).json({ error: 'noLunch must be true or false.' });
    }
    const workDate = staffWorkDate(new Date());
    const summary = await timeTracking.setDayNoLunch(req.technicianId, workDate, noLunch);
    res.json({ workDate, noLunch: Boolean(summary?.no_lunch), summary });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /status
// ---------------------------------------------------------------------------
router.get('/status', async (req, res, next) => {
  try {
    const status = await timeTracking.getStatus(req.technicianId);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /history — paginated entries for this tech
// ---------------------------------------------------------------------------
// A page holds 1-100 entries and the offset is a whole number; anything else
// falls back to the defaults. A date filter must be a real YYYY-MM-DD day: a
// malformed one is refused here instead of failing the ::date cast in Postgres.
const HISTORY_PAGE_MAX = 100;
router.get('/history', async (req, res, next) => {
  try {
    const { startDate, endDate, entryType } = req.query;
    for (const [name, value] of Object.entries({ startDate, endDate })) {
      if (value && !validDateOnly(value)) {
        return res.status(400).json({ error: `${name} must be a valid YYYY-MM-DD date` });
      }
    }
    const limit = Number.parseInt(req.query.limit, 10);
    const offset = Number.parseInt(req.query.offset, 10);
    const result = await timeTracking.getEntries({
      technicianId: req.technicianId,
      startDate,
      endDate,
      entryType,
      limit: limit >= 1 ? Math.min(limit, HISTORY_PAGE_MAX) : 50,
      // A 20-digit offset would overflow Postgres bigint: past a safe integer it falls back too.
      offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /weekly — weekly summaries for this tech
// ---------------------------------------------------------------------------
router.get('/weekly', async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const summaries = await timeTracking.getWeeklySummaries({
      technicianId: req.technicianId,
      startDate,
      endDate,
    });
    // Revenue and revenue per hour are the owner's figures (owner 2026-11-04):
    // a technician gets its hours only. An admin's response is unchanged.
    res.json(req.techRole === 'admin' ? summaries : summaries.map(withoutOwnerMoney));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /my-hours?weekStart=YYYY-MM-DD — the signed-in technician's own week
// for the "My hours" card on Today (owner 2026-11-04, D5 A): daily hours, the
// week's totals and the week's entries. Scoped to req.technicianId; the card
// is a projection. It carries no revenue, no revenue per hour, no utilization,
// no GPS, no customer and no pay rate. The week is the ET Monday that holds
// weekStart (default this week); a future week is clamped to this one.
// ---------------------------------------------------------------------------
const OWNER_ONLY_WEEKLY_FIELDS = ['total_revenue', 'avg_rpmh', 'utilization_pct'];
function withoutOwnerMoney(row) {
  const copy = { ...row };
  for (const key of OWNER_ONLY_WEEKLY_FIELDS) delete copy[key];
  return copy;
}
const MY_HOURS_PAGE = 100;
const MY_HOURS_MAX_PAGES = 5;
const minutesOf = (value) => Math.round((Number.parseFloat(value) || 0) * 100) / 100;
function myHoursDay(row) {
  return {
    date: dateColumnToYMD(row.work_date),
    shiftMinutes: minutesOf(row.total_shift_minutes),
    jobMinutes: minutesOf(row.total_job_minutes),
    driveMinutes: minutesOf(row.total_drive_minutes),
    breakMinutes: minutesOf(row.total_break_minutes),
    unpaidMealMinutes: minutesOf(row.unpaid_meal_minutes),
    jobCount: Number(row.job_count) || 0,
    firstClockIn: row.first_clock_in || null,
    lastClockOut: row.last_clock_out || null,
    status: row.status || 'pending',
  };
}
function myHoursLiveDay(date, rows) {
  const sum = (type) => minutesOf(rows.filter((row) => row.entry_type === type).reduce((total, row) => total + (Number.parseFloat(row.duration_minutes) || 0), 0));
  const shifts = rows.filter((row) => row.entry_type === 'shift');
  const clockIns = shifts.map((row) => new Date(row.clock_in).getTime());
  return {
    date,
    shiftMinutes: sum('shift'),
    jobMinutes: sum('job'),
    driveMinutes: sum('drive'),
    breakMinutes: sum('break'),
    unpaidMealMinutes: 0,
    jobCount: rows.filter((row) => row.entry_type === 'job' && row.status !== 'active').length,
    firstClockIn: clockIns.length ? new Date(Math.min(...clockIns)).toISOString() : null,
    lastClockOut: shifts.length && shifts.every((row) => row.clock_out) ? new Date(Math.max(...shifts.map((row) => new Date(row.clock_out).getTime()))).toISOString() : null,
    status: 'pending',
  };
}
function myHoursEntry(row) {
  return {
    id: row.id,
    type: row.entry_type,
    status: row.status,
    clockIn: row.clock_in,
    clockOut: row.clock_out || null,
    minutes: row.duration_minutes == null ? null : minutesOf(row.duration_minutes),
    serviceType: row.service_type || row.job_service_type || null,
    edited: row.status === 'edited',
  };
}
function myHoursWeek(row) {
  if (!row) return null;
  return {
    shiftMinutes: minutesOf(row.total_shift_minutes),
    regularMinutes: minutesOf(row.regular_minutes),
    overtimeMinutes: minutesOf(row.overtime_minutes),
    daysWorked: Number(row.days_worked) || 0,
    jobCount: Number(row.job_count) || 0,
    status: row.status || 'pending',
    signed: Boolean(row.tech_signed_at),
  };
}
// A stored summary is current only once the office approves the day: a job or
// break ended after "No lunch today" (or any early summary write) does not
// refresh it. So every unapproved day is read from its current entries; the
// stored row keeps only the unpaid meal and the status. An approved day keeps
// its stored numbers, and a day with entries but no row still shows. Read-only.
// dayRows is every non-voided entry of the week, not the capped detail list.
function reconcileMyHoursDays(dailies, dayRows) {
  const byDate = new Map();
  for (const row of dayRows) {
    const date = staffWorkDate(row.clock_in);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(row);
  }
  const days = [];
  const seen = new Set();
  for (const row of dailies) {
    const stored = myHoursDay(row);
    seen.add(stored.date);
    days.push(stored.status === 'approved'
      ? stored
      : { ...myHoursLiveDay(stored.date, byDate.get(stored.date) || []), unpaidMealMinutes: stored.unpaidMealMinutes, status: stored.status });
  }
  for (const [date, rows] of byDate) if (!seen.has(date)) days.push(myHoursLiveDay(date, rows));
  return days;
}
// The stored weekly row is shown only while it still agrees with the days above.
function weekMatchingDays(week, totals) {
  if (!week) return null;
  return week.status === 'approved' || Math.abs(week.shiftMinutes - totals.shiftMinutes) < 0.01 ? week : null;
}
router.get('/my-hours', async (req, res, next) => {
  try {
    const { weekStart } = req.query;
    if (weekStart && !validDateOnly(weekStart)) {
      return res.status(400).json({ error: 'weekStart must be a valid YYYY-MM-DD date' });
    }
    const thisMonday = mondayOfET();
    const asked = mondayOfET(weekStart || undefined);
    const monday = asked > thisMonday ? thisMonday : asked;
    const mondayNoon = parseETDateTime(`${monday}T12:00`);
    const sunday = etDateString(addETDays(mondayNoon, 6));
    const technicianId = req.technicianId;

    const entryRows = [];
    let total = 0;
    for (let page = 0; page < MY_HOURS_MAX_PAGES; page += 1) {
      const result = await timeTracking.getEntries({
        technicianId, startDate: monday, endDate: sunday, limit: MY_HOURS_PAGE, offset: page * MY_HOURS_PAGE,
      });
      entryRows.push(...(result.entries || []));
      total = result.total || 0;
      if (entryRows.length >= total || !(result.entries || []).length) break;
    }
    const [dailies, weeklies, dayRows] = await Promise.all([
      timeTracking.getDailySummaries({ technicianId, startDate: monday, endDate: sunday }),
      timeTracking.getWeeklySummaries({ technicianId, startDate: monday, endDate: monday }),
      // Every entry of the week, only the columns the day totals need: the totals
      // never come from the capped detail list above.
      db('time_entries')
        .where({ technician_id: technicianId })
        .where('status', '!=', 'voided')
        .whereRaw(`${STAFF_WORK_DATE_SQL} >= ?::date`, [monday])
        .whereRaw(`${STAFF_WORK_DATE_SQL} <= ?::date`, [sunday])
        .select('entry_type', 'status', 'clock_in', 'clock_out', 'duration_minutes'),
    ]);

    const liveEntries = entryRows.filter((row) => row.status !== 'voided');
    const days = reconcileMyHoursDays(dailies, dayRows);
    days.sort((a, b) => (a.date < b.date ? -1 : 1));
    const totals = days.reduce((sum, day) => ({
      shiftMinutes: sum.shiftMinutes + day.shiftMinutes,
      jobMinutes: sum.jobMinutes + day.jobMinutes,
      driveMinutes: sum.driveMinutes + day.driveMinutes,
      breakMinutes: sum.breakMinutes + day.breakMinutes,
      unpaidMealMinutes: sum.unpaidMealMinutes + day.unpaidMealMinutes,
      jobCount: sum.jobCount + day.jobCount,
    }), { shiftMinutes: 0, jobMinutes: 0, driveMinutes: 0, breakMinutes: 0, unpaidMealMinutes: 0, jobCount: 0 });
    for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key] * 100) / 100;

    res.json({
      weekStart: monday,
      weekEnd: sunday,
      prevWeekStart: etDateString(addETDays(mondayNoon, -7)),
      nextWeekStart: monday < thisMonday ? etDateString(addETDays(mondayNoon, 7)) : null,
      days,
      totals,
      week: weekMatchingDays(myHoursWeek(weeklies[0]), totals),
      entries: liveEntries.map(myHoursEntry),
      entriesTruncated: entryRows.length < total,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /pending-signoff — server-anchored "what week should this tech
// sign right now?" lookup. Returns last week's weekly summary if it
// exists, isn't yet admin-approved, and isn't yet tech-signed.
// Returns { weekly: null } otherwise. The TechHomePage signoff card
// hits this so the week boundary is computed in ET on the server,
// not via browser-local Date math (Railway runs UTC, browser may
// not be in ET).
// ---------------------------------------------------------------------------
router.get('/pending-signoff', async (req, res, next) => {
  try {
    const thisMonday = mondayOfET(etDateString(new Date()));

    // Backfill weekly summary rows for any past week (within a
    // 12-week lookback) that has worked dailies but no time_weekly_summary
    // row yet. Without this, a cron gap or a fresh tech would let
    // /pending-signoff silently return null even though there's a
    // legitimate week to sign. Mirrors the pattern in
    // timesheet-approval.getPendingWeeks.
    const LOOKBACK_DAYS = 7 * 12;
    const lookbackStart = etDateString(addETDays(new Date(), -LOOKBACK_DAYS));
    const workDays = await db('time_entry_daily_summary')
      .where({ technician_id: req.technicianId })
      .where('work_date', '>=', lookbackStart)
      .where('work_date', '<', thisMonday)
      .where(b => b.where('total_shift_minutes', '>', 0).orWhere('job_count', '>', 0))
      .select('work_date');
    const entryWorkDays = await db('time_entries')
      .where({ technician_id: req.technicianId })
      .where('status', '!=', 'voided')
      .whereRaw(`${STAFF_WORK_DATE_SQL} >= ?::date`, [lookbackStart])
      .whereRaw(`${STAFF_WORK_DATE_SQL} < ?::date`, [thisMonday])
      .select(db.raw(`${STAFF_WORK_DATE_SQL} AS work_date`));
    if (workDays.length || entryWorkDays.length) {
      const weekMondays = new Set();
      for (const row of [...workDays, ...entryWorkDays]) {
        const ymd = dateColumnToYMD(row.work_date);
        weekMondays.add(etWeekStart(parseETDateTime(`${ymd}T12:00`)));
      }
      // Recompute UNCONDITIONALLY for every past Monday with worked
      // dailies — not just missing rows. A stale zero-total row from
      // a prior compute (before admin entry edits added hours) would
      // otherwise be skipped by the total_shift_minutes>0 filter on
      // the candidate query below, hiding a legitimate sign-off
      // prompt. computeWeeklySummary is idempotent and cheap;
      // bounded at ~12 calls per /pending-signoff hit.
      for (const ws of weekMondays) {
        try { await timesheetApproval.getWeekDetail(req.technicianId, ws); } catch (_) { /* noop */ }
      }
    }

    // Find the OLDEST past week that still needs sign-off — not just
    // last week. unlockWeek clears tech_signed_at on whichever week
    // an admin reopens, which may be older than last week; restricting
    // to lastWeekStart silently hides those re-sign prompts. Filter
    // out approved + already-signed + zero-hour rows so we only
    // surface real outstanding attestations.
    const candidate = await db('time_weekly_summary')
      .where({ technician_id: req.technicianId })
      .where('status', '!=', 'approved')
      .whereNull('tech_signed_at')
      .where('week_start', '<', thisMonday)
      .where('total_shift_minutes', '>', 0)
      .orderBy('week_start', 'asc')
      .first();
    if (!candidate) return res.json({ weekly: null, weekStart: null });

    // Format the DATE column directly as YYYY-MM-DD — DON'T route
    // through etDateString(new Date(...)) because that shifts the
    // UTC-midnight Date back into the prior ET day.
    const weekStartStr = dateColumnToYMD(candidate.week_start);

    // Refresh entries → dailies → weekly under the payroll week lock, then
    // return a token for exactly the snapshot rendered by the tech.
    const detail = await timesheetApproval.getWeekDetail(req.technicianId, weekStartStr);
    const weekly = detail.weekly;
    if (!weekly) return res.json({ weekly: null, weekStart: weekStartStr });

    // Recompute may have flipped this row's eligibility — re-check the
    // gate. Approved (admin raced ahead), tech_signed_at set (concurrent
    // sign), or total_shift_minutes now zero (admin voided everything)
    // -> not pending anymore.
    const hours = parseFloat(weekly.total_shift_minutes || 0);
    const blockedReviewState = detail.entries.some(
      entry => (entry.approval_status || 'pending') === 'disputed',
    ) || detail.dailies.some(daily => ['disputed', 'rejected'].includes(daily.status));
    if (
      weekly.status === 'approved'
      || weekly.tech_signed_at
      || hours === 0
      || blockedReviewState
    ) {
      return res.json({
        weekly,
        weekStart: weekStartStr,
        pending: false,
        reviewToken: detail.reviewToken,
      });
    }
    res.json({
      weekly,
      weekStart: weekStartStr,
      pending: true,
      reviewToken: detail.reviewToken,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /sign-week { weekStart: 'YYYY-MM-DD', signature: 'Tech Name' }
//
// Tech acknowledges their own week before admin approval. Sign-off is
// informational; admin still has to approve to lock entries. A
// previously-signed week that's later disputed or unlocked has these
// columns cleared so the tech re-signs after the correction.
// ---------------------------------------------------------------------------
router.post('/sign-week', async (req, res, next) => {
  try {
    const { weekStart, signature, reviewToken } = req.body || {};
    const result = await timesheetApproval.signWeek({
      technicianId: req.technicianId,
      weekStart,
      signature,
      reviewToken,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
