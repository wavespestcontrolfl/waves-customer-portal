const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const ReviewService = require('../services/review-request');
const db = require('../models/db');
const { publicPortalUrl } = require('../utils/portal-url');

router.use(adminAuthenticate, requireTechOrAdmin);

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
    const { customerId, serviceRecordId, scheduledServiceId, triggeredBy } = req.body;
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
  } catch (err) { next(err); }
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
      reviewUrl: `${publicPortalUrl()}/review/${request.token}`,
    });
  } catch (err) { next(err); }
});

module.exports = router;
