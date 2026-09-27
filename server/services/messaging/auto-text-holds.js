/**
 * Why an automated first-touch text must not go to a phone number — or null.
 *
 * Owner rulings 2026-09-27 for the automated texts a missed call or a
 * voicemail sets off (voicemail-lead-sms.js today; the missed-call
 * text-back next): none of them goes to someone who
 *   quote_on_file             — already has a quote or estimate: an online
 *                               quote-wizard lead carrying one (they saw
 *                               their price in the wizard), a lead whose
 *                               linked estimate reached them, or an estimate
 *                               that reached their number — never a draft
 *                               (an estimator-engine call draft included)
 *                               that was not sent
 *   lead_assigned             — has an open lead a staff member is working
 *   asked_not_to_be_contacted — asked not to be contacted on an earlier call
 *   not_a_prospect            — an earlier call showed a salesperson, vendor,
 *                               robocall, wrong number or job applicant
 *   recent_conversation       — texted with us, either way, from 7 days
 *                               before this call up to now (so a deferred
 *                               send replayed later still sees a text that
 *                               came after the call)
 * Every phone comparison is on the last 10 digits, so a number stored in any
 * shape still matches.
 */

const db = require('../../models/db');
const { excludeUnresolvedSendReservations } = require('./review-ask-reservation');
const { applyOpenLeadPredicate } = require('../lead-statuses');
const { whereNotSandboxCall } = require('../voice-agent/relay-protocol');

const RECENT_CONVERSATION_MS = 7 * 24 * 60 * 60 * 1000;
// An estimate reached them when it carries delivery evidence (sent_at or
// viewed_at — estimate-extension.js's own rule: an 'expired' or
// 'send_failed' row without either never went out) or sits in a status only
// a delivered estimate reaches.
const QUOTED_ESTIMATE_STATUSES = ['sent', 'viewed', 'accepted', 'declined'];
// V2 call natures that are not a prospect (utils/extraction-compat.js's
// spam-class set plus a job applicant), and the legacy extraction's own
// spam / wrong-number labels for calls processed before V2.
const NOT_A_PROSPECT_NATURES = ['spam_solicitation', 'robocall', 'wrong_number', 'vendor_or_partner', 'job_applicant'];
// Outbound sms_log statuses that reached nobody — lead-auto-reply.js's
// delayed-reply rule: scheduled, cancelled, or bounced.
const UNSENT_STATUSES = ['scheduled', 'cancelled', 'canceled', 'failed', 'undelivered'];

function phoneDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function matches(column, digits) {
  return [`RIGHT(regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g'), 10) = ?`, [digits]];
}

// sms_log rows that are a text that actually reached the other side — the
// definition lead-auto-reply.js's delayed-reply check uses: an inbound text,
// or an outbound one Twilio accepted (a real SM/MM sid) that was not
// scheduled, cancelled or bounced. Never an unresolved send reservation.
function deliveredTexts(dbi = db) {
  return excludeUnresolvedSendReservations(dbi('sms_log'))
    .where((q) => q.where({ direction: 'inbound' })
      .orWhere((out) => out.where({ direction: 'outbound' })
        .whereRaw("COALESCE(twilio_sid, '') ~ '^(SM|MM)'")
        .where((st) => st.whereNull('status').orWhereNotIn('status', UNSENT_STATUSES))));
}

// Earlier calls with this number, either direction — never a Sandy sandbox
// test call, whose extraction says nothing about the real caller.
function callsWith(dbi, digits, excludeCallLogId) {
  return dbi('call_log')
    .modify((q) => whereNotSandboxCall(q))
    .where((q) => q.whereRaw(...matches('from_phone', digits)).orWhereRaw(...matches('to_phone', digits)))
    .modify((q) => { if (excludeCallLogId) q.whereNot('id', excludeCallLogId); });
}

/**
 * @param {string} phone                        the number about to be texted
 * @param {object} [opts]
 * @param {Date}   [opts.callAt]                when the call that sets the text off came in (window start = 7 days before it)
 * @param {string} [opts.excludeCallLogId]      that call itself — it is not an "earlier" call
 * @param {string[]} [opts.excludeMessageTypes] the lane's own sms_log types (its one-shot, not a conversation)
 * @returns {Promise<string|null>} a hold reason, or null when the text may go
 */
async function autoTextHoldReason(phone, {
  callAt = new Date(), excludeCallLogId = null, excludeMessageTypes = [], dbi = db,
} = {}) {
  const digits = phoneDigits(phone);
  if (!digits) return null;

  const quoteLead = await dbi('leads as l').join('estimates as e', 'e.id', 'l.estimate_id')
    .whereNull('l.deleted_at')
    .whereRaw(...matches('l.phone', digits))
    .where((q) => q.where('l.lead_type', 'quote_wizard')
      .orWhereNotNull('e.sent_at').orWhereNotNull('e.viewed_at').orWhereIn('e.status', QUOTED_ESTIMATE_STATUSES))
    .first('l.id');
  if (quoteLead) return 'quote_on_file';
  const quotedEstimate = await dbi('estimates')
    .whereRaw(...matches('customer_phone', digits))
    .where((q) => q.whereNotNull('sent_at').orWhereNotNull('viewed_at').orWhereIn('status', QUOTED_ESTIMATE_STATUSES))
    .first('id');
  if (quotedEstimate) return 'quote_on_file';

  const assignedLead = await applyOpenLeadPredicate(dbi('leads'))
    .whereNull('deleted_at').whereNotNull('assigned_to')
    .whereRaw(...matches('phone', digits)).first('id');
  if (assignedLead) return 'lead_assigned';

  // Both DNC shapes: the V2 consent object, and the legacy extraction's flat
  // field (a call processed with V2 off, unavailable or schema-failed).
  const doNotContact = await callsWith(dbi, digits, excludeCallLogId)
    .where((q) => q.whereRaw("ai_extraction_enriched->'consent'->>'do_not_contact_request' = 'true'")
      .orWhereRaw(`COALESCE(ai_extraction, '') ~ '"do_not_contact_request"\\s*:\\s*true'`))
    .first('id');
  if (doNotContact) return 'asked_not_to_be_contacted';

  const notAProspect = await callsWith(dbi, digits, excludeCallLogId)
    .where((q) => q.whereRaw("ai_extraction_enriched->>'call_nature' = ANY(?)", [NOT_A_PROSPECT_NATURES])
      .orWhereRaw(`COALESCE(ai_extraction, '') ~ '"is_spam"\\s*:\\s*true'`)
      .orWhereRaw(`COALESCE(ai_extraction, '') ~ '"call_type"\\s*:\\s*"(spam|wrong_number)"'`))
    .first('id');
  if (notAProspect) return 'not_a_prospect';

  const since = new Date(new Date(callAt).getTime() - RECENT_CONVERSATION_MS);
  const recentText = await deliveredTexts(dbi)
    .where((q) => q.whereRaw(...matches('from_phone', digits)).orWhereRaw(...matches('to_phone', digits)))
    .where('created_at', '>=', since)
    .modify((q) => {
      if (excludeMessageTypes.length) q.whereRaw("COALESCE(message_type, '') <> ALL(?)", [excludeMessageTypes]);
    })
    .first('id');
  if (recentText) return 'recent_conversation';

  return null;
}

module.exports = {
  autoTextHoldReason,
  deliveredTexts,
  RECENT_CONVERSATION_MS,
  NOT_A_PROSPECT_NATURES,
};
