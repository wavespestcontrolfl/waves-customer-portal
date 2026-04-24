/**
 * Public slot-availability + reservation routes for the estimate view.
 *
 * GET /api/public/estimates/:token/available-slots
 *   Returns the 3 best route-optimal time slots over the next 14 days
 *   plus an expander list. No auth — token is the only gate. Rate-limited
 *   at 30/min per IP.
 *
 * POST /api/public/estimates/:token/reserve
 *   Body: { slotId }. Creates a 15-minute hold on the chosen slot as a
 *   scheduled_services row with reservation_expires_at set. Rate-limited
 *   at 10/min (tighter than GET — actual writes). Subsequent accept call
 *   commits the reservation; abandoned reservations get reclaimed.
 *
 * Query params on GET:
 *   ?windowDays=14    override lookahead window
 *   ?expand=true      include full expander list (default true anyway)
 *
 * Errors:
 *   404 — token not found, or estimate expired (expires_at in past)
 *   409 — estimate in terminal state, or slot no longer available
 *   429 — rate limited
 *   5xx — sanitized; logged with full context server-side.
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { getAvailableSlots } = require('../services/estimate-slot-availability');
const slotReservation = require('../services/slot-reservation');

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

// Tighter per-route limiter for POST /reserve (actual writes — 10/min
// stacks below the router-level 30/min GET limiter).
const reserveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reservation attempts. Please try again in a minute.' },
});

// POST /:token/reserve — create a 15-min hold on a slot
router.post('/:token/reserve', reserveLimiter, async (req, res) => {
  const token = req.params.token;
  if (!token || !TOKEN_RE.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const slotId = req.body && typeof req.body.slotId === 'string' ? req.body.slotId.trim() : '';
  if (!slotId) {
    return res.status(400).json({ error: 'slotId required' });
  }

  try {
    const estimate = await db('estimates').where({ token }).first('id', 'status', 'expires_at');
    if (!estimate) {
      return res.status(404).json({ error: 'Not found' });
    }

    try {
      const { scheduledServiceId, expiresAt } = await slotReservation.reserveSlot({
        estimateId: estimate.id,
        slotId,
      });
      return res.status(201).json({
        scheduledServiceId,
        expiresAt,
        slotConfirmed: { slotId },
      });
    } catch (svcErr) {
      if (svcErr.code === 'INVALID_SLOT_ID') {
        return res.status(400).json({ error: 'invalid slotId format' });
      }
      if (svcErr.code === 'ESTIMATE_NOT_FOUND' || svcErr.code === 'ESTIMATE_EXPIRED') {
        return res.status(404).json({ error: 'Not found' });
      }
      if (svcErr.code === 'ESTIMATE_TERMINAL') {
        return res.status(409).json({ error: 'Estimate is no longer active' });
      }
      if (svcErr.code === 'SLOT_UNAVAILABLE') {
        // Refresh slot availability for the estimate so the caller can
        // re-render without another round trip.
        let fresh = null;
        try {
          fresh = await getAvailableSlots(estimate.id);
        } catch (freshErr) {
          logger.warn(`[estimate-slots-public] fresh slots lookup failed: ${freshErr.message}`);
        }
        return res.status(409).json({
          error: 'slot no longer available',
          slotId: svcErr.slotId,
          nextBest: fresh?.primary?.[0] || null,
          availableSlots: fresh,
        });
      }
      throw svcErr;
    }
  } catch (err) {
    logger.error(`[estimate-slots-public:reserve] ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'unable to reserve slot', retry: true });
  }
});

// DELETE /:token/reserve/:scheduledServiceId — release a live hold
// when the customer taps "Change my pick" or closes the tab. Narrow —
// only deletes rows still in reservation state (no customer_id). Safe
// to spam; always returns 200 so the client never has to special-case
// "already released."
router.delete('/:token/reserve/:scheduledServiceId', async (req, res) => {
  const token = req.params.token;
  const scheduledServiceId = req.params.scheduledServiceId;
  if (!token || !TOKEN_RE.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const estimate = await db('estimates').where({ token }).first('id');
    if (!estimate) return res.status(404).json({ error: 'Not found' });
    const result = await slotReservation.releaseReservation({
      scheduledServiceId,
      estimateId: estimate.id,
    });
    return res.json({ ok: true, released: result.released });
  } catch (err) {
    logger.error(`[estimate-slots-public:release] ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'unable to release reservation' });
  }
});

module.exports = router;
