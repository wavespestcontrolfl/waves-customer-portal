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

// The API spelling of a contact's choices (portal /contact-preferences and
// the Customer 360 admin read-out share it): purpose columns ↔ camelCase
// keys, channel columns ↔ camelCase keys.
const CONTACT_PREF_KEY_BY_COLUMN = {
  appointment_confirmation: 'appointmentConfirmation',
  service_reminder_72h: 'serviceReminder72h',
  service_reminder_24h: 'serviceReminder24h',
  tech_en_route: 'techEnRoute',
  tech_arrived: 'techArrived',
  service_completed: 'serviceCompleted',
};
const CONTACT_CHANNEL_KEY_BY_COLUMN = {
  appointment_confirmation_channel: 'appointmentConfirmationChannel',
  service_reminder_72h_channel: 'serviceReminder72hChannel',
  service_reminder_24h_channel: 'serviceReminder24hChannel',
  en_route_channel: 'enRouteChannel',
  tech_arrived_channel: 'techArrivedChannel',
  service_complete_channel: 'serviceCompleteChannel',
};
const CONTACT_CHANNEL_VALUES = ['sms', 'email', 'both'];

// Effective choices: the contact's row overlaid on the account's
// notification_prefs row. A purpose the holder turned off account-wide reads
// off AND is flagged in accountOff (locked — choices only narrow). NULL
// channel = 'both' (whatever the account sends).
function effectiveContactPreferences(accountRow, ownRow, { emailAvailable = true } = {}) {
  const account = accountRow || {};
  const own = ownRow || {};
  const preferences = {};
  const accountOff = {};
  for (const [col, key] of Object.entries(CONTACT_PREF_KEY_BY_COLUMN)) {
    const holderOff = account[col] === false;
    accountOff[key] = holderOff;
    preferences[key] = !holderOff && own[col] !== false;
  }
  for (const [col, key] of Object.entries(CONTACT_CHANNEL_KEY_BY_COLUMN)) {
    const chosen = CONTACT_CHANNEL_VALUES.includes(own[col]) ? own[col] : 'both';
    // An email-only choice with no address on file (the holder removed it)
    // is nothing — the save clears it; a row from before that reads as the
    // default rather than as an option the card no longer offers (codex r6).
    // So does a text-only report choice from before the contact report text
    // was switched off — the senders read it the same way (codex r10,
    // effectiveChannelChoice).
    const unavailable = (chosen === 'email' && !emailAvailable)
      || (col === 'service_complete_channel' && chosen === 'sms' && !reportTextLive());
    preferences[key] = unavailable ? 'both' : chosen;
  }
  preferences.smsEnabled = own.sms_enabled !== false;
  preferences.emailEnabled = own.email_enabled !== false;
  return { preferences, accountOff };
}

// API body (camelCase) → row patch (columns). Unknown keys are ignored here;
// the routes validate the body first.
function contactPrefPatchFromBody(updates = {}) {
  const patch = {};
  for (const [col, key] of Object.entries(CONTACT_PREF_KEY_BY_COLUMN)) if (updates[key] !== undefined) patch[col] = updates[key];
  for (const [col, key] of Object.entries(CONTACT_CHANNEL_KEY_BY_COLUMN)) if (updates[key] !== undefined) patch[col] = updates[key];
  if (updates.smsEnabled !== undefined) patch.sms_enabled = updates.smsEnabled;
  if (updates.emailEnabled !== undefined) patch.email_enabled = updates.emailEnabled;
  return patch;
}

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

function reportTextLive() {
  try {
    return require('../config/feature-gates').contactReportTextLive();
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

// The delivery choice a stored row means TODAY. A text-only service-report
// choice exists only while the contact report text (GATE_CONTACT_REPORT_TEXT)
// does: the route refuses a new one with the gate off, and one stored before
// a rollback reads as the default — otherwise the gate flip would end both of
// that contact's report legs at once (codex #6363 r10 P2).
function effectiveChannelChoice(row, column) {
  const chosen = CHANNEL_COLUMN_FOR[column] ? row[CHANNEL_COLUMN_FOR[column]] : null;
  if (column === 'service_completed' && chosen === 'sms' && !reportTextLive()) return 'both';
  return chosen;
}

// Pure: does this contact's row allow `column` (a purpose; null = a purpose
// with no opt-out) on `channel` ('sms' | 'email')? No row = allowed.
function contactAllows(row, column, channel = 'sms') {
  if (!row) return true;
  if (channel === 'sms' && row.sms_enabled === false) return false;
  if (channel === 'email' && row.email_enabled === false) return false;
  if (!column) return true;
  if (row[column] === false) return false;
  const chosen = effectiveChannelChoice(row, column);
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

// Deny wins across duplicate addresses (codex #6363 r16 security P2): the
// contact editor allows the same email on two slots, and the senders dedupe
// recipients by address before these filters run, so a declining slot's
// address is declined wherever it appears — a holder cannot route around a
// contact's email switch through a second slot carrying the same mailbox.
// The addresses whose slot (by its phone's row) declines `column` by email.
const emailKey = (value) => String(value || '').trim().toLowerCase();
function declinedEmailsOf(slots, rows, column) {
  const declined = new Set();
  for (const slot of slots) {
    if (!slot.email || !slot.phone) continue;
    const row = rows.get(phoneKey(slot.phone));
    if (row && !contactAllows(row, column, 'email')) declined.add(emailKey(slot.email));
  }
  return declined;
}

// The addresses (lower-cased) a contact declined for an appointment EMAIL
// event, read now — the recipient resolution reads them through
// declinedEmailSlotRoles below; the dispatch boundary re-reads per address
// through contactAddressStillAllowed (codex #6363 r21 / r27 P2). Empty with
// the gate off; throws on an unreadable table (the caller holds).
async function declinedEmailAddresses(customer, eventType, { dbh = db } = {}) {
  if (!contactPrefsLive() || !customer) return new Set();
  const { getServiceContactSlots } = require('./customer-contact');
  const rows = await loadContactPrefRows(customer.id, { dbh });
  return declinedEmailsOf(getServiceContactSlots(customer), rows, columnForEmailEvent(eventType));
}

// The slot roles (service_contact, service_contact_2, …) whose phone declined
// an appointment EMAIL event (appointment-email.js resolveRecipients), plus
// every slot sharing a declining slot's address. Empty with the gate off;
// throws on an unreadable table (the caller holds).
async function declinedEmailSlotRoles(customer, eventType, { dbh = db } = {}) {
  const declined = new Set();
  if (!contactPrefsLive() || !customer) return declined;
  const slots = require('./customer-contact').getServiceContactSlots(customer);
  const declinedEmails = await declinedEmailAddresses(customer, eventType, { dbh });
  for (const slot of slots) {
    // A slot with no email of its own is emailed at the HOLDER's address
    // (appointment-email.js resolveRecipients): the contact's email switch
    // governs the contact's own inbox, never the holder's fallback
    // (codex #6363 r8 P2).
    if (!slot.email) continue;
    if (declinedEmails.has(emailKey(slot.email))) declined.add(slot.role);
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
  const slots = getServiceContactSlots(customer);
  const phoneByRole = new Map(slots.map((s) => [s.role, s.phone]));
  // The resolver deduped the slots by address before this filter: an address
  // a declining slot carries is declined whichever slot survived (deny wins).
  const declinedEmails = declinedEmailsOf(slots, rows, 'service_completed');
  return recipients.filter((r) => {
    if (!isServiceContactRole(r.role)) return true;
    if (r.email && declinedEmails.has(emailKey(r.email))) return false;
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
// `requireSlot` (the dispatch-boundary re-checks, codex #6363 r27 P2): the
// contact was resolved when the send was prepared — the customer row is
// re-read NOW and a number the holder has since removed from every slot (or a
// customer row that is gone) is a former contact and declines; for email, a
// slot that now carries a DIFFERENT address of its own declines too (the
// resolved address is no longer that contact's). The holder's own number
// (the slot-1 fallback identity) is never slot-bound.
// Is the resolved `contact` still one of `customer`'s people for `channel`
// (pure; `customer` is the row as of now)? The holder's own number is; a slot
// phone is while a slot carries it and, for email, while the address that
// slot resolves to NOW — its own address, else the holder's current address
// (the slot-1 fallback mailbox, customer-contact.js getServiceContact) — is
// still the resolved address (codex #6363 r28 security P2: an address the
// holder cleared from the slot is no longer that contact's). EVERY slot
// carrying the phone is asked (codex r30 P2): the holder may store one
// number twice with the address on only one slot, and that phone + address
// identity is live while any of its slots resolves to the address.
function contactStillListed(customer, contact, channel) {
  const key = phoneKey(contact.phone);
  if (phoneKey(customer.phone) === key) return true;
  const slots = require('./customer-contact').getServiceContactSlots(customer).filter((s) => phoneKey(s.phone) === key);
  if (!slots.length) return false;
  if (channel !== 'email' || !contact.email) return true;
  const address = emailKey(contact.email);
  return slots.some((s) => emailKey(s.email || customer.email) === address);
}

async function contactDeclinesChannel(customerId, contact, channel = 'sms', { dbh = db, requireSlot = false } = {}) {
  if (!contactPrefsLive() || !contact || !contact.phone) return false;
  if (!require('./customer-contact').isServiceContactRole(contact.role)) return false;
  if (requireSlot) {
    let customer;
    try {
      customer = await dbh('customers').where({ id: customerId }).first();
    } catch (err) {
      if (dbh && dbh.isTransaction) throw err;
      logger.warn(`[contact-prefs] customer read failed (${err.message}) — holding the service contact's ${channel}`);
      return true;
    }
    if (!customer || !contactStillListed(customer, contact, channel)) return true;
  }
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

// An appointment EMAIL recipient's address as of the provider handoff (codex
// #6363 r27 P2): the customer's slots are re-read NOW — an address the holder
// has since removed from every slot (or a customer row that is gone) is a
// former contact's and is held, and a kept address is re-judged by the choices
// row of every slot that carries it today (deny wins). Gate off = allowed.
// Throws on an unreadable row or table (the caller holds).
async function contactAddressStillAllowed(customer, email, eventType, { dbh = db } = {}) {
  const address = emailKey(email);
  if (!contactPrefsLive() || !customer || !address) return true;
  const { getServiceContactSlots } = require('./customer-contact');
  const live = await dbh('customers').where({ id: customer.id }).first();
  if (!live) return false;
  const carrying = getServiceContactSlots(live).filter((s) => emailKey(s.email) === address);
  if (!carrying.length) return false;
  const rows = await loadContactPrefRows(customer.id, { dbh });
  return !declinedEmailsOf(carrying, rows, columnForEmailEvent(eventType)).has(address);
}

// Does the number a single-recipient TEXT is addressed to belong to one of
// this customer's on-location contacts who declines `column` (null = the
// master switch alone) by text? The estimate accept flow (estimate-public.js)
// texts the ESTIMATE's own phone, which may be a contact's — the tenant who
// requested it under the landlord's row — and dispatches outside the
// recipient fan-out the other seams filter (codex #6363 r10 P2). The holder's
// own number, a number in no slot, and the gate off never decline. Fail
// CLOSED on an unreadable row or table, as every other seam here.
// `requireSlot` (the provider-boundary re-check in send-customer-message.js,
// codex #6363 r25 P2): the leg was classified a service-contact text when the
// fan-out ran — a number the holder has since removed from every slot (or a
// customer row that is gone) is a FORMER contact and declines too.
async function contactPhoneDeclinesText(customerId, phone, column = null, { dbh = db, requireSlot = false } = {}) {
  const key = phoneKey(phone);
  if (!contactPrefsLive() || !customerId || !key) return false;
  let customer;
  try {
    customer = await dbh('customers').where({ id: customerId }).first();
  } catch (err) {
    if (dbh && dbh.isTransaction) throw err;
    logger.warn(`[contact-prefs] customer read failed (${err.message}) — holding the text to ${key.slice(-4)}`);
    return true;
  }
  if (!customer) return requireSlot;
  if (phoneKey(customer.phone) === key) return false;
  const slot = require('./customer-contact').getServiceContactSlots(customer).find((s) => phoneKey(s.phone) === key);
  if (!slot) return requireSlot;
  return (await filterContactsByOwnPrefs([{ phone: slot.phone, role: slot.role }], customerId, column, { channel: 'sms', dbh })).length === 0;
}

// Service-report EMAIL recipient as of the provider handoff (codex #6363 r24 +
// r25 P2): the recipient list was resolved before the report data, credit read
// and PDF render, so the slots are re-read NOW — a service-contact recipient
// whose address the holder has since removed from every slot (or a customer
// row that is gone) is a former contact and is held, and a kept address is
// re-judged by the choices row of the slot that carries it today. Holder and
// billing recipients always pass; gate off = pass-through. Throws on an
// unreadable customer row (the caller holds).
async function reportEmailRecipientStillAllowed(customer, recipient, { dbh = db } = {}) {
  if (!contactPrefsLive() || !customer || !recipient) return true;
  const { isServiceContactRole, getServiceContactSlots, SERVICE_CONTACT_COLUMNS } = require('./customer-contact');
  if (!isServiceContactRole(recipient.role)) return true;
  const live = await dbh('customers').where({ id: customer.id }).first();
  if (!live) return false;
  const current = { ...customer, ...Object.fromEntries(SERVICE_CONTACT_COLUMNS.map((column) => [column, live[column]])) };
  const address = emailKey(recipient.email);
  const slot = getServiceContactSlots(current).find((s) => s.email && emailKey(s.email) === address);
  if (!slot) return false;
  return (await filterReportEmailRecipientsByContactPrefs([{ ...recipient, role: slot.role }], current, { dbh })).length > 0;
}

// Does the address a single-recipient EMAIL is going to belong to one of
// this customer's on-location contacts who turned their email off? The
// estimate accept flow's onboarding email (estimate-accepted-email.js) falls
// back to the ESTIMATE's own address, which may be ANY slot's — the tenant
// in slot 2 who requested it (codex #6363 r16 security P2) — so every slot
// carrying the address is checked and deny wins; the matched slot's phone
// keys the contact's row. The holder's own address, an address in no slot,
// and the gate off never decline. Fail CLOSED on an unreadable row or table.
// `requireSlot` (the project-email handoff for a recipient RESOLVED as a
// service contact, codex #6363 r26 security P2): an address the holder has
// since removed from every slot (or a customer row that is gone) is a former
// contact's and declines too.
async function contactEmailDeclines(customerId, email, { dbh = db, requireSlot = false } = {}) {
  const addr = (v) => String(v || '').trim().toLowerCase();
  const current = addr(email);
  if (!contactPrefsLive() || !customerId || !current) return false;
  let customer;
  try {
    customer = await dbh('customers').where({ id: customerId }).first();
  } catch (err) {
    if (dbh && dbh.isTransaction) throw err;
    logger.warn(`[contact-prefs] customer read failed (${err.message}) — holding the email`);
    return true;
  }
  if (!customer) return requireSlot;
  if (addr(customer.email) === current) return false;
  const carrying = require('./customer-contact').getServiceContactSlots(customer).filter((s) => addr(s.email) === current);
  if (!carrying.length) return requireSlot;
  for (const slot of carrying.filter((s) => s.phone)) {
    if (await contactDeclinesChannel(customerId, { phone: slot.phone, role: slot.role }, 'email', { dbh })) return true;
  }
  return false;
}

// The review candidates page (admin-reviews.js) mirrors the sender's email
// verdict (review-request.js sendOutreachTouch: contactDeclinesChannel on the
// email identity) across its 200 rows at once (codex #6363 r20 P2): per
// customer, the phone keys whose contact turned their email off. Gate off or
// a missing table → empty; any other read error throws — the page fails
// rather than offering a cadence the sender refuses.
async function contactEmailOffPhoneKeys(customerIds = [], { dbh = db } = {}) {
  const byCustomer = new Map();
  if (!contactPrefsLive() || !customerIds.length) return byCustomer;
  let found;
  try {
    found = await dbh(TABLE).whereIn('customer_id', customerIds).where({ email_enabled: false }).select('customer_id', 'phone_key');
  } catch (err) {
    if (err && err.code === '42P01') {
      logger.warn('[contact-prefs] table missing — no per-contact choices');
      return byCustomer;
    }
    throw err;
  }
  for (const row of found || []) {
    const key = String(row.customer_id);
    if (!byCustomer.has(key)) byCustomer.set(key, new Set());
    byCustomer.get(key).add(String(row.phone_key));
  }
  return byCustomer;
}

// The contact's email master switch as a query predicate (codex #6363 r20
// P2): the inline review email's dispatch claim (review-request.js
// _claimInlineEmailDispatch) is the last fence before the provider and
// re-applies every consent it read earlier as of that write — a contact who
// turns their email off while the template resolves is not emailed. Adds
// nothing with the gate off or for a recipient with no phone (the holder's
// own address never carries a contact row).
// `requireSlot` (codex #6363 r27 P2): the claim also requires, as of the
// same write, that the contact's number still occupies a slot of the customer
// row (or is the holder's own number — the slot-1 fallback identity) and that
// the address the slot resolves to now — its own, else the holder's current
// address (the fallback mailbox) — is still the resolved address (r28
// security P2: a cleared slot address never keeps the stale one authorized).
const SLOT_PHONE_SQL = (column) => `RIGHT(REGEXP_REPLACE(COALESCE(customers.${column}, ''), '[^0-9]', '', 'g'), 10) = ?`;
function whereContactEmailAllowed(query, customerIdColumn, contact, { requireSlot = false } = {}) {
  const key = phoneKey(contact && contact.phone);
  if (!contactPrefsLive() || !key) return query;
  query.whereNotExists(function contactEmailConsent() {
    this.select(db.raw('1')).from(TABLE)
      .whereRaw(`${TABLE}.customer_id = ${customerIdColumn}`)
      .where({ [`${TABLE}.phone_key`]: key, [`${TABLE}.email_enabled`]: false });
  });
  if (!requireSlot) return query;
  const address = emailKey(contact.email);
  const { SERVICE_CONTACT_SLOTS } = require('./customer-contact');
  return query.whereExists(function contactSlotLive() {
    this.select(db.raw('1')).from('customers')
      .whereRaw(`customers.id = ${customerIdColumn}`)
      .where(function contactStillListed() {
        this.whereRaw(SLOT_PHONE_SQL('phone'), [key]);
        for (const slot of SERVICE_CONTACT_SLOTS) {
          this.orWhere(function slotMatches() {
            this.whereRaw(SLOT_PHONE_SQL(slot.phone), [key]);
            if (address) this.whereRaw(`LOWER(TRIM(COALESCE(NULLIF(TRIM(customers.${slot.email}), ''), customers.email, ''))) = ?`, [address]);
          });
        }
      });
  });
}

// Dispatch-time recheck for a DEFERRED email (an automation step, a queued
// template run) whose address was resolved when it was enqueued: when that
// address is the slot-1 contact's and the contact has since turned their
// email off, the mail goes to the account holder instead — or nowhere when
// the holder has no address (codex #6363 r7 P1). Returns the address to use
// (null = hold) and whether it moved. Holder / unmatched addresses pass
// through; gate off = pass-through.
//
// WHOSE address it is comes from the enqueue, not from matching: a send the
// enqueue stamped as the slot-1 contact's (`recipientRole`, kept on the
// enrollment's metadata / the run's context by appointment-tagger.js) is the
// contact's whatever address it carries — the holder may have replaced it
// since — and is re-resolved from the current row with the contact's switch
// applied (codex #6363 r9 P1): the contact's current address, the holder
// when the switch is off, nothing when the holder has none. A send with no
// stamp (queued before the stamp existed) is the contact's only when its
// address IS slot 1's current one. Every other address — the holder's, a
// tenant's estimate under a landlord's record, an operator-entered inbox —
// is somebody else's mail and passes through untouched (codex r10 P1).
async function rerouteForContactEmailOptOut(customerId, email, { dbh = db, recipientRole = null } = {}) {
  const current = String(email || '').trim().toLowerCase();
  if (!contactPrefsLive() || !customerId || !current) return { email: email || null, rerouted: false };
  // The lookup's failure propagates (codex #6363 r8 P1): the callers' own
  // error handling retries or holds the send; a swallowed error here would
  // mail a contact whose switch may be off.
  const customer = await dbh('customers').where({ id: customerId }).first();
  if (!customer) return { email, rerouted: false };
  const addr = (v) => String(v || '').trim().toLowerCase();
  const slotOnes = require('./customer-contact').isServiceContactRole(recipientRole)
    || current === addr(customer.service_contact_email);
  if (!slotOnes) return { email, rerouted: false };
  const target = await require('./project-email').resolveProjectEmailRecipientForSend(customer);
  const targetEmail = addr(target.email) || null;
  if (targetEmail === current) return { email, rerouted: false };
  logger.info(`[contact-prefs] queued contact email on ${customer.id} re-resolved — ${targetEmail ? `now ${target.role}` : 'holding (no address)'}`);
  return { email: targetEmail, rerouted: true };
}

// The holder's contact save rewrote the slots: drop the rows of phones that
// no longer occupy one, and clear the email-only delivery choices of a kept
// phone whose slot no longer carries an email (an "email only" choice with
// no address would deliver nothing — codex #6363 r6 P2). `contacts` are the
// saved slots ({ phone, email }; a bare phone string = no email). Inside the
// save's transaction; a missing table is the absent state.
async function pruneContactNotificationPrefs(trx, customerId, contacts = []) {
  const slots = contacts.map((c) => (typeof c === 'string' ? { phone: c } : c || {}));
  // Email availability is per NUMBER, across every slot that carries it
  // (codex #6363 r16 P2): the same phone stored twice, once with an address,
  // still has one — its email-only choices and "email off" stay.
  const emailByKey = new Map();
  for (const slot of slots) {
    const key = phoneKey(slot.phone);
    if (key) emailByKey.set(key, emailByKey.get(key) === true || !!String(slot.email || '').trim());
  }
  const keep = [...emailByKey.keys()];
  const emailLess = keep.filter((key) => !emailByKey.get(key));
  try {
    const q = trx(TABLE).where({ customer_id: customerId });
    if (keep.length) q.whereNotIn('phone_key', keep);
    await q.delete();
    for (const col of Object.values(CHANNEL_COLUMN_FOR)) {
      if (!emailLess.length) break;
      await trx(TABLE).where({ customer_id: customerId, [col]: 'email' }).whereIn('phone_key', emailLess).update({ [col]: null, updated_at: new Date() });
    }
    // The email master switch too: with no address of their own, "email off"
    // would only ever suppress the holder's fallback address (codex r8 P2).
    if (emailLess.length) {
      await trx(TABLE).where({ customer_id: customerId, email_enabled: false }).whereIn('phone_key', emailLess).update({ email_enabled: null, updated_at: new Date() });
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
  CONTACT_PREF_KEY_BY_COLUMN,
  CONTACT_CHANNEL_KEY_BY_COLUMN,
  CONTACT_CHANNEL_VALUES,
  effectiveContactPreferences,
  contactPrefPatchFromBody,
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
  contactAddressStillAllowed,
  contactPhoneDeclinesText,
  reportEmailRecipientStillAllowed,
  contactEmailDeclines,
  contactEmailOffPhoneKeys,
  whereContactEmailAllowed,
  rerouteForContactEmailOptOut,
  pruneContactNotificationPrefs,
  upsertContactNotificationPrefs,
};
