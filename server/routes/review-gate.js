const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { WAVES_LOCATIONS } = require('../config/locations');

const WAVES_ADMIN_PHONE = '+19413187612';

// GET /api/rate/:token — public page data for the review funnel
router.get('/:token', async (req, res, next) => {
  try {
    const request = await db('review_requests')
      .where({ token: req.params.token })
      .first();

    if (!request) {
      return res.status(404).json({ error: 'Review link not found or expired' });
    }

    // Check expiry
    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This review link has expired' });
    }

    // Already submitted
    if (request.status === 'submitted') {
      return res.status(200).json({ alreadySubmitted: true, message: 'You already submitted feedback — thank you!' });
    }

    // Look up customer name
    const customer = await db('customers').where({ id: request.customer_id }).first();
    const loc = WAVES_LOCATIONS.find(l => l.id === request.location_id) || WAVES_LOCATIONS[0];

    res.json({
      firstName: customer?.first_name || 'there',
      techName: request.tech_name || 'your technician',
      serviceType: request.service_type || 'pest control service',
      serviceDate: request.service_date,
      locationName: loc.name,
      googleReviewUrl: loc.googleReviewUrl,
    });
  } catch (err) { next(err); }
});

// POST /api/rate/:token/submit — submit NPS score + feedback
router.post('/:token/submit', async (req, res, next) => {
  try {
    const { score, feedback, highlights } = req.body;

    if (!score || score < 1 || score > 10) {
      return res.status(400).json({ error: 'Score must be between 1 and 10' });
    }

    const request = await db('review_requests')
      .where({ token: req.params.token })
      .first();

    if (!request) {
      return res.status(404).json({ error: 'Review link not found' });
    }

    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This review link has expired' });
    }

    if (request.status === 'submitted') {
      return res.status(409).json({ error: 'Feedback already submitted' });
    }

    // Categorize by NPS score
    let category;
    if (score >= 8) category = 'promoter';
    else if (score >= 4) category = 'passive';
    else category = 'detractor';

    // Update the review request record
    await db('review_requests').where({ id: request.id }).update({
      score,
      feedback: feedback || null,
      highlights: highlights ? JSON.stringify(highlights) : null,
      category,
      status: 'submitted',
      submitted_at: db.fn.now(),
    });

    // Create activity log entry
    await db('activity_log').insert({
      customer_id: request.customer_id,
      action: 'review_submitted',
      description: `NPS ${score}/10 (${category}) — ${request.service_type || 'service'} at ${request.location_id}`,
      metadata: JSON.stringify({ score, category, feedback: (feedback || '').slice(0, 200), highlights }),
    });

    // Look up location for Google review URL
    const loc = WAVES_LOCATIONS.find(l => l.id === request.location_id) || WAVES_LOCATIONS[0];

    // Handle by category
    if (category === 'promoter') {
      // Score 8-10: redirect to Google review
      return res.json({
        category: 'promoter',
        redirect: loc.googleReviewUrl,
        message: 'Thank you! We\'d love if you could share that on Google too.',
      });
    }

    if (category === 'passive') {
      // Score 4-7: thank them, save feedback
      return res.json({
        category: 'passive',
        message: 'Thank you for your feedback! We\'re always working to improve.',
      });
    }

    // Detractor (1-3): alert admin via SMS
    try {
      const customer = await db('customers').where({ id: request.customer_id }).first();
      const customerName = customer ? `${customer.first_name} ${customer.last_name}` : 'Unknown';

      const TwilioService = require('../services/twilio');
      await TwilioService.sendSMS(WAVES_ADMIN_PHONE,
        `⚠️ Low NPS alert: ${customerName} rated ${score}/10 for ${request.service_type || 'service'} (${loc.name}).\n\nFeedback: "${(feedback || 'No comment').slice(0, 150)}"\n\nFollow up ASAP.`,
        { messageType: 'internal_alert' }
      );
    } catch (smsErr) {
      logger.error(`Detractor SMS alert failed: ${smsErr.message}`);
    }

    return res.json({
      category: 'detractor',
      message: 'Thank you for letting us know. A manager will reach out to make things right.',
    });
  } catch (err) { next(err); }
});

module.exports = router;
