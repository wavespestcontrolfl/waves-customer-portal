const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');

router.use(authenticate);

const PREF_SELECT = [
  'appointment_confirmation',
  'service_reminder_72h',
  'service_reminder_24h',
  'tech_en_route',
  'auto_flip_en_route',
  'service_completed',
  'billing_reminder',
  'seasonal_tips',
  'sms_enabled',
  'email_enabled',
  'billing_email',
  'payment_confirmation_sms',
  'appointment_notify_primary',
];

function preferencePayload(prefs = {}) {
  return {
    appointmentConfirmation: prefs.appointment_confirmation !== false,
    serviceReminder72h: prefs.service_reminder_72h !== false,
    serviceReminder24h: prefs.service_reminder_24h !== false,
    techEnRoute: prefs.tech_en_route !== false,
    autoFlipEnRoute: prefs.auto_flip_en_route !== false,
    serviceCompleted: prefs.service_completed !== false,
    billingReminder: !!prefs.billing_reminder,
    seasonalTips: prefs.seasonal_tips !== false,
    smsEnabled: prefs.sms_enabled !== false,
    emailEnabled: prefs.email_enabled !== false,
    billingEmail: prefs.billing_email || '',
    paymentConfirmationSms: prefs.payment_confirmation_sms !== false,
    appointmentNotifyPrimary: prefs.appointment_notify_primary === true,
  };
}

async function ensurePrefs(customerId) {
  let prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
  if (!prefs) {
    [prefs] = await db('notification_prefs').insert({
      customer_id: customerId,
      appointment_confirmation: true,
      service_reminder_72h: true,
      service_reminder_24h: true,
      tech_en_route: true,
      service_completed: true,
      billing_reminder: false,
      seasonal_tips: true,
      sms_enabled: true,
      email_enabled: true,
      appointment_notify_primary: false,
    }).returning('*');
  }
  return prefs;
}

async function accountPropertyIds(req) {
  const accountId = req.accountId || req.customer?.account_id || req.customerId;
  const rows = await db('customers')
    .where({ active: true })
    .whereNull('deleted_at')
    .where(function () {
      this.where({ account_id: accountId }).orWhere({ id: accountId });
    })
    .select('id');
  return rows.map(r => r.id);
}

// =========================================================================
// GET /api/notifications/preferences — Get current notification prefs
// =========================================================================
router.get('/preferences', async (req, res, next) => {
  try {
    const prefs = await ensurePrefs(req.customerId);
    res.json(preferencePayload(prefs));
  } catch (err) {
    next(err);
  }
});

router.get('/property-preferences', async (req, res, next) => {
  try {
    const ids = await accountPropertyIds(req);
    const properties = await db('customers')
      .whereIn('id', ids)
      .select(
        'id', 'profile_label', 'address_line1', 'city', 'state', 'zip', 'is_primary_profile',
        'service_contact_name', 'service_contact_phone', 'service_contact_email'
      )
      .orderBy('is_primary_profile', 'desc')
      .orderBy('profile_label', 'asc');

    const prefsRows = await db('notification_prefs').whereIn('customer_id', ids).select('customer_id', ...PREF_SELECT);
    const byCustomerId = new Map(prefsRows.map(row => [String(row.customer_id), row]));

    for (const id of ids) {
      if (!byCustomerId.has(String(id))) {
        byCustomerId.set(String(id), await ensurePrefs(id));
      }
    }

    res.json({
      properties: properties.map((p) => ({
        id: p.id,
        profileLabel: p.profile_label || (p.is_primary_profile ? 'Primary' : 'Service property'),
        address: {
          line1: p.address_line1,
          city: p.city,
          state: p.state,
          zip: p.zip,
        },
        preferences: preferencePayload(byCustomerId.get(String(p.id)) || {}),
        serviceContact: {
          name: p.service_contact_name || '',
          firstName: String(p.service_contact_name || '').trim().split(/\s+/)[0] || '',
          lastName: String(p.service_contact_name || '').trim().split(/\s+/).slice(1).join(' '),
          phone: p.service_contact_phone || '',
          email: p.service_contact_email || '',
        },
      })),
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
      appointmentConfirmation: Joi.boolean(),
      serviceReminder72h: Joi.boolean(),
      serviceReminder24h: Joi.boolean(),
      techEnRoute: Joi.boolean(),
      appointmentNotifyPrimary: Joi.boolean(),
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
    if (updates.appointmentConfirmation !== undefined) dbUpdates.appointment_confirmation = updates.appointmentConfirmation;
    if (updates.serviceReminder72h !== undefined) dbUpdates.service_reminder_72h = updates.serviceReminder72h;
    if (updates.serviceReminder24h !== undefined) dbUpdates.service_reminder_24h = updates.serviceReminder24h;
    if (updates.techEnRoute !== undefined) dbUpdates.tech_en_route = updates.techEnRoute;
    if (updates.appointmentNotifyPrimary !== undefined) dbUpdates.appointment_notify_primary = updates.appointmentNotifyPrimary;
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
      preferences: preferencePayload(prefs),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/property-preferences/:customerId', async (req, res, next) => {
  try {
    const ids = await accountPropertyIds(req);
    if (!ids.some(id => String(id) === String(req.params.customerId))) {
      return res.status(403).json({ error: 'Property is not available for this account' });
    }

    const schema = Joi.object({
      appointmentConfirmation: Joi.boolean(),
      serviceReminder72h: Joi.boolean(),
      serviceReminder24h: Joi.boolean(),
      techEnRoute: Joi.boolean(),
      appointmentNotifyPrimary: Joi.boolean(),
      serviceContact: Joi.object({
        firstName: Joi.string().trim().max(50).allow('', null),
        lastName: Joi.string().trim().max(50).allow('', null),
        phone: Joi.string().trim().max(30).allow('', null),
        email: Joi.string().trim().email().max(150).allow('', null),
      }),
    }).min(1);
    const updates = await schema.validateAsync(req.body);
    const dbUpdates = { updated_at: new Date() };
    if (updates.appointmentConfirmation !== undefined) dbUpdates.appointment_confirmation = updates.appointmentConfirmation;
    if (updates.serviceReminder72h !== undefined) dbUpdates.service_reminder_72h = updates.serviceReminder72h;
    if (updates.serviceReminder24h !== undefined) dbUpdates.service_reminder_24h = updates.serviceReminder24h;
    if (updates.techEnRoute !== undefined) dbUpdates.tech_en_route = updates.techEnRoute;
    if (updates.appointmentNotifyPrimary !== undefined) dbUpdates.appointment_notify_primary = updates.appointmentNotifyPrimary;

    if (updates.serviceContact !== undefined) {
      const firstName = updates.serviceContact.firstName || '';
      const lastName = updates.serviceContact.lastName || '';
      await db('customers').where({ id: req.params.customerId }).update({
        service_contact_name: [firstName, lastName].filter(Boolean).join(' ') || null,
        service_contact_phone: updates.serviceContact.phone || null,
        service_contact_email: updates.serviceContact.email || null,
        updated_at: new Date(),
      });
    }

    const existing = await db('notification_prefs').where({ customer_id: req.params.customerId }).first();
    if (existing) {
      await db('notification_prefs').where({ customer_id: req.params.customerId }).update(dbUpdates);
    } else {
      await db('notification_prefs').insert({ customer_id: req.params.customerId, ...dbUpdates });
    }

    const prefs = await ensurePrefs(req.params.customerId);
    res.json({ success: true, preferences: preferencePayload(prefs) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
