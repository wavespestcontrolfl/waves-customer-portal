/**
 * Tech-portal tracking routes. Mounted at /api/tech/services.
 *
 * POST /:id/en-route — tech taps "En Route" in the field. Flips
 * BOTH state machines for the service:
 *
 *   1. scheduled_services.status → 'en_route' via transitionJobStatus
 *      (the canonical sole-writer; PRs #328 / #329 / #330 migrated
 *      every other status-write call site to it). This is the
 *      admin-side state — what the dispatch board shows. Brings
 *      atomic guard, job_status_history audit, overdue-alert
 *      auto-resolve, and customer:job_update + dispatch:job_update
 *      broadcasts.
 *
 *   2. scheduled_services.track_state → 'en_route' via
 *      trackTransitions.markEnRoute. This is the customer-facing
 *      state — what /track/:token renders. Also fires the
 *      track-link SMS to the customer (idempotent on track_sms_sent_at).
 *
 * Pre-migration this route only flipped track_state, leaving the
 * admin-side status stuck at 'pending' / 'confirmed' until an admin
 * also touched the dispatch board. After this migration the two
 * state machines stay in sync regardless of which surface the
 * actor uses.
 *
 * Race + atomicity:
 *   transitionJobStatus runs inside a trx with a WHERE status =
 *   fromStatus guard. A concurrent admin transition between our
 *   SELECT and our UPDATE rejects with 409 + a refresh-and-retry
 *   message. markEnRoute is internally idempotent so a retry from
 *   any path is safe.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const trackTransitions = require('../services/track-transitions');
const { transitionJobStatus } = require('../services/job-status');

router.use(adminAuthenticate, requireTechOrAdmin);

// POST /api/tech/services/:id/en-route
router.post('/:id/en-route', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'technician_id', 'status');

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Tech can only flip their own assigned services. Admins with
    // requireTechOrAdmin go through admin-dispatch; don't bypass here.
    if (svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }

    // 1. Admin-side status flip via transitionJobStatus. Same
    // migration pattern as PRs #328 / #329 / #330. The trx + atomic
    // guard rejects on a concurrent transition; we surface as 409.
    const fromStatus = svc.status;
    try {
      await db.transaction(async (trx) => {
        await transitionJobStatus({
          jobId: svc.id,
          fromStatus,
          toStatus: 'en_route',
          transitionedBy: req.technicianId,
          trx,
        });
      });
    } catch (err) {
      if (err && err.message && err.message.includes('not in state')) {
        return res.status(409).json({
          error: `Job is no longer in state ${fromStatus} (concurrent transition). Refresh and try again.`,
        });
      }
      throw err;
    }

    // 2. Customer-facing track_state flip + SMS. Post-trx,
    // idempotent — markEnRoute checks track_state and returns
    // alreadyEnRoute=true (no SMS re-fire) if already advanced.
    // We don't roll back the admin-side status flip if this fails;
    // the dispatch board reflecting reality is more important than
    // the customer SMS firing.
    const result = await trackTransitions.markEnRoute(svc.id, {
      actorType: 'tech',
      actorId: req.technicianId,
    });

    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      return res.status(status).json({ error: result.reason });
    }

    logger.info(
      `[tech-track] en-route service=${svc.id} tech=${req.technicianId} ` +
      `fromStatus=${fromStatus} smsSent=${result.smsSent} alreadyEnRoute=${!!result.alreadyEnRoute}`
    );

    res.json({
      state: result.state,
      enRouteAt: result.enRouteAt,
      smsSent: result.smsSent,
      alreadyEnRoute: !!result.alreadyEnRoute,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
