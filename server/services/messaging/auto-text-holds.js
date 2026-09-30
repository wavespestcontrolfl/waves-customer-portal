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
 *   asked_not_to_be_contacted — asked not to be contacted on any call,
 *                               including the one setting the text off (a
 *                               reprocess can correct it after a deferral)
 *   said_no_texts             — explicitly said no to texts on any call
 *                               (consent.sms_declined, schema 1.19.0+), the
 *                               same "no texts" the booking-link text honours
 *                               (owner 2026-09-30). Only an explicit decline
 *                               holds: calls extracted before the field
 *                               existed never recorded one either way, and
 *                               treating that as a "no" would silence these
 *                               texts for nearly every past caller
 *   not_a_prospect            — a call with this number, the one setting
 *                               the text off included, showed a salesperson,
 *                               robocall, wrong number or job applicant — or
 *                               a vendor/partner call ALSO flagged spam
 *                               (owner ruling 2026-09-28: a vendor_or_partner
 *                               call V2 cleared of spam content — a genuine
 *                               property manager or referral partner — is a
 *                               prospect like any other and no longer holds;
 *                               the office's own callback to them is
 *                               untouched either way)
 * The call setting the text off is read by its id as well as by number: a
 * voicemail can be texted at a spoken callback number its own row does not
 * carry (call-recording-processor.js resolveCallContactPhone).
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
// V2 call natures that are not a prospect on their own, no additional spam
// flag needed (utils/extraction-compat.js's HARD_SPAM_CALL_NATURES plus a
// job applicant), and the legacy extraction's own spam / wrong-number labels
// for calls processed before V2. vendor_or_partner is deliberately NOT here
// (owner ruling 2026-09-28) — see the dedicated vendor/spam check below.
const NOT_A_PROSPECT_NATURES = ['spam_solicitation', 'robocall', 'wrong_number', 'job_applicant'];
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
// ONE definition, shared with lead-auto-reply.js's delayed-reply check: an
// inbound text, or an outbound one Twilio accepted (a real SM/MM sid) that
// was not scheduled, cancelled or bounced. Never an unresolved send
// reservation.
function deliveredTexts(dbi = db) {
  return excludeUnresolvedSendReservations(dbi('sms_log'))
    .where((q) => q.where({ direction: 'inbound' })
      .orWhere((out) => out.where({ direction: 'outbound' })
        .whereRaw("COALESCE(twilio_sid, '') ~ '^(SM|MM)'")
        .where((st) => st.whereNull('status').orWhereNotIn('status', UNSENT_STATUSES))));
}

// Every call with this number, either direction, plus the call setting the
// text off by its id (a reprocess after a deferral can re-judge it, and its
// text may go to a number its row does not carry) — never a Sandy sandbox
// test call, whose extraction says nothing about the real caller.
function callsWith(dbi, digits, originCallId) {
  return dbi('call_log')
    .modify((q) => whereNotSandboxCall(q))
    .where((q) => q.whereRaw(...matches('from_phone', digits)).orWhereRaw(...matches('to_phone', digits))
      .modify((either) => { if (originCallId) either.orWhere('id', originCallId); }));
}

/**
 * @param {string} phone                        the number about to be texted
 * @param {object} [opts]
 * @param {Date}   [opts.callAt]                when the call that sets the text off came in (window start = 7 days before it)
 * @param {string} [opts.originCallId]          that call's id — read whatever number it came from
 * @param {string[]} [opts.excludeMessageTypes] the lane's own sms_log types (its one-shot, not a conversation)
 * @returns {Promise<string|null>} a hold reason, or null when the text may go
 */
async function autoTextHoldReason(phone, {
  callAt = new Date(), originCallId = null, excludeMessageTypes = [], dbi = db,
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
  // field (a call processed with V2 off, unavailable or schema-failed). Read
  // from ANY stored extraction, valid or not, and from the call setting this
  // text off too: an opt-out is honoured wherever it was heard.
  const doNotContact = await callsWith(dbi, digits, originCallId)
    .where((q) => q.whereRaw("ai_extraction_enriched->'consent'->>'do_not_contact_request' = 'true'")
      .orWhereRaw(`COALESCE(ai_extraction, '') ~ '"do_not_contact_request"\\s*:\\s*true'`))
    .first('id');
  if (doNotContact) return 'asked_not_to_be_contacted';

  // An explicit "no texts" on any call with this number, the one setting
  // this text off included. Only a VALID V2 extraction counts: whether the
  // caller truly declined texts is model judgment, trusted only from a
  // schema-validated row (the booking-link lane's own posture).
  // Also a call where the caller SPOKE this number ("call me at Y, don't
  // text me") from another line: a later missed call or voicemail from Y
  // must still see that decline (the booking-link lane's
  // smsDeclinedOnEarlierCall matches caller.phone_e164 for the same reason).
  const saidNoTexts = await dbi('call_log')
    .modify((q) => whereNotSandboxCall(q))
    .where((q) => q.whereRaw(...matches('from_phone', digits)).orWhereRaw(...matches('to_phone', digits))
      .orWhereRaw(...matches("(ai_extraction_enriched->'caller'->>'phone_e164')", digits))
      .modify((either) => { if (originCallId) either.orWhere('id', originCallId); }))
    .where('v2_extraction_status', 'valid')
    .whereRaw("ai_extraction_enriched->'consent'->>'sms_declined' = 'true'")
    .first('id');
  if (saidNoTexts) return 'said_no_texts';

  // Only a VALID V2 extraction's nature counts (a schema-failed one can
  // persist a normalized but wrong call_nature); the legacy labels are what
  // the processor itself acted on, and the only label on a call processed
  // before V2 or with it off or failed. The call setting this text off
  // counts too: the voicemail route vetoes neither a vendor nor a job
  // applicant, so one naming a service still becomes a lead.
  //
  // vendor_or_partner is split out from the other natures (owner ruling
  // 2026-09-28): it holds ONLY when the SAME call is ALSO flagged spam
  // (extraction-compat.js's merge stamps is_spam true on the legacy
  // ai_extraction column for every vendor_or_partner call UNLESS V2's own
  // spam_verdict explicitly cleared its content — that clearing is what a
  // genuine property manager or referral partner looks like). A vendor call
  // V2 cleared of spam is a prospect like any other and no longer holds;
  // the office's own callback to them is untouched either way.
  const notAProspect = await callsWith(dbi, digits, originCallId)
    .where((q) => q
      .where((v2) => v2.where('v2_extraction_status', 'valid')
        .whereRaw("ai_extraction_enriched->>'call_nature' = ANY(?)", [NOT_A_PROSPECT_NATURES]))
      // A valid V2 vendor_or_partner call V2 itself judged spam holds on its
      // own verdict — a shadow-mode row persists that verdict without
      // stamping the legacy is_spam flag the fallback below reads.
      .orWhere((v2VendorSpam) => v2VendorSpam.where('v2_extraction_status', 'valid')
        .whereRaw("ai_extraction_enriched->>'call_nature' = 'vendor_or_partner'")
        .whereRaw("ai_extraction_enriched->'spam_verdict'->>'is_spam_content' = 'true'"))
      .orWhere((legacy) => legacy
        .where((flag) => flag
          .whereRaw(`COALESCE(ai_extraction, '') ~ '"is_spam"\\s*:\\s*true'`)
          .orWhereRaw(`COALESCE(ai_extraction, '') ~ '"call_type"\\s*:\\s*"(spam|wrong_number)"'`))
        // A valid V2 vendor_or_partner call whose own spam_verdict cleared
        // its content is authoritative over the legacy labels: a call
        // processed while V2 was shadow-only keeps the legacy is_spam /
        // call_type "spam" that V2-primary adoption would have cleared, and
        // one such row in the number's history must not silence a genuine
        // property manager or referral partner for good. COALESCE: a row
        // with no V2 data evaluates the clear as false, so its legacy flag
        // still holds.
        .whereRaw(`NOT COALESCE(v2_extraction_status = 'valid'
          AND ai_extraction_enriched->>'call_nature' = 'vendor_or_partner'
          AND ai_extraction_enriched->'spam_verdict'->>'is_spam_content' = 'false', false)`)))
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
