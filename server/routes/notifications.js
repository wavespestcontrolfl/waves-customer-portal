const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');

router.use(authenticate);

// =========================================================================
// GET /api/notifications/preferences — Get current notification prefs
// =========================================================================
router.get('/preferences', async (req, res, next) => {
  try {
    let prefs = await db('notification_prefs')
      .where({ customer_id: req.customerId })
      .first();

    // Create defaults if none exist
    if (!prefs) {
      [prefs] = await db('notification_prefs').insert({
        customer_id: req.customerId,
        service_reminder_24h: true,
        tech_en_route: true,
        service_completed: true,
        billing_reminder: false,
        seasonal_tips: true,
        sms_enabled: true,
        email_enabled: true,
      }).returning('*');
    }

    res.json({
      serviceReminder24h: prefs.service_reminder_24h,
      techEnRoute: prefs.tech_en_route,
      // Phase 2E: per-customer auto-flip opt-out, distinct from
      // tech_en_route. Customer can keep manual en-route SMS while
      // skipping the geofence-departure-triggered automated version.
      // Defaults TRUE on the column (added in migration
      // 20260428000002) so a customer with an old prefs row reads
      // as opted-in.
      autoFlipEnRoute: prefs.auto_flip_en_route !== false,
      serviceCompleted: prefs.service_completed,
      billingReminder: prefs.billing_reminder,
      seasonalTips: prefs.seasonal_tips,
      smsEnabled: prefs.sms_enabled,
      emailEnabled: prefs.email_enabled,
      billingEmail: prefs.billing_email || '',
      paymentConfirmationSms: prefs.payment_confirmation_sms !== false,
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PUT /api/notifications/preferences — Update notification prefs
// =========================================================================
router.put('/preferences', async (req, res, next) => {
  try {
    const schema = Joi.object({
      serviceReminder24h: Joi.boolean(),
      techEnRoute: Joi.boolean(),
      autoFlipEnRoute: Joi.boolean(),
      serviceCompleted: Joi.boolean(),
      billingReminder: Joi.boolean(),
      seasonalTips: Joi.boolean(),
      smsEnabled: Joi.boolean(),
      emailEnabled: Joi.boolean(),
      billingEmail: Joi.string().trim().email().max(200).allow('', null),
      paymentConfirmationSms: Joi.boolean(),
    }).min(1);

    const updates = await schema.validateAsync(req.body);

    // Map camelCase to snake_case
    const dbUpdates = {};
    if (updates.serviceReminder24h !== undefined) dbUpdates.service_reminder_24h = updates.serviceReminder24h;
    if (updates.techEnRoute !== undefined) dbUpdates.tech_en_route = updates.techEnRoute;
    if (updates.autoFlipEnRoute !== undefined) dbUpdates.auto_flip_en_route = updates.autoFlipEnRoute;
    if (updates.serviceCompleted !== undefined) dbUpdates.service_completed = updates.serviceCompleted;
    if (updates.billingReminder !== undefined) dbUpdates.billing_reminder = updates.billingReminder;
    if (updates.seasonalTips !== undefined) dbUpdates.seasonal_tips = updates.seasonalTips;
    if (updates.smsEnabled !== undefined) dbUpdates.sms_enabled = updates.smsEnabled;
    if (updates.emailEnabled !== undefined) dbUpdates.email_enabled = updates.emailEnabled;
    if (updates.billingEmail !== undefined) dbUpdates.billing_email = updates.billingEmail || null;
    if (updates.paymentConfirmationSms !== undefined) dbUpdates.payment_confirmation_sms = updates.paymentConfirmationSms;
    dbUpdates.updated_at = new Date();

    const existing = await db('notification_prefs').where({ customer_id: req.customerId }).first();

    if (existing) {
      await db('notification_prefs')
        .where({ customer_id: req.customerId })
        .update(dbUpdates);
    } else {
      await db('notification_prefs').insert({
        customer_id: req.customerId,
        ...dbUpdates,
      });
    }

    logger.info(`Notification prefs updated for ${req.customerId}:`, updates);

    const prefs = await db('notification_prefs').where({ customer_id: req.customerId }).first();

    res.json({
      success: true,
      preferences: {
        serviceReminder24h: prefs.service_reminder_24h,
        techEnRoute: prefs.tech_en_route,
        autoFlipEnRoute: prefs.auto_flip_en_route !== false,
        serviceCompleted: prefs.service_completed,
        billingReminder: prefs.billing_reminder,
        seasonalTips: prefs.seasonal_tips,
        smsEnabled: prefs.sms_enabled,
        emailEnabled: prefs.email_enabled,
        billingEmail: prefs.billing_email || '',
        paymentConfirmationSms: prefs.payment_confirmation_sms !== false,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
