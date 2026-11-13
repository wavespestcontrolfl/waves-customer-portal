'use strict';

/**
 * The read behind the Intelligence Bar's get_customer_text_status (gap #23, 2026-11-13).
 *
 * "Why is this customer not getting texts?" The bar could read the thread and
 * Twilio's failures, but not the settings that stop a text before it is ever
 * written to sms_log (a STOP, the do-not-text list, a text type switched off).
 * A text stopped there leaves no row anywhere the bar could see: the reminder
 * and en-route senders skip a switched-off type before the send wrapper, so
 * there is no audit row either.
 *
 * Read only. Nothing here sends, queues or changes a row. The per-type answer
 * comes from the validators the send wrapper itself runs (checkSuppression,
 * checkConsentForPurpose) on the state it loads (loadContactState,
 * loadSuppressionState): the same pattern as intelligence-bar/comms-tools smsConsentVerdict.
 * No rule is copied here. It answers consent and settings only: a sender can
 * still hold a text for its own reason (quiet hours, a visit hold), and those
 * show up in recent_blocked.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { excludeRecruitingSmsLog } = require('../utils/recruiting-thread-scope');
const { loadContactState, checkConsentForPurpose } = require('./messaging/validators/consent');
const { loadSuppressionState, checkSuppression } = require('./messaging/validators/suppression');
const { resolvePolicy } = require('./messaging/policy');
const { getAppointmentContacts, isSecondaryProfile } = require('./customer-contact');

const WINDOW_DAYS = 60;
const LIST_LIMIT = 10;

// The text types an operator asks about, by send purpose (messaging/policy.js).
// Marketing purposes are left out: they need a captured opt-in the caller
// supplies, so a dry check here would always read "blocked".
const TEXT_TYPES = [
  ['appointment_confirmation', 'Appointment confirmation'],
  ['appointment_reminder_72h', '3-day reminder'],
  ['appointment_reminder_24h', 'Day-before reminder'],
  ['tech_en_route', 'Technician on the way'],
  ['tech_arrived', 'Technician arrived'],
  ['service_completion', 'Service complete'],
  ['billing', 'Billing notice'],
  ['payment_receipt', 'Payment receipt'],
  ['review_request', 'Review request'],
  ['conversational', 'A text typed by the office'],
];

// A failed lookup is not an answer about the customer.
const TRANSIENT_CODES = new Set(['CONSENT_LOOKUP_FAILED', 'SUPPRESSION_LOOKUP_FAILED']);

// Plain words for the validator codes an operator meets. Any other code keeps
// the validator's own reason.
const PLAIN_REASON = {
  SMS_OPTED_OUT: 'The customer opted out of all texts (STOP).',
  PURPOSE_OPTED_OUT: 'This text type is switched off in the customer\'s notification settings.',
  SUPPRESSED_OPT_OUT: 'The number is on the do-not-text list: the customer texted STOP.',
  SUPPRESSED_WRONG_NUMBER: 'The number is flagged as a wrong number.',
  SUPPRESSED_MANUAL_DNC: 'Staff put the number on the do-not-contact list.',
  SUPPRESSED_NON_MOBILE: 'The number is a landline or cannot receive texts.',
  CHANNEL_EMAIL_ONLY: 'The customer chose email only for this type.',
  CHANNEL_NOT_SELECTED: 'The customer did not choose Text for billing notices.',
  NO_CONSENT_RECORD: 'This customer has no notification settings row.',
};

// A hold that sends later is not a text the customer missed.
const HELD_NOT_BLOCKED_CODES = ['QUIET_HOURS_HOLD'];
const NOT_DELIVERED_STATUSES = ['failed', 'undelivered', 'blocked'];
const SENT_STATUSES = ['sent', 'delivered'];
const OPEN_VISIT_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];

function last4(phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-4);
  return digits ? `…${digits}` : null;
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

// An optional read: one unreadable table must not lose the rest of the answer.
async function readOrNull(label, read) {
  try {
    return await read();
  } catch (err) {
    logger.warn(`[customer-text-status] ${label} unreadable (code=${err.code || 'unknown'})`);
    return null;
  }
}

function nextOpenVisit(customerId) {
  return db('scheduled_services')
    .where({ customer_id: customerId })
    .whereIn('status', OPEN_VISIT_STATUSES)
    .where('scheduled_date', '>=', etDateString())
    .orderBy('scheduled_date', 'asc')
    .first('id', 'scheduled_date');
}

async function typeVerdict(purpose, base, state) {
  const input = { ...base, purpose };
  const policy = resolvePolicy('customer', purpose);
  for (const check of [checkSuppression, checkConsentForPurpose]) {
    const verdict = await check(input, policy, state);
    if (verdict.ok) continue;
    if (TRANSIENT_CODES.has(verdict.code)) return { allowed: null, note: 'Could not check this right now.' };
    return { allowed: false, code: verdict.code, reason: PLAIN_REASON[verdict.code] || verdict.reason };
  }
  return { allowed: true };
}

function recentBlocked(customerId, since) {
  return db('messaging_audit_log')
    .where({ customer_id: customerId, channel: 'sms' })
    .whereNotNull('blocked_code')
    .whereNotIn('blocked_code', HELD_NOT_BLOCKED_CODES)
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .limit(LIST_LIMIT)
    .select('created_at', 'purpose', 'blocked_code', 'blocked_reason');
}

function outboundTexts(customerId, statuses) {
  return excludeRecruitingSmsLog(excludeUnresolvedSendReservations(db('sms_log')))
    .where({ 'sms_log.customer_id': customerId, 'sms_log.direction': 'outbound' })
    .whereIn('sms_log.status', statuses)
    .orderBy('sms_log.created_at', 'desc')
    .orderBy('sms_log.id', 'desc')
    .select('sms_log.created_at', 'sms_log.message_type', 'sms_log.status');
}

/**
 * @param {object} customer a full customers row (the tool's resolver supplies it)
 */
async function getCustomerTextStatus(customer) {
  const out = {
    customer_id: customer.id,
    customer_name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || null,
    phone_last4: last4(customer.phone),
    additional_property_profile: isSecondaryProfile(customer),
  };
  if (out.additional_property_profile) {
    out.additional_property_note = 'This profile is an additional property on an account. Those profiles start with the five appointment texts '
      + '(confirmation, 3-day and day-before reminders, on the way, arrived) switched off; they are switched on per profile in its notification settings.';
  }
  if (!customer.phone) {
    return { ...out, no_phone: true, note: 'No phone number is on file, so no text can go to this customer.' };
  }

  const visit = await readOrNull('next visit', () => nextOpenVisit(customer.id));
  // appointmentId: a visit at a saved property can own the appointment toggles
  // (loadContactState resolves them, as it does for a real appointment send).
  const base = { audience: 'customer', channel: 'sms', customerId: customer.id, to: customer.phone, appointmentId: visit?.id || undefined };
  // 'conversational' so the no-settings-row reply evidence is loaded too.
  let state = await loadContactState({ ...base, purpose: 'conversational' });
  state = await loadSuppressionState(base, state);
  const prefs = state.propertyToggles || state.prefs || {};

  out.opted_out_of_all_texts = state.prefs ? state.prefs.sms_enabled === false : null;
  out.do_not_text_list = state.suppression
    ? { reason: state.suppression.reason || null, since: iso(state.suppression.created_at), source: state.suppression.source || null }
    : null;
  out.checked_for_visit = visit ? { service_id: visit.id, date: dateOnlyString(visit.scheduled_date) } : null;

  out.text_types = [];
  for (const [purpose, label] of TEXT_TYPES) {
    out.text_types.push({ type: purpose, label, ...(await typeVerdict(purpose, base, state)) });
  }

  out.appointment_text_recipients = getAppointmentContacts(customer, prefs)
    .map((contact) => ({ role: contact.role || 'primary', phone_last4: last4(contact.phone) }));

  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  const blocked = await readOrNull('send audit log', () => recentBlocked(customer.id, since));
  const undelivered = await readOrNull('undelivered texts', () => outboundTexts(customer.id, NOT_DELIVERED_STATUSES).where('sms_log.created_at', '>=', since).limit(LIST_LIMIT));
  // .first() answers undefined for "no row"; readOrNull answers null for "could not read".
  const lastSent = await readOrNull('last sent text', () => outboundTexts(customer.id, SENT_STATUSES).first());
  out.window_days = WINDOW_DAYS;
  out.recent_blocked = blocked
    ? blocked.map((row) => ({ time: iso(row.created_at), type: row.purpose, code: row.blocked_code, reason: PLAIN_REASON[row.blocked_code] || row.blocked_reason || null }))
    : 'unavailable';
  out.recent_not_delivered = undelivered
    ? undelivered.map((row) => ({ time: iso(row.created_at), type: row.message_type, status: row.status }))
    : 'unavailable';
  out.last_text_sent = lastSent ? { time: iso(lastSent.created_at), type: lastSent.message_type, status: lastSent.status }
    : (lastSent === null ? 'unavailable' : null);
  out.note = 'allowed covers consent and settings only. A sender can still hold one text for its own reason (quiet hours, a visit hold); '
    + 'recent_blocked lists those. A text type that is switched off is skipped before any send, so it leaves no row in recent_blocked.';
  return out;
}

module.exports = { getCustomerTextStatus, TEXT_TYPES };
