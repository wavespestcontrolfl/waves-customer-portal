/**
 * /api/tech/answers — three instant answers for the technician, from the
 * Intelligence Bar chips. Deterministic and read-only: no model call, no write.
 *
 *   GET /        → { kinds: [{ kind, label }] }
 *   GET /:kind   → { kind, title, lines, visitId }   kind: next_stop |
 *                  access_notes | last_treatment
 *
 * Dark behind GATE_TECH_INSTANT_ANSWERS: both routes answer 404 when off.
 *
 * Scope: answers are ALWAYS about visits assigned to req.technicianId, even
 * for an admin login (the owner works a route too). The visit-scope helper
 * that lets an admin reach any visit is deliberately not used here.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { techInstantAnswersLive } = require('../config/feature-gates');
const { INSTANT_ANSWER_KINDS, answer } = require('../services/tech-instant-answers');

router.use(adminAuthenticate, requireTechOrAdmin);

// A DB error message can carry the customer's id or name in its bindings. Log
// the code only and hand the error middleware a clean error.
function sanitized(err, label) {
  const code = String((err && (err.code || err.name)) || 'error');
  logger.error(`[tech-answers] ${label} failed (${code})`);
  const safe = new Error(`Tech answers ${label} failed`);
  safe.isOperational = true;
  safe.statusCode = 500;
  safe.code = code;
  return safe;
}

router.get('/', (req, res) => {
  if (!techInstantAnswersLive()) return res.status(404).json({ error: 'Not found' });
  res.json({ kinds: Object.entries(INSTANT_ANSWER_KINDS).map(([kind, label]) => ({ kind, label })) });
});

router.get('/:kind', async (req, res, next) => {
  if (!techInstantAnswersLive()) return res.status(404).json({ error: 'Not found' });
  const { kind } = req.params;
  if (!Object.prototype.hasOwnProperty.call(INSTANT_ANSWER_KINDS, kind)) {
    return res.status(400).json({ error: 'Unknown answer' });
  }
  try {
    res.json(await answer(db, kind, { technicianId: req.technicianId }));
  } catch (err) {
    next(sanitized(err, kind));
  }
});

module.exports = router;
