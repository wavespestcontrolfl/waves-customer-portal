/**
 * Owner preview of a technician's rewards scoreboard (Tech Rewards Plan D5-4). Admin only, NOT behind
 * GATE_TECH_REWARDS_SCOREBOARD: the owner checks the numbers here before he turns the technician view on.
 *
 * GET /                    { technicians: [{ id, name }] }  active technicians for the picker.
 * GET /:technicianId       { scoreboard }  exactly what that technician would see (same service, same numbers).
 *
 * Read only; writes nothing. 404 for an unknown technician, 400 for a malformed id. No-store.
 */
const express = require('express');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const scoreboard = require('../services/tech-rewards-scoreboard');

const router = express.Router();
router.use(adminAuthenticate);
router.use(requireAdmin);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

function fail(res, err, what) {
  if (err instanceof scoreboard.ScoreboardError) return res.status(err.status).json({ error: err.message });
  logger.error(`[admin-tech-rewards-scoreboard] ${what} failed (${err.code || err.name || 'error'})`);
  return res.status(500).json({ error: `Could not ${what}.` });
}

router.get('/', async (req, res) => {
  try {
    res.json({ technicians: await scoreboard.listTechnicians() });
  } catch (err) { fail(res, err, 'list technicians'); }
});

router.get('/:technicianId', async (req, res) => {
  try {
    res.json({ scoreboard: await scoreboard.getScoreboard(req.params.technicianId) });
  } catch (err) { fail(res, err, 'load the scoreboard'); }
});

module.exports = router;
