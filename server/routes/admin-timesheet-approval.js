const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const approval = require('../services/timesheet-approval');
const {
  addStaffWorkDays,
  staffWeekStartForWorkDate,
  staffWorkDate,
} = require('../utils/staff-time-work-date');

// Weekly approval is admin-only (not tech). requireAdmin excludes techs.
router.use(adminAuthenticate, requireAdmin);

function defaultPendingWeekStart(now = new Date()) {
  const previousWeekDate = addStaffWorkDays(staffWorkDate(now), -7);
  return staffWeekStartForWorkDate(previousWeekDate);
}

// GET /pending?weekStart=YYYY-MM-DD — all techs' weekly rollups (defaults to last week)
router.get('/pending', async (req, res, next) => {
  try {
    let weekStart = req.query.weekStart;
    if (!weekStart) {
      weekStart = defaultPendingWeekStart();
    }
    const weeks = await approval.getPendingWeeks(weekStart);
    res.json({ weekStart, techs: weeks });
  } catch (err) { next(err); }
});

// GET /week-detail?technicianId=&weekStart=
router.get('/week-detail', async (req, res, next) => {
  try {
    const { technicianId, weekStart } = req.query;
    if (!technicianId || !weekStart) {
      return res.status(400).json({ error: 'technicianId and weekStart required' });
    }
    const detail = await approval.getWeekDetail(technicianId, weekStart);
    res.json(detail);
  } catch (err) { next(err); }
});

// POST /approve { technicianId, weekStart, reviewToken, notes? }
router.post('/approve', async (req, res, next) => {
  try {
    const { technicianId, weekStart, reviewToken, notes } = req.body || {};
    if (!technicianId || !weekStart || !reviewToken) {
      return res.status(400).json({
        error: 'technicianId, weekStart, and reviewToken required',
      });
    }
    const result = await approval.approveWeek({
      technicianId, weekStart, adminId: req.technicianId, notes, reviewToken,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// POST /bulk-approve { technicianIds: [...], weekStart, reviewTokens, notes? }
router.post('/bulk-approve', async (req, res, next) => {
  try {
    const { technicianIds, weekStart, reviewTokens, notes } = req.body || {};
    if (
      !Array.isArray(technicianIds)
      || !technicianIds.length
      || !weekStart
      || !reviewTokens
      || technicianIds.some(id => !reviewTokens[id])
    ) {
      return res.status(400).json({
        error: 'technicianIds[], weekStart, and every review token required',
      });
    }
    const result = await approval.bulkApproveWeeks({
      technicianIds, weekStart, adminId: req.technicianId, notes, reviewTokens,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /dispute { entryId, reason }
router.post('/dispute', async (req, res, next) => {
  try {
    const { entryId, reason } = req.body || {};
    if (!entryId || !reason) return res.status(400).json({ error: 'entryId and reason required' });
    const entry = await approval.disputeEntry({ entryId, adminId: req.technicianId, reason });
    res.json({ success: true, entry });
  } catch (err) { next(err); }
});

// POST /unlock { technicianId, weekStart, reviewToken, reason }
router.post('/unlock', async (req, res, next) => {
  try {
    const { technicianId, weekStart, reviewToken, reason } = req.body || {};
    if (!technicianId || !weekStart || !reviewToken) {
      return res.status(400).json({
        error: 'technicianId, weekStart, and reviewToken required',
      });
    }
    const result = await approval.unlockWeek({
      technicianId, weekStart, adminId: req.technicianId, reason, reviewToken,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// GET /export?weekStart=YYYY-MM-DD — weekly CSV payroll export
router.get('/export', async (req, res, next) => {
  try {
    const { weekStart } = req.query;
    if (!weekStart) return res.status(400).json({ error: 'weekStart required' });
    const csv = await approval.generateWeeklyPayrollExport(weekStart);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payroll_week_${weekStart}.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

router._test = { defaultPendingWeekStart };

module.exports = router;
