const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const ReviewService = require('../services/review-request');
const db = require('../models/db');

router.use(adminAuthenticate, requireTechOrAdmin);
// 2026-08-25 role lockdown: the review-request queue (reads return customer
// name/phone) is owner-only. Technician exemptions are the two field
// completion triggers only: POST /trigger (Dispatch surface) and
// POST /tech-trigger (deployed native tech app — breaking it is a P0).
const TECH_TRIGGER_PATHS = new Set(['/trigger', '/tech-trigger']);
router.use((req, res, next) => (
  req.method === 'POST' && TECH_TRIGGER_PATHS.has(req.path) ? next() : requireAdmin(req, res, next)
));

// GET /stats
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await ReviewService.getStats();
    res.json(stats);
  } catch (err) { next(err); }
});

// GET / — list review requests
router.get('/', async (req, res, next) => {
  try {
    const { status, limit = 50, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let query = db('review_requests')
      .leftJoin('customers', 'review_requests.customer_id', 'customers.id')
      .select('review_requests.*', 'customers.first_name', 'customers.last_name', 'customers.phone');
    if (status) query = query.where('review_requests.status', status);
    const requests = await query.orderBy('review_requests.created_at', 'desc').limit(parseInt(limit)).offset(offset);
    res.json({ requests });
  } catch (err) { next(err); }
});

// POST /trigger — manually trigger a review request for a customer
router.post('/trigger', async (req, res, next) => {
  try {
    const { customerId, serviceRecordId, scheduledServiceId } = req.body;
    // Allowlisted manual provenance only — NEVER the caller's raw string. A
    // request body claiming 'auto' would bypass the manual-trigger gate stack
    // in ReviewService.create and leave a scheduled ask processScheduled()
    // sends without rechecking (pre-push audit r1).
    // 'tech' stays allowed — DispatchPageV2 posts it and the techTriggered
    // metric + audit provenance count triggered_by='tech' (codex #3285 r8).
    const triggeredBy = ['admin', 'csr', 'tech'].includes(req.body.triggeredBy) ? req.body.triggeredBy : 'admin';
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    let resolvedServiceRecordId = serviceRecordId || null;
    let serviceContext = {};

    if (resolvedServiceRecordId) {
      const sr = await db('service_records').where({ id: resolvedServiceRecordId }).first();
      if (!sr) return res.status(404).json({ error: 'serviceRecordId not found' });
      if (sr.customer_id !== customerId) {
        return res.status(409).json({ error: 'serviceRecordId does not belong to customerId' });
      }
    } else if (scheduledServiceId) {
      const sr = await db('service_records')
        .where({ customer_id: customerId, scheduled_service_id: scheduledServiceId })
        .first();
      if (sr) {
        resolvedServiceRecordId = sr.id;
      } else {
        const svc = await db('scheduled_services')
          .where({
            'scheduled_services.id': scheduledServiceId,
            'scheduled_services.customer_id': customerId,
          })
          .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
          .select('scheduled_services.*', 'technicians.name as tech_name')
          .first();
        if (!svc) {
          return res.status(404).json({ error: 'scheduledServiceId not found for customerId' });
        }
        serviceContext = {
          techName: svc.tech_name || null,
          serviceType: svc.service_type || null,
          serviceDate: svc.scheduled_date || null,
          technicianId: svc.technician_id || null,
        };
      }
    }

    const request = await ReviewService.create({
      customerId,
      serviceRecordId: resolvedServiceRecordId,
      triggeredBy: triggeredBy || 'admin',
      ...serviceContext,
    });
    res.json(request);
  } catch (err) {
    // Gate refusals from ReviewService.create (at cap / cooldown / active
    // cadence / already queued / already reviewed) are 409s, not 500s.
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message, code: err.code || null });
    next(err);
  }
});

// POST /tech-trigger — tech triggers review from the field (simpler endpoint)
// Called from the tech app after completing a service
router.post('/tech-trigger', async (req, res, next) => {
  try {
    const { serviceRecordId } = req.body;
    if (!serviceRecordId) return res.status(400).json({ error: 'serviceRecordId required' });

    const sr = await db('service_records').where({ id: serviceRecordId }).first();
    if (!sr) return res.status(404).json({ error: 'Service record not found' });

    const request = await ReviewService.create({
      customerId: sr.customer_id,
      serviceRecordId,
      triggeredBy: 'tech',
    });

    res.json({
      sent: true,
      // The gate-respecting tokenized link — same helper the SMS paths use
      // (/go behind GATE_REVIEW_DIRECT_LINK; with the gate off /go is a rate-
      // page alias, so main's hardcoded /go form and this resolve identically
      // when on). Kept over main's literal so the kill switch governs every
      // emitted link through ONE helper.
      reviewUrl: ReviewService.unshortenedReviewUrl(request.token),
    });
  } catch (err) {
    // Same 409 mapping as /trigger — the tech app shows the message.
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message, code: err.code || null });
    next(err);
  }
});

module.exports = router;
