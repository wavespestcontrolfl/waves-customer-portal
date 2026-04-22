/**
 * Public slot-availability route for the customer-facing estimate view.
 *
 * GET /api/public/estimates/:token/available-slots
 *   Returns the 3 best route-optimal time slots over the next 14 days
 *   plus an expander list. No auth — token is the only gate. Rate-limited
 *   at 30/min per IP (customer hits this on estimate view + a few refreshes;
 *   no polling behavior on this endpoint).
 *
 * Query params:
 *   ?windowDays=14    override lookahead window
 *   ?expand=true      include full expander list (default true anyway —
 *                     the UI wants both primary + "see more times")
 *
 * Errors:
 *   404 — token not found, or estimate expired (expires_at in past)
 *   409 — estimate in terminal state (accepted / declined / expired status)
 *   429 — rate limited
 *   5xx — sanitized: { error: 'unable to load availability', retry: true }
 *         logged with full context server-side; never leaks internals.
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { getAvailableSlots } = require('../services/estimate-slot-availability');

const TOKEN_RE = /^[a-f0-9]{64}$|^[a-z0-9-]{3,80}$/i;
// Accept both the legacy admin slug tokens (nameSlug-8hex) AND the new
// 64-char hex format. Post-estimate-versions PR every new token will be
// 64-char hex; existing slug tokens remain valid for historical estimates
// and their customer links shouldn't break.

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
}));

router.get('/:token/available-slots', async (req, res) => {
  const token = req.params.token;
  if (!token || !TOKEN_RE.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const estimate = await db('estimates').where({ token }).first('id', 'status', 'expires_at');
    if (!estimate) {
      return res.status(404).json({ error: 'Not found' });
    }

    const windowDays = Number.parseInt(req.query.windowDays, 10);
    const opts = {};
    if (Number.isFinite(windowDays) && windowDays > 0 && windowDays <= 30) {
      opts.windowDays = windowDays;
    }

    try {
      const result = await getAvailableSlots(estimate.id, opts);
      return res.json(result);
    } catch (svcErr) {
      if (svcErr.code === 'ESTIMATE_NOT_FOUND' || svcErr.code === 'ESTIMATE_EXPIRED') {
        return res.status(404).json({ error: 'Not found' });
      }
      if (svcErr.code === 'ESTIMATE_TERMINAL') {
        return res.status(409).json({ error: 'Estimate is no longer active' });
      }
      throw svcErr;
    }
  } catch (err) {
    logger.error(`[estimate-slots-public] ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'unable to load availability', retry: true });
  }
});

module.exports = router;
