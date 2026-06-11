const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const PhotoService = require('../services/photos');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

const listQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20),
  offset: Joi.number().integer().min(0).default(0),
  type: Joi.string().pattern(/^[A-Za-z0-9 _-]+$/).max(50).optional(),
});

// =========================================================================
// GET /api/services — Service history for authenticated customer
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const { value, error } = listQuerySchema.validate(req.query, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { limit, offset, type } = value;

    let query = db('service_records')
      .where({ 'service_records.customer_id': req.customerId })
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .leftJoin('scheduled_services', 'service_records.scheduled_service_id', 'scheduled_services.id')
      .select(
        'service_records.*',
        'technicians.name as technician_name',
        db.raw('COALESCE(scheduled_services.check_in_time, scheduled_services.actual_start_time) as effective_check_in_time'),
        db.raw('COALESCE(scheduled_services.check_out_time, scheduled_services.actual_end_time) as effective_check_out_time')
      )
      .orderBy('service_records.service_date', 'desc')
      .orderBy('service_records.id', 'desc')
      .limit(limit)
      .offset(offset);

    if (type) {
      query = query.where('service_records.service_type', 'ilike', `%${type}%`);
    }

    const services = await query;

    // Attach products and photo counts
    const enriched = await Promise.all(services.map(async (svc) => {
      const products = await db('service_products')
        .where({ service_record_id: svc.id })
        .select('product_name', 'product_category', 'active_ingredient', 'moa_group', 'notes');

      const photoCount = await db('service_photos')
        .where({ service_record_id: svc.id })
        .count('id as count')
        .first();

      const photoCountNum = parseInt(photoCount?.count) || 0;
      const structuredNotes = parseJsonObject(svc.structured_notes);
      const isProjectCompletion = svc.completion_source === 'project_completion'
        || structuredNotes.projectCompletion === true;
      const projectReport = structuredNotes.projectReport || {};
      const projectReportUrl = structuredNotes.portalAttached && projectReport.url
        ? projectReport.url
        : null;
      // Any typed delivery posture other than auto_send (internal_only
      // shadow, disabled kill switch) keeps report links off customer surfaces.
      const internalOnlyReport = Boolean(structuredNotes.typedReportDelivery)
        && structuredNotes.typedReportDelivery !== 'auto_send';
      return {
        id: svc.id,
        date: svc.service_date,
        type: svc.service_type,
        status: svc.status || null,
        technician: svc.technician_name || null,
        checkInTime: svc.effective_check_in_time || null,
        checkOutTime: svc.effective_check_out_time || null,
        notes: svc.technician_notes || null,
        soilTemp: svc.soil_temp ? parseFloat(svc.soil_temp) : null,
        thatchMeasurement: svc.thatch_measurement ? parseFloat(svc.thatch_measurement) : null,
        soilPh: svc.soil_ph ? parseFloat(svc.soil_ph) : null,
        soilMoisture: svc.soil_moisture || null,
        // field_flags are internal QA markers, not customer-facing.
        products: products || [],
        hasPhotos: photoCountNum > 0,
        photoCount: photoCountNum,
        isProjectCompletion,
        projectId: structuredNotes.projectId || null,
        projectType: structuredNotes.projectType || null,
        projectReportPortalAttached: Boolean(structuredNotes.portalAttached && projectReportUrl),
        // internal_only typed completions (Phase-1b shadow) store a report
        // for admin review, but the customer must not see it — the flag is
        // frozen at completion time, so graduating the profile to auto_send
        // later never retroactively exposes shadow reports.
        reportUrl: isProjectCompletion
          ? projectReportUrl
          : (svc.report_view_token && !internalOnlyReport ? `/report/${svc.report_view_token}` : null),
        reportPdfUrl: isProjectCompletion
          ? projectReportUrl
          : (svc.report_view_token && !internalOnlyReport ? `/api/reports/${svc.report_view_token}` : null),
        reportToken: !internalOnlyReport ? (svc.report_view_token || null) : null,
        reportGeneratedAt: !internalOnlyReport ? (svc.report_generated_at || null) : null,
        reportViewedAt: !internalOnlyReport ? (svc.report_viewed_at || null) : null,
        // Explicit signal for the client: when false, render no report
        // button at all (the /api/documents/service-report fallback 404s
        // for suppressed records, so a fallback link would dead-end).
        reportAvailable: isProjectCompletion
          ? Boolean(projectReportUrl)
          : !internalOnlyReport,
      };
    }));

    // Get total count for pagination
    const total = await db('service_records')
      .where({ customer_id: req.customerId })
      .count('id as count')
      .first();

    res.json({
      services: enriched,
      total: parseInt(total.count),
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/services/:id — Single service detail
// =========================================================================
router.get('/:id', async (req, res, next) => {
  try {
    const service = await db('service_records')
      .where({ 'service_records.id': req.params.id, 'service_records.customer_id': req.customerId })
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .leftJoin('scheduled_services', 'service_records.scheduled_service_id', 'scheduled_services.id')
      .select(
        'service_records.*',
        'technicians.name as technician_name',
        db.raw('COALESCE(scheduled_services.check_in_time, scheduled_services.actual_start_time) as effective_check_in_time'),
        db.raw('COALESCE(scheduled_services.check_out_time, scheduled_services.actual_end_time) as effective_check_out_time')
      )
      .first();

    if (!service) {
      return res.status(404).json({ error: 'Service record not found' });
    }

    const products = await db('service_products')
      .where({ service_record_id: service.id });

    const photos = await db('service_photos')
      .where({ service_record_id: service.id })
      .orderBy('sort_order');

    // Generate signed URLs for photos
    const photosWithUrls = await Promise.all(photos.map(async (photo) => ({
      id: photo.id,
      type: photo.photo_type,
      caption: photo.caption,
      url: await PhotoService.getViewUrl(photo.s3_key),
    })));

    res.json({
      id: service.id,
      date: service.service_date,
      type: service.service_type,
      status: service.status,
      technician: service.technician_name,
      checkInTime: service.effective_check_in_time || null,
      checkOutTime: service.effective_check_out_time || null,
      notes: service.technician_notes,
      measurements: {
        soilTemp: service.soil_temp ? parseFloat(service.soil_temp) : null,
        thatchMeasurement: service.thatch_measurement ? parseFloat(service.thatch_measurement) : null,
        soilPh: service.soil_ph ? parseFloat(service.soil_ph) : null,
        soilMoisture: service.soil_moisture,
      },
      products,
      photos: photosWithUrls,
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/services/stats/summary — Lawn health progress stats
// =========================================================================
router.get('/stats/summary', async (req, res, next) => {
  try {
    const servicesYTD = await db('service_records')
      .where({ customer_id: req.customerId })
      .where('service_date', '>=', `${new Date().getFullYear()}-01-01`)
      .count('id as count')
      .first();

    const latestThatch = await db('service_records')
      .where({ customer_id: req.customerId })
      .whereNotNull('thatch_measurement')
      .orderBy('service_date', 'desc')
      .select('thatch_measurement', 'service_date')
      .first();

    const firstThatch = await db('service_records')
      .where({ customer_id: req.customerId })
      .whereNotNull('thatch_measurement')
      .orderBy('service_date', 'asc')
      .select('thatch_measurement', 'service_date')
      .first();

    // Count Celsius applications this year (cap tracking)
    const celsiusApps = await db('service_products')
      .join('service_records', 'service_products.service_record_id', 'service_records.id')
      .where({ 'service_records.customer_id': req.customerId })
      .where('service_records.service_date', '>=', `${new Date().getFullYear()}-01-01`)
      .where('service_products.product_name', 'ilike', '%celsius%')
      .count('service_products.id as count')
      .first();

    res.json({
      servicesYTD: parseInt(servicesYTD.count),
      celsiusApplicationsThisYear: parseInt(celsiusApps.count),
      celsiusMaxPerYear: 3,
      thatch: {
        current: latestThatch ? parseFloat(latestThatch.thatch_measurement) : null,
        initial: firstThatch ? parseFloat(firstThatch.thatch_measurement) : null,
        currentDate: latestThatch?.service_date,
        initialDate: firstThatch?.service_date,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
