const { lockCustomerComms, withCustomerCommsLock } = require('../utils/customer-comms-lock');
const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const { accountPropertyIds, resolvePrimaryProfileId, appPropertyScopeEnabled, accountSavedProperties } = require('../services/account-properties');
const PropertyTexts = require('../services/property-notification-prefs');
const { gateEnvValue } = require('../config/feature-gates');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const AccountMembershipEmail = require('../services/account-membership-email');
const { SERVICE_CONTACT_COLUMNS, getServiceContactSlots } = require('../services/customer-contact');
const { recordServiceContactChanges } = require('../services/service-contact-events');

router.use(authenticate);

// Max on-location contacts per property (slots on the customers row).
const MAX_SERVICE_CONTACTS = 3;

// Version tag for the recipient-consent disclosure shown in the portal
// property editor. Bump when the disclosure wording changes so the stored
// artifact says exactly which text the account holder attested to.
const SERVICE_CONTACT_CONSENT_VERSION = 'portal-2026-07-22';

// A contacts save that would store a texting target (any phone slot) is
// only allowed when the account holder attested on THIS save. Fail closed:
// legacy/cached clients and direct API calls that omit the flag get a 400
// instead of silently enrolling a third-party number (codex #2948 P1).
function serviceContactsRequireConsent(contacts = [], consentGiven) {
  return contacts.some((c) => c.phone) && consentGiven !== true;
}

// Consent artifact columns for a contacts save. Stamped only when the
// account holder attested on THIS save and the saved list is non-empty;
// any other save clears the stamp — a prior attestation doesn't cover a
// list it never described.
function serviceContactConsentUpdates(contacts = [], consentGiven = false) {
  if (contacts.length && consentGiven === true) {
    return {
      service_contacts_consent_at: new Date(),
      service_contacts_consent_source: 'portal_account_holder',
      service_contacts_consent_text_version: SERVICE_CONTACT_CONSENT_VERSION,
    };
  }
  return {
    service_contacts_consent_at: null,
    service_contacts_consent_source: null,
    service_contacts_consent_text_version: null,
  };
}

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
function serviceContactSlotUpdates(contacts = [], before = {}) {
  const updates = {};
  const slotColumns = [
    ['service_contact_name', 'service_contact_phone', 'service_contact_email', 'service_contact_role'],
    ['service_contact2_name', 'service_contact2_phone', 'service_contact2_email', 'service_contact2_role'],
    ['service_contact3_name', 'service_contact3_phone', 'service_contact3_email', 'service_contact3_role'],
  ];
  const norm = (v) => String(v || '').trim().toLowerCase();
  const phoneKey = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  // The editor rewrites slot IDENTITIES without knowing about roles — a
  // stale role left behind would attach itself to the new person (and the
  // call pipeline's household-role matching would trust it). But a person
  // who merely SHIFTED slots (deleting contact 1 compacts 2→1, 3→2) is not
  // a new identity, and the portal echoes the full list on save — so match
  // each incoming contact against ALL previous slots (phone, then email,
  // then exact name) and carry the matched slot's role; only a genuinely
  // new person gets a cleared role (codex round-3/round-4 P1 class).
  const prevSlots = slotColumns.map(([nameCol, phoneCol, emailCol, roleCol]) => ({
    name: before[nameCol], phone: before[phoneCol], email: before[emailCol], role: before[roleCol],
  }));
  const matchPrev = (contact) => {
    if (!contact) return null;
    return prevSlots.find((s) => phoneKey(contact.phone) && phoneKey(contact.phone) === phoneKey(s.phone))
      || prevSlots.find((s) => norm(contact.email) && norm(contact.email) === norm(s.email))
      || prevSlots.find((s) => norm(contact.name) && norm(contact.name) === norm(s.name))
      || null;
  };
  slotColumns.forEach(([nameCol, phoneCol, emailCol, roleCol], i) => {
    const contact = contacts[i];
    updates[nameCol] = contact?.name || null;
    updates[phoneCol] = contact?.phone || null;
    updates[emailCol] = contact?.email || null;
    updates[roleCol] = matchPrev(contact)?.role || null;
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
const APP_CHANNEL_KEYS = new Set([
  'appointmentConfirmationChannel', 'serviceReminder72hChannel', 'serviceReminder24hChannel', 'enRouteChannel', 'techArrivedChannel',
  'serviceCompleteChannel', 'paymentConfirmationChannel', 'invoiceChannel', 'paymentIssueChannel', 'requestChannel',
]);

function appPreferencesAvailable(req) {
  return gateEnvValue('GATE_CUSTOMER_APP_NOTIFICATIONS') && req.query?.appPreferences === '1';
}

// Delivery channels for appointment notifications are an account-level "how
// to reach me" preference, stored on the account's primary profile so they are
// consistent across every property. en_route_channel reuses the migration-104
// column; tech_arrived_channel is added by 20260707000050. Both are honored by
// the tech-tracking senders in services/twilio.js. The billing channels are
// NOT listed here — billing sends target the charged customer row, so
// billing_channel / payment_receipt_channel (migration-104 columns, also read
// by the estimate-deposits / estimate-card-holds receipt senders and the
// messaging consent gate) stay per-row next to the payment_confirmation_sms
// toggle and billing_email they modify. (billing_reminder is RETIRED —
// owner ruling 2026-08-01: billing notices carry no per-purpose opt-out;
// the column itself drops in a follow-up deploy.)
const CHANNEL_DB_COLUMNS = [
  'appointment_confirmation_channel',
  'service_reminder_72h_channel',
  // The explicit-choice stamp must travel WITH the channel it describes
  // (pre-push #3588 P1): the PUT handler routes CHANNEL_DB_COLUMNS to the
  // account's primary-profile row, and the reminder cron reads the stamp
  // from that same owner-resolved row — a stamp left on a secondary row
  // would be invisible to the cron and the promotion would override the
  // owner's explicit Text choice.
  'service_reminder_72h_channel_explicit',
  'service_reminder_24h_channel',
  'en_route_channel',
  'tech_arrived_channel',
  'service_complete_channel',
  'push_enabled',
];

const PREF_SELECT = [
  'appointment_confirmation',
  'service_reminder_72h',
  'service_reminder_24h',
  'tech_en_route',
  'tech_arrived',
  'auto_flip_en_route',
  'service_completed',
  'seasonal_tips',
  'weather_alerts',
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
  'en_route_channel',
  'tech_arrived_channel',
  'billing_channel',
  'payment_receipt_channel',
];

function channelValue(value, appPreferences = false) {
  return value === 'push' && appPreferences ? 'push' : CHANNEL_VALUES.includes(value) ? value : 'sms';
}

// Delivery channels are an account-level preference resolved from the primary
// profile, so they only belong on the account payload. Property payloads omit
// them (`includeChannels: false`) — otherwise a secondary property's local
// default channels would clobber the account channels when the client merges a
// property response into the top-level prefs.
function preferencePayload(prefs = {}, { includeChannels = true, appPreferences = false } = {}) {
  return {
    appointmentConfirmation: prefs.appointment_confirmation !== false,
    serviceReminder72h: prefs.service_reminder_72h !== false,
    serviceReminder24h: prefs.service_reminder_24h !== false,
    techEnRoute: prefs.tech_en_route !== false,
    techArrived: prefs.tech_arrived !== false,
    autoFlipEnRoute: prefs.auto_flip_en_route !== false,
    serviceCompleted: prefs.service_completed !== false,
    // seasonal_tips renders like the seasonal-content senders read it
    // (opt-OUT semantics: NULL = not opted out) so the UI never claims
    // seasonal messages are off while the weekly lawn email still sends.
    // The flip-only write guard below keeps a NULL row's ON rendering
    // from round-tripping into a stored true (fabricated SMS consent).
    seasonalTips: prefs.seasonal_tips !== false,
    weatherAlerts: prefs.weather_alerts !== false,
    smsEnabled: prefs.sms_enabled !== false,
    emailEnabled: prefs.email_enabled !== false,
    billingEmail: prefs.billing_email || '',
    billingContactName: prefs.billing_contact_name || '',
    paymentConfirmationSms: prefs.payment_confirmation_sms !== false,
    // `!== false` matches getAppointmentContacts' opt-OUT semantics — a strict
    // `=== true` here would render the portal/admin toggle OFF for rows where
    // the send path actually includes the holder (NULL / no prefs row).
    appointmentNotifyPrimary: prefs.appointment_notify_primary !== false,
    serviceReportNotifyPrimary: prefs.service_report_notify_primary !== false,
    ...(includeChannels ? {
      // Per-notification delivery channel (sms | email | both)
      appointmentConfirmationChannel: channelValue(prefs.appointment_confirmation_channel, appPreferences),
      serviceReminder72hChannel: channelValue(prefs.service_reminder_72h_channel, appPreferences),
      serviceReminder24hChannel: channelValue(prefs.service_reminder_24h_channel, appPreferences),
      enRouteChannel: channelValue(prefs.en_route_channel, appPreferences),
      techArrivedChannel: channelValue(prefs.tech_arrived_channel, appPreferences),
      // Billing delivery channels reuse the migration-104 columns so the
      // portal, the consent gate, and the channel-aware receipt senders
      // (estimate-deposits / estimate-card-holds) all read ONE preference.
      billingReminderChannel: channelValue(prefs.billing_channel),
      paymentConfirmationChannel: channelValue(prefs.payment_receipt_channel, appPreferences),
      ...(appPreferences ? {
        appPreferencesAvailable: true,
        pushEnabled: prefs.push_enabled !== false,
        serviceCompleteChannel: channelValue(prefs.service_complete_channel, true),
        invoiceChannel: channelValue(prefs.invoice_channel, true),
        paymentIssueChannel: channelValue(prefs.payment_issue_channel, true),
        requestChannel: prefs.request_channel === 'push' ? 'push' : 'email',
      } : {}),
    } : {}),
  };
}

function comparableEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function notificationPrefsDbUpdates(updates = {}, existing = {}) {
  const dbUpdates = {};
  for (const [key, field] of Object.entries(DB_FIELD_BY_PREF)) {
    if (['seasonalTips', 'billingEmail', 'billingContactName'].includes(key) || updates[key] === undefined) continue;
    dbUpdates[field] = CHANNEL_PREF_KEYS.has(key)
      ? channelValue(updates[key], APP_CHANNEL_KEYS.has(key)) : updates[key];
  }
  if (updates.seasonalTips !== undefined) {
    // Tri-state consent flag: persist only real flips vs the rendered
    // (opt-out style) state — an unchanged echo of the serializer's ON
    // rendering over a stored NULL must not mint a true (fabricated SMS
    // consent), and never-asked stays NULL on unrelated saves.
    if (updates.seasonalTips !== (existing.seasonal_tips !== false)) {
      dbUpdates.seasonal_tips = updates.seasonalTips;
    }
  }
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
  if (updates.serviceReminder72hChannel !== undefined) {
    // Explicit-choice stamp (Codex #3588 P1): a customer write of this field
    // is a deliberate delivery-method choice — the email-first 72h promotion
    // (GATE_REMINDER_72H_EMAIL_FIRST) must never override it. Stamped for
    // EVERY explicit value (sms included): re-choosing Text after the gate
    // flips is exactly the opt-out this exists to honor.
    dbUpdates.service_reminder_72h_channel_explicit = true;
  }
  // A full preference round trip may echo the default Email value. Only a
  // changed request channel proves a choice; unrelated saves keep provenance.
  if (updates.requestChannel !== undefined && updates.requestChannel !== (existing.request_channel || 'email')) {
    dbUpdates.request_channel_explicit = true;
  }
  return dbUpdates;
}

const ACCOUNT_PREF_LABELS = {
  appointmentConfirmation: 'New Appointment Confirmation',
  serviceReminder72h: '72-Hour Appointment Reminder',
  serviceReminder24h: '24-Hour Service Reminder',
  techEnRoute: 'Tech En Route Alert',
  techArrived: 'Tech Arrived Alert',
  appointmentNotifyPrimary: 'Primary Account Appointment Copies',
  autoFlipEnRoute: 'Auto En Route from GPS',
  serviceCompleted: 'Service Complete Report',
  seasonalTips: 'Seasonal Lawn Tips',
  weatherAlerts: 'Weather & Property Alerts',
  smsEnabled: 'Text Messages',
  emailEnabled: 'Email Messages',
  pushEnabled: 'App Notifications',
  billingEmail: 'Billing Recipient Email',
  billingContactName: 'Billing Contact Name',
  paymentConfirmationSms: 'Payment Confirmation Texts',
  serviceReportNotifyPrimary: 'Primary Account Service Report Copies',
  appointmentConfirmationChannel: 'New Appointment Confirmation — Delivery',
  serviceReminder72hChannel: '72-Hour Appointment Reminder — Delivery',
  serviceReminder24hChannel: '24-Hour Service Reminder — Delivery',
  enRouteChannel: 'Tech En Route Alert — Delivery',
  techArrivedChannel: 'Tech Arrived Alert — Delivery',
  serviceCompleteChannel: 'Service Complete Report — Delivery',
  invoiceChannel: 'Invoices — Delivery',
  paymentIssueChannel: 'Payment Problems — Delivery',
  requestChannel: 'Request Updates — Delivery',
  billingReminderChannel: 'Billing Reminder — Delivery',
  paymentConfirmationChannel: 'Payment Confirmation — Delivery',
};

// Preference keys whose value is a delivery channel (sms | email | both)
// rather than an on/off toggle — displayed by name in the change log.
const CHANNEL_PREF_KEYS = new Set([
  'appointmentConfirmationChannel',
  'serviceReminder72hChannel',
  'serviceReminder24hChannel',
  'enRouteChannel',
  'techArrivedChannel',
  'serviceCompleteChannel',
  'invoiceChannel',
  'paymentIssueChannel',
  'requestChannel',
  'billingReminderChannel',
  'paymentConfirmationChannel',
]);

const CHANNEL_DISPLAY = { sms: 'Text', email: 'Email', both: 'Text & Email', push: 'App' };

const DB_FIELD_BY_PREF = {
  appointmentConfirmation: 'appointment_confirmation',
  serviceReminder72h: 'service_reminder_72h',
  serviceReminder24h: 'service_reminder_24h',
  techEnRoute: 'tech_en_route',
  techArrived: 'tech_arrived',
  appointmentNotifyPrimary: 'appointment_notify_primary',
  autoFlipEnRoute: 'auto_flip_en_route',
  serviceCompleted: 'service_completed',
  seasonalTips: 'seasonal_tips',
  weatherAlerts: 'weather_alerts',
  smsEnabled: 'sms_enabled',
  emailEnabled: 'email_enabled',
  pushEnabled: 'push_enabled',
  billingEmail: 'billing_email',
  billingContactName: 'billing_contact_name',
  paymentConfirmationSms: 'payment_confirmation_sms',
  serviceReportNotifyPrimary: 'service_report_notify_primary',
  appointmentConfirmationChannel: 'appointment_confirmation_channel',
  serviceReminder72hChannel: 'service_reminder_72h_channel',
  serviceReminder24hChannel: 'service_reminder_24h_channel',
  enRouteChannel: 'en_route_channel',
  techArrivedChannel: 'tech_arrived_channel',
  serviceCompleteChannel: 'service_complete_channel',
  invoiceChannel: 'invoice_channel',
  paymentIssueChannel: 'payment_issue_channel',
  requestChannel: 'request_channel',
  billingReminderChannel: 'billing_channel',
  paymentConfirmationChannel: 'payment_receipt_channel',
};

function prefDisplayValue(key, value) {
  if (key === 'billingEmail' || key === 'billingContactName') return value || 'Not set';
  if (CHANNEL_PREF_KEYS.has(key)) return CHANNEL_DISPLAY[channelValue(value, true)];
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
    else if (CHANNEL_PREF_KEYS.has(key)) oldValue = channelValue(oldRaw, true);
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
    // Canonical helper: transactional defaults on, marketing-grade flags
    // NULL — an implicit row-mint must never fabricate marketing consent.
    const { createDefaultCustomerRows } = require('../services/customer-default-rows');
    await createDefaultCustomerRows(db, customerId);
    prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
  }
  return prefs;
}


// Build the account-level preferences payload: per-property toggles/contacts
// come from the current customer; delivery channels come from the account's
// primary profile.
async function loadPreferencePayload(req) {
  const prefs = await ensurePrefs(req.customerId);
  const primaryId = await resolvePrimaryProfileId(req);
  const channelPrefs = String(primaryId) === String(req.customerId) ? prefs : await ensurePrefs(primaryId);
  return {
    ...preferencePayload({
      ...prefs,
      appointment_confirmation_channel: channelPrefs.appointment_confirmation_channel,
      service_reminder_72h_channel: channelPrefs.service_reminder_72h_channel,
      service_reminder_24h_channel: channelPrefs.service_reminder_24h_channel,
      en_route_channel: channelPrefs.en_route_channel,
      tech_arrived_channel: channelPrefs.tech_arrived_channel,
      service_complete_channel: channelPrefs.service_complete_channel,
      push_enabled: channelPrefs.push_enabled,
    }, { appPreferences: appPreferencesAvailable(req) }),
    // Channels are account-level and the senders fall back to the account
    // primary's email on a secondary property (#1995 E), so the portal's
    // Email/Both offer keys on the ACCOUNT having an address — not on the
    // currently-selected property row alone.
    channelEmailAvailable: await accountEmailAvailable(req.customerId, primaryId),
  };
}

// True when the current profile OR the account primary carries a
// deliverable-looking email. Fail closed (false) on a read error — a false
// here only narrows the select to SMS; it never changes a stored channel.
async function accountEmailAvailable(customerId, primaryId) {
  const ids = [...new Set([customerId, primaryId].filter(Boolean).map(String))];
  if (!ids.length) return false;
  try {
    const rows = await db('customers').whereIn('id', ids).select('id', 'email');
    return rows.some((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r.email || '').trim()));
  } catch {
    return false;
  }
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

// App property scope (PR 3): under GATE_APP_PROPERTY_SCOPE the card lists
// every SAVED property (the same entries as GET /auth/properties?scope=saved,
// `id` = the entry key so the page's selection matches). A primary property
// answers its profile's notification_prefs row — byte-for-byte today's
// payload; a NON-primary one answers its own toggles (property_notification_
// prefs where chosen, the ruling-R1 default otherwise). On-location contacts
// stay per PROFILE (ruling R2 pending) and are repeated on every entry with
// `contactsShared: true`.
async function savedPropertyPreferences(req) {
  const { properties: entries } = await accountSavedProperties(req);
  if (!entries.some((e) => e.propertyId)) return null; // profile-shaped: today's list
  const profileIds = [...new Set(entries.map((e) => String(e.customerId)))];
  const profiles = await db('customers').whereIn('id', profileIds).select('id', ...SERVICE_CONTACT_COLUMNS);
  const profileById = new Map(profiles.map((p) => [String(p.id), p]));
  const prefsRows = await db('notification_prefs').whereIn('customer_id', profileIds).select('customer_id', ...PREF_SELECT);
  const prefsByProfile = new Map(prefsRows.map((row) => [String(row.customer_id), row]));
  for (const id of profileIds) {
    if (!prefsByProfile.has(id)) prefsByProfile.set(id, await ensurePrefs(id));
  }
  const propertyIds = entries.map((e) => e.propertyId).filter(Boolean);
  const propertyRows = propertyIds.length
    ? await db('property_notification_prefs').whereIn('property_id', propertyIds).select('property_id', ...PropertyTexts.PROPERTY_PREF_COLUMNS)
    : [];
  const rowByProperty = new Map(propertyRows.map((row) => [String(row.property_id), row]));
  return entries.map((entry) => {
    const profile = profileById.get(String(entry.customerId)) || {};
    const customerPrefs = prefsByProfile.get(String(entry.customerId)) || {};
    const secondary = !!entry.propertyId && entry.isPrimaryProperty !== true;
    const row = secondary ? rowByProperty.get(String(entry.propertyId)) || null : null;
    const prefsRow = secondary
      ? { ...customerPrefs, ...PropertyTexts.effectivePropertyToggles(entry, row, customerPrefs) }
      : customerPrefs;
    const chosen = {};
    if (secondary) {
      for (const col of PropertyTexts.PROPERTY_PREF_COLUMNS) chosen[PREF_COLUMN_TO_KEY[col]] = !!(row && typeof row[col] === 'boolean');
    }
    return {
      id: entry.key,
      key: entry.key,
      customerId: entry.customerId,
      propertyId: entry.propertyId,
      isPrimaryProfile: entry.isPrimaryProfile,
      isPrimaryProperty: entry.isPrimaryProperty,
      profileLabel: entry.profileLabel,
      label: entry.label,
      relationship: entry.relationship,
      quietByDefault: secondary && PropertyTexts.isQuietRelationship(entry.relationship),
      address: entry.address,
      preferences: preferencePayload(prefsRow, { includeChannels: false }),
      // Which toggles this property has CHOSEN (vs inheriting the default).
      ...(secondary ? { chosen } : {}),
      contactsShared: true,
      serviceContact: serviceContactPayload({
        name: profile.service_contact_name,
        phone: profile.service_contact_phone,
        email: profile.service_contact_email,
      }),
      serviceContacts: serviceContactsPayload(profile),
      maxServiceContacts: MAX_SERVICE_CONTACTS,
    };
  });
}

// The six property-owned columns, keyed both ways from the one field map the
// profile path already uses (DB_FIELD_BY_PREF) — no second spelling.
const PREF_KEY_TO_COLUMN = Object.fromEntries(
  Object.entries(DB_FIELD_BY_PREF).filter(([, col]) => PropertyTexts.PROPERTY_PREF_COLUMNS.includes(col)),
);
const PREF_COLUMN_TO_KEY = Object.fromEntries(Object.entries(PREF_KEY_TO_COLUMN).map(([key, col]) => [col, key]));

router.get('/property-preferences', async (req, res, next) => {
  try {
    // Shadow mode (GATE_APP_PROPERTY_TEXTS off): the sends still follow the
    // customer row, so the card must keep showing — and editing — that row
    // (today's per-profile card). Per-property controls appear only once
    // they are enforced (GitHub codex #4299 r1 P1).
    if (PropertyTexts.propertyTextsEnforced()) {
      const saved = await savedPropertyPreferences(req);
      if (saved) return res.json({ properties: saved });
    }
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
        preferences: preferencePayload(byCustomerId.get(String(p.id)) || {}, { includeChannels: false }),
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
      techArrived: Joi.boolean(),
      appointmentNotifyPrimary: Joi.boolean(),
      autoFlipEnRoute: Joi.boolean(),
      serviceCompleted: Joi.boolean(),
      // Tolerated + DISCARDED: the billing_reminder opt-out is removed
      // (owner ruling 2026-08-01), but a customer holding a cached portal
      // bundle still sends this key, and Joi rejects unknown keys — which
      // would fail their ENTIRE prefs save until they refresh. Safe to
      // delete after a deploy cycle.
      billingReminder: Joi.boolean().strip(),
      seasonalTips: Joi.boolean(),
      weatherAlerts: Joi.boolean(),
      smsEnabled: Joi.boolean(),
      emailEnabled: Joi.boolean(),
      pushEnabled: Joi.boolean(),
      billingEmail: Joi.string().trim().email().max(200).allow('', null),
      billingContactName: Joi.string().trim().max(120).allow('', null),
      paymentConfirmationSms: Joi.boolean(),
      serviceReportNotifyPrimary: Joi.boolean(),
      appointmentConfirmationChannel: Joi.string().valid(...CHANNEL_VALUES, 'push'),
      serviceReminder72hChannel: Joi.string().valid(...CHANNEL_VALUES, 'push'),
      serviceReminder24hChannel: Joi.string().valid(...CHANNEL_VALUES, 'push'),
      enRouteChannel: Joi.string().valid(...CHANNEL_VALUES, 'push'),
      techArrivedChannel: Joi.string().valid(...CHANNEL_VALUES, 'push'),
      serviceCompleteChannel: Joi.string().valid('sms', 'push'),
      invoiceChannel: Joi.string().valid('sms', 'push'),
      paymentIssueChannel: Joi.string().valid('sms', 'push'),
      requestChannel: Joi.string().valid('email', 'push'),
      billingReminderChannel: Joi.string().valid(...CHANNEL_VALUES),
      paymentConfirmationChannel: Joi.string().valid(...CHANNEL_VALUES, 'push'),
    }).min(1);

    const updates = await schema.validateAsync(req.body);
    const appPreferences = appPreferencesAvailable(req);
    if (!appPreferences && (updates.pushEnabled !== undefined || updates.serviceCompleteChannel !== undefined
      || [...APP_CHANNEL_KEYS].some((key) => updates[key] === 'push'))) {
      return res.status(400).json({ error: 'Refresh the app to manage app notifications.' });
    }

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

    // Older native builds render an unknown channel as Text and may echo it
    // when saving another setting. Their saves must not erase an App choice.
    // The same rule applies while the new UI gate is off during rollback.
    if (!appPreferences) {
      for (const [key, col] of Object.entries(DB_FIELD_BY_PREF)) {
        if (!APP_CHANNEL_KEYS.has(key)) continue;
        const owner = CHANNEL_DB_COLUMNS.includes(col) ? existingPrimary : existing;
        if (owner?.[col] === 'push') {
          delete channelDbUpdates[col];
          delete propertyDbUpdates[col];
          if (key === 'requestChannel') delete propertyDbUpdates.request_channel_explicit;
          delete updates[key];
        }
      }
    }
    if ([...APP_CHANNEL_KEYS].some((key) => updates[key] === 'push'
      && (CHANNEL_DB_COLUMNS.includes(DB_FIELD_BY_PREF[key]) ? existingPrimary : existing)?.[DB_FIELD_BY_PREF[key]] !== 'push')) {
      const status = await require('../services/push-notifications').customerStatus(req.customerId);
      if (!status.fresh || updates.pushEnabled === false || (updates.pushEnabled !== true && !status.enabled)) {
        return res.status(409).json({ error: 'Connect the app and enable notifications before choosing App.' });
      }
    }

    await db.transaction(async (trx) => {
      for (const id of [...new Set([req.customerId, primaryId])].sort()) await lockCustomerComms(trx, id);
      // Row before key, like every other notification_prefs writer in this
      // file: lock the preference row(s) this save is about to update
      // BEFORE requesting the address key. retrySummaryThroughHandoff and
      // commitRecoveryOnDelivery both lock a preference row first and take
      // the address key second — taking the key first here would let this
      // transaction wait on a preference row while one of those waits on
      // this transaction's key, a deadlock either side can lose.
      const prefRowIds = [
        ...(Object.keys(propertyDbUpdates).length ? [req.customerId] : []),
        ...(Object.keys(channelDbUpdates).length ? [primaryId] : []),
      ];
      for (const id of [...new Set(prefRowIds)].sort()) {
        await trx('notification_prefs').where({ customer_id: id }).forUpdate().first('customer_id');
      }
      // A billing address assigned here takes the address key after the row
      // locks, like every customer address writer: a bearer-link handoff
      // that read the address as unowned commits before this claim or
      // re-judges ownership after it.
      await require('../utils/customer-comms-lock').lockAssignedCustomerEmails(trx, { ...propertyDbUpdates, ...channelDbUpdates });
      if (Object.keys(propertyDbUpdates).length) {
        await trx('notification_prefs').where({ customer_id: req.customerId })
          .update({ ...propertyDbUpdates, updated_at: new Date() });
      }
      if (Object.keys(channelDbUpdates).length) {
        await trx('notification_prefs').where({ customer_id: primaryId })
          .update({ ...channelDbUpdates, updated_at: new Date() });
      }
    });

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
      // App property scope (PR 3): the SAVED property these toggles are for.
      // Omitted, or the profile's primary property = the profile row below.
      propertyId: Joi.string().guid({ version: 'uuidv4' }).allow(null),
      appointmentConfirmation: Joi.boolean(),
      serviceReminder72h: Joi.boolean(),
      serviceReminder24h: Joi.boolean(),
      techEnRoute: Joi.boolean(),
      techArrived: Joi.boolean(),
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
      // Account-holder attestation that every listed person agreed to
      // receive service texts (see SERVICE_CONTACT_CONSENT_VERSION).
      serviceContactsConsent: Joi.boolean(),
    }).min(1);
    const updates = await schema.validateAsync(req.body);
    if (updates.propertyId) {
      const handled = await savePropertyToggles(req, res, updates);
      if (handled) return undefined;
    }
    delete updates.propertyId;
    const targetCustomer = await db('customers')
      .where({ id: req.params.customerId })
      .first('id', 'profile_label', 'address_line1', 'city');
    const dbUpdates = { updated_at: new Date() };
    if (updates.appointmentConfirmation !== undefined) dbUpdates.appointment_confirmation = updates.appointmentConfirmation;
    if (updates.serviceReminder72h !== undefined) dbUpdates.service_reminder_72h = updates.serviceReminder72h;
    if (updates.serviceReminder24h !== undefined) dbUpdates.service_reminder_24h = updates.serviceReminder24h;
    if (updates.techEnRoute !== undefined) dbUpdates.tech_en_route = updates.techEnRoute;
    if (updates.techArrived !== undefined) dbUpdates.tech_arrived = updates.techArrived;
    if (updates.appointmentNotifyPrimary !== undefined) dbUpdates.appointment_notify_primary = updates.appointmentNotifyPrimary;

    let savedContacts;
    // Claimed opt-in asks dispatch AFTER ensurePrefs below — the consent
    // validator needs the notification_prefs row to exist, or a first-save
    // race fails the ask with NO_CONSENT_RECORD and strands it ask_failed.
    let pendingOptinDispatch = null;
    if (updates.serviceContacts !== undefined) {
      // Full-list save: compact out empty entries and rewrite all three slots.
      const contacts = updates.serviceContacts
        .map(normalizeContactInput)
        .filter((c) => c.name || c.phone || c.email)
        .slice(0, MAX_SERVICE_CONTACTS);
      if (serviceContactsRequireConsent(contacts, updates.serviceContactsConsent)) {
        return res.status(400).json({
          error: 'Saving a contact with a phone number requires confirming the text-message consent statement. Refresh the portal and try again.',
        });
      }
      const beforeRow = await db('customers').where({ id: req.params.customerId }).first() || {};
      // Recipient double opt-in (gated + dark template): the pending-row
      // CLAIMS and the contact UPDATE commit in ONE transaction — the claim
      // lands before the slots become visible (no grandfather window), and
      // a failed UPDATE rolls the claims back (no stranded pending rows).
      // A claim failure fails the whole save. Twilio dispatch runs only
      // after commit, async, with failures logged.
      let optinClaims = [];
      const optinArgs = updates.serviceContactsConsent === true && contacts.length ? {
        customer: beforeRow,
        contacts: contacts.map((c) => ({ name: c.name, firstName: String(c.name || '').split(/\s+/)[0], phone: c.phone })),
        priorPhones: [beforeRow.service_contact_phone, beforeRow.service_contact2_phone, beforeRow.service_contact3_phone],
        propertyAddress: [beforeRow.address_line1, beforeRow.city].filter(Boolean).join(', '),
      } : null;
      const slotUpdates = serviceContactSlotUpdates(contacts, beforeRow);
      const consentUpdates = serviceContactConsentUpdates(contacts, updates.serviceContactsConsent);
      let lockedBefore = beforeRow;
      let lockedAt = null;
      await db.transaction(async (trx) => {
        // Row lock + re-read: the audit diff below must describe the actual
        // DB transition — a concurrent save may have moved the row since the
        // unlocked beforeRow read, and diffing against that stale snapshot
        // fabricates or drops timeline events. The lock-held timestamp
        // orders the events even if a later save's insert lands first.
        lockedBefore = await trx('customers').where({ id: req.params.customerId }).forUpdate().first() || beforeRow;
        lockedAt = new Date();
        // The assigned addresses take the shared email key after the row
        // lock, so a bounce recovery's ownership check cannot be overtaken
        // by this save (utils/customer-comms-lock.js lockAssignedCustomerEmails).
        await require('../utils/customer-comms-lock').lockAssignedCustomerEmails(trx, slotUpdates);
        if (optinArgs) {
          const { claimRecipientOptins } = require('../services/recipient-optin');
          optinClaims = await claimRecipientOptins({ ...optinArgs, trx });
        }
        await trx('customers').where({ id: req.params.customerId }).update({
          ...slotUpdates,
          ...consentUpdates,
          updated_at: new Date(),
        });
      });
      savedContacts = contacts.map(serviceContactPayload);
      if (optinClaims.length) pendingOptinDispatch = { claims: optinClaims, customer: beforeRow };
      // Contact change events for the 360 timeline — post-commit, best-effort
      // (the recorder never throws; a logging failure only warns and never
      // fails the save). Awaited so the row is committed before the save
      // reports done and events land in order.
      await recordServiceContactChanges({
        customerId: req.params.customerId,
        before: lockedBefore,
        after: { ...lockedBefore, ...slotUpdates, ...consentUpdates },
        source: 'portal',
        actorCustomerId: req.customerId,
        occurredAt: lockedAt,
      });
    } else if (updates.serviceContact !== undefined) {
      // Legacy single-contact save: writes slot 1 only. Role handling
      // mirrors the list save: the same person (matched by phone/email/name
      // against any previous slot) keeps their pipeline-recorded role; a
      // genuinely new person never inherits the old one.
      const contact = normalizeContactInput(updates.serviceContact);
      const beforeRow = await db('customers').where({ id: req.params.customerId }).first() || {};
      // Consent decisions must describe what will actually be STORED after
      // this save — the new slot 1 plus the untouched slot 2/3 people — not
      // just the payload (codex #2948 r5): a slot-1-only edit neither
      // bypasses the guard while other phone recipients remain, nor strips
      // their stamp semantics by looking at slot 1 alone.
      const survivors = [2, 3]
        .map((n) => ({
          name: String(beforeRow[`service_contact${n}_name`] || '').trim(),
          phone: String(beforeRow[`service_contact${n}_phone`] || '').trim(),
          email: String(beforeRow[`service_contact${n}_email`] || '').trim(),
        }))
        .filter((c) => c.name || c.phone || c.email);
      const postSave = [contact, ...survivors].filter((c) => c.name || c.phone || c.email);
      // Same consent rail as the list save — the legacy shape must not be
      // a loophole for storing an unattested texting target.
      if (serviceContactsRequireConsent(postSave, updates.serviceContactsConsent)) {
        return res.status(400).json({
          error: 'Saving a contact with a phone number requires confirming the text-message consent statement. Refresh the portal and try again.',
        });
      }
      const slot1 = serviceContactSlotUpdates([contact], beforeRow);
      // Same artifact rule AND same claim-in-transaction opt-in flow as the
      // list save — the legacy shape must not be a loophole that enrolls a
      // new phone without the confirmation flow or its rollback semantics.
      let legacyClaims = [];
      // Full post-save list, not just slot 1: ask_failed survivors in
      // slots 2/3 must retry on this consented save too (#2956 r4).
      const legacyOptinArgs = updates.serviceContactsConsent === true && postSave.some((c) => c.phone) ? {
        customer: beforeRow,
        contacts: postSave.map((c) => ({ name: c.name, firstName: String(c.name || '').split(/\s+/)[0], phone: c.phone })),
        priorPhones: [beforeRow.service_contact_phone, beforeRow.service_contact2_phone, beforeRow.service_contact3_phone],
        propertyAddress: [beforeRow.address_line1, beforeRow.city].filter(Boolean).join(', '),
      } : null;
      const legacySlot1Updates = {
        service_contact_name: slot1.service_contact_name,
        service_contact_phone: slot1.service_contact_phone,
        service_contact_email: slot1.service_contact_email,
        service_contact_role: slot1.service_contact_role,
      };
      const legacyConsentUpdates = serviceContactConsentUpdates(postSave, updates.serviceContactsConsent);
      let legacyLockedBefore = beforeRow;
      let legacyLockedAt = null;
      await db.transaction(async (trx) => {
        // Same row-lock re-read as the list save — the audit diff must
        // describe the actual DB transition, not a possibly-stale snapshot.
        legacyLockedBefore = await trx('customers').where({ id: req.params.customerId }).forUpdate().first() || beforeRow;
        legacyLockedAt = new Date();
        await require('../utils/customer-comms-lock').lockAssignedCustomerEmails(trx, legacySlot1Updates);
        if (legacyOptinArgs) {
          const { claimRecipientOptins } = require('../services/recipient-optin');
          legacyClaims = await claimRecipientOptins({ ...legacyOptinArgs, trx });
        }
        await trx('customers').where({ id: req.params.customerId }).update({
          ...legacySlot1Updates,
          ...legacyConsentUpdates,
          updated_at: new Date(),
        });
      });
      if (legacyClaims.length) pendingOptinDispatch = { claims: legacyClaims, customer: beforeRow };
      // Same events as the list save — the legacy shape must not be a
      // logging loophole either. Post-commit, best-effort, awaited (the
      // recorder never throws).
      await recordServiceContactChanges({
        customerId: req.params.customerId,
        before: legacyLockedBefore,
        after: { ...legacyLockedBefore, ...legacySlot1Updates, ...legacyConsentUpdates },
        source: 'portal',
        actorCustomerId: req.customerId,
        occurredAt: legacyLockedAt,
      });
    }

    // ensurePrefs creates any missing row through the canonical helper
    // (marketing flags NULL), so this is always an update — a bare insert
    // here would take the legacy true defaults and mint marketing consent.
    const existing = await ensurePrefs(req.params.customerId);
    await withCustomerCommsLock(db, req.params.customerId, async (trx) => {
      // Row first, then the address key for an assigned billing_email (the
      // bounce recovery reads billing_email as an ownership source).
      await trx('notification_prefs').where({ customer_id: req.params.customerId }).forUpdate().first('customer_id');
      await require('../utils/customer-comms-lock').lockAssignedCustomerEmails(trx, dbUpdates);
      await trx('notification_prefs').where({ customer_id: req.params.customerId }).update(dbUpdates);
    });
    if (pendingOptinDispatch) {
      const { dispatchRecipientOptins } = require('../services/recipient-optin');
      void dispatchRecipientOptins(pendingOptinDispatch.claims, pendingOptinDispatch.customer)
        .catch((err) => logger.error(`[notifications] recipient opt-in dispatch failed for customer ${req.params.customerId}: ${err.message}`));
    }

    const prefs = await ensurePrefs(req.params.customerId);
    const payload = preferencePayload(prefs, { includeChannels: false });
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

// The per-property write (app property scope, PR 3). Returns true when the
// response was sent; false hands the request to the profile path (the
// property is the profile's PRIMARY — it has no row of its own by design).
async function savePropertyToggles(req, res, updates) {
  if (!PropertyTexts.propertyTextsEnforced()) {
    res.status(404).json({ error: 'Per-property notification settings are not available.' });
    return true;
  }
  const property = await db('customer_properties')
    .where({ id: updates.propertyId, customer_id: req.params.customerId })
    .first('id', 'customer_id', 'is_primary', 'active', 'relationship', 'label', 'address_line1', 'city');
  if (!property || property.active === false) {
    res.status(404).json({ error: 'Property is not available for this account' });
    return true;
  }
  if (property.is_primary === true) return false;
  const contactFields = ['serviceContact', 'serviceContacts', 'serviceContactsConsent'].filter((k) => updates[k] !== undefined);
  if (contactFields.length) {
    // Ruling R2 pending: on-location contacts stay per PROFILE. Refuse rather
    // than silently write house B's tenant onto every house.
    res.status(400).json({ error: 'On-location contacts are shared across this profile\'s properties. Edit them under the primary property.' });
    return true;
  }
  const dbUpdates = { updated_at: new Date() };
  for (const [key, col] of Object.entries(PREF_KEY_TO_COLUMN)) {
    if (updates[key] !== undefined) dbUpdates[col] = updates[key];
  }
  if (Object.keys(dbUpdates).length === 1) {
    res.status(400).json({ error: 'No notification setting to save.' });
    return true;
  }
  // One statement, serialized like the profile write: two quick taps on a
  // fresh house race the read-then-insert (property_id is UNIQUE), and an
  // in-flight send must not read a half-committed toggle.
  const existing = await db('property_notification_prefs').where({ property_id: property.id }).first(...PropertyTexts.PROPERTY_PREF_COLUMNS);
  // Re-read the property row UNDER the lock: a primary flip landing between
  // the unlocked read above and this write would otherwise leave a dormant
  // row on the new primary that resurfaces as a stale override on a later
  // demotion (GitHub codex r4 P2).
  const stillSecondary = await withCustomerCommsLock(db, property.customer_id, async (trx) => {
    const live = await trx('customer_properties').where({ id: property.id, customer_id: property.customer_id }).forUpdate().first('is_primary', 'active');
    if (!live || live.active === false || live.is_primary === true) return false;
    await trx('property_notification_prefs')
      .insert({ property_id: property.id, customer_id: property.customer_id, ...dbUpdates })
      .onConflict('property_id')
      .merge(dbUpdates);
    return true;
  });
  if (!stillSecondary) {
    res.status(409).json({ error: 'This property just changed. Refresh and try again.' });
    return true;
  }
  const row = await db('property_notification_prefs').where({ property_id: property.id }).first(...PropertyTexts.PROPERTY_PREF_COLUMNS);
  const customerPrefs = await ensurePrefs(req.params.customerId);
  const effective = PropertyTexts.effectivePropertyToggles(property, row, customerPrefs);
  const payload = preferencePayload({ ...customerPrefs, ...effective }, { includeChannels: false });
  // DB-shaped (preferenceChangeItems reads the column names from `before`).
  const before = { ...customerPrefs, ...PropertyTexts.effectivePropertyToggles(property, existing, customerPrefs) };
  sendAccountUpdatedForPrefs({
    req,
    targetCustomerId: req.params.customerId,
    propertyLabel: property.label || property.address_line1 || property.city || 'Service property',
    items: preferenceChangeItems(updates, before, payload, { scope: 'Property' }),
    section: 'Property notifications',
  });
  res.json({ success: true, propertyId: property.id, preferences: payload });
  return true;
}

router._private = {
  comparableEmail,
  notificationPrefsDbUpdates,
  preferencePayload,
  preferenceChangeItems,
  serviceContactPayload,
  serviceContactsPayload,
  serviceContactSlotUpdates,
  serviceContactConsentUpdates,
  serviceContactsRequireConsent,
  normalizeContactInput,
  loadPreferencePayload,
  accountEmailAvailable,
  CHANNEL_DB_COLUMNS,
  SERVICE_CONTACT_CONSENT_VERSION,
};

module.exports = router;
