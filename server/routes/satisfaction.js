const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const TwilioService = require('../services/twilio');
const logger = require('../services/logger');
const ReviewService = require('../services/review-request');

router.use(authenticate);

// Office/GBP routing for the portal satisfaction prompt goes through the ONE
// review-routing resolver in config/locations.js. This file used to carry its
// own REVIEW_LINKS + CITY_MAP + ZIP_MAP — a third answer to "which profile does
// this customer review?", which is how a Palmetto customer could be pointed at
// the Parrish profile by their tokenized text and the Bradenton profile by this
// page in the same week. The GBP URLs now come from WAVES_LOCATIONS, so a
// profile-link change lands everywhere at once.
const { resolveReviewLocation } = require('../config/locations');

// Admin alert recipient — must be a real cell, never one of our own Twilio
// numbers (an SMS from the HQ line to itself fails with Twilio error 21266).
const ADMIN_ALERT_PHONE = process.env.ADAM_PHONE || '+19415993489';

// =========================================================================
// GET /api/satisfaction/pending — unrated services from last 7 days
// =========================================================================
router.get('/pending', async (req, res, next) => {
  try {
    if (req.customer?.has_left_google_review) {
      return res.json({ pending: [] });
    }

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
      // The rating step already inserted this row; the follow-up feedback
      // step legitimately adds the written note to it. Accept that update
      // (filling an empty note only) instead of stranding the customer's
      // concern behind the duplicate 409 — and forward the note to the
      // office, which only saw the bare rating at alert time.
      if (feedbackText && !existing.feedback_text) {
        await db('satisfaction_responses')
          .where({ id: existing.id })
          .update({ feedback_text: feedbackText });
        if (existing.flagged_for_followup) {
          try {
            await TwilioService.sendSMS(
              ADMIN_ALERT_PHONE,
              `Follow-up note added\n\n` +
              `${req.customer.first_name} ${req.customer.last_name} added a note to their ` +
              `${service.service_type} (${service.service_date}) rating of ${existing.rating}/10:\n` +
              `"${feedbackText}"\n` +
              `Phone: ${req.customer.phone}`,
            );
          } catch (smsErr) {
            logger.error(`Failed to send feedback follow-up alert: ${smsErr.message}`);
          }
        }
        return res.json({ success: true, action: 'feedback_saved' });
      }
      return res.status(409).json({ error: 'Already rated this service' });
    }

    const customer = req.customer;
    // Same last-resort stored id the ask path uses (ReviewService
    // resolveLocation) so the office shown here can never disagree with the
    // office the gated ask resolves.
    const office = resolveReviewLocation(customer, {
      storedLocationId: customer.nearest_location_id || null,
    });
    const isPromoter = rating >= 8;
    const isDetractor = rating <= 3;

    // Insert the response. office_location now stores the canonical location id
    // ('bradenton') rather than this file's private 'lakewood_ranch' key —
    // review-request.js already wrote canonical ids into the same column, and
    // nothing reads it.
    await db('satisfaction_responses').insert({
      customer_id: req.customerId,
      service_record_id: serviceRecordId,
      rating,
      feedback_text: feedbackText || null,
      directed_to_review: isPromoter,
      flagged_for_followup: !isPromoter,
      office_location: office.id,
    });

    // Handle routing based on score
    if (isPromoter) {
      // 8-10: ask for the Google review through the SAME gated path as every
      // other unscheduled ask. This used to text a BARE g.page link with no
      // review_requests row, so the ask was invisible to the 3-ask cap, the
      // 30-day cooldown, the already-reviewed flag, and the outreach funnel —
      // and the click could never be attributed. sendGatedAsk mints the token,
      // applies the gates, and records the row.
      let asked = { outcome: 'send_failed' };
      try {
        asked = await ReviewService.sendGatedAsk({
          customerId: customer.id,
          customer,
          channel: 'sms',
          templateId: 'friendly_ask',
          serviceRecordId,
          triggeredBy: 'portal_satisfaction',
          manageRetryVia: 'cron',
          // This path had no Day-3 follow-up before the fold, and adding one
          // would be a new customer touch nobody asked for. Drop this flag to
          // opt the portal ask into the same follow-up admin one-offs get.
          skipLegacyFollowup: true,
        });
      } catch (smsErr) {
        // Never fail the rating write because the ask could not go out.
        logger.error(`[satisfaction] Gated review ask threw (customerId=${customer.id} errType=${smsErr?.name || 'Error'})`);
      }
      if (asked.outcome !== 'sent') {
        logger.info(`[satisfaction] Review ask not sent (customerId=${customer.id} outcome=${asked.outcome})`);
      }

      // The in-app button points at the SAME tokenized link the text carries,
      // so a customer who taps here instead of in their messages is still
      // attributed. When the ask was gated (at cap, in cooldown, already in a
      // cadence) there is no fresh token — reuse the customer's most recent
      // live DELIVERED one, and only fall back to the bare profile URL if
      // there is none. Exception: while an ask is QUEUED (deferred /
      // already_queued / transient-retry / concurrent in-flight) there is a
      // pending row processScheduled will send later — a bare link now could
      // not consume it, so the customer would review AND still get the SMS
      // (codex #3285 r3). No actionable fallback in that window; the queued
      // text carries the link.
      const askQueued = ['deferred', 'already_queued', 'send_failed', 'concurrent'].includes(asked.outcome);
      let reviewLink = asked.reviewUrl || null;
      if (!reviewLink) {
        reviewLink = await ReviewService.livePortalReviewUrlFor(customer.id).catch(() => null);
      }
      if (!reviewLink && !askQueued) reviewLink = office.googleReviewUrl;

      return res.json({
        success: true,
        action: 'review',
        reviewLink,
        officeName: office.name,
      });
    }

    // Below 8: Flag for follow-up, alert the office
    const urgency = isDetractor ? '🚨 URGENT' : '⚠️';
    try {
      await TwilioService.sendSMS(
        ADMIN_ALERT_PHONE,
        `${urgency} Satisfaction Alert\n\n` +
        `${customer.first_name} ${customer.last_name} rated their ` +
        `${service.service_type} (${service.service_date}) a ${rating}/10.\n` +
        `Tech: ${service.technician_name || 'Unknown'}\n` +
        (feedbackText ? `Feedback: "${feedbackText}"\n` : '') +
        `Phone: ${customer.phone}\n\n` +
        (isDetractor ? 'Follow up ASAP — detractor score.' : 'Follow up within 24 hours.'),
        { messageType: 'internal_alert', link: '/admin/reviews' }
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
