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
    const lastWeekStart = mondayOfET(etDateString(addETDays(new Date(), -7)));
    const lastWeekEnd = sundayOfETWeek(lastWeekStart);

    const hasDailies = await db('time_entry_daily_summary')
      .where({ technician_id: req.technicianId })
      .where('work_date', '>=', lastWeekStart)
      .where('work_date', '<=', lastWeekEnd)
      .first();
    if (!hasDailies) return res.json({ weekly: null, weekStart: lastWeekStart });

    let weekly = await db('time_weekly_summary')
      .where({ technician_id: req.technicianId, week_start: lastWeekStart })
      .first();
    if (!weekly) {
      try { await timeTracking.computeWeeklySummary(req.technicianId, lastWeekStart); } catch (_) { /* noop */ }
      weekly = await db('time_weekly_summary')
        .where({ technician_id: req.technicianId, week_start: lastWeekStart })
        .first();
    }
    if (!weekly) return res.json({ weekly: null, weekStart: lastWeekStart });

    // Approved or already signed -> nothing pending.
    if (weekly.status === 'approved' || weekly.tech_signed_at) {
      return res.json({ weekly, weekStart: lastWeekStart, pending: false });
    }
    res.json({ weekly, weekStart: lastWeekStart, pending: true });
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
    if (weekStart && !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return res.status(400).json({ error: 'weekStart must be YYYY-MM-DD' });
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

    // Require actual daily summaries for that tech in this week before
    // signing. computeWeeklySummary will happily create a zero-total
    // row even when there's no underlying time data, which would let
    // a tech sign arbitrary empty weeks. Anchor on the dailies first.
    const weekEndStr = sundayOfETWeek(start);
    const hasDailies = await db('time_entry_daily_summary')
      .where({ technician_id: req.technicianId })
      .where('work_date', '>=', start)
      .where('work_date', '<=', weekEndStr)
      .first();
    if (!hasDailies) {
      return res.status(404).json({ error: 'No timecard for that week' });
    }

    let weekly = await db('time_weekly_summary')
      .where({ technician_id: req.technicianId, week_start: start })
      .first();
    if (!weekly) {
      try { await timeTracking.computeWeeklySummary(req.technicianId, start); } catch (_) { /* noop */ }
      weekly = await db('time_weekly_summary')
        .where({ technician_id: req.technicianId, week_start: start })
        .first();
    }
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

    logger.info(`[timetracking] Tech ${req.technicianId} signed week ${start}`);
    res.json({ success: true, weekly: updatedRows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
