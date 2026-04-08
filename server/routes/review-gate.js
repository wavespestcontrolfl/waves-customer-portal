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

      // Fire-and-forget: trigger referral nudge workflow
      try {
        const referralNudge = require('../services/workflows/referral-nudge');
        if (referralNudge.triggerAfterPositiveReview) {
          referralNudge.triggerAfterPositiveReview(request.customer_id, score).catch(err =>
            logger.error(`[review-gate] Referral nudge failed: ${err.message}`)
          );
        }
      } catch (err) {
        logger.error(`[review-gate] Referral nudge require failed: ${err.message}`);
      }

      // Fire-and-forget: update customer health score
      try {
        const customerHealth = require('../services/customer-health');
        if (customerHealth.scoreCustomer) {
          customerHealth.scoreCustomer(request.customer_id).catch(err =>
            logger.error(`[review-gate] Health score update failed: ${err.message}`)
          );
        }
      } catch (err) {
        logger.error(`[review-gate] Customer health require failed: ${err.message}`);
      }

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

    // Fire-and-forget: create health alert for detractor
    try {
      const healthAlerts = require('../services/health-alerts');
      if (healthAlerts.generateAlerts) {
        healthAlerts.generateAlerts(request.customer_id, {
          overall: 0,
          satisfaction: 0,
          satisfactionDetails: { avgRating: score / 2 },
          churnRisk: 'high',
          churnSignals: [{ signal: 'low_nps', severity: 'high', message: `NPS score ${score}/10 (detractor)` }],
          grade: 'F',
        }).catch(err => logger.error(`[review-gate] Health alert failed: ${err.message}`));
      }
    } catch (err) {
      logger.error(`[review-gate] Health alerts require failed: ${err.message}`);
    }

    // Fire-and-forget: update customer health score for detractor
    try {
      const customerHealth = require('../services/customer-health');
      if (customerHealth.scoreCustomer) {
        customerHealth.scoreCustomer(request.customer_id).catch(err =>
          logger.error(`[review-gate] Detractor health score update failed: ${err.message}`)
        );
      }
    } catch (err) {
      logger.error(`[review-gate] Customer health require failed: ${err.message}`);
    }

    return res.json({
      category: 'detractor',
      message: 'Thank you for letting us know. A manager will reach out to make things right.',
    });
  } catch (err) { next(err); }
});

// POST /api/rate/:token/generate-review — AI-powered review writer
router.post('/:token/generate-review', async (req, res, next) => {
  try {
    const { services, highlights, personalNote } = req.body;

    const request = await db('review_requests')
      .where({ token: req.params.token })
      .first();

    if (!request) {
      return res.status(404).json({ error: 'Review link not found' });
    }

    const customer = await db('customers').where({ id: request.customer_id }).first();
    const firstName = customer?.first_name || 'there';

    // Build the prompt
    const serviceList = (services && services.length > 0)
      ? services.join(', ')
      : (request.service_type || 'pest control');

    const highlightList = (highlights && highlights.length > 0)
      ? highlights.join(', ')
      : '';

    const personalDetail = personalNote ? personalNote.trim() : '';

    const prompt = `Write a Google review for a pest control company called Waves Pest Control in Southwest Florida. Write it as if you are the customer named ${firstName}. Use a natural, conversational tone that sounds like a real person wrote it.

Details to include:
- Services received: ${serviceList}
${highlightList ? `- What stood out: ${highlightList}` : ''}
${personalDetail ? `- Customer's personal note: "${personalDetail}"` : ''}
${request.tech_name ? `- Technician name: ${request.tech_name}` : ''}

Rules:
- Write 2-4 sentences only
- No emojis
- Sound genuine and specific, not generic
- Mention specific services or what they liked
- Do not use exclamation marks more than once
- Do not start with "I"
- Do not mention star ratings`;

    // Call Claude API
    let reviewText = '';
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic();

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      });

      reviewText = message.content[0]?.text?.trim() || '';
    } catch (aiErr) {
      logger.error(`[review-gate] AI review generation failed: ${aiErr.message}`);
      // Fallback: generate a simple template
      const parts = [];
      if (highlightList) parts.push(`They were ${highlightList.toLowerCase()}`);
      if (request.tech_name) parts.push(`${request.tech_name} did a great job`);
      parts.push(`Really happy with the ${serviceList.toLowerCase()} service from Waves Pest Control`);
      if (personalDetail) parts.push(personalDetail);
      parts.push('Would definitely recommend them to anyone in Southwest Florida.');
      reviewText = parts.join('. ') + (parts[parts.length - 1].endsWith('.') ? '' : '.');
    }

    res.json({ review: reviewText });
  } catch (err) { next(err); }
});

module.exports = router;
