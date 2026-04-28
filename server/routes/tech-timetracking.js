const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const timeTracking = require('../services/time-tracking');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { etDateString, addETDays, parseETDateTime, etWeekStart } = require('../utils/datetime-et');

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

// Sunday of the ET week starting at `mondayStr` (YYYY-MM-DD). Pure
// calendar +6 — no timezone enters because we never read hours from
// the YYYY-MM-DD string.
function sundayOfETWeek(mondayStr) {
  const [y, m, d] = mondayStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 6));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
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
    if (err.message.includes('Must be clocked in')) return res.status(409).json({ error: err.message });
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
    if (workDays.length) {
      const weekMondays = new Set();
      for (const row of workDays) {
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
        try { await timeTracking.computeWeeklySummary(req.technicianId, ws); } catch (_) { /* noop */ }
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

    // Always recompute the weekly summary before returning it. Existing
    // rows can be stale after late clock-outs or admin entry edits —
    // mutation paths clear tech_signed_at but don't all re-run
    // computeWeeklySummary, so total_shift_minutes / overtime_minutes
    // / job_count may not match the current dailies. Recompute is
    // idempotent and cheap.
    try { await timeTracking.computeWeeklySummary(req.technicianId, weekStartStr); } catch (_) { /* noop */ }
    const weekly = await db('time_weekly_summary')
      .where({ id: candidate.id })
      .first();
    if (!weekly) return res.json({ weekly: null, weekStart: weekStartStr });

    // Recompute may have flipped this row's eligibility — re-check the
    // gate. Approved (admin raced ahead), tech_signed_at set (concurrent
    // sign), or total_shift_minutes now zero (admin voided everything)
    // -> not pending anymore.
    const hours = parseFloat(weekly.total_shift_minutes || 0);
    if (weekly.status === 'approved' || weekly.tech_signed_at || hours === 0) {
      return res.json({ weekly, weekStart: weekStartStr, pending: false });
    }
    res.json({ weekly, weekStart: weekStartStr, pending: true });
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
    const { weekStart, signature } = req.body || {};
    if (!signature || !String(signature).trim()) {
      return res.status(400).json({ error: 'signature required (typed name)' });
    }
    if (weekStart) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
        return res.status(400).json({ error: 'weekStart must be YYYY-MM-DD' });
      }
      // Calendar-validity check — regex passes 2026-02-31, but
      // parseETDateTime / Date.UTC silently overflow that to 2026-03-03,
      // letting a malformed payload sign the wrong week. Round-trip
      // the parsed parts and reject if they don't match the input.
      const [y, m, d] = weekStart.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) {
        return res.status(400).json({ error: 'weekStart must be a valid calendar date' });
      }
    }
    const start = mondayOfET(weekStart);

    // Reject current/future weeks. Sign-off only makes sense for a
    // completed week (Monday last week or earlier) — otherwise a tech
    // could sign hours that haven't happened yet, polluting the audit
    // trail.
    const todayET = etDateString(new Date());
    if (start >= mondayOfET(todayET)) {
      return res.status(400).json({ error: 'Cannot sign current or future weeks' });
    }

    // Require actual worked time in this week before signing.
    // computeDailySummary leaves zero-total rows in place after admin
    // voids/edits (services/time-tracking.js: existing rows are
    // updated, never deleted), so a row's mere existence isn't enough
    // — total_shift_minutes>0 or job_count>0 is. computeWeeklySummary
    // would also happily create a zero row, which we want to refuse.
    const weekEndStr = sundayOfETWeek(start);
    const workedDay = await db('time_entry_daily_summary')
      .where({ technician_id: req.technicianId })
      .where('work_date', '>=', start)
      .where('work_date', '<=', weekEndStr)
      .where(b => b.where('total_shift_minutes', '>', 0).orWhere('job_count', '>', 0))
      .first();
    if (!workedDay) {
      return res.status(404).json({ error: 'No worked time on that week' });
    }

    // Recompute before reading so the tech is signing the latest
    // totals, not whatever was stored before the most recent
    // clock-out / entry edit. Idempotent.
    try { await timeTracking.computeWeeklySummary(req.technicianId, start); } catch (_) { /* noop */ }

    const weekly = await db('time_weekly_summary')
      .where({ technician_id: req.technicianId, week_start: start })
      .first();
    if (!weekly) return res.status(404).json({ error: 'No timecard for that week' });

    if (weekly.status === 'approved') {
      return res.status(409).json({ error: 'Week already approved by admin — cannot sign after lock' });
    }
    if (weekly.tech_signed_at) {
      // Friendly idempotent path — the read showed a signature already.
      // Don't error; return the existing row so a double-click or stale
      // tab reload sees the same shape it would after a fresh sign.
      return res.json({ success: true, weekly, alreadySigned: true });
    }

    // Atomic guard: if either an admin approves or a concurrent sign
    // request lands between our read above and this update, the
    // predicates make the update affect 0 rows so we don't (a) stamp
    // tech_signed_at onto a now-locked week or (b) overwrite a prior
    // signature timestamp from a double-submit / second-tab race.
    const updatedRows = await db('time_weekly_summary')
      .where({ id: weekly.id })
      .whereNot({ status: 'approved' })
      .whereNull('tech_signed_at')
      .update({
        tech_signed_at: new Date(),
        tech_signature: String(signature).trim().slice(0, 200),
        updated_at: new Date(),
      })
      .returning('*');

    if (!updatedRows.length) {
      // Race lost — re-read to figure out which guard tripped so the
      // tech sees the right state instead of a generic error.
      const fresh = await db('time_weekly_summary').where({ id: weekly.id }).first();
      if (fresh?.tech_signed_at) {
        return res.json({ success: true, weekly: fresh, alreadySigned: true });
      }
      return res.status(409).json({ error: 'Week was approved before sign-off completed — refresh and try again' });
    }

    // Structural identifiers only — no typed signature or name-bearing
    // context per AGENTS.md. tech UUID + weekly_summary id are enough
    // to reconstruct the event from DB if needed.
    logger.info(`[timetracking] sign-week tech=${req.technicianId} weekly_id=${updatedRows[0].id}`);
    res.json({ success: true, weekly: updatedRows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
