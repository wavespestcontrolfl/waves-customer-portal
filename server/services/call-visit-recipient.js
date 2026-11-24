/**
 * Visit-only text recipients (GATE_CALL_GIVEN_VISIT_TEXTS; owner 2026-11-24, "yes, visit only").
 *
 * A caller who books a visit and gives another person's number to be texted ("my husband Bob will
 * be home, text him too, here is his number") gives that person the texts for THAT ONE VISIT: its
 * booking confirmation, its reminders and its en-route text. Nothing else. Anything beyond those
 * three still goes through the Reply-YES flow, unchanged.
 *
 * The permission lives on a visit_text_recipients row tied to the visit. This module never reads or
 * writes customers.service_contacts_consent_at, the service-contact slots, recipient_optin or contact
 * login: an earlier build that made the number an account-wide consented contact leaked into login,
 * review asks, email and the YES flow.
 *
 * This is the ONE place that decides who is eligible and who is owed a text for a visit. Every sender
 * asks it:
 *   - the call pipeline records the number when it books the visit (recordForVisit) and texts the
 *     same-call confirmation (contactsForVisit + sendOnce);
 *   - appointment-reminders.js safeSendAppointment, for the confirmation and the 72 h / 24 h reminders;
 *   - twilio.js sendTechEnRoute.
 * The send layer (sendCustomerMessage) still enforces STOP, suppression, a disclaimed number, the send
 * window and the line type on every text.
 */
const db = require('../models/db');
const logger = require('./logger');
const { toE164, isValidNanpNumber } = require('../utils/phone');
const { mapSecondaryContactToLegacy } = require('../utils/extraction-compat');
const { dateOnlyString } = require('../utils/date-only');

const SOURCE = 'call_caller_provided';
const CONSENT_VERSION = 'owner-ruling-2026-11-24-visit-only';
const ROLE = 'visit_text_recipient';
const TABLE = 'visit_text_recipients';

// The only texts a visit-only recipient gets, keyed by the sender's messageType and its policy purpose.
// A reschedule, cancellation, no-show, arrival, completion, review or any other text is not on this
// list, so it never reaches the recipient. A reschedule keeps the same visit row, so the recipient
// stays; the reminders the new slot arms reach the recipient again.
const KIND_BY_SEND = {
  confirmation: { purpose: 'appointment_confirmation', kind: 'confirmation' },
  reminder_72h: { purpose: 'appointment_reminder_72h', kind: 'reminder_72h' },
  appointment_reminder: { purpose: 'appointment_reminder_24h', kind: 'reminder_24h' },
};

// A recipient gets no text about a visit that is over or cancelled.
const LIVE_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route'];

// On-site roles whose appointment-text flag counts as a request to text that person
// (same set as the call pipeline's on-site opt-in ask).
const ON_SITE_ROLES = new Set(['spouse_partner', 'home_buyer', 'home_seller', 'tenant', 'family_member']);

const lastTen = (value) => String(value || '').replace(/\D/g, '').slice(-10);

/** GATE_CALL_GIVEN_VISIT_TEXTS, read at call time. Every sender asks here, so one test double of feature-gates covers them all. */
function gateLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.callGivenVisitTextsLive === 'function' && gates.callGivenVisitTextsLive() === true;
}

/** The kind of text a sender is about to send, or null when a visit-only recipient is owed none. */
function kindForSend(messageType, purpose) {
  const entry = KIND_BY_SEND[String(messageType || '')];
  return entry && entry.purpose === purpose ? entry.kind : null;
}

/** The caller asked to text this person: the notify request, or an on-site role with the appointment-text or on-site flag. */
function askedToText(entry) {
  if (entry.wants_notifications === true) return true;
  const role = String(entry.role || '').trim().toLowerCase();
  return (entry.wants_appointment_texts === true || entry.on_site === true) && ON_SITE_ROLES.has(role);
}

/**
 * The V2 extraction's own entries, each judged ALONE: the phone and the ask must sit on the same
 * entry. The merged V1/V2 contact is never used, so one person's flag cannot move onto another
 * person's number. Pure.
 */
function eligibleEntries(v2Extraction, { excludePhones = [] } = {}) {
  const taken = new Set(excludePhones.map(lastTen).filter(Boolean));
  const raw = [v2Extraction?.secondary_contact, ...(Array.isArray(v2Extraction?.secondary_contacts) ? v2Extraction.secondary_contacts : [])];
  const out = [];
  for (const rawEntry of raw) {
    const entry = mapSecondaryContactToLegacy(rawEntry);
    if (!entry || !isValidNanpNumber(entry.phone) || !askedToText(entry)) continue;
    const key = lastTen(entry.phone);
    if (taken.has(key)) continue;
    taken.add(key);
    const role = String(entry.role || '').trim().toLowerCase();
    out.push({
      phoneKey: key,
      phoneE164: toE164(entry.phone),
      firstName: entry.first_name || null,
      lastName: entry.last_name || null,
      role: role && role !== 'unknown' ? role.slice(0, 30) : null,
    });
  }
  return out;
}

/** Every number that belongs to the call itself or to the caller: never a visit-only recipient. */
function callerNumbers({ call = {}, contactPhone = null, extractedPhone = null, v2Extraction = null } = {}) {
  return [
    call.from_phone, call.to_phone, contactPhone, extractedPhone,
    v2Extraction?.caller?.phone_e164, v2Extraction?.caller?.text_phone_e164,
  ].filter(Boolean);
}

async function suppressedNumber(phoneKey, conn) {
  const row = await conn('messaging_suppression')
    .whereRaw("right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ?", [phoneKey])
    .where('active', true)
    .first('phone');
  return !!row;
}

/**
 * Record the people the caller asked to text for the visit the call booked. Idempotent: a retry of
 * the call processing finds the row and changes nothing. Never throws on a refused number; a database
 * error propagates so the caller can retry the pass.
 *
 * `blocked`: the call-level SMS verdict (do-not-contact, the TCPA gate, a disclaimed caller number).
 * `excludePhones`: the call legs and the caller's own numbers (callerNumbers) plus the account holder's.
 */
async function recordForVisit({ scheduledServiceId, callLogId = null, v2Extraction, excludePhones = [], blocked = false, conn = db }) {
  const result = { recorded: [], skipped: [] };
  if (!scheduledServiceId || blocked) return { ...result, skipped: [{ reason: blocked ? 'call_sms_blocked' : 'no_visit' }] };
  const { disclaimedNumberHeld } = require('./disclaimed-number-holds');
  // The account holder already gets this visit's texts as themselves: no second row for their own number.
  const holder = await conn('scheduled_services as s').join('customers as c', 'c.id', 's.customer_id')
    .where('s.id', scheduledServiceId).first('c.phone');
  for (const entry of eligibleEntries(v2Extraction, { excludePhones: [...excludePhones, holder?.phone] })) {
    if (await disclaimedNumberHeld(entry.phoneE164, conn)) { result.skipped.push({ reason: 'disclaimed_number' }); continue; }
    if (await suppressedNumber(entry.phoneKey, conn)) { result.skipped.push({ reason: 'suppressed' }); continue; }
    const rows = await conn(TABLE).insert({
      scheduled_service_id: scheduledServiceId,
      phone_key: entry.phoneKey,
      phone_e164: entry.phoneE164,
      first_name: entry.firstName ? String(entry.firstName).slice(0, 100) : null,
      last_name: entry.lastName ? String(entry.lastName).slice(0, 100) : null,
      role: entry.role,
      source: SOURCE,
      consent_version: CONSENT_VERSION,
      call_log_id: callLogId,
    }).onConflict(['scheduled_service_id', 'phone_key']).ignore().returning('id');
    result.recorded.push({ phoneKey: entry.phoneKey, created: rows.length > 0 });
  }
  return result;
}

/**
 * The call pipeline's entry, at the point it books the visit. Fail-soft: a write error leaves the person
 * unrecorded (nobody extra is texted) and never touches the booking. `blocked` is the call-level SMS verdict.
 */
async function recordForCall({ scheduledServiceId, customerId, call, contactPhone = null, extracted = {}, v2Extraction, blocked = false }) {
  if (!gateLive() || !customerId) return null;
  try {
    const result = await recordForVisit({
      scheduledServiceId,
      callLogId: call.id,
      v2Extraction,
      excludePhones: callerNumbers({ call, contactPhone, extractedPhone: extracted.phone, v2Extraction }),
      blocked,
    });
    if (result.recorded.length) logger.info(`[call-visit-recipient] ${result.recorded.length} recipient(s) recorded for visit ${scheduledServiceId}`);
    return result;
  } catch (err) {
    logger.warn(`[call-visit-recipient] not recorded for visit ${scheduledServiceId}: ${err.code || err.name || 'error'}`);
    return null;
  }
}

/**
 * The visit-only recipients owed a text of `kind` for this visit right now, as contacts a sender can
 * text. Empty for a visit that is cancelled or over, a number the account holder already gets, or
 * anything in `excludePhones` (the numbers the sender is already texting). Fails closed: a read error
 * answers nobody.
 */
async function contactsForVisit(scheduledServiceId, kind, { excludePhones = [], conn = db } = {}) {
  if (!scheduledServiceId || !kind) return [];
  try {
    const visit = await conn('scheduled_services').where({ id: scheduledServiceId }).first('id', 'status', 'scheduled_date', 'window_start', 'customer_id');
    if (!visit || !LIVE_STATUSES.includes(String(visit.status || ''))) return [];
    const rows = await conn(TABLE).where({ scheduled_service_id: scheduledServiceId }).orderBy('created_at', 'asc');
    if (!rows.length) return [];
    const holder = await conn('customers').where({ id: visit.customer_id }).first('phone');
    const taken = new Set([...excludePhones, holder?.phone].map(lastTen).filter(Boolean));
    const slot = `${dateOnlyString(visit.scheduled_date) || ''}T${visit.window_start ? String(visit.window_start).slice(0, 5) : ''}`;
    return rows
      .filter((row) => !taken.has(row.phone_key))
      .map((row) => ({
        phone: row.phone_e164,
        email: null,
        name: [row.first_name, row.last_name].filter(Boolean).join(' '),
        // Not a service-contact role: the send runs at phone_matches_customer trust, so the contact-login
        // check (which needs a contact slot) never applies. This person has no slot and no login.
        role: ROLE,
        visitRecipientId: row.id,
        claimKey: `${kind}:${slot}`,
      }));
  } catch (err) {
    logger.warn(`[call-visit-recipient] recipients unreadable for visit ${scheduledServiceId}: ${err.code || err.name || 'db_error'}`);
    return [];
  }
}

function deliveryAccepted(result) {
  if (typeof result === 'boolean') return result;
  if (!result) return false;
  const { classifyDeliveryCertainty } = require('./messaging/send-customer-message');
  const certainty = typeof classifyDeliveryCertainty === 'function' ? classifyDeliveryCertainty(result) : null;
  if (certainty === 'sent') return true;
  return (certainty === 'unknown' || certainty === null) && (result.sent === true || result.deliveryOutcome === 'uncertain');
}

/**
 * Run `send` for one recipient at most once per text kind and visit slot. The claim is written before
 * the send and released when nothing reached the provider, so a retry or a second sender never texts
 * the same message twice, and a text that never went out is still owed. Returns { skipped, reason }
 * when the claim was already taken or could not be written (fail closed: no claim, no text).
 */
async function sendOnce(contact, send, { conn = db } = {}) {
  let claimed;
  try {
    claimed = await conn(TABLE)
      .where({ id: contact.visitRecipientId })
      .whereRaw('NOT jsonb_exists(deliveries, ?)', [contact.claimKey])
      .update({ deliveries: conn.raw('deliveries || jsonb_build_object(?::text, now()::text)', [contact.claimKey]) });
  } catch (err) {
    logger.warn(`[call-visit-recipient] claim failed for ${contact.claimKey}: ${err.code || err.name || 'db_error'}`);
    return { skipped: true, reason: 'claim_failed' };
  }
  if (!claimed) return { skipped: true, reason: 'already_sent' };
  const release = () => conn(TABLE)
    .where({ id: contact.visitRecipientId })
    .update({ deliveries: conn.raw('deliveries - ?::text', [contact.claimKey]) })
    .catch((err) => logger.warn(`[call-visit-recipient] claim release failed for ${contact.claimKey}: ${err.code || err.name || 'db_error'}`));
  let result;
  try {
    result = await send();
  } catch (err) {
    // A throw may have reached the provider: keep the claim (no double text) unless the error proves it did not.
    if (!deliveryAccepted(err && err.providerOutcome) && err && err.providerOutcome) await release();
    throw err;
  }
  if (!deliveryAccepted(result)) await release();
  return { skipped: false, result };
}

module.exports = {
  gateLive,
  SOURCE,
  CONSENT_VERSION,
  ROLE,
  LIVE_STATUSES,
  kindForSend,
  eligibleEntries,
  callerNumbers,
  recordForVisit,
  recordForCall,
  contactsForVisit,
  sendOnce,
  deliveryAccepted,
};
