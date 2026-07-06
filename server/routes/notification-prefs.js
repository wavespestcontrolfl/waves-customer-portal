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
      // Create default prefs for this customer
      const [created] = await db('notification_prefs').insert({ customer_id: req.customerId }).returning('*');
      prefs = created;
    }

    res.json({
      // Existing toggles
      serviceReminder24h: prefs.service_reminder_24h ?? true,
      techEnRoute: prefs.tech_en_route ?? true,
      serviceCompleted: prefs.service_completed ?? true,
      billingAlerts: prefs.billing_alerts ?? true,
      seasonalTips: prefs.seasonal_tips ?? true,
      // New toggles
      reviewRequest: prefs.review_request ?? true,
      referralNudge: prefs.referral_nudge ?? true,
      marketingOffers: prefs.marketing_offers ?? true,
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
      billingAlerts: 'billing_alerts',
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

    updates.updated_at = new Date();

    // Upsert
    const existing = await db('notification_prefs').where({ customer_id: req.customerId }).first();
    if (existing) {
      await db('notification_prefs').where({ customer_id: req.customerId }).update(updates);
    } else {
      await db('notification_prefs').insert({ customer_id: req.customerId, ...updates });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
