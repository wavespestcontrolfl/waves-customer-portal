/**
 * Admin Square Bulk Import Routes
 *
 * POST /full      — run all 5 phases
 * POST /customers — phase 1 only
 * POST /history   — phase 2 only
 * POST /bookings  — phase 3 only
 * POST /invoices  — phase 4 only
 * POST /payments  — phase 5 only
 * POST /cleanup   — run data cleanup
 * GET  /status    — import completeness stats
 */

const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const SquareBulkImport = require('../services/square-bulk-import');
const db = require('../models/db');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /status — import completeness stats
router.get('/status', async (req, res, next) => {
  try {
    const [{ count: totalCustomers }] = await db('customers').count('id as count');
    const [{ count: withSquareId }] = await db('customers').whereNotNull('square_customer_id').count('id as count');

    // Customers that have at least one service record
    const withHistory = await db('customers')
      .whereNotNull('square_customer_id')
      .whereExists(function () {
        this.select(db.raw(1)).from('service_records').whereRaw('service_records.customer_id = customers.id');
      })
      .count('id as count');
    const withHistoryCount = parseInt(withHistory[0].count) || 0;

    // Customers with square_customer_id but no service records
    const missingHistory = await db('customers')
      .whereNotNull('square_customer_id')
      .whereNotExists(function () {
        this.select(db.raw(1)).from('service_records').whereRaw('service_records.customer_id = customers.id');
      })
      .count('id as count');
    const missingHistoryCount = parseInt(missingHistory[0].count) || 0;

    const [{ count: totalServiceRecords }] = await db('service_records').count('id as count');
    const [{ count: totalPayments }] = await db('payments').count('id as count');
    const [{ count: totalScheduled }] = await db('scheduled_services').count('id as count');

    let totalInvoices = 0;
    try {
      const [{ count }] = await db('invoices').count('id as count');
      totalInvoices = parseInt(count) || 0;
    } catch { /* invoices table may not exist */ }

    const totalRecords = parseInt(totalServiceRecords) + parseInt(totalPayments) + parseInt(totalScheduled) + totalInvoices;
    const totalCust = parseInt(totalCustomers) || 1;
    const sqCust = parseInt(withSquareId) || 0;

    res.json({
      totalCustomers: parseInt(totalCustomers),
      withSquareId: sqCust,
      withHistory: withHistoryCount,
      missingHistory: missingHistoryCount,
      totalServiceRecords: parseInt(totalServiceRecords),
      totalPayments: parseInt(totalPayments),
      totalScheduled: parseInt(totalScheduled),
      totalInvoices,
      totalRecords,
      completeness: totalCust > 0 ? Math.round((sqCust / totalCust) * 100) : 0,
      historyCompleteness: sqCust > 0 ? Math.round((withHistoryCount / sqCust) * 100) : 0,
    });
  } catch (err) { next(err); }
});

// POST /full — run full 5-phase import
router.post('/full', async (req, res, next) => {
  try {
    logger.info('[admin-import] Full import requested');
    const result = await SquareBulkImport.runFullImport({});
    res.json(result);
  } catch (err) { next(err); }
});

// POST /customers — phase 1 only
router.post('/customers', async (req, res, next) => {
  try {
    const result = await SquareBulkImport.syncAllCustomers({});
    res.json(result);
  } catch (err) { next(err); }
});

// POST /history — phase 2 only
router.post('/history', async (req, res, next) => {
  try {
    const { batchSize, delayBetweenBatches } = req.body || {};
    const result = await SquareBulkImport.syncAllHistory({
      batchSize: batchSize || 10,
      delayBetweenBatches: delayBetweenBatches || 2000,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /bookings — phase 3 only
router.post('/bookings', async (req, res, next) => {
  try {
    const { startDate, endDate } = req.body || {};
    const result = await SquareBulkImport.syncAllBookings({ startDate, endDate });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /invoices — phase 4 only
router.post('/invoices', async (req, res, next) => {
  try {
    const result = await SquareBulkImport.syncAllInvoices({});
    res.json(result);
  } catch (err) { next(err); }
});

// POST /payments — phase 5 only
router.post('/payments', async (req, res, next) => {
  try {
    const { startDate } = req.body || {};
    const result = await SquareBulkImport.syncAllPayments({ startDate });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /cleanup — run data cleanup
router.post('/cleanup', async (req, res, next) => {
  try {
    const result = await SquareBulkImport.cleanupImportedData();
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
