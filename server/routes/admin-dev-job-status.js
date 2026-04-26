/**
 * Dev-only test route for the customer:job_update event channel.
 *
 *   POST /api/admin/dev/job-status
 *   body: { jobId, fromStatus, toStatus }
 *
 * Calls server/services/job-status.js#transitionJobStatus, which
 * updates scheduled_services.status + appends to job_status_history
 * in a single transaction and (post-commit) broadcasts
 * customer:job_update to the customer:<id> room. Use this with
 * wscat to verify the flow before wiring real status-change paths.
 *
 * Two gates:
 *   1. NODE_ENV !== 'production' — fully off in prod regardless of
 *      role. Returns 404 (not 403) so prod scanners don't even know
 *      it exists.
 *   2. requireAdmin — even in dev/staging, plain technicians can't
 *      fire arbitrary state into customer rooms.
 *
 * Same gating shape as POST /api/admin/dev/tech-status (#284).
 *
 * Remove or feature-flag this route in a later PR once real writers
 * (admin-schedule.js, admin-dispatch.js, Bouncie webhook) call
 * transitionJobStatus directly.
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { transitionJobStatus } = require('../services/job-status');
const logger = require('../services/logger');

function devOnly(req, res, next) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

router.use(devOnly, adminAuthenticate, requireAdmin);

router.post('/job-status', async (req, res) => {
  const { jobId, fromStatus, toStatus } = req.body || {};

  // fromStatus is mandatory. Without it, transitionJobStatus's atomic
  // guard would have nothing to gate on and racing transitions could
  // overwrite each other silently (Codex P1 on #290).
  if (!jobId || !fromStatus || !toStatus) {
    return res.status(400).json({
      error: 'jobId, fromStatus, and toStatus are required',
    });
  }

  try {
    const { customerPayload, adminPayload } = await transitionJobStatus({
      jobId,
      fromStatus,
      toStatus,
      transitionedBy: req.technicianId,
    });
    return res.json({ ok: true, customerPayload, adminPayload });
  } catch (err) {
    logger.error(`[admin-dev-job-status] transition failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
