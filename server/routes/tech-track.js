/**
 * Tech-app tracking endpoints — for now, just "On my way" to flip the
 * customer-visible state from `scheduled` → `en_route`.
 *
 *   POST /api/tech/services/:id/en-route
 *
 * Requires tech auth. Idempotent on re-tap.
 *
 * Why not Bouncie trip_start? Pulling the truck out of the shop to grab
 * coffee ≠ the customer's service starting. Sarah's page shouldn't flip to
 * "Adam is headed your way" at 6:45 AM because Adam drove to Wawa.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.post('/services/:id/en-route', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services').where({ id: req.params.id }).first();
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (svc.track_state === 'en_route' || svc.track_state === 'on_property') {
      return res.json({ success: true, state: svc.track_state, idempotent: true });
    }
    if (['complete', 'cancelled'].includes(svc.track_state)) {
      return res.status(409).json({ error: `Service is ${svc.track_state}; cannot flip to en-route` });
    }

    await db('scheduled_services').where({ id: svc.id }).update({
      track_state: 'en_route',
      en_route_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    logger.info(`[track] en_route set for service ${svc.id} by tech ${req.technicianId}`);
    res.json({ success: true, state: 'en_route' });
  } catch (err) { next(err); }
});

module.exports = router;
