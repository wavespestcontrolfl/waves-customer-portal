const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const PhotoService = require('../services/photos');
const { authenticate } = require('../middleware/auth');
// Shared with the service-report PDF renderer (documents.js) and the pay
// page so every customer-facing render of technician_notes follows one
// rule: the reviewed report text only, never the tech's raw note, with the
// legacy inspection-fee scrub on top (owner ruling 2026-10-01; codex #2817).
const { customerSafeVisitNotes } = require('../services/context-aggregator');
const { listPortalServiceHistory, parseJsonObject, suppressesCustomerArtifacts } = require('../services/portal-service-history');
const { etDateString } = require('../utils/datetime-et');
const { resolveSessionScope, resolvedScopePayload } = require('../services/account-properties');

router.use(authenticate);

const listQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20),
  offset: Joi.number().integer().min(0).default(0),
  type: Joi.string().pattern(/^[A-Za-z0-9 _-]+$/).max(50).optional(),
  // Opt-in saved-property scope (GATE_APP_PROPERTY_SCOPE): Home's "Last
  // Visit" card and the request overlay's callback check follow the selected
  // house (GitHub codex r5 P1). The Completed list stays customer-wide by
  // design — the tab says so. No-op when the gate is off or single-home.
  propertyScoped: Joi.boolean().truthy('1').falsy('0').default(false),
});

// =========================================================================
// GET /api/services — Service history for authenticated customer
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const { value, error } = listQuerySchema.validate(req.query, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { limit, offset, type, propertyScoped } = value;
    const scope = propertyScoped ? await resolveSessionScope(req) : null;

    const { services: enriched, total } = await listPortalServiceHistory(req.customerId, { limit, offset, type, scope });

    res.json({
      // The selection this read was scoped to (propertyScoped only): Home
      // compares it with the house it shows and withholds the Last Visit card
      // on a mismatch (uncapped codex r1v P1) — same echo as /schedule.
      ...(scope ? { propertyScope: resolvedScopePayload(scope) } : {}),
      services: enriched,
      total,
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

    const structuredNotes = parseJsonObject(service.structured_notes);
    const suppressCustomerArtifacts = suppressesCustomerArtifacts(structuredNotes);

    const products = suppressCustomerArtifacts
      ? []
      : await db('service_products')
        .where({ service_record_id: service.id });

    const photos = suppressCustomerArtifacts
      ? []
      : await db('service_photos')
        .where({ service_record_id: service.id })
        .orderBy('sort_order');

    // Generate signed URLs for photos — customer-dwell TTL, not the 5-minute
    // getViewUrl default (portal pages sit open far longer than that).
    const photosWithUrls = await Promise.all(photos.map(async (photo) => ({
      id: photo.id,
      type: photo.photo_type,
      caption: photo.caption,
      url: await PhotoService.getViewUrl(photo.s3_key, PhotoService.CUSTOMER_DWELL_TTL_SECONDS),
    })));

    res.json({
      id: service.id,
      date: service.service_date,
      type: service.service_type,
      status: service.status,
      technician: service.technician_name,
      checkInTime: service.effective_check_in_time || null,
      checkOutTime: service.effective_check_out_time || null,
      notes: suppressCustomerArtifacts ? null : customerSafeVisitNotes(service, { projectLine: true }),
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
    // ET calendar year — service_date is a DATE in ET terms; UTC's year
    // flips 5 hours early on New Year's Eve.
    const etYearStart = `${etDateString().slice(0, 4)}-01-01`;
    const servicesYTD = await db('service_records')
      .where({ customer_id: req.customerId })
      .where('service_date', '>=', etYearStart)
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
      .where('service_records.service_date', '>=', etYearStart)
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
// THE customer-artifact suppression predicate — a named production export so
// other customer-facing surfaces (the voice agent's account/visit reads) can
// import it instead of re-implementing it and drifting.
module.exports.suppressesCustomerArtifacts = suppressesCustomerArtifacts;
module.exports._test = {
  parseJsonObject,
  suppressesCustomerArtifacts,
};
