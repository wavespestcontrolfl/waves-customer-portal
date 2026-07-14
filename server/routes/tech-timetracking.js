const express = require('express');
const router = express.Router();
const db = require('../models/db');
const timeTracking = require('../services/time-tracking');
const timesheetApproval = require('../services/timesheet-approval');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { etDateString, addETDays, parseETDateTime, etWeekStart } = require('../utils/datetime-et');
const { STAFF_WORK_DATE_SQL } = require('../utils/staff-time-work-date');

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
    const entry = await timeTracking.startJob(req.technicianId, req.params.jobId, { lat, lng });
    res.json(entry);
  } catch (err) {
    if (err.message.includes('Must be clocked in')) return res.status(409).json({ error: err.message });
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
router.get('/history', async (req, res, next) => {
  try {
    const { startDate, endDate, entryType, limit, offset } = req.query;
    const result = await timeTracking.getEntries({
      technicianId: req.technicianId,
      startDate,
      endDate,
      entryType,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
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
    res.json(summaries);
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
