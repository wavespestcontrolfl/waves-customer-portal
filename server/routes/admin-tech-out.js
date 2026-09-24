/**
 * Admin API for "tech out today" (GATE_TECH_OUT_REDISTRIBUTE).
 *
 *   GET    /api/admin/tech-out/:technicianId?date=   current absence for that tech+date
 *   POST   /api/admin/tech-out/:technicianId         mark out + redistribute the day
 *   DELETE /api/admin/tech-out/:technicianId?date=   clear the absence (does not move stops back)
 *
 * Gate checked at call time on every handler — off answers 404 { enabled: false },
 * matching the other GATE_*-owned admin surfaces (e.g. admin-job-card.js).
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');
const {
  techOutEnabled, getTechOut, markTechOut, clearTechOut,
} = require('../services/tech-out');

router.use(adminAuthenticate, requireAdmin);

// A non-UUID param would surface as a Postgres cast error (500); answer 400.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('technicianId', (req, res, next, value) => {
  if (!UUID_RE.test(String(value))) return res.status(400).json({ error: 'technicianId must be a UUID' });
  next();
});

router.get('/:technicianId', async (req, res, next) => {
  if (!techOutEnabled()) return res.status(404).json({ enabled: false });
  try {
    const date = req.query.date || etDateString();
    if (!validCalendarDate(date)) return res.status(400).json({ error: 'date must be a valid calendar date (YYYY-MM-DD)' });
    const absence = await getTechOut({ technicianId: req.params.technicianId, date });
    res.json({ enabled: true, absence });
  } catch (err) { next(err); }
});

router.post('/:technicianId', async (req, res, next) => {
  if (!techOutEnabled()) return res.status(404).json({ enabled: false });
  try {
    const { date, reason, note } = req.body || {};
    const { absence, summary, resumed } = await markTechOut({
      technicianId: req.params.technicianId,
      date: date || etDateString(),
      reason,
      note,
      actorId: req.technicianId,
    });
    // 200 for a resume of an existing (incomplete) absence, 201 for a fresh mark.
    res.status(resumed ? 200 : 201).json({ absence, summary });
  } catch (err) {
    if (err.code === 'ALREADY_OUT') return res.status(409).json({ error: 'already_out' });
    if (err.code === 'PAST_DATE') return res.status(409).json({ error: 'past_date' });
    if (err.code === 'VALIDATION' || err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.delete('/:technicianId', async (req, res, next) => {
  if (!techOutEnabled()) return res.status(404).json({ enabled: false });
  try {
    const date = req.query.date || etDateString();
    if (!validCalendarDate(date)) return res.status(400).json({ error: 'date must be a valid calendar date (YYYY-MM-DD)' });
    const { absence, resolvedAlerts } = await clearTechOut({
      technicianId: req.params.technicianId,
      date,
      actorId: req.technicianId,
    });
    res.json({ absence, resolvedAlerts });
  } catch (err) {
    if (err.code === 'NOT_OUT') return res.status(404).json({ error: 'not_out' });
    next(err);
  }
});

module.exports = router;
