const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');

const WAVES_OFFICE_PHONE = '+19413187612';

const VALID_CATEGORIES = ['pest_issue', 'lawn_concern', 'add_service', 'schedule_change', 'billing', 'cancellation', 'pause', 'upgrade', 'other'];
const VALID_URGENCIES = ['routine', 'urgent'];
const VALID_LOCATIONS = ['front_yard', 'back_yard', 'side_yard', 'inside_home', 'garage_lanai', 'garden_beds', 'other'];

// =========================================================================
// POST /api/requests — Create a new service request
// =========================================================================
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { category, subject, description, urgency, locationOnProperty, photos } = req.body;

    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Valid category required' });
    }
    if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
      return res.status(400).json({ error: 'Subject required' });
    }
    if (description && description.length > 500) {
      return res.status(400).json({ error: 'Description must be 500 characters or less' });
    }

    const validUrgency = urgency && VALID_URGENCIES.includes(urgency) ? urgency : 'routine';
    const validLocation = locationOnProperty && VALID_LOCATIONS.includes(locationOnProperty) ? locationOnProperty : null;

    // For now, store photo base64 references as JSON
    // When S3 is connected, this would upload and store keys
    const photoData = Array.isArray(photos) ? photos.slice(0, 3) : [];

    const [request] = await db('service_requests')
      .insert({
        customer_id: req.customer.id,
        category,
        subject: subject.trim(),
        description: (description || '').trim(),
        urgency: validUrgency,
        location_on_property: validLocation,
        photos: JSON.stringify(photoData),
        status: 'new',
      })
      .returning('*');

    logger.info(`Service request created: ${request.id} by customer ${req.customer.id} [${validUrgency}]`);

    const customerName = `${req.customer.first_name} ${req.customer.last_name}`;
    const categoryLabel = category.replace(/_/g, ' ');
    const descPreview = (description || '').slice(0, 100);
    const photoCount = photoData.length;
    const locationLabel = validLocation ? validLocation.replace(/_/g, ' ') : '';

    // Notify office via SMS
    try {
      const urgencyTag = validUrgency === 'urgent' ? '🚨 URGENT ' : '';
      await TwilioService.sendSMS(
        WAVES_OFFICE_PHONE,
        `${urgencyTag}New service request from ${customerName}\n\n` +
        `Category: ${categoryLabel}\n` +
        `Subject: ${subject.trim()}\n` +
        (locationLabel ? `Location: ${locationLabel}\n` : '') +
        (photoCount > 0 ? `📸 ${photoCount} photo(s) attached\n` : '') +
        (descPreview ? `\n"${descPreview}${description && description.length > 100 ? '...' : ''}"\n` : '') +
        `\nCheck the admin panel.`
      );
    } catch (smsErr) {
      logger.error(`Failed to send office SMS for request ${request.id}: ${smsErr.message}`);
    }

    // Send customer confirmation SMS
    try {
      const responseTime = validUrgency === 'urgent' ? '2 hours' : '24 hours';
      await TwilioService.sendSMS(
        req.customer.phone,
        `🌊 Waves Pest Control\n\n` +
        `We received your ${categoryLabel} request! Our team will review it within ${responseTime}.\n\n` +
        `We'll text you when it's been assigned to a technician. Track progress in your customer portal.`
      );
    } catch (smsErr) {
      logger.error(`Failed to send confirmation SMS for request ${request.id}: ${smsErr.message}`);
    }

    // Return camelCase response
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
router.get('/', authenticate, async (req, res, next) => {
  try {
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
        'service_requests.admin_notes as adminNotes',
        'service_requests.created_at as createdAt',
        'service_requests.resolved_at as resolvedAt',
        'technicians.name as assignedTechnician'
      )
      .orderBy('service_requests.created_at', 'desc');

    res.json({ requests });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
