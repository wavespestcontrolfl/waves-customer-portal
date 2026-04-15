const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const PhotoService = require('../services/photos');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

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
      .select(
        'service_records.*',
        'technicians.name as technician_name'
      )
      .orderBy('service_records.service_date', 'desc')
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

      return {
        id: svc.id,
        date: svc.service_date,
        type: svc.service_type,
        status: svc.status,
        technician: svc.technician_name,
        notes: svc.technician_notes,
        soilTemp: svc.soil_temp ? parseFloat(svc.soil_temp) : null,
        thatchMeasurement: svc.thatch_measurement ? parseFloat(svc.thatch_measurement) : null,
        soilPh: svc.soil_ph ? parseFloat(svc.soil_ph) : null,
        soilMoisture: svc.soil_moisture,
        fieldFlags: svc.field_flags,
        products,
        hasPhotos: parseInt(photoCount.count) > 0,
        photoCount: parseInt(photoCount.count),
        reportUrl: svc.report_view_token ? `/api/reports/${svc.report_view_token}` : null,
        reportToken: svc.report_view_token,
        reportGeneratedAt: svc.report_generated_at,
        reportViewedAt: svc.report_viewed_at,
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
      .select('service_records.*', 'technicians.name as technician_name')
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
      notes: service.technician_notes,
      measurements: {
        soilTemp: service.soil_temp ? parseFloat(service.soil_temp) : null,
        thatchMeasurement: service.thatch_measurement ? parseFloat(service.thatch_measurement) : null,
        soilPh: service.soil_ph ? parseFloat(service.soil_ph) : null,
        soilMoisture: service.soil_moisture,
      },
      fieldFlags: service.field_flags,
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
