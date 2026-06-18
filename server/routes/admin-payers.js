/**
 * Admin API for third-party payers (Bill-To accounts).
 *
 * A payer is a reusable Bill-To entity attached to a customer (default) and/or
 * a specific scheduled service (per-job override). Invoices resolve and
 * snapshot the payer at creation, then route the invoice email to the payer's
 * AP inbox. See server/services/payer.js + the 20260617000002 migration.
 *
 * Billing data → admin-only.
 */

const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const PayerService = require('../services/payer');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireAdmin);

// GET /api/admin/payers?search=&includeInactive=true
router.get('/', async (req, res, next) => {
  try {
    const payers = await PayerService.listPayers({
      search: req.query.search,
      includeInactive: req.query.includeInactive === 'true' || req.query.includeInactive === '1',
    });
    res.json({ payers });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/payers/:id
router.get('/:id', async (req, res, next) => {
  try {
    const payer = await PayerService.getPayer(req.params.id);
    if (!payer) return res.status(404).json({ error: 'Payer not found' });
    res.json({ payer });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/payers
router.post('/', async (req, res, next) => {
  try {
    const { payer, error } = await PayerService.createPayer(req.body || {});
    if (error) return res.status(400).json({ error });
    logger.info(`[payers] created payer ${payer.id}`);
    res.status(201).json({ payer });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/payers/:id
router.put('/:id', async (req, res, next) => {
  try {
    const { payer, error, notFound } = await PayerService.updatePayer(req.params.id, req.body || {});
    if (notFound) return res.status(404).json({ error });
    if (error) return res.status(400).json({ error });
    res.json({ payer });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
