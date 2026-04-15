const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const approval = require('../services/timesheet-approval');

// Weekly approval is admin-only (not tech). requireAdmin excludes techs.
router.use(adminAuthenticate, requireAdmin);

function mondayOf(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

// GET /pending?weekStart=YYYY-MM-DD — all techs' weekly rollups (defaults to last week)
router.get('/pending', async (req, res, next) => {
  try {
    let weekStart = req.query.weekStart;
    if (!weekStart) {
      const prev = new Date();
      prev.setDate(prev.getDate() - 7);
      weekStart = mondayOf(prev.toISOString().split('T')[0]);
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

// POST /approve { technicianId, weekStart, notes? }
router.post('/approve', async (req, res, next) => {
  try {
    const { technicianId, weekStart, notes } = req.body || {};
    if (!technicianId || !weekStart) {
      return res.status(400).json({ error: 'technicianId and weekStart required' });
    }
    const result = await approval.approveWeek({
      technicianId, weekStart, adminId: req.technicianId, notes,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// POST /bulk-approve { technicianIds: [...], weekStart, notes? }
router.post('/bulk-approve', async (req, res, next) => {
  try {
    const { technicianIds, weekStart, notes } = req.body || {};
    if (!Array.isArray(technicianIds) || !technicianIds.length || !weekStart) {
      return res.status(400).json({ error: 'technicianIds[] and weekStart required' });
    }
    const result = await approval.bulkApproveWeeks({
      technicianIds, weekStart, adminId: req.technicianId, notes,
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

// POST /unlock { technicianId, weekStart, reason }
router.post('/unlock', async (req, res, next) => {
  try {
    const { technicianId, weekStart, reason } = req.body || {};
    if (!technicianId || !weekStart) {
      return res.status(400).json({ error: 'technicianId and weekStart required' });
    }
    const result = await approval.unlockWeek({
      technicianId, weekStart, adminId: req.technicianId, reason,
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

module.exports = router;
