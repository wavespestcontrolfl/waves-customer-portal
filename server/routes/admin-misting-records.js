/**
 * Misting system records for a customer: the install calibration and the tank refill log
 * (dark behind GATE_MOSQUITO_MISTING; services/misting-records.js).
 *
 *   GET  /api/admin/misting-records/customers/:customerId/records       properties, calibrations, refills
 *   POST /api/admin/misting-records/customers/:customerId/calibrations  record an install calibration -> { calibration }
 *   POST /api/admin/misting-records/customers/:customerId/refills       log a tank refill -> { refill }
 *   POST /api/admin/misting-records/calibrations/:id/void               body { reason } -> { calibration }
 *   POST /api/admin/misting-records/refills/:id/void                    body { reason } -> { refill }
 *
 * Admin only (technicians do not get these in v1). The gate is read per request; with it off every route
 * answers 404 before any database read, so the surface is indistinguishable from an unknown route.
 * Records change nothing else: no price, no customer message.
 */
const express = require('express');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const records = require('../services/misting-records');

const router = express.Router();

const notEnabled = (req, res, next) => (records.recordsEnabled() ? next() : res.status(404).json({ error: 'Not enabled' }));
const adminOnly = [adminAuthenticate, requireAdmin, notEnabled];

// A non-uuid id cannot name a row.
const uuidParam = (name, message) => (req, res, next) => (
  records.isUuid(req.params[name]) ? next() : res.status(404).json({ error: message })
);

function fail(res, next, err, what) {
  if (err?.isOperational) return res.status(err.statusCode || 400).json({ error: err.message, code: err.code });
  logger.error(`[admin-misting-records] ${what} failed: ${err.message}`);
  return next(err);
}

router.get('/customers/:customerId/records', ...adminOnly, uuidParam('customerId', 'Customer not found.'), async (req, res, next) => {
  try {
    return res.json(await records.listCustomerRecords(req.params.customerId));
  } catch (err) {
    return fail(res, next, err, 'read');
  }
});

router.post('/customers/:customerId/calibrations', ...adminOnly, uuidParam('customerId', 'Customer not found.'), async (req, res, next) => {
  try {
    const calibration = await records.createCalibration({
      customerId: req.params.customerId,
      input: req.body,
      actorId: req.technicianId || null,
    });
    logger.info(
      `[admin-misting-records] calibration customer=${req.params.customerId} id=${calibration.id} by=${req.technicianId || 'n/a'} `
      + `daily=${calibration.dailyOutputFlOz} cap=${calibration.labelDailyCapFlOz}`,
    );
    return res.status(201).json({ calibration });
  } catch (err) {
    return fail(res, next, err, 'calibration save');
  }
});

router.post('/customers/:customerId/refills', ...adminOnly, uuidParam('customerId', 'Customer not found.'), async (req, res, next) => {
  try {
    const refill = await records.createRefill({
      customerId: req.params.customerId,
      input: req.body,
      actorId: req.technicianId || null,
    });
    logger.info(
      `[admin-misting-records] refill customer=${req.params.customerId} id=${refill.id} by=${req.technicianId || 'n/a'} `
      + `concentrate=${refill.concentrateFlOzAdded} water=${refill.waterGallonsAdded}`,
    );
    return res.status(201).json({ refill });
  } catch (err) {
    return fail(res, next, err, 'refill save');
  }
});

router.post('/calibrations/:id/void', ...adminOnly, uuidParam('id', 'Calibration not found.'), async (req, res, next) => {
  try {
    const calibration = await records.voidCalibration({
      id: req.params.id,
      reason: req.body?.reason,
      actorId: req.technicianId || null,
    });
    logger.info(`[admin-misting-records] calibration voided id=${req.params.id} by=${req.technicianId || 'n/a'}`);
    return res.json({ calibration });
  } catch (err) {
    return fail(res, next, err, 'calibration void');
  }
});

router.post('/refills/:id/void', ...adminOnly, uuidParam('id', 'Refill not found.'), async (req, res, next) => {
  try {
    const refill = await records.voidRefill({
      id: req.params.id,
      reason: req.body?.reason,
      actorId: req.technicianId || null,
    });
    logger.info(`[admin-misting-records] refill voided id=${req.params.id} by=${req.technicianId || 'n/a'}`);
    return res.json({ refill });
  } catch (err) {
    return fail(res, next, err, 'refill void');
  }
});

module.exports = router;
