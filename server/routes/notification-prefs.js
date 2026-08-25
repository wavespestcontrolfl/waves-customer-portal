const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /api/notification-prefs — get current preferences
router.get('/', async (req, res, next) => {
  try {
    let prefs = await db('notification_prefs').where({ customer_id: req.customerId }).first();

    if (!prefs) {
      // Create default prefs via the canonical helper — marketing-grade
      // flags seed NULL ("never asked"); a portal READ must never mint
      // marketing consent.
      const { createDefaultCustomerRows } = require('../services/customer-default-rows');
      await createDefaultCustomerRows(db, req.customerId);
      prefs = await db('notification_prefs').where({ customer_id: req.customerId }).first();
    }

    res.json({
      // Existing toggles
      serviceReminder24h: prefs.service_reminder_24h ?? true,
      techEnRoute: prefs.tech_en_route ?? true,
      serviceCompleted: prefs.service_completed ?? true,
      // No billingAlerts toggle any more (owner ruling 2026-08-01): billing
      // notices carry no per-purpose opt-out — billing_reminder is retired
      // (column drops in a follow-up deploy). billingChannel (below) still
      // routes delivery.
      // seasonal_tips renders like the seasonal-content senders read it
      // (opt-OUT semantics: NULL = not opted out — the weekly lawn email
      // keeps sending) so the portal never claims seasonal messages are
      // off while emails still arrive. The PUT below persists only real
      // flips vs this rendered state, so the ON rendering of a NULL row
      // can't round-trip into a stored true (fabricated SMS consent).
      seasonalTips: prefs.seasonal_tips !== false,
      // New toggles
      reviewRequest: prefs.review_request ?? true,
      referralNudge: prefs.referral_nudge ?? true,
      marketingOffers: prefs.marketing_offers === true,
      weatherAlerts: prefs.weather_alerts ?? true,
      paymentReceipt: prefs.payment_receipt ?? true,
      // Channel preferences
      serviceReminderChannel: prefs.service_reminder_channel || 'sms',
      enRouteChannel: prefs.en_route_channel || 'sms',
      serviceCompleteChannel: prefs.service_complete_channel || 'sms',
      billingChannel: prefs.billing_channel || 'sms',
      seasonalChannel: prefs.seasonal_channel || 'email',
      reviewRequestChannel: prefs.review_request_channel || 'sms',
      referralChannel: prefs.referral_channel || 'sms',
      marketingChannel: prefs.marketing_channel || 'email',
      paymentReceiptChannel: prefs.payment_receipt_channel || 'sms',
      weatherAlertChannel: prefs.weather_alert_channel || 'sms',
      // Quiet hours
      quietHoursStart: prefs.quiet_hours_start || null,
      quietHoursEnd: prefs.quiet_hours_end || null,
    });
  } catch (err) { next(err); }
});

// PUT /api/notification-prefs — update preferences
router.put('/', async (req, res, next) => {
  try {
    const b = req.body;
    const updates = {};

    // Map camelCase request body to snake_case DB columns
    const fieldMap = {
      serviceReminder24h: 'service_reminder_24h',
      techEnRoute: 'tech_en_route',
      serviceCompleted: 'service_completed',
      seasonalTips: 'seasonal_tips',
      reviewRequest: 'review_request',
      referralNudge: 'referral_nudge',
      marketingOffers: 'marketing_offers',
      weatherAlerts: 'weather_alerts',
      paymentReceipt: 'payment_receipt',
      serviceReminderChannel: 'service_reminder_channel',
      enRouteChannel: 'en_route_channel',
      serviceCompleteChannel: 'service_complete_channel',
      billingChannel: 'billing_channel',
      seasonalChannel: 'seasonal_channel',
      reviewRequestChannel: 'review_request_channel',
      referralChannel: 'referral_channel',
      marketingChannel: 'marketing_channel',
      paymentReceiptChannel: 'payment_receipt_channel',
      weatherAlertChannel: 'weather_alert_channel',
      quietHoursStart: 'quiet_hours_start',
      quietHoursEnd: 'quiet_hours_end',
    };

    for (const [camel, snake] of Object.entries(fieldMap)) {
      if (b[camel] !== undefined) {
        // Validate channel values
        if (snake.endsWith('_channel') && !['sms', 'email', 'both'].includes(b[camel])) continue;
        updates[snake] = b[camel];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided' });
    }

    const existing = await db('notification_prefs').where({ customer_id: req.customerId }).first();

    // seasonal_tips / marketing_offers are marketing-CONSENT flags with
    // tri-state storage: true = captured opt-in, false = explicit opt-out,
    // NULL = never asked. Persist only real FLIPS relative to the state the
    // GET rendered — an unchanged value in a full-object save is a
    // round-trip, and writing it would either fabricate consent
    // (NULL -> true) or burn the never-asked tri-state (NULL -> false).
    // seasonal_tips renders opt-out style (ON unless explicitly false);
    // marketing_offers renders opt-in style (ON only when true).
    const renderedFlag = (flag, stored) => (flag === 'seasonal_tips'
      ? stored !== false
      : stored === true);
    for (const flag of ['seasonal_tips', 'marketing_offers']) {
      if (typeof updates[flag] === 'boolean'
        && updates[flag] === renderedFlag(flag, existing ? existing[flag] : null)) {
        delete updates[flag];
      }
    }

    if (Object.keys(updates).length === 0) {
      // Nothing left to write (e.g. an untouched round-trip of unconsented
      // marketing flags) — a successful no-op, not a client error.
      return res.json({ success: true });
    }

    updates.updated_at = new Date();
    if (existing) {
      await db('notification_prefs').where({ customer_id: req.customerId }).update(updates);
    } else {
      // Canonical helper first (marketing flags NULL) — a bare insert
      // would take the legacy true defaults, turning an unrelated
      // preference update into minted marketing consent.
      const { createDefaultCustomerRows } = require('../services/customer-default-rows');
      await createDefaultCustomerRows(db, req.customerId);
      await db('notification_prefs').where({ customer_id: req.customerId }).update(updates);
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
