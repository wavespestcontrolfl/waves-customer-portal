const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const AccountMembershipEmail = require('../services/account-membership-email');
const { SERVICE_CONTACT_COLUMNS, getServiceContactSlots } = require('../services/customer-contact');

router.use(authenticate);

// Max on-location contacts per property (slots on the customers row).
const MAX_SERVICE_CONTACTS = 3;

function serviceContactPayload(slot = {}) {
  const name = String(slot.name || '').trim();
  return {
    name,
    firstName: name.split(/\s+/)[0] || '',
    lastName: name.split(/\s+/).slice(1).join(' '),
    phone: slot.phone || '',
    email: slot.email || '',
  };
}

// Filled slots in order — compacted, so the UI renders a simple list.
function serviceContactsPayload(customerRow) {
  return getServiceContactSlots(customerRow)
    .filter((slot) => slot.name || slot.phone || slot.email)
    .map(serviceContactPayload);
}

// Map an ordered contact list (≤3, already trimmed of empty entries) onto the
// slot columns, nulling everything past the last filled slot.
function serviceContactSlotUpdates(contacts = []) {
  const updates = {};
  const slotColumns = [
    ['service_contact_name', 'service_contact_phone', 'service_contact_email'],
    ['service_contact2_name', 'service_contact2_phone', 'service_contact2_email'],
    ['service_contact3_name', 'service_contact3_phone', 'service_contact3_email'],
  ];
  slotColumns.forEach(([nameCol, phoneCol, emailCol], i) => {
    const contact = contacts[i];
    updates[nameCol] = contact?.name || null;
    updates[phoneCol] = contact?.phone || null;
    updates[emailCol] = contact?.email || null;
  });
  return updates;
}

function normalizeContactInput(contact = {}) {
  return {
    // slice: joined first+last (50+1+50) can exceed the varchar(100) column
    name: [contact.firstName || '', contact.lastName || ''].map(s => String(s).trim()).filter(Boolean).join(' ').slice(0, 100),
    phone: String(contact.phone || '').trim(),
    email: String(contact.email || '').trim(),
  };
}

// Delivery-channel options for per-notification channel selection.
const CHANNEL_VALUES = ['sms', 'email', 'both'];

// Delivery channel is an account-level "how to reach me" preference, stored on
// the account's primary profile so it is consistent across every property.
const CHANNEL_DB_COLUMNS = ['appointment_confirmation_channel', 'service_reminder_72h_channel', 'service_reminder_24h_channel'];

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
  'billing_contact_name',
  'payment_confirmation_sms',
  'appointment_notify_primary',
  'service_report_notify_primary',
  'appointment_confirmation_channel',
  'service_reminder_72h_channel',
  'service_reminder_24h_channel',
];

function channelValue(value) {
  return CHANNEL_VALUES.includes(value) ? value : 'sms';
}

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
    billingContactName: prefs.billing_contact_name || '',
    paymentConfirmationSms: prefs.payment_confirmation_sms !== false,
    appointmentNotifyPrimary: prefs.appointment_notify_primary === true,
    serviceReportNotifyPrimary: prefs.service_report_notify_primary === true,
    // Per-notification delivery channel (sms | email | both)
    appointmentConfirmationChannel: channelValue(prefs.appointment_confirmation_channel),
    serviceReminder72hChannel: channelValue(prefs.service_reminder_72h_channel),
    serviceReminder24hChannel: channelValue(prefs.service_reminder_24h_channel),
  };
}

function comparableEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function notificationPrefsDbUpdates(updates = {}, existing = {}) {
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
  if (updates.billingEmail !== undefined) {
    dbUpdates.billing_email = updates.billingEmail || null;
    const emailChanged = comparableEmail(updates.billingEmail) !== comparableEmail(existing.billing_email);
    if (!updates.billingEmail || (emailChanged && updates.billingContactName === undefined)) {
      dbUpdates.billing_contact_name = null;
    }
  }
  if (updates.billingContactName !== undefined) {
    const effectiveBillingEmail = dbUpdates.billing_email !== undefined
      ? dbUpdates.billing_email
      : existing.billing_email;
    if (effectiveBillingEmail) {
      dbUpdates.billing_contact_name = updates.billingContactName || null;
    }
  }
  if (updates.paymentConfirmationSms !== undefined) dbUpdates.payment_confirmation_sms = updates.paymentConfirmationSms;
  if (updates.serviceReportNotifyPrimary !== undefined) dbUpdates.service_report_notify_primary = updates.serviceReportNotifyPrimary;
  if (updates.appointmentConfirmationChannel !== undefined) dbUpdates.appointment_confirmation_channel = channelValue(updates.appointmentConfirmationChannel);
  if (updates.serviceReminder72hChannel !== undefined) dbUpdates.service_reminder_72h_channel = channelValue(updates.serviceReminder72hChannel);
  if (updates.serviceReminder24hChannel !== undefined) dbUpdates.service_reminder_24h_channel = channelValue(updates.serviceReminder24hChannel);
  return dbUpdates;
}

const ACCOUNT_PREF_LABELS = {
  appointmentConfirmation: 'New Appointment Confirmation',
  serviceReminder72h: '72-Hour Appointment Reminder',
  serviceReminder24h: '24-Hour Service Reminder',
  techEnRoute: 'Tech En Route Alert',
  appointmentNotifyPrimary: 'Primary Account Appointment Copies',
  autoFlipEnRoute: 'Auto En Route from GPS',
  serviceCompleted: 'Service Complete Report',
  billingReminder: 'Billing Reminder',
  seasonalTips: 'Seasonal Lawn Tips',
  smsEnabled: 'Text Messages',
  emailEnabled: 'Email Messages',
  billingEmail: 'Billing Recipient Email',
  billingContactName: 'Billing Contact Name',
  paymentConfirmationSms: 'Payment Confirmation Texts',
  serviceReportNotifyPrimary: 'Primary Account Service Report Copies',
  appointmentConfirmationChannel: 'New Appointment Confirmation — Delivery',
  serviceReminder72hChannel: '72-Hour Appointment Reminder — Delivery',
  serviceReminder24hChannel: '24-Hour Service Reminder — Delivery',
};

// Preference keys whose value is a delivery channel (sms | email | both)
// rather than an on/off toggle — displayed by name in the change log.
const CHANNEL_PREF_KEYS = new Set([
  'appointmentConfirmationChannel',
  'serviceReminder72hChannel',
  'serviceReminder24hChannel',
]);

const CHANNEL_DISPLAY = { sms: 'Text', email: 'Email', both: 'Text & Email' };

const DB_FIELD_BY_PREF = {
  appointmentConfirmation: 'appointment_confirmation',
  serviceReminder72h: 'service_reminder_72h',
  serviceReminder24h: 'service_reminder_24h',
  techEnRoute: 'tech_en_route',
  appointmentNotifyPrimary: 'appointment_notify_primary',
  autoFlipEnRoute: 'auto_flip_en_route',
  serviceCompleted: 'service_completed',
  billingReminder: 'billing_reminder',
  seasonalTips: 'seasonal_tips',
  smsEnabled: 'sms_enabled',
  emailEnabled: 'email_enabled',
  billingEmail: 'billing_email',
  billingContactName: 'billing_contact_name',
  paymentConfirmationSms: 'payment_confirmation_sms',
  serviceReportNotifyPrimary: 'service_report_notify_primary',
  appointmentConfirmationChannel: 'appointment_confirmation_channel',
  serviceReminder72hChannel: 'service_reminder_72h_channel',
  serviceReminder24hChannel: 'service_reminder_24h_channel',
};

function prefDisplayValue(key, value) {
  if (key === 'billingEmail' || key === 'billingContactName') return value || 'Not set';
  if (CHANNEL_PREF_KEYS.has(key)) return CHANNEL_DISPLAY[channelValue(value)];
  return value === false ? 'Off' : 'On';
}

function preferenceChangeItems(updates = {}, before = {}, afterPrefs = {}, options = {}) {
  const items = [];
  for (const key of Object.keys(updates)) {
    if (key === 'serviceContact' || key === 'serviceContacts') continue;
    const label = ACCOUNT_PREF_LABELS[key];
    if (!label) continue;
    const dbField = DB_FIELD_BY_PREF[key];
    const oldRaw = dbField ? before?.[dbField] : undefined;
    let oldValue;
    if (key === 'billingEmail' || key === 'billingContactName') oldValue = oldRaw || '';
    else if (CHANNEL_PREF_KEYS.has(key)) oldValue = channelValue(oldRaw);
    else oldValue = oldRaw !== false;
    const newValue = afterPrefs?.[key];
    if (prefDisplayValue(key, oldValue) === prefDisplayValue(key, newValue)) continue;
    items.push({
      key,
      label,
      oldValue: prefDisplayValue(key, oldValue),
      newValue: prefDisplayValue(key, newValue),
      scope: options.scope || 'Account',
    });
  }
  if (updates.serviceContact || updates.serviceContacts) {
    items.push({
      key: 'serviceContact',
      label: updates.serviceContacts ? 'On-location Contacts' : 'On-location Contact',
      oldValue: 'Previous contacts',
      newValue: 'Updated',
      scope: options.scope || 'Property',
    });
  }
  return items;
}

function sendAccountUpdatedForPrefs({ req, targetCustomerId, propertyLabel, items, section }) {
  if (!items.length) return;
  const summary = items.length === 1
    ? `${items[0].label} was set to ${items[0].newValue}.`
    : `${items.length} Waves account settings were updated.`;
  void AccountMembershipEmail.sendAccountUpdated({
    customerId: targetCustomerId || req.customerId,
    recipientCustomerId: req.customerId,
    actorCustomerId: req.customerId,
    changedItems: items,
    changeSummary: summary,
    accountSection: section,
    propertyLabel,
  }).catch((err) => logger.warn(`[notifications] account.updated email failed for ${req.customerId}: ${err.message}`));
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

// Resolve the customer id that owns the account-level channel preference — the
// account's primary profile — so a customer switched to a secondary property
// still reads/writes the one shared channel. Falls back to the current customer
// when no primary profile resolves.
async function resolvePrimaryProfileId(req) {
  const accountId = req.accountId || req.customer?.account_id || req.customerId;
  if (!accountId) return req.customerId;
  const primary = await db('customers')
    .where({ account_id: accountId, is_primary_profile: true })
    .first('id')
    .catch(() => null);
  return primary?.id || req.customerId;
}

// Build the account-level preferences payload: per-property toggles/contacts
// come from the current customer; delivery channels come from the account's
// primary profile.
async function loadPreferencePayload(req) {
  const prefs = await ensurePrefs(req.customerId);
  const primaryId = await resolvePrimaryProfileId(req);
  const channelPrefs = String(primaryId) === String(req.customerId) ? prefs : await ensurePrefs(primaryId);
  return preferencePayload({
    ...prefs,
    appointment_confirmation_channel: channelPrefs.appointment_confirmation_channel,
    service_reminder_72h_channel: channelPrefs.service_reminder_72h_channel,
    service_reminder_24h_channel: channelPrefs.service_reminder_24h_channel,
  });
}

// =========================================================================
// GET /api/notifications/preferences — Get current notification prefs
// =========================================================================
router.get('/preferences', async (req, res, next) => {
  try {
    res.json(await loadPreferencePayload(req));
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
        ...SERVICE_CONTACT_COLUMNS
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
        // Legacy single-contact shape (slot 1) — kept for older clients.
        serviceContact: serviceContactPayload({
          name: p.service_contact_name,
          phone: p.service_contact_phone,
          email: p.service_contact_email,
        }),
        serviceContacts: serviceContactsPayload(p),
        maxServiceContacts: MAX_SERVICE_CONTACTS,
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
      billingContactName: Joi.string().trim().max(120).allow('', null),
      paymentConfirmationSms: Joi.boolean(),
      serviceReportNotifyPrimary: Joi.boolean(),
      appointmentConfirmationChannel: Joi.string().valid(...CHANNEL_VALUES),
      serviceReminder72hChannel: Joi.string().valid(...CHANNEL_VALUES),
      serviceReminder24hChannel: Joi.string().valid(...CHANNEL_VALUES),
    }).min(1);

    const updates = await schema.validateAsync(req.body);

    const existing = await ensurePrefs(req.customerId);
    const allDbUpdates = notificationPrefsDbUpdates(updates, existing || {});

    // Delivery channels are account-level — persist them on the primary profile
    // so the choice is honored no matter which property the customer is viewing.
    // Everything else stays per-property on the current customer row.
    const channelDbUpdates = {};
    const propertyDbUpdates = {};
    for (const [col, val] of Object.entries(allDbUpdates)) {
      (CHANNEL_DB_COLUMNS.includes(col) ? channelDbUpdates : propertyDbUpdates)[col] = val;
    }

    // Capture the primary profile's prior channel state before writing.
    const primaryId = Object.keys(channelDbUpdates).length ? await resolvePrimaryProfileId(req) : req.customerId;
    const existingPrimary = String(primaryId) === String(req.customerId) ? existing : await ensurePrefs(primaryId);

    if (Object.keys(propertyDbUpdates).length) {
      await db('notification_prefs')
        .where({ customer_id: req.customerId })
        .update({ ...propertyDbUpdates, updated_at: new Date() });
    }
    if (Object.keys(channelDbUpdates).length) {
      await db('notification_prefs')
        .where({ customer_id: primaryId })
        .update({ ...channelDbUpdates, updated_at: new Date() });
    }

    logger.info(`Notification prefs updated for ${req.customerId}: ${JSON.stringify({
      fields: Object.keys(updates).sort(),
    })}`);

    const payload = await loadPreferencePayload(req);

    // Change log: non-channel fields compare against the current customer's prior
    // row; channel fields against the primary profile's prior row.
    const before = { ...(existing || {}) };
    for (const col of CHANNEL_DB_COLUMNS) before[col] = existingPrimary?.[col];
    sendAccountUpdatedForPrefs({
      req,
      targetCustomerId: req.customerId,
      items: preferenceChangeItems(updates, before, payload, { scope: 'Account' }),
      section: 'Notification preferences',
    });

    res.json({
      success: true,
      preferences: payload,
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
      // phone max matches the service_contact*_phone column width (varchar 20)
      // so an over-long value is a 400, not a database length error.
      serviceContact: Joi.object({
        firstName: Joi.string().trim().max(50).allow('', null),
        lastName: Joi.string().trim().max(50).allow('', null),
        phone: Joi.string().trim().max(20).allow('', null),
        email: Joi.string().trim().email().max(150).allow('', null),
      }),
      serviceContacts: Joi.array().max(MAX_SERVICE_CONTACTS).items(Joi.object({
        firstName: Joi.string().trim().max(50).allow('', null),
        lastName: Joi.string().trim().max(50).allow('', null),
        phone: Joi.string().trim().max(20).allow('', null),
        email: Joi.string().trim().email().max(150).allow('', null),
      })),
    }).min(1);
    const updates = await schema.validateAsync(req.body);
    const targetCustomer = await db('customers')
      .where({ id: req.params.customerId })
      .first('id', 'profile_label', 'address_line1', 'city');
    const dbUpdates = { updated_at: new Date() };
    if (updates.appointmentConfirmation !== undefined) dbUpdates.appointment_confirmation = updates.appointmentConfirmation;
    if (updates.serviceReminder72h !== undefined) dbUpdates.service_reminder_72h = updates.serviceReminder72h;
    if (updates.serviceReminder24h !== undefined) dbUpdates.service_reminder_24h = updates.serviceReminder24h;
    if (updates.techEnRoute !== undefined) dbUpdates.tech_en_route = updates.techEnRoute;
    if (updates.appointmentNotifyPrimary !== undefined) dbUpdates.appointment_notify_primary = updates.appointmentNotifyPrimary;

    let savedContacts;
    if (updates.serviceContacts !== undefined) {
      // Full-list save: compact out empty entries and rewrite all three slots.
      const contacts = updates.serviceContacts
        .map(normalizeContactInput)
        .filter((c) => c.name || c.phone || c.email)
        .slice(0, MAX_SERVICE_CONTACTS);
      await db('customers').where({ id: req.params.customerId }).update({
        ...serviceContactSlotUpdates(contacts),
        updated_at: new Date(),
      });
      savedContacts = contacts.map(serviceContactPayload);
    } else if (updates.serviceContact !== undefined) {
      // Legacy single-contact save: writes slot 1 only.
      const contact = normalizeContactInput(updates.serviceContact);
      await db('customers').where({ id: req.params.customerId }).update({
        service_contact_name: contact.name || null,
        service_contact_phone: contact.phone || null,
        service_contact_email: contact.email || null,
        updated_at: new Date(),
      });
    }

    const existing = await ensurePrefs(req.params.customerId);
    if (existing) {
      await db('notification_prefs').where({ customer_id: req.params.customerId }).update(dbUpdates);
    } else {
      await db('notification_prefs').insert({ customer_id: req.params.customerId, ...dbUpdates });
    }

    const prefs = await ensurePrefs(req.params.customerId);
    const payload = preferencePayload(prefs);
    sendAccountUpdatedForPrefs({
      req,
      targetCustomerId: req.params.customerId,
      propertyLabel: targetCustomer?.profile_label || targetCustomer?.address_line1 || targetCustomer?.city || 'Service property',
      items: preferenceChangeItems(updates, existing || {}, payload, { scope: 'Property' }),
      section: 'Property notifications',
    });
    res.json({
      success: true,
      preferences: payload,
      ...(savedContacts !== undefined ? { serviceContacts: savedContacts } : {}),
    });
  } catch (err) {
    next(err);
  }
});

router._private = {
  comparableEmail,
  notificationPrefsDbUpdates,
  preferenceChangeItems,
  serviceContactPayload,
  serviceContactsPayload,
  serviceContactSlotUpdates,
  normalizeContactInput,
  resolvePrimaryProfileId,
  CHANNEL_DB_COLUMNS,
};

module.exports = router;
