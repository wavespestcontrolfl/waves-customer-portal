const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { WAVES_LOCATIONS, nearestLocation } = require('../config/locations');
const MODELS = require('../config/models');

// Nearest GBP to the customer's geocoded address, with fallbacks. Prefers the
// haversine winner when the customer has a lat/lng; otherwise falls back to
// whatever location the review request was tagged with at creation time
// (review-request.js already city-routes on create).
function resolveReviewLocation(request, customer) {
  if (customer && customer.latitude != null && customer.longitude != null) {
    const hit = nearestLocation(customer.latitude, customer.longitude);
    if (hit) return hit;
  }
  if (request && request.location_id) {
    const byId = WAVES_LOCATIONS.find((l) => l.id === request.location_id);
    if (byId) return byId;
  }
  return WAVES_LOCATIONS[0];
}

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

    // Look up customer name — prefer the beneficiary (service contact) when
    // set so the review page greets the right person. Closest-GBP routing
    // uses the customer's geocoded lat/lng (spec ask: "paired with the
    // closest Google Business Profile"), falling back to the location tagged
    // at request creation.
    const customer = await db('customers').where({ id: request.customer_id }).first();
    const { getServiceContact } = require('../services/customer-contact');
    const contact = getServiceContact(customer);
    const loc = resolveReviewLocation(request, customer);

    res.json({
      firstName: contact.name || customer?.first_name || 'there',
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

    // Look up location for Google review URL — closest-GBP by customer
    // geocode, fallback to the request's tagged location.
    const customerForLoc = await db('customers').where({ id: request.customer_id }).first();
    const loc = resolveReviewLocation(request, customerForLoc);

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

    // Vary opening style so Google's dup-detection doesn't flag a pattern
    // of "Adam was…" across every generated review. One is sampled per call.
    const OPENING_STYLES = [
      'start mid-thought, as if the customer is finishing a conversation',
      'lead with the specific result they got',
      'lead with the technician\'s behavior',
      'lead with a short reaction word (e.g. "Really happy", "Super impressed", "Honestly great")',
      'lead with how the experience compared to expectations',
      'lead with the service type',
    ];
    const style = OPENING_STYLES[Math.floor(Math.random() * OPENING_STYLES.length)];

    const prompt = `Write a genuine Google review for Waves Pest Control (Southwest Florida) from the customer's perspective. Sound like a real SWFL homeowner wrote it on their phone — casual, short, specific.

Context:
- Customer first name: ${firstName}
- Services received: ${serviceList}
${highlightList ? `- What stood out: ${highlightList}` : ''}
${personalDetail ? `- Customer's own words: "${personalDetail}"` : ''}
${request.tech_name ? `- Technician: ${request.tech_name}` : ''}

Opening style for this review: ${style}

Rules:
- 2 to 4 sentences. Vary the length between reviews — sometimes tight, sometimes chattier.
- No emojis, no hashtags, no star ratings.
- Do NOT start with "I", "My", "We", or the technician's name.
- At most one exclamation mark in the whole review; preferably zero.
- Weave in at least one specific trait or detail; avoid generic filler like "great service" or "highly recommend".
- Don't say "Waves Pest Control" more than once; never use "WPC" or other abbreviations.
- No marketing phrases like "5 stars" or "best company ever".

Return ONLY the review body. No quotes, no preamble, no sign-off.`;

    // Call Claude API — FAST tier is plenty for 256-token review body; high
    // temperature keeps wording varied across customers.
    let reviewText = '';
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic();

      const message = await anthropic.messages.create({
        model: MODELS.FAST,
        max_tokens: 256,
        temperature: 0.95,
        messages: [{ role: 'user', content: prompt }],
      });

      reviewText = message.content[0]?.text?.trim() || '';
      // Strip accidental quotes or "Review:" preambles
      reviewText = reviewText.replace(/^["']+|["']+$/g, '').replace(/^(Review|My review):\s*/i, '').trim();
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

    // Persist so we can audit variation + iterate the prompt. Soft-fail:
    // if the column isn't present yet (pre-migration env) the API still
    // returns the draft.
    try {
      await db('review_requests').where({ id: request.id }).update({
        generated_review_text: reviewText.slice(0, 2000),
        generated_at: db.fn.now(),
      });
    } catch (persistErr) {
      logger.warn(`[review-gate] generated_review_text persist skipped: ${persistErr.message}`);
    }

    res.json({ review: reviewText });
  } catch (err) { next(err); }
});

module.exports = router;
