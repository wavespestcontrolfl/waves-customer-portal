/**
 * A technician's own rewards scoreboard (Tech Rewards Plan D5-4), dark behind GATE_TECH_REWARDS_SCOREBOARD.
 *
 * GET /   { scoreboard }: the signed-in technician's season score and parts, review rate, commission year to
 *         date, season bonus estimate and next stay bonus date (services/tech-rewards-scoreboard.js).
 *
 * Own numbers only (owner ruling 2026-11-04: a technician sees their own customers and pay, never another
 * technician's). The technician is ALWAYS the authenticated one (req.technicianId). A technicianId query
 * parameter is accepted only when it names the caller; any other id answers 403 before any read. An admin
 * login reads its own board here too: the owner's look at another technician is /api/admin/tech-rewards-scoreboard.
 * GET /year-statement?year=YYYY  { statement }: the signed-in technician's pay statement for one calendar year, from their
 *         finalized paychecks (services/tech-rewards-year-statement.js, Plan D5-6). No year = this year. The same own-only rule.
 * GET /availability  { available } the light check the Staff page makes on every load (the board itself loads only when the
 *         Scoreboard tab opens).
 * Off answers 404 { enabled: false } after the staff login check and before any query. Read only. No-store.
 */
const express = require('express');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { techRewardsScoreboardLive } = require('../config/feature-gates');
const scoreboard = require('../services/tech-rewards-scoreboard');
const { getYearStatement } = require('../services/tech-rewards-year-statement');

const router = express.Router();

const gateOn = () => typeof techRewardsScoreboardLive === 'function' && techRewardsScoreboardLive();

router.use(adminAuthenticate, requireTechOrAdmin);
// The light check the Staff page makes on every load: only whether the tab shows. It reads nothing else.
router.get('/availability', (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json({ available: gateOn() });
});
router.use((req, res, next) => {
  if (!gateOn()) return res.status(404).json({ enabled: false });
  return next();
});
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

// Own numbers only: a technicianId that names anyone but the caller is refused before any read. So is one that is not a
// single plain value (a query string can carry an array or an object).
router.use((req, res, next) => {
  const asked = req.query.technicianId;
  if (asked !== undefined && (typeof asked !== 'string' || asked.toLowerCase() !== String(req.technicianId).toLowerCase())) {
    return res.status(403).json({ error: 'You can view only your own scoreboard.' });
  }
  return next();
});

function fail(res, err, what) {
  if (err instanceof scoreboard.ScoreboardError) return res.status(err.status).json({ error: err.message });
  // the error text can carry SQL: log the operation and a code only
  logger.error(`[tech-rewards-scoreboard] ${what} read failed (${err.code || err.name || 'error'})`);
  return res.status(500).json({ error: `The ${what} failed to load. Try again.` });
}

router.get('/', async (req, res) => {
  try {
    return res.json({ scoreboard: await scoreboard.getScoreboard(req.technicianId) });
  } catch (err) { return fail(res, err, 'scoreboard'); }
});

router.get('/year-statement', async (req, res) => {
  try {
    return res.json({ statement: await getYearStatement(req.technicianId, req.query.year) });
  } catch (err) { return fail(res, err, 'pay statement'); }
});

module.exports = router;
