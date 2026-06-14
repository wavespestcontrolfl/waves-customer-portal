/**
 * Admin turf-height review queue (PR2).
 *
 * Surfaces readings whose dual-model gauge OCR diverged from the manual entry
 * (`discrepancy`) or couldn't be read (`ocr_failed`). Manual entry is the source
 * of truth everywhere customer-facing; this queue is QA only. `resolve` just
 * clears the review flag after a human looks — it never changes the height.
 */
const express = require('express');

const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const photos = require('../services/photos');

router.use(adminAuthenticate, requireTechOrAdmin);

const REVIEW_STATES = ['discrepancy', 'ocr_failed'];

// GET /api/admin/turf-height/review — readings needing a human look. Newest first.
router.get('/review', async (req, res, next) => {
  try {
    const rows = await db('turf_height_readings as thr')
      .leftJoin('customers as c', 'c.id', 'thr.customer_id')
      .leftJoin('service_photos as sp', 'sp.id', 'thr.gauge_photo_id')
      .whereIn('thr.verification_status', REVIEW_STATES)
      .orderBy('thr.measured_at', 'desc')
      .limit(200)
      .select(
        'thr.id',
        'thr.customer_id',
        'thr.grass_type',
        'thr.manual_height_in',
        'thr.ocr_height_in',
        'thr.ocr_confidence',
        'thr.verification_status',
        'thr.target_min_in',
        'thr.target_max_in',
        'thr.range_status',
        'thr.measured_at',
        'sp.s3_key as gauge_s3_key',
        'c.first_name as cust_first',
        'c.last_name as cust_last',
      );

    const items = await Promise.all(rows.map(async (r) => ({
      id: r.id,
      customerId: r.customer_id,
      customerName: `${r.cust_first || ''} ${r.cust_last || ''}`.trim() || null,
      grassType: r.grass_type,
      manualHeightIn: r.manual_height_in != null ? Number(r.manual_height_in) : null,
      ocrHeightIn: r.ocr_height_in != null ? Number(r.ocr_height_in) : null,
      ocrConfidence: r.ocr_confidence != null ? Number(r.ocr_confidence) : null,
      verificationStatus: r.verification_status,
      band: { min: Number(r.target_min_in), max: Number(r.target_max_in) },
      rangeStatus: r.range_status,
      measuredAt: r.measured_at,
      gaugePhotoUrl: r.gauge_s3_key ? await photos.getViewUrl(r.gauge_s3_key, 600).catch(() => null) : null,
    })));

    res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/turf-height/:id/resolve — clear the review flag after a human
// look. Body: { status: 'verified' }. Never changes the height (manual = truth).
router.patch('/:id/resolve', async (req, res, next) => {
  try {
    if ((req.body || {}).status !== 'verified') {
      return res.status(400).json({ error: "status must be 'verified'" });
    }
    const updated = await db('turf_height_readings')
      .where({ id: req.params.id })
      .whereIn('verification_status', REVIEW_STATES)
      .update({ verification_status: 'verified', updated_at: db.fn.now() });
    if (!updated) return res.status(404).json({ error: 'Reading not found or not in review' });
    res.json({ ok: true, id: req.params.id, verification_status: 'verified' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
