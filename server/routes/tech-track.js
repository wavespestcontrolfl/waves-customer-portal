/**
 * Tech-portal tracking routes. Mounted at /api/tech/services.
 *
 * Phase 1 surface: POST /:id/en-route — flips track_state 'scheduled' →
 * 'en_route', fires the customer SMS with the /track/:token link, logs.
 *
 * Thin wrapper around services/track-transitions.js so admin-dispatch
 * and this route produce byte-identical behavior for the same input.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const trackTransitions = require('../services/track-transitions');

router.use(adminAuthenticate, requireTechOrAdmin);

// POST /api/tech/services/:id/en-route
router.post('/:id/en-route', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'technician_id');

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Tech can only flip their own assigned services. Admins with
    // requireTechOrAdmin go through admin-dispatch; don't bypass here.
    if (svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }

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
      `smsSent=${result.smsSent} alreadyEnRoute=${!!result.alreadyEnRoute}`
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
