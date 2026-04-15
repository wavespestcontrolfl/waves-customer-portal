/**
 * Admin — Job Expenses
 *
 * Thin CRUD around the expenses table for receipts attached to a specific
 * scheduled_service. General expense management lives in /api/admin/expenses.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});
const RECEIPT_PREFIX = 'job-receipts/';

// GET /api/admin/job-expenses?scheduled_service_id=
router.get('/', async (req, res, next) => {
  try {
    const { scheduled_service_id, customer_id, technician_id, limit = 100 } = req.query;
    let q = db('expenses as e')
      .leftJoin('expense_categories as cat', 'e.category_id', 'cat.id')
      .leftJoin('technicians as t', 'e.technician_id', 't.id')
      .select('e.*', 'cat.name as category_name', 't.name as technician_name')
      .whereNotNull('e.scheduled_service_id')
      .orderBy('e.expense_date', 'desc')
      .limit(Number(limit) || 100);

    if (scheduled_service_id) q = q.where('e.scheduled_service_id', scheduled_service_id);
    if (customer_id) q = q.where('e.customer_id', customer_id);
    if (technician_id) q = q.where('e.technician_id', technician_id);

    const rows = await q;
    res.json({ expenses: rows });
  } catch (err) { next(err); }
});

// POST /api/admin/job-expenses
router.post('/', async (req, res, next) => {
  try {
    const {
      scheduled_service_id, technician_id, customer_id,
      category_id, description, amount, vendor_name,
      payment_method, expense_date, receipt_s3_key, notes,
    } = req.body;
    if (!scheduled_service_id) return res.status(400).json({ error: 'scheduled_service_id required' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'amount required' });

    const [row] = await db('expenses').insert({
      scheduled_service_id,
      technician_id: technician_id || null,
      customer_id: customer_id || null,
      category_id: category_id || null,
      description: description || 'Job expense',
      amount: Number(amount),
      tax_deductible_amount: Number(amount),
      vendor_name: vendor_name || null,
      payment_method: payment_method || null,
      expense_date: expense_date || new Date(),
      receipt_s3_key: receipt_s3_key || null,
      notes: notes || null,
    }).returning('*');

    // Recalc the job's cost to absorb the new expense
    try {
      const JobCosting = require('../services/job-costing');
      JobCosting.calculateJobCost(scheduled_service_id).catch(() => {});
    } catch { /* non-critical */ }

    res.json({ expense: row });
  } catch (err) { next(err); }
});

// PUT /api/admin/job-expenses/:id
router.put('/:id', async (req, res, next) => {
  try {
    const updates = {};
    const fields = ['description', 'amount', 'vendor_name', 'payment_method', 'expense_date', 'receipt_s3_key', 'notes', 'category_id'];
    for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];
    if (updates.amount !== undefined) updates.tax_deductible_amount = Number(updates.amount);

    const existing = await db('expenses').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Not found' });

    await db('expenses').where({ id: req.params.id }).update(updates);

    if (existing.scheduled_service_id) {
      try {
        const JobCosting = require('../services/job-costing');
        JobCosting.calculateJobCost(existing.scheduled_service_id).catch(() => {});
      } catch { /* non-critical */ }
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/job-expenses/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await db('expenses').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await db('expenses').where({ id: req.params.id }).del();
    if (existing.scheduled_service_id) {
      try {
        const JobCosting = require('../services/job-costing');
        JobCosting.calculateJobCost(existing.scheduled_service_id).catch(() => {});
      } catch { /* non-critical */ }
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/job-expenses/receipt-upload — multipart receipt, returns s3_key
router.post('/receipt-upload', upload.single('receipt'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${RECEIPT_PREFIX}${Date.now()}-${safeName}`;
    await s3.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));
    logger.info(`[job-expenses] Receipt uploaded: ${key} (${(req.file.size / 1024).toFixed(0)} KB)`);
    res.json({ receipt_s3_key: key, file_name: req.file.originalname, file_size: req.file.size });
  } catch (err) { next(err); }
});

// GET /api/admin/job-expenses/:id/receipt-url — presigned download
router.get('/:id/receipt-url', async (req, res, next) => {
  try {
    const row = await db('expenses').where({ id: req.params.id }).first();
    if (!row?.receipt_s3_key) return res.status(404).json({ error: 'No receipt' });
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: config.s3.bucket, Key: row.receipt_s3_key,
    }), { expiresIn: 3600 });
    res.json({ url });
  } catch (err) { next(err); }
});

module.exports = router;
