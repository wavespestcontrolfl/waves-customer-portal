const express = require('express');
const router = express.Router();
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

const WAVES_OFFICE_PHONE = '+19413187612';

const VALID_CATEGORIES = ['pest_issue', 'lawn_concern', 'add_service', 'schedule_change', 'billing', 'cancellation', 'pause', 'upgrade', 'other'];
const VALID_URGENCIES = ['routine', 'urgent'];
const VALID_LOCATIONS = ['front_yard', 'back_yard', 'side_yard', 'inside_home', 'garage_lanai', 'garden_beds', 'other'];

const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB per photo decoded
const DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,([A-Za-z0-9+/=]+)$/;

// Throttle creates per authenticated customer — POST fans out two SMS messages,
// so we want stricter scoping than the global /api limiter.
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.customer && req.customer.id) || req.ip,
  message: { error: 'Too many service requests submitted. Please wait before sending another or call our office.' },
});

const createSchema = Joi.object({
  category: Joi.string().valid(...VALID_CATEGORIES).required(),
  subject: Joi.string().trim().min(1).max(200).required(),
  description: Joi.string().trim().allow('').max(500).optional(),
  urgency: Joi.string().valid(...VALID_URGENCIES).optional(),
  locationOnProperty: Joi.string().valid(...VALID_LOCATIONS).optional(),
  source: Joi.string().trim().max(50).optional(),
  type: Joi.string().trim().max(50).optional(),
  photos: Joi.array().items(Joi.string().max(8 * 1024 * 1024)).max(MAX_PHOTOS).optional(),
});

// Strip any HTML-ish characters before storage so admin/UI surfaces can never
// render injected markup, regardless of the client renderer.
function stripHtml(s) {
  return String(s || '').replace(/[<>]/g, '');
}

// Validate a single photo entry — must be a small base64 data URL of an allowed image type.
function validatePhoto(p) {
  if (typeof p !== 'string') return null;
  const m = DATA_URL_RE.exec(p);
  if (!m) return null;
  const b64 = m[2];
  // Approximate decoded byte size from base64 length
  const padding = (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  const decoded = Math.floor((b64.length * 3) / 4) - padding;
  if (decoded > MAX_PHOTO_BYTES) return null;
  return p;
}

// =========================================================================
// POST /api/requests — Create a new service request
// =========================================================================
router.post('/', authenticate, createLimiter, async (req, res, next) => {
  try {
    const { value, error } = createSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { category, subject, description, urgency, locationOnProperty, photos } = value;
    const validUrgency = urgency || 'routine';
    const validLocation = locationOnProperty || null;

    const cleanSubject = stripHtml(subject);
    const cleanDescription = stripHtml(description || '');

    // Server-side photo validation — strict data URL, type, decoded size
    const photoData = Array.isArray(photos)
      ? photos.map(validatePhoto).filter(Boolean).slice(0, MAX_PHOTOS)
      : [];

    // Lightweight server-side dedupe — reject identical create within 60s
    const dupeWindow = new Date(Date.now() - 60 * 1000);
    const dupe = await db('service_requests')
      .where({ customer_id: req.customer.id, category, subject: cleanSubject })
      .where('created_at', '>=', dupeWindow)
      .first();
    if (dupe) {
      return res.status(200).json({
        success: true,
        deduped: true,
        request: {
          id: dupe.id,
          category: dupe.category,
          subject: dupe.subject,
          description: dupe.description,
          urgency: dupe.urgency,
          locationOnProperty: dupe.location_on_property,
          status: dupe.status,
          photoCount: 0,
          createdAt: dupe.created_at,
        },
      });
    }

    const [request] = await db('service_requests')
      .insert({
        customer_id: req.customer.id,
        category,
        subject: cleanSubject,
        description: cleanDescription,
        urgency: validUrgency,
        location_on_property: validLocation,
        photos: JSON.stringify(photoData),
        status: 'new',
      })
      .returning('*');

    logger.info(`Service request created: ${request.id} by customer ${req.customer.id} [${validUrgency}]`);

    const customerName = `${req.customer.first_name} ${req.customer.last_name}`;
    const categoryLabel = category.replace(/_/g, ' ');
    const descPreview = cleanDescription.slice(0, 100);
    const photoCount = photoData.length;
    const locationLabel = validLocation ? validLocation.replace(/_/g, ' ') : '';

    // Notify office via SMS
    try {
      const urgencyTag = validUrgency === 'urgent' ? '🚨 URGENT ' : '';
      await TwilioService.sendSMS(
        WAVES_OFFICE_PHONE,
        `${urgencyTag}New service request from ${customerName}\n\n` +
        `Category: ${categoryLabel}\n` +
        `Subject: ${cleanSubject}\n` +
        (locationLabel ? `Location: ${locationLabel}\n` : '') +
        (photoCount > 0 ? `📸 ${photoCount} photo(s) attached\n` : '') +
        (descPreview ? `\n"${descPreview}${cleanDescription.length > 100 ? '...' : ''}"\n` : '') +
        `\nCheck the admin panel.`
      );
    } catch (smsErr) {
      logger.error(`Failed to send office SMS for request ${request.id}: ${smsErr.message}`);
    }

    // Send customer confirmation SMS
    try {
      const responseTime = validUrgency === 'urgent' ? '2 hours' : '24 hours';
      const smsResult = await sendCustomerMessage({
        to: req.customer.phone,
        body: `Waves Pest Control: We received your ${categoryLabel} request. Our team will review it within ${responseTime}. We'll text you when it's been assigned to a technician. Track progress in your customer portal.`,
        channel: 'sms',
        audience: 'customer',
        purpose: 'support_resolution',
        customerId: req.customer.id,
        identityTrustLevel: 'authenticated_portal',
        entryPoint: 'customer_service_request',
        metadata: {
          original_message_type: 'service_request_confirmation',
          service_request_id: request.id,
          urgency: validUrgency,
        },
      });
      if (!smsResult.sent) {
        logger.warn(`Request confirmation SMS blocked/failed for customer ${req.customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
      }
    } catch (smsErr) {
      logger.error(`Failed to send confirmation SMS for request ${request.id}: ${smsErr.message}`);
    }

    res.status(201).json({
      success: true,
      request: {
        id: request.id,
        category: request.category,
        subject: request.subject,
        description: request.description,
        urgency: request.urgency,
        locationOnProperty: request.location_on_property,
        status: request.status,
        photoCount: photoData.length,
        createdAt: request.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/requests — List current customer's service requests
// =========================================================================
const listSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

router.get('/', authenticate, async (req, res, next) => {
  try {
    const { value, error } = listSchema.validate(req.query, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { limit, offset } = value;

    const requests = await db('service_requests')
      .where({ customer_id: req.customer.id })
      .leftJoin('technicians', 'service_requests.assigned_technician_id', 'technicians.id')
      .select(
        'service_requests.id',
        'service_requests.category',
        'service_requests.subject',
        'service_requests.description',
        'service_requests.urgency',
        'service_requests.location_on_property as locationOnProperty',
        'service_requests.status',
        'service_requests.photos',
        // admin_notes intentionally omitted — internal field, not customer-facing.
        'service_requests.created_at as createdAt',
        'service_requests.resolved_at as resolvedAt',
        'technicians.name as assignedTechnician'
      )
      .orderBy('service_requests.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const total = await db('service_requests')
      .where({ customer_id: req.customer.id })
      .count('id as count')
      .first();

    res.json({
      requests,
      total: parseInt(total?.count || 0),
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
