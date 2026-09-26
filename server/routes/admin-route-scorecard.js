/**
 * Admin API for the per-day drive-vs-stops scorecard (GATE_ROUTE_SCORECARD).
 *
 *   GET /api/admin/route-scorecard/status        {enabled}
 *   GET /api/admin/route-scorecard?from=&to=     404 {enabled:false} when the
 *                                                 gate is off, 400 on an
 *                                                 invalid range, else the
 *                                                 scorecard payload.
 *
 * Read-only: no writes, no customer surface. Gate checked at call time on
 * every handler, matching the other GATE_*-owned admin surfaces (e.g.
 * admin-tech-out.js).
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { routeScorecardEnabled, validDateRange, getDayScorecard } = require('../services/scheduling/day-scorecard');

router.use(adminAuthenticate, requireAdmin);

router.get('/status', (req, res) => {
  res.json({ enabled: routeScorecardEnabled() });
});

router.get('/', async (req, res, next) => {
  if (!routeScorecardEnabled()) return res.status(404).json({ enabled: false });
  try {
    const from = req.query.from || etDateString(addETDays(new Date(), -7));
    const to = req.query.to || etDateString(addETDays(new Date(), 7));
    if (!validDateRange(from, to)) return res.status(400).json({ error: 'Use a valid date range of at most 31 days.' });
    const payload = await getDayScorecard({ date_from: from, date_to: to });
    if (payload.error) return res.status(400).json({ error: payload.error });
    res.json(payload);
  } catch (err) { next(err); }
  return undefined;
});

module.exports = router;
