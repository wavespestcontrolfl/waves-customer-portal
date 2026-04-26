/**
 * Dev-only test route for the dispatch:alert event channel.
 *
 *   POST /api/admin/dev/dispatch-alert
 *   body: { type, severity?, techId?, jobId?, payload? }
 *
 * Calls server/services/dispatch-alerts.js#createAlert, which
 * inserts a dispatch_alerts row and (post-commit) broadcasts
 * dispatch:alert to the dispatch:admins room. Use this with
 * wscat to verify the channel before generators (cron / inline
 * detectors on status transitions) are wired up.
 *
 * Two gates, same shape as the other admin/dev routes:
 *   1. NODE_ENV !== 'production' — fully off in prod regardless of
 *      role. Returns 404 (not 403) so prod scanners don't see it.
 *   2. requireAdmin — even in dev/staging, plain technicians can't
 *      fire arbitrary alerts into the dispatch room.
 *
 * Remove or feature-flag once real generators exist (cron job that
 * detects late techs, inline detector on transitionJobStatus that
 * fires missed_photo, etc.).
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { createAlert } = require('../services/dispatch-alerts');
const logger = require('../services/logger');

function devOnly(req, res, next) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

router.use(devOnly, adminAuthenticate, requireAdmin);

router.post('/dispatch-alert', async (req, res) => {
  const { type, severity, techId, jobId, payload } = req.body || {};

  if (!type) {
    return res.status(400).json({ error: 'type is required' });
  }

  try {
    const row = await createAlert({ type, severity, techId, jobId, payload });
    return res.json({ ok: true, row });
  } catch (err) {
    logger.error(`[admin-dev-dispatch-alert] createAlert failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
