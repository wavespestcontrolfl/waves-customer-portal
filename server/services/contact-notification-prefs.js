'use strict';

// Per-contact notification choices (contact login, GATE_CONTACT_LOGIN):
// what an on-location contact chose for THEMSELVES in the app, stored in
// service_contact_notification_prefs keyed by (customer, phone key).
//
// One rule, applied at every fan-out seam right after the recipient opt-in
// filter: a stored choice only NARROWS. The customer row's toggles and the
// consent validator stay authoritative, so a contact can never receive a
// purpose the holder turned off account-wide; they can only decline one the
// account would otherwise send them, or keep it to one channel.
//
// Fail CLOSED on an unreadable table (same posture as filterRecipientsByOptin):
// a contact whose choices cannot be read is held, never texted on a guess.
// A missing table (42P01, un-migrated env) is the documented absent state and
// reads as "no choices". Gate off = pass-through, byte-identical to before.

const db = require('../models/db');
const logger = require('./logger');

const TABLE = 'service_contact_notification_prefs';

// The six purposes a contact may decline, by notification_prefs column name
// (the same spelling messaging/policy.js PURPOSE_POLICY.prefsColumn uses).
const CONTACT_PREF_TOGGLES = [
  'appointment_confirmation',
  'service_reminder_72h',
  'service_reminder_24h',
  'tech_en_route',
  'tech_arrived',
  'service_completed',
];

// Purpose column → the channel column that narrows its delivery.
const CHANNEL_COLUMN_FOR = {
  appointment_confirmation: 'appointment_confirmation_channel',
  service_reminder_72h: 'service_reminder_72h_channel',
  service_reminder_24h: 'service_reminder_24h_channel',
  tech_en_route: 'en_route_channel',
  tech_arrived: 'tech_arrived_channel',
  service_completed: 'service_complete_channel',
};

const CONTACT_PREF_COLUMNS = [
  ...CONTACT_PREF_TOGGLES,
  ...Object.values(CHANNEL_COLUMN_FOR),
  'sms_enabled',
  'email_enabled',
  'consent_attested_at',
];

// The appointment EMAIL's event types (appointment-email.js sendTemplate) →
// the purpose column they belong to. Cancellation / no-show carry no
// per-purpose opt-out, for the holder or a contact.
const EMAIL_EVENT_COLUMN = {
  'appointment.confirmation': 'appointment_confirmation',
  'appointment.reminder_72h': 'service_reminder_72h',
  'appointment.reminder_24h': 'service_reminder_24h',
  'appointment.en_route': 'tech_en_route',
  'appointment.tech_arrived': 'tech_arrived',
};

function contactPrefsLive() {
  try {
    return require('../config/feature-gates').contactLoginLive();
  } catch {
    return false;
  }
}

function phoneKey(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

function columnForEmailEvent(eventType) {
  return EMAIL_EVENT_COLUMN[String(eventType || '')] || null;
}

// Pure: does this contact's row allow `column` (a purpose; null = a purpose
// with no opt-out) on `channel` ('sms' | 'email')? No row = allowed.
function contactAllows(row, column, channel = 'sms') {
  if (!row) return true;
  if (channel === 'sms' && row.sms_enabled === false) return false;
  if (channel === 'email' && row.email_enabled === false) return false;
  if (!column) return true;
  if (row[column] === false) return false;
  const chosen = CHANNEL_COLUMN_FOR[column] ? row[CHANNEL_COLUMN_FOR[column]] : null;
  if (chosen === 'sms' && channel === 'email') return false;
  if (chosen === 'email' && channel === 'sms') return false;
  return true;
}

// Map<phoneKey, row> for one customer. Missing table → empty map; any other
// read error throws (the callers hold).
async function loadContactPrefRows(customerId, { dbh = db } = {}) {
  const rows = new Map();
  if (!customerId) return rows;
  let found;
  try {
    found = await dbh(TABLE).where({ customer_id: customerId }).select('phone_key', ...CONTACT_PREF_COLUMNS);
  } catch (err) {
    if (err && err.code === '42P01' && !(dbh && dbh.isTransaction)) {
      logger.warn('[contact-prefs] table missing — no per-contact choices');
      return rows;
    }
    throw err;
  }
  for (const row of found || []) rows.set(String(row.phone_key), row);
  return rows;
}

async function getContactPrefRow(customerId, phone, { dbh = db } = {}) {
  const key = phoneKey(phone);
  if (!key) return null;
  return (await loadContactPrefRows(customerId, { dbh })).get(key) || null;
}

// Send-path filter: drops service-contact-role recipients (customer-contact.js
// isServiceContactRole) whose own row declines `column` on `channel`. Primary
// / billing recipients pass through untouched. Fail CLOSED: with the gate on,
// an unreadable table holds every service contact; on a transaction handle
// the error is rethrown (Postgres has already aborted that transaction).
async function filterContactsByOwnPrefs(contacts = [], customerId = null, column = null, { channel = 'sms', dbh = db } = {}) {
  if (!contactPrefsLive() || !contacts.length) return contacts;
  const { isServiceContactRole } = require('./customer-contact');
  if (!contacts.some((c) => isServiceContactRole(c.role))) return contacts;
  let rows;
  try {
    rows = await loadContactPrefRows(customerId, { dbh });
  } catch (err) {
    if (dbh && dbh.isTransaction) throw err;
    logger.warn(`[contact-prefs] read failed (${err.message}) — holding service contacts`);
    return contacts.filter((c) => !isServiceContactRole(c.role));
  }
  if (!rows.size) return contacts;
  return contacts.filter((c) => {
    if (!isServiceContactRole(c.role)) return true;
    const allowed = contactAllows(rows.get(phoneKey(c.phone)) || null, column, channel);
    if (!allowed) logger.info(`[contact-prefs] contact declined ${column || 'this notice'} by ${channel} — holding`);
    return allowed;
  });
}

// The slot roles (service_contact, service_contact_2, …) whose phone declined
// an appointment EMAIL event (appointment-email.js resolveRecipients). Empty
// with the gate off; throws on an unreadable table (the caller holds).
async function declinedEmailSlotRoles(customer, eventType, { dbh = db } = {}) {
  const declined = new Set();
  if (!contactPrefsLive() || !customer) return declined;
  const { getServiceContactSlots } = require('./customer-contact');
  const column = columnForEmailEvent(eventType);
  const rows = await loadContactPrefRows(customer.id, { dbh });
  for (const slot of getServiceContactSlots(customer)) {
    const row = slot.phone ? rows.get(phoneKey(slot.phone)) : null;
    if (row && !contactAllows(row, column, 'email')) declined.add(slot.role);
  }
  return declined;
}

// Does `patch` OPEN a text path for this contact that was closed before —
// a purpose that will now text them (holder has it on, contact has it on,
// delivery is text-capable, texts not switched off)? That, and only that,
// needs the contact's own text consent. An email-only delivery, a purpose
// the holder turned off account-wide, or a change that leaves every text
// path as it was never does (codex round 1 on #6363).
function textPathsOpened(accountRow, existingRow, patch = {}) {
  const account = accountRow || {};
  const before = existingRow || {};
  const after = { ...before, ...patch };
  const textPath = (row, col) => account[col] !== false && row[col] !== false && row.sms_enabled !== false
    && [null, undefined, 'both', 'sms'].includes(row[CHANNEL_COLUMN_FOR[col]]);
  return CONTACT_PREF_TOGGLES.some((col) => textPath(after, col) && !textPath(before, col));
}

// Service-report EMAIL recipients (customer-contact.js
// getServiceReportEmailRecipients) carry the SLOT role, and a slot's email
// may travel without its phone — so the row is found through the slot's
// phone, and an email-only slot (no phone, no row) passes through.
async function filterReportEmailRecipientsByContactPrefs(recipients = [], customer = null, { dbh = db } = {}) {
  if (!contactPrefsLive() || !customer || !recipients.length) return recipients;
  const { isServiceContactRole, getServiceContactSlots } = require('./customer-contact');
  if (!recipients.some((r) => isServiceContactRole(r.role))) return recipients;
  let rows;
  try {
    rows = await loadContactPrefRows(customer.id, { dbh });
  } catch (err) {
    if (dbh && dbh.isTransaction) throw err;
    logger.warn(`[contact-prefs] read failed (${err.message}) — holding service-contact report emails`);
    return recipients.filter((r) => !isServiceContactRole(r.role));
  }
  if (!rows.size) return recipients;
  const phoneByRole = new Map(getServiceContactSlots(customer).map((s) => [s.role, s.phone]));
  return recipients.filter((r) => {
    if (!isServiceContactRole(r.role)) return true;
    const key = phoneKey(phoneByRole.get(r.role));
    return contactAllows(key ? rows.get(key) || null : null, 'service_completed', 'email');
  });
}

// Does this resolved recipient — a service-contact-role contact — decline
// `channel` through their own master switch? Review outreach (review-
// request.js) resolves ONE recipient rather than a list, so it asks here
// instead of filterContactsByOwnPrefs. Primary / billing recipients never
// decline here; gate off = never. Fail CLOSED on an unreadable table: a
// contact whose choices cannot be read is treated as declining.
async function contactDeclinesChannel(customerId, contact, channel = 'sms', { dbh = db } = {}) {
  if (!contactPrefsLive() || !contact || !contact.phone) return false;
  if (!require('./customer-contact').isServiceContactRole(contact.role)) return false;
  let row;
  try {
    row = await getContactPrefRow(customerId, contact.phone, { dbh });
  } catch (err) {
    if (dbh && dbh.isTransaction) throw err;
    logger.warn(`[contact-prefs] read failed (${err.message}) — holding the service contact's ${channel}`);
    return true;
  }
  return !contactAllows(row, null, channel);
}

// The holder's contact save rewrote the slots: drop the rows of phones that
// no longer occupy one, and clear the email-only delivery choices of a kept
// phone whose slot no longer carries an email (an "email only" choice with
// no address would deliver nothing — codex #6363 r6 P2). `contacts` are the
// saved slots ({ phone, email }; a bare phone string = no email). Inside the
// save's transaction; a missing table is the absent state.
async function pruneContactNotificationPrefs(trx, customerId, contacts = []) {
  const slots = contacts.map((c) => (typeof c === 'string' ? { phone: c } : c || {}));
  const keep = [...new Set(slots.map((c) => phoneKey(c.phone)).filter(Boolean))];
  const emailLess = [...new Set(slots.filter((c) => !String(c.email || '').trim()).map((c) => phoneKey(c.phone)).filter(Boolean))];
  try {
    const q = trx(TABLE).where({ customer_id: customerId });
    if (keep.length) q.whereNotIn('phone_key', keep);
    await q.delete();
    for (const col of Object.values(CHANNEL_COLUMN_FOR)) {
      if (!emailLess.length) break;
      await trx(TABLE).where({ customer_id: customerId, [col]: 'email' }).whereIn('phone_key', emailLess).update({ [col]: null, updated_at: new Date() });
    }
  } catch (err) {
    if (err && err.code === '42P01') return;
    throw err;
  }
}

async function upsertContactNotificationPrefs(trx, customerId, phone, patch = {}) {
  const key = phoneKey(phone);
  if (!key) throw new Error('contact phone key required');
  const row = {};
  for (const col of CONTACT_PREF_COLUMNS) if (patch[col] !== undefined) row[col] = patch[col];
  const now = new Date();
  await trx(TABLE)
    .insert({ customer_id: customerId, phone_key: key, ...row, created_at: now, updated_at: now })
    .onConflict(['customer_id', 'phone_key'])
    .merge({ ...row, updated_at: now });
  return trx(TABLE).where({ customer_id: customerId, phone_key: key }).first();
}

module.exports = {
  TABLE,
  CONTACT_PREF_TOGGLES,
  CHANNEL_COLUMN_FOR,
  CONTACT_PREF_COLUMNS,
  contactPrefsLive,
  columnForEmailEvent,
  contactAllows,
  loadContactPrefRows,
  getContactPrefRow,
  filterContactsByOwnPrefs,
  textPathsOpened,
  declinedEmailSlotRoles,
  filterReportEmailRecipientsByContactPrefs,
  contactDeclinesChannel,
  pruneContactNotificationPrefs,
  upsertContactNotificationPrefs,
};
