const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate } = require('../middleware/admin-auth');
const featureGates = require('../config/feature-gates');
const logger = require('../services/logger');

// The technician estimate tool, step 1 of 4: setup and a price preview. Nothing is saved or sent.
// GATE_TECH_ESTIMATES (owner 2026-11-09): the later steps text customers and the preview runs the paid property lookup.
router.use(adminAuthenticate);

const OFF = { enabled: false };

// Gate off, or a technician whose own switch is off: 404 before any customer read. An admin always passes.
router.use(async (req, res, next) => {
  try {
    if (!featureGates.techEstimatesLive()) return res.status(404).json(OFF);
    if (req.techRole === 'admin') return next();
    const row = await db('technicians').where({ id: req.technicianId }).first('can_create_estimates');
    if (!row || row.can_create_estimates !== true) return res.status(404).json(OFF);
    return next();
  } catch (err) { return next(err); }
});

/* GET /setup — the services this login may quote */
router.get('/setup', async (req, res, next) => {
  try {
    res.json(await require('../services/tech-estimate-price').setupFor(req));
  } catch (err) { next(err); }
});

/* POST /price — price a quote at list price; saves nothing */
router.post('/price', async (req, res, next) => {
  const Price = require('../services/tech-estimate-price');
  try {
    res.json(await Price.priceQuote(req, req.body || {}));
  } catch (err) {
    if (err instanceof Price.PriceRefusal) return res.status(err.status).json({ error: err.message, ...err.extra });
    logger.error(`[tech-estimates] price failed: ${err.message}`);
    return next(err);
  }
});

module.exports = router;
