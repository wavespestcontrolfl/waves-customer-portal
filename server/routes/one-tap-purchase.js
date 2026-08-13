'use strict';

/**
 * One-Tap Purchase Routes (portal roadmap bet 3, owner rulings 2026-08-13)
 *
 * POST   /init                    — recompute + drift-check the priced offer,
 *                                   synthesize the draft, return terms + slots.
 * POST   /:purchaseId/reserve     — hold a slot (15-min reservation).
 * DELETE /:purchaseId/reserve     — release the hold (overlay close/back).
 * GET    /:purchaseId/slots       — re-fetch availability.
 * POST   /:purchaseId/confirm     — accept + convert (no charge; card must be
 *                                   on file — 402 {needsCard} routes the
 *                                   client to the existing save-card flow).
 *
 * Dark behind GATE_ONE_TAP_PURCHASE (request-time gateEnvValue — a Railway
 * flip needs no redeploy). This router has no browse GET: the availability
 * signal rides GET /api/property-recommendations as `oneTap`. Gate-off, every
 * endpoint here answers 404 {error:'Not available'} (the write-route idiom).
 * Every handler verifies purchase ownership inside the service (404 on
 * mismatch, never a 403 leak).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { gateEnvValue } = require('../config/feature-gates');
const oneTapPurchase = require('../services/one-tap-purchase');

router.use(authenticate);

// Same posture as the recommendations request route: per-customer, low
// ceiling — these are purchase writes, not browsing actions.
const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.customerId || req.ip,
  message: { error: 'Too many attempts. Please wait a moment or call our office.' },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function gateOff(res) {
  return res.status(404).json({ error: 'Not available' });
}

function validPurchaseId(req, res) {
  const id = String(req.params.purchaseId || '').trim();
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return id;
}

function sendServiceError(res, err) {
  if (!err || !err.status) return false;
  const body = { error: err.message };
  if (err.needsCard) body.needsCard = true;
  if (err.code) body.code = err.code;
  res.status(err.status).json(body);
  return true;
}

router.post('/init', writeLimiter, async (req, res, next) => {
  try {
    if (!gateEnvValue('GATE_ONE_TAP_PURCHASE')) return gateOff(res);
    const result = await oneTapPurchase.initPurchase({
      customerId: req.customerId,
      clicked: {
        fingerprint: req.body?.fingerprint,
        serviceKey: req.body?.serviceKey,
        optionId: req.body?.optionId,
        perApplication: req.body?.perApplication,
      },
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });
    return res.json(result);
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    return next(err);
  }
});

router.post('/:purchaseId/reserve', writeLimiter, async (req, res, next) => {
  try {
    if (!gateEnvValue('GATE_ONE_TAP_PURCHASE')) return gateOff(res);
    const purchaseId = validPurchaseId(req, res);
    if (!purchaseId) return undefined;
    const slotId = typeof req.body?.slotId === 'string' ? req.body.slotId.trim() : '';
    if (!slotId) return res.status(400).json({ error: 'slotId required' });
    const result = await oneTapPurchase.reserve({
      customerId: req.customerId,
      purchaseId,
      slotId,
    });
    return res.json(result);
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    return next(err);
  }
});

router.delete('/:purchaseId/reserve', async (req, res, next) => {
  try {
    if (!gateEnvValue('GATE_ONE_TAP_PURCHASE')) return gateOff(res);
    const purchaseId = validPurchaseId(req, res);
    if (!purchaseId) return undefined;
    const result = await oneTapPurchase.release({
      customerId: req.customerId,
      purchaseId,
    });
    return res.json(result);
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    return next(err);
  }
});

// Read-only purchase snapshot for the client resume path (return from a
// hosted SetupIntent redirect). Ownership enforced in the service (404).
router.get('/:purchaseId', async (req, res, next) => {
  try {
    if (!gateEnvValue('GATE_ONE_TAP_PURCHASE')) return gateOff(res);
    const purchaseId = validPurchaseId(req, res);
    if (!purchaseId) return undefined;
    const result = await oneTapPurchase.getPurchaseState({
      customerId: req.customerId,
      purchaseId,
    });
    return res.json(result);
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    return next(err);
  }
});

router.get('/:purchaseId/slots', async (req, res, next) => {
  try {
    if (!gateEnvValue('GATE_ONE_TAP_PURCHASE')) return gateOff(res);
    const purchaseId = validPurchaseId(req, res);
    if (!purchaseId) return undefined;
    const result = await oneTapPurchase.slots({
      customerId: req.customerId,
      purchaseId,
    });
    return res.json(result);
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    return next(err);
  }
});

router.post('/:purchaseId/confirm', writeLimiter, async (req, res, next) => {
  try {
    if (!gateEnvValue('GATE_ONE_TAP_PURCHASE')) return gateOff(res);
    const purchaseId = validPurchaseId(req, res);
    if (!purchaseId) return undefined;
    const result = await oneTapPurchase.confirm({
      customerId: req.customerId,
      purchaseId,
      termsAccepted: req.body?.termsAccepted,
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });
    return res.json(result);
  } catch (err) {
    if (sendServiceError(res, err)) return undefined;
    return next(err);
  }
});

module.exports = router;
