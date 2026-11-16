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
 * No rule is copied here. One difference from a real send, on purpose: the
 * visit's saved-property toggles are read through property-notification-prefs'
 * read-only twin (loadVisitProperties), never through loadContactState's
 * appointmentId path, because that path also writes the senders' decision log. It answers consent and settings only: a sender can
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
const { isSecondaryProfile } = require('./customer-contact');
const propertyPrefs = require('./property-notification-prefs');

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
  ['payment_link', 'Invoice or payment link'],
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
  CHANNEL_EMAIL_ONLY: 'The customer chose email only for this type. A notice that has no email version still goes by text.',
  CHANNEL_NOT_SELECTED: 'The customer did not choose Text for this kind of billing notice.',
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
    .first('id', 'scheduled_date', 'property_id');
}

// The settings row with the visit's saved-property toggles laid over it, when a saved property decides them
// (the property rule enforced, a non-primary saved property of this customer). null = the customer row decides.
// Same reads and overlay as the senders' enforced answer, without its decision-log write. Throws on a failed read.
async function visitPropertyToggles(customerId, visit, prefs) {
  if (!visit?.property_id || !propertyPrefs.propertyTextsEnforced()) return null;
  const found = (await propertyPrefs.loadVisitProperties(db, [{ id: visit.id, customer_id: customerId, property_id: visit.property_id }])).get(visit.id);
  return found ? propertyPrefs.overlayPropertyPrefs(found.property, found.row, prefs) : null;
}

const COULD_NOT_CHECK = Object.freeze({ allowed: null, note: 'Could not check this right now.' });
const blockedVerdict = (verdict) => ({ allowed: false, code: verdict.code, reason: PLAIN_REASON[verdict.code] || verdict.reason });

async function typeVerdict(purpose, base, state) {
  const input = { ...base, purpose };
  const policy = resolvePolicy('customer', purpose);
  const suppressed = await checkSuppression(input, policy, state);
  if (!suppressed.ok) return TRANSIENT_CODES.has(suppressed.code) ? COULD_NOT_CHECK : blockedVerdict(suppressed);
  // checkSuppression fails OPEN for a text when the do-not-text list could not be read (the send path has the STOP
  // switch behind it). "Not blocked" is then not an answer about this customer: say it could not be checked.
  if (state.suppressionLoaded !== true) return COULD_NOT_CHECK;
  const consent = await checkConsentForPurpose(input, policy, state);
  if (consent.ok) return { allowed: true };
  return TRANSIENT_CODES.has(consent.code) ? COULD_NOT_CHECK : blockedVerdict(consent);
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

// What the consent rows say today: the STOP switch, the do-not-text list and each text type's verdict.
// One load of the send path's contact state answers all three.
async function consentAnswer(customer) {
  // No appointmentId: with one, loadContactState would write the senders' decision log (see the header).
  // hasEmailLeg: an email-only choice for billing or receipts stops the text only for a notice that also has an email
  // version (the consent validator's rule). Most do, so that is the case answered; PLAIN_REASON says so.
  const base = { audience: 'customer', channel: 'sms', customerId: customer.id, to: customer.phone, hasEmailLeg: true };
  // 'conversational' so the no-settings-row reply evidence is loaded too.
  let state = await loadContactState({ ...base, purpose: 'conversational' });
  state = await loadSuppressionState(base, state);
  // The next visit can carry a saved property whose toggles decide. A visit or property that cannot be READ is not
  // "no visit": the senders hold a text whose property toggles are unreadable, and the same state answers
  // "could not check" here instead of the customer row's answer.
  let visit = null;
  try {
    visit = await nextOpenVisit(customer.id);
    state.propertyToggles = await visitPropertyToggles(customer.id, visit, state.prefs);
  } catch (err) {
    logger.warn(`[customer-text-status] next visit or its property toggles unreadable (code=${err.code || 'unknown'})`);
    state.lookupFailed = true;
  }
  let checkedForVisit = state.lookupFailed ? 'unavailable' : null;
  if (visit) checkedForVisit = { service_id: visit.id, date: dateOnlyString(visit.scheduled_date) };

  let doNotText = state.suppressionLoaded === true ? null : 'unavailable';
  if (state.suppression) doNotText = { reason: state.suppression.reason, since: iso(state.suppression.created_at), source: state.suppression.source };
  const textTypes = [];
  for (const [purpose, label] of TEXT_TYPES) {
    textTypes.push({ type: purpose, label, ...(await typeVerdict(purpose, base, state)) });
  }
  return {
    checked_for_visit: checkedForVisit,
    // No settings row is "never opted out" (a STOP always writes one); a row that could not be read is unknown.
    opted_out_of_all_texts: state.prefs || !state.lookupFailed ? state.prefs?.sms_enabled === false : null,
    do_not_text_list: doNotText,
    text_types: textTypes,
  };
}

const sentRow = (row) => ({ time: iso(row.created_at), type: row.message_type, status: row.status });
// readOrNull answers null for a table that could not be read.
const listOrUnavailable = (rows, shape) => (rows ? rows.map(shape) : 'unavailable');

// What the logs say for the last 60 days. Each read stands alone: one unreadable table does not lose the others.
async function historyAnswer(customerId) {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  const blocked = await readOrNull('send audit log', () => recentBlocked(customerId, since));
  const undelivered = await readOrNull('undelivered texts', () => outboundTexts(customerId, NOT_DELIVERED_STATUSES).where('sms_log.created_at', '>=', since).limit(LIST_LIMIT));
  // .first() answers undefined for "no row"; readOrNull answers null for "could not read".
  const lastSent = await readOrNull('last sent text', () => outboundTexts(customerId, SENT_STATUSES).first());
  let lastTextSent = lastSent === null ? 'unavailable' : null;
  if (lastSent) lastTextSent = sentRow(lastSent);
  return {
    window_days: WINDOW_DAYS,
    recent_blocked: listOrUnavailable(blocked, (row) => ({ time: iso(row.created_at), type: row.purpose, code: row.blocked_code, reason: PLAIN_REASON[row.blocked_code] || row.blocked_reason })),
    recent_not_delivered: listOrUnavailable(undelivered, sentRow),
    last_text_sent: lastTextSent,
  };
}

const ADDITIONAL_PROPERTY_NOTE = 'This profile is an additional property on an account. Those profiles start with the five appointment texts '
  + '(confirmation, 3-day and day-before reminders, on the way, arrived) switched off; they are switched on per profile in its notification settings.';
const ANSWER_NOTE = 'allowed covers consent and settings only. A sender can still hold one text for its own reason (quiet hours, a visit hold); '
  + 'recent_blocked lists those. A text type that is switched off is skipped before any send, so it leaves no row in recent_blocked.';

/**
 * @param {object} customer a customers row: id, first_name, last_name, phone, account_id, is_primary_profile
 */
async function getCustomerTextStatus(customer) {
  const additionalProperty = isSecondaryProfile(customer);
  const out = {
    customer_id: customer.id,
    customer_name: [customer.first_name, customer.last_name].filter(Boolean).join(' '),
    phone_last4: last4(customer.phone),
    additional_property_profile: additionalProperty,
    ...(additionalProperty ? { additional_property_note: ADDITIONAL_PROPERTY_NOTE } : {}),
  };
  if (!customer.phone) {
    return { ...out, no_phone: true, note: 'No phone number is on file, so no text can go to this customer.' };
  }
  return {
    ...out,
    ...(await consentAnswer(customer)),
    ...(await historyAnswer(customer.id)),
    note: ANSWER_NOTE,
  };
}

module.exports = { getCustomerTextStatus, TEXT_TYPES };
