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
 * Off answers 404 { enabled: false } after the staff login check and before any query. Read only. No-store.
 */
const express = require('express');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { techRewardsScoreboardLive } = require('../config/feature-gates');
const scoreboard = require('../services/tech-rewards-scoreboard');

const router = express.Router();

router.use(adminAuthenticate, requireTechOrAdmin);
router.use((req, res, next) => {
  if (!(typeof techRewardsScoreboardLive === 'function' && techRewardsScoreboardLive())) return res.status(404).json({ enabled: false });
  return next();
});
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

router.get('/', async (req, res) => {
  const asked = req.query.technicianId;
  if (asked !== undefined && String(asked).toLowerCase() !== String(req.technicianId).toLowerCase()) {
    return res.status(403).json({ error: 'You can view only your own scoreboard.' });
  }
  try {
    return res.json({ scoreboard: await scoreboard.getScoreboard(req.technicianId) });
  } catch (err) {
    if (err instanceof scoreboard.ScoreboardError) return res.status(err.status).json({ error: err.message });
    // the error text can carry SQL: log the operation and a code only
    logger.error(`[tech-rewards-scoreboard] read failed (${err.code || err.name || 'error'})`);
    return res.status(500).json({ error: 'The scoreboard failed to load. Try again.' });
  }
});

module.exports = router;
