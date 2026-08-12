'use strict';

/**
 * Customer-Facing Property Score Route
 *
 * One endpoint: the authenticated customer's unified Property Score
 * (see server/services/property-score.js). Dark behind GATE_PROPERTY_SCORE
 * (default OFF), read at request time via the shared gateEnvValue parser so
 * a Railway flip needs no redeploy. Gate-off answers 200 {available:false}
 * — the client renders nothing rather than an error (same contract as the
 * termite-bond card).
 */

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { gateEnvValue } = require('../config/feature-gates');
const { buildPropertyScore } = require('../services/property-score');

router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    if (!gateEnvValue('GATE_PROPERTY_SCORE')) {
      return res.json({ available: false, reason: 'disabled' });
    }
    const result = await buildPropertyScore(req.customerId);
    return res.json({ available: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
