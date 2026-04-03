const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const TwilioService = require('../services/twilio');
const logger = require('../services/logger');

router.use(authenticate);

// =========================================================================
// OFFICE LOCATION MAPPING — routes customers to their nearest office
// =========================================================================

const REVIEW_LINKS = {
  lakewood_ranch: 'https://g.page/r/CVRc_P5butTMEBM/review',
  sarasota: 'https://g.page/r/CRkzS6M4EpncEBM/review',
  venice: 'https://g.page/r/CURA5pQ1KatBEBM/review',
  parrish: 'https://g.page/r/Ca-4KKoWwFacEBM/review',
};

// City/neighborhood → office mapping
const CITY_MAP = {
  // Lakewood Ranch area
  'lakewood ranch': 'lakewood_ranch', 'bradenton': 'lakewood_ranch',
  'university park': 'lakewood_ranch', 'braden river': 'lakewood_ranch',
  'longboat key': 'lakewood_ranch', 'anna maria': 'lakewood_ranch',
  'holmes beach': 'lakewood_ranch', 'palmetto': 'lakewood_ranch',
  'cortez': 'lakewood_ranch', 'myakka city': 'lakewood_ranch',

  // Sarasota area
  'sarasota': 'sarasota', 'siesta key': 'sarasota', 'lido key': 'sarasota',
  'bee ridge': 'sarasota', 'gulf gate': 'sarasota', 'southgate': 'sarasota',
  'fruitville': 'sarasota', 'kensington park': 'sarasota',
  'indian beach': 'sarasota', 'bird key': 'sarasota',

  // Venice area
  'venice': 'venice', 'north port': 'venice', 'englewood': 'venice',
  'nokomis': 'venice', 'osprey': 'venice', 'casey key': 'venice',
  'south venice': 'venice', 'laurel': 'venice', 'warm mineral springs': 'venice',
  'port charlotte': 'venice', 'punta gorda': 'venice', 'rotonda west': 'venice',
  'manasota key': 'venice',

  // Parrish area
  'parrish': 'parrish', 'ellenton': 'parrish', 'terra ceia': 'parrish',
  'rubonia': 'parrish', 'gillette': 'parrish', 'duette': 'parrish',
  'sun city center': 'parrish', 'ruskin': 'parrish', 'wimauma': 'parrish',
  'apollo beach': 'parrish', 'riverview': 'parrish',
};

// ZIP → office mapping
const ZIP_MAP = {
  // Lakewood Ranch
  '34202': 'lakewood_ranch', '34211': 'lakewood_ranch', '34212': 'lakewood_ranch',
  '34205': 'lakewood_ranch', '34207': 'lakewood_ranch', '34208': 'lakewood_ranch',
  '34209': 'lakewood_ranch', '34210': 'lakewood_ranch', '34217': 'lakewood_ranch',
  '34218': 'lakewood_ranch', '34219': 'lakewood_ranch', '34221': 'lakewood_ranch',

  // Sarasota
  '34230': 'sarasota', '34231': 'sarasota', '34232': 'sarasota',
  '34233': 'sarasota', '34234': 'sarasota', '34235': 'sarasota',
  '34236': 'sarasota', '34237': 'sarasota', '34238': 'sarasota',
  '34239': 'sarasota', '34240': 'sarasota', '34241': 'sarasota',
  '34242': 'sarasota', '34243': 'sarasota',

  // Venice
  '34275': 'venice', '34285': 'venice', '34286': 'venice',
  '34287': 'venice', '34288': 'venice', '34289': 'venice',
  '34291': 'venice', '34292': 'venice', '34293': 'venice',
  '33948': 'venice', '33950': 'venice', '33952': 'venice',
  '33954': 'venice', '33980': 'venice', '33982': 'venice',
  '33983': 'venice', '34223': 'venice', '34224': 'venice',

  // Parrish
  '34219': 'parrish', '34220': 'parrish', '34222': 'parrish',
  '33570': 'parrish', '33572': 'parrish', '33573': 'parrish',
  '33598': 'parrish', '33534': 'parrish', '33569': 'parrish',
  '33578': 'parrish', '33579': 'parrish',
};

function resolveOffice(customer) {
  // Try city first
  const city = (customer.city || '').toLowerCase().trim();
  if (CITY_MAP[city]) return CITY_MAP[city];

  // Try zip
  const zip = (customer.zip || '').trim();
  if (ZIP_MAP[zip]) return ZIP_MAP[zip];

  // Default
  return 'lakewood_ranch';
}

const WAVES_OFFICE_PHONE = '+19413187612';

// =========================================================================
// GET /api/satisfaction/pending — unrated services from last 7 days
// =========================================================================
router.get('/pending', async (req, res, next) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const pending = await db('service_records')
      .where({ 'service_records.customer_id': req.customerId, 'service_records.status': 'completed' })
      .where('service_records.service_date', '>=', sevenDaysAgo.toISOString().split('T')[0])
      .leftJoin('satisfaction_responses', function () {
        this.on('service_records.id', 'satisfaction_responses.service_record_id')
          .andOn('service_records.customer_id', 'satisfaction_responses.customer_id');
      })
      .whereNull('satisfaction_responses.id')
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select(
        'service_records.id',
        'service_records.service_type',
        'service_records.service_date',
        'technicians.name as technician_name'
      )
      .orderBy('service_records.service_date', 'desc')
      .limit(1); // show one at a time

    res.json({ pending });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/satisfaction — submit a rating
// =========================================================================
router.post('/', async (req, res, next) => {
  try {
    const { serviceRecordId, rating, feedbackText } = req.body;

    if (!serviceRecordId || !rating || rating < 1 || rating > 10) {
      return res.status(400).json({ error: 'Valid serviceRecordId and rating (1-10) required' });
    }

    // Verify the service belongs to this customer
    const service = await db('service_records')
      .where({ 'service_records.id': serviceRecordId, 'service_records.customer_id': req.customerId })
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'technicians.name as technician_name')
      .first();

    if (!service) {
      return res.status(404).json({ error: 'Service record not found' });
    }

    // Check for duplicate
    const existing = await db('satisfaction_responses')
      .where({ customer_id: req.customerId, service_record_id: serviceRecordId })
      .first();

    if (existing) {
      return res.status(409).json({ error: 'Already rated this service' });
    }

    const customer = req.customer;
    const office = resolveOffice(customer);
    const isPromoter = rating >= 8;
    const isDetractor = rating <= 3;

    // Insert the response
    await db('satisfaction_responses').insert({
      customer_id: req.customerId,
      service_record_id: serviceRecordId,
      rating,
      feedback_text: feedbackText || null,
      directed_to_review: isPromoter,
      flagged_for_followup: !isPromoter,
      office_location: office,
    });

    // Handle routing based on score
    if (isPromoter) {
      // 8-10: Send Google review SMS to customer
      const reviewLink = REVIEW_LINKS[office];
      try {
        await TwilioService.sendSMS(
          customer.phone,
          `🌊 Thanks for the ${rating}/10, ${customer.first_name}! ` +
          `We'd love if you shared your experience on Google — it means the world to our team.\n\n` +
          `${reviewLink}\n\n` +
          `Thank you for choosing Waves! 🙏`
        );
      } catch (smsErr) {
        logger.error(`Failed to send review SMS: ${smsErr.message}`);
      }

      return res.json({
        success: true,
        action: 'review',
        reviewLink,
        officeName: office.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      });
    }

    // Below 8: Flag for follow-up, alert the office
    const urgency = isDetractor ? '🚨 URGENT' : '⚠️';
    try {
      await TwilioService.sendSMS(
        WAVES_OFFICE_PHONE,
        `${urgency} Satisfaction Alert\n\n` +
        `${customer.first_name} ${customer.last_name} rated their ` +
        `${service.service_type} (${service.service_date}) a ${rating}/10.\n` +
        `Tech: ${service.technician_name || 'Unknown'}\n` +
        (feedbackText ? `Feedback: "${feedbackText}"\n` : '') +
        `Phone: ${customer.phone}\n\n` +
        (isDetractor ? 'Follow up ASAP — detractor score.' : 'Follow up within 24 hours.')
      );
    } catch (smsErr) {
      logger.error(`Failed to send office alert SMS: ${smsErr.message}`);
    }

    return res.json({
      success: true,
      action: 'followup',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
