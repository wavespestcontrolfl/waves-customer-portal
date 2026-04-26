/**
 * Dev-only test route for the dispatch:tech_status event channel.
 *
 *   POST /api/admin/dev/tech-status
 *   body: { tech_id, status, lat?, lng?, current_job_id? }
 *
 * Calls server/services/tech-status.js#upsertTechStatus, which writes
 * the row in a transaction and (post-commit) broadcasts to the
 * dispatch:admins Socket.io room. Use this with wscat to verify the
 * end-to-end flow before the Bouncie webhook integration ships.
 *
 * Two gates:
 *   1. NODE_ENV !== 'production' — fully off in prod regardless of role.
 *      Returns 404 (not 403) so prod scanners don't even know it exists.
 *   2. requireAdmin — even in dev/staging, plain technicians can't fire
 *      arbitrary state into the admin room. Admin role only.
 *
 * Remove or feature-flag this route in a later PR once a real writer
 * (Bouncie webhook + tech-mobile heartbeat) calls upsertTechStatus.
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { upsertTechStatus } = require('../services/tech-status');
const logger = require('../services/logger');

// Hard gate: this route returns 404 in production. Order matters —
// gate runs before auth so prod never even fires the JWT verify.
function devOnly(req, res, next) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

router.use(devOnly, adminAuthenticate, requireAdmin);

router.post('/tech-status', async (req, res) => {
  const { tech_id, status, lat, lng, current_job_id } = req.body || {};

  if (!tech_id || !status) {
    return res.status(400).json({ error: 'tech_id and status are required' });
  }

  try {
    const row = await upsertTechStatus({ tech_id, status, lat, lng, current_job_id });
    return res.json({ ok: true, row });
  } catch (err) {
    logger.error(`[admin-dev-tech-status] upsert failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
