'use strict';

/**
 * Customer-Facing Property Alerts Route
 *
 * GET / — the authenticated customer's recent property alerts (the same
 * rows the daily sweep ledgered; see server/services/property-alerts.js).
 * Dark behind GATE_PROPERTY_ALERTS (default OFF), read at request time via
 * the shared gateEnvValue parser so a Railway flip needs no redeploy.
 * Gate-off answers 200 {available:false} — the client renders nothing
 * rather than an error (same contract as the property-score and
 * property-recommendations cards).
 */

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { gateEnvValue } = require('../config/feature-gates');
const { listCustomerAlerts } = require('../services/property-alerts');

router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    if (!gateEnvValue('GATE_PROPERTY_ALERTS')) {
      return res.json({ available: false, reason: 'disabled' });
    }
    const alerts = await listCustomerAlerts(req.customerId);
    return res.json({ available: true, alerts });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
