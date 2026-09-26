/**
 * Lead auto-reply — once-per-phone mechanism.
 *
 * Owns the "AT MOST ONCE per person, ever" guarantee (owner ruling
 * 2026-08-05) for the lead_auto_reply_biz standard reply, and the shared
 * first-touch claim primitive the Lead Response Agent's personalized SMS
 * (lead_response_auto_reply, see services/lead-response-tools.js) now
 * tests against too (owner ruling 2026-09-26: only ONE automated text
 * ever reaches a new website lead — the agent's personalized reply
 * REPLACES the standard reply; the standard reply is the fallback for
 * when the agent doesn't send).
 *
 * Extracted verbatim from routes/lead-webhook.js — no behavior change.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { sendCustomerMessage, normalizeRecipient, classifyDeliveryCertainty } = require('./messaging/send-customer-message');
const { renderRequiredSmsTemplate } = require('./sms-template-renderer');
const { withSmsConsentLock } = require('../utils/customer-comms-lock');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');

/**
 * The lead auto-reply (lead_auto_reply_biz) is sent AT MOST ONCE per
 * person, ever (owner ruling 2026-08-05).
 *
 * Audit leg: messaging_audit_log rows with
 * entry_point='lead_webhook_auto_reply' — this route is the ONLY sender
 * of the menu template, so the entry point identifies it exactly
 * (sms_log.message_type='auto_reply' is shared with the public-quote
 * booking invite and can't distinguish templates). Only rows with a
 * non-null sent_at count: blocked and provider-failed attempts never
 * reached the customer and must not suppress a real first send.
 * to_hash is sha256 of the wrapper-normalized recipient
 * (+1XXXXXXXXXX for NANP — see normalizeRecipient in
 * services/messaging/send-customer-message.js and sha256 in
 * services/messaging/audit.js); phoneFormatted here is built the same
 * way, so the hashes line up.
 *
 * Legacy leg: 36 menu sends predate the first audit row
 * (2026-05-04T11:16:45Z). For rows STRICTLY BEFORE that instant we
 * fall back to the old sms_log signature. The bound is a fixed UTC
 * instant (not an ET business-day window), so comparing against the
 * raw timestamptz is correct. Post-cutover sms_log rows are never
 * consulted — that's what keeps quote-wizard sends from
 * false-positively suppressing the menu.
 *
 * Durable marker: lead_auto_reply_sends is a CLAIM-BEFORE-SEND record —
 * the caller commits it (an atomic ON CONFLICT test-and-set that also
 * serializes concurrent requests) before calling Twilio, confirms it
 * with the real SID on success, and releases it only on PROVABLY
 * undelivered outcomes (see resolveLeadAutoReplyClaim). There is
 * therefore no instant where a delivered menu lacks durable evidence:
 * persistAudit failing (best-effort, {id:null}) or a crash between
 * Twilio's accept and any later write both leave the claim in place.
 * An unresolved claim (null twilio_sid) suppresses by design — fail
 * closed; delete the row to re-arm the phone. Checked first — it is
 * the only leg fully controlled by this once-ever mechanism.
 *
 * The audit leg additionally requires a REAL Twilio SID (SM/MM prefix):
 * gate-blocked / template-disabled / owner-silence sends record
 * sent_at with a sentinel provider_message_id even though no text
 * reached the customer — those must not suppress a later real send.
 * All 167 historical sent rows for this entry point carry real SIDs
 * (prod-verified), so the filter changes nothing for genuine sends.
 *
 * FAIL CLOSED: if any dedup query errors, report "already sent" so
 * the caller skips the send. A missed greeting is recoverable (the
 * operator lead alert still fires); texting a customer the same
 * automated message twice is the failure this guard exists to prevent.
 */
const LEAD_AUTO_REPLY_AUDIT_CUTOVER = new Date('2026-05-04T11:16:45Z');
const REAL_TWILIO_SID_RE = /^(SM|MM)/;
// Both automated first-touch texts count as "already greeted": the standard
// reply and the Lead Response agent's personal text. Before the one-text
// ruling the agent could reach a phone whose standard reply had failed,
// leaving only a lead_response_auto_reply audit row and no claim marker.
const LEAD_FIRST_TOUCH_ENTRY_POINTS = ['lead_webhook_auto_reply', 'lead_response_auto_reply'];

async function hasPriorLeadAutoReply(phoneFormatted, dbc = db) {
  try {
    const markerHit = await dbc('lead_auto_reply_sends')
      .where({ phone_digits: String(phoneFormatted).slice(-10) })
      .first();
    if (markerHit) return true;

    const toHash = crypto.createHash('sha256').update(String(phoneFormatted || ''), 'utf8').digest('hex');
    const auditHit = await dbc('messaging_audit_log')
      .whereIn('entry_point', LEAD_FIRST_TOUCH_ENTRY_POINTS)
      .where({ to_hash: toHash })
      .whereNotNull('sent_at')
      .whereRaw("provider_message_id ~ '^(SM|MM)'")
      .first();
    if (auditHit) return true;

    const legacyHit = await dbc('sms_log')
      .where({ direction: 'outbound', message_type: 'auto_reply' })
      .where('created_at', '<', LEAD_AUTO_REPLY_AUDIT_CUTOVER)
      .whereRaw("RIGHT(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [String(phoneFormatted).slice(-10)])
      .first();
    return !!legacyHit;
  } catch (dedupErr) {
    logger.warn(`[lead-auto-reply] auto-reply dedup check failed — skipping send (fail closed): ${dedupErr.message}`);
    return true;
  }
}

/**
 * Settle a pre-send lead-auto-reply claim after the send attempt.
 *
 *  - Real Twilio SID → confirm the claim (stamp twilio_sid).
 *  - DETERMINISTIC no-delivery → release the claim so a later
 *    submission can greet the customer. Deterministic means the text
 *    provably never reached the carrier path:
 *      · wrapper policy block (blocked === true — provider never called)
 *      · gate/template/owner sentinel sid (sent:true without a real SID)
 *      · terminal provider failure (Twilio definitively rejected)
 *  - AMBIGUOUS outcomes KEEP the claim (fail closed): a retryable
 *    transport error (timeout, socket reset) can occur AFTER Twilio
 *    accepted the message, so releasing on those could let a later
 *    form send the menu a second time to a customer who received the
 *    first one. Same for unknown/absent result shapes.
 *  - If the release itself fails we keep the claim (fail closed) and
 *    log — a suppressed greeting is recoverable, a duplicate is not.
 *
 * Never throws: claim settlement must not mask the original send error.
 */
async function resolveLeadAutoReplyClaim(phoneDigits, smsResult, dbc = db) {
  try {
    const sid = smsResult && smsResult.sent ? String(smsResult.providerMessageId || '') : '';
    if (REAL_TWILIO_SID_RE.test(sid)) {
      await dbc('lead_auto_reply_sends').where({ phone_digits: phoneDigits }).update({ twilio_sid: sid });
      return;
    }
    const deterministicNoDelivery = !!smsResult && (
      // The messaging wrapper's canonical verdict: a throw before dispatch
      // carries deliveryOutcome 'not_sent' (provider never called).
      classifyDeliveryCertainty(smsResult) === 'not_sent'
      || smsResult.blocked === true
      || smsResult.sent === true // sentinel sid: gate-blocked / template-disabled / owner-silence
      || (smsResult.sent === false && smsResult.terminal === true)
    );
    if (deterministicNoDelivery) {
      await dbc('lead_auto_reply_sends').where({ phone_digits: phoneDigits }).whereNull('twilio_sid').del();
    } else {
      logger.warn(`[lead-auto-reply] auto-reply outcome ambiguous (retryable/unknown) — keeping claim, fail closed`);
    }
  } catch (settleErr) {
    logger.warn(`[lead-auto-reply] auto-reply claim settlement failed (claim stays, fail closed): ${settleErr.message}`);
  }
}

async function recipientStillCurrent(customerId, phoneDigits, conn = db) {
  const query = conn('customers').where({ id: customerId }).whereNull('deleted_at');
  if (conn !== db) query.forNoKeyUpdate();
  const row = await query.first('phone');
  const currentDigits = String(row?.phone || '').replace(/\D/g, '').slice(-10);
  return row && currentDigits === phoneDigits
    ? { ok: true }
    : { ok: false, code: 'LEAD_SUBJECT_CHANGED', reason: 'Customer deleted or phone changed before the delayed lead reply' };
}

// The delayed fallback goes out up to a minute after the form; in that time
// staff may have contacted, disqualified or deleted the lead, or the
// customer may have texted first. Send only while the lead is still
// untouched: the recipient is current, the customer has not texted since the
// form arrived (a reply need not move intake or lead status), intake has not
// moved past the webhook's own seeding, and the customer's lead rows (if
// any) include a live pre-contact one.
const UNTOUCHED_INTAKE_STATUSES = [null, 'awaiting_service', 'awaiting_address'];
const PRE_CONTACT_LEAD_STATUSES = ['new', 'pending', 'started'];
async function delayedLeadReplyStillEligible(customerId, phoneDigits, conn = db, { since = null } = {}) {
  const recipient = await recipientStillCurrent(customerId, phoneDigits, conn);
  if (!recipient.ok) return recipient;
  if (since) {
    // Any text either way since the form: the customer replied, or staff
    // already answered from the Inbox (which leaves lead status untouched).
    // Outbound counts only when Twilio actually accepted it (a real SM/MM
    // sid, not scheduled/cancelled/failed): a reply staff merely scheduled
    // has reached nobody.
    // An unresolved send reservation (a 'sending' placeholder) is not a text.
    const exchanged = await excludeUnresolvedSendReservations(conn('sms_log'))
      .where((q) => q.where({ direction: 'inbound' })
        .orWhere((out) => out.where({ direction: 'outbound' })
          .whereRaw("COALESCE(twilio_sid, '') ~ '^(SM|MM)'")
          .where((st) => st.whereNull('status')
            .orWhereNotIn('status', ['scheduled', 'cancelled', 'canceled', 'failed', 'undelivered']))))
      .where('created_at', '>=', since)
      .where((q) => q.where({ customer_id: customerId })
        .orWhereRaw("RIGHT(regexp_replace(COALESCE(from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phoneDigits])
        .orWhereRaw("RIGHT(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phoneDigits]))
      .first('id');
    if (exchanged) {
      return { ok: false, code: 'LEAD_CONVERSATION_STARTED', reason: 'A text was exchanged with the customer before the delayed lead reply' };
    }
    // A human reply still in flight on this thread (the Inbox sender commits
    // its 'sending' reservation before its provider call): the human wins.
    // Human reply types only, so this send's OWN provider-handoff
    // reservation (twilio.js creates one before the handoff while gratitude
    // coordination is on) can never block it. Accepted replies and newer
    // inbound texts are covered by the query above. The thread advisory lock
    // is not held here: the provider call can take it on its own connection.
    const { HUMAN_REPLY_TYPES } = require('./sms-suggest-mode');
    const humanReplyInFlight = await conn('sms_log')
      .where({ direction: 'outbound' })
      .whereIn('message_type', HUMAN_REPLY_TYPES)
      .whereIn('status', ['scheduled', 'sending'])
      .where('created_at', '>=', since)
      .whereRaw("RIGHT(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phoneDigits])
      .first('id');
    if (humanReplyInFlight) {
      return { ok: false, code: 'LEAD_CONVERSATION_STARTED', reason: 'A staff reply is in flight before the delayed lead reply' };
    }
  }
  const customer = await conn('customers').where({ id: customerId }).first('lead_intake_status');
  if (!UNTOUCHED_INTAKE_STATUSES.includes(customer?.lead_intake_status ?? null)) {
    return { ok: false, code: 'LEAD_CONVERSATION_STARTED', reason: 'The lead conversation moved on before the delayed lead reply' };
  }
  // Locked through dispatch (customer before lead, the Customer 360 order):
  // a staff status change waits until the provider has the request.
  const leadQuery = conn('leads').where({ customer_id: customerId });
  if (conn !== db) leadQuery.forNoKeyUpdate();
  const leads = await leadQuery.select('status', 'deleted_at', 'phone');
  const livePreContactLeads = leads.filter(lead => !lead.deleted_at && (lead.status == null || PRE_CONTACT_LEAD_STATUSES.includes(lead.status)));
  if (leads.length && !livePreContactLeads.length) {
    return { ok: false, code: 'LEAD_NO_LONGER_PRE_CONTACT', reason: 'The lead was contacted, closed or deleted before the delayed lead reply' };
  }
  // Staff can correct the phone on the lead alone (PUT /api/admin/leads/:id
  // leaves customers.phone as is): a live lead now on another number means
  // the captured recipient is stale.
  const leadPhoneChanged = livePreContactLeads.some(lead => lead.phone
    && String(lead.phone).replace(/\D/g, '').slice(-10) !== phoneDigits);
  if (leadPhoneChanged) {
    return { ok: false, code: 'LEAD_SUBJECT_CHANGED', reason: 'The lead phone changed before the delayed lead reply' };
  }
  return { ok: true };
}

// Auto-reply to lead — send AT MOST ONCE per person, ever (owner ruling
// 2026-08-05). Callers gate this to new customer rows; the same person can
// still produce a second "new" row (phone stored in a different format,
// deleted/merged record, double submission racing the 5-min window — 20
// phones got the menu text twice in prod). See hasPriorLeadAutoReply for the
// dedup predicate. Concurrency: the CLAIM ITSELF is the mutex — the ON
// CONFLICT DO NOTHING ... RETURNING insert is an atomic per-phone
// test-and-set, so two concurrent callers can both pass the history check
// but exactly one wins the claim row and sends; the loser skips. No
// transaction and no advisory lock, so no handler ever holds one pool
// connection while waiting on a second (that shape deadlocks the pool under
// a burst). Fails CLOSED: any error in the check or claim path skips the
// send — a missed greeting beats texting a customer twice. Later inbound
// replies are still classified by server/services/lead-intake.js. Edit copy
// in the admin UI.
async function sendLeadAutoReplyOnce({ customer, phoneFormatted, firstName, location, leadSource, revalidateRecipient = false, leadReceivedAt = null }) {
  if (await hasPriorLeadAutoReply(phoneFormatted)) {
    logger.info(`[lead-auto-reply] Auto-reply skipped for customer ${customer.id}: already sent once to this phone`);
    return;
  }

  // Render BEFORE claiming: a template failure claims nothing and the
  // phone stays re-armed.
  const replyMsg = await renderRequiredSmsTemplate(
    'lead_auto_reply_biz',
    { first_name: firstName },
    { workflow: 'lead_webhook_auto_reply', entity_type: 'customer', entity_id: customer.id }
  );

  // CLAIM-BEFORE-SEND, committed (autocommit) before the Twilio call: from
  // this point there is no instant where the customer can have received
  // the menu without durable evidence — a crash anywhere after Twilio's
  // accept leaves the claim in place and the guard stays fail-closed.
  // RETURNING distinguishes winning the claim ([row]) from losing to a
  // concurrent request or an existing row ([]). An unresolved claim
  // (twilio_sid null) suppresses future sends by design — delete the
  // lead_auto_reply_sends row to re-arm that phone.
  const phoneDigits = String(phoneFormatted).slice(-10);
  const claim = await db('lead_auto_reply_sends')
    .insert({ phone_digits: phoneDigits, customer_id: customer.id, twilio_sid: null })
    .onConflict('phone_digits')
    .ignore()
    .returning('phone_digits');

  if (claim.length === 0) {
    logger.info(`[lead-auto-reply] Auto-reply skipped for customer ${customer.id}: claim already held for this phone`);
    return;
  }

  // A throw (for example a refused or failed locked handoff) carries the
  // wrapper's tagged outcome; settle the claim on it (a provable not_sent
  // releases it) before rethrowing, as the agent's send path does.
  const smsResult = await sendCustomerMessage({
    to: phoneFormatted,
    body: replyMsg,
    channel: 'sms',
    audience: 'lead',
    purpose: 'conversational',
    customerId: customer.id,
    identityTrustLevel: 'phone_matches_customer',
    entryPoint: 'lead_webhook_auto_reply',
    // The delayed fallback (after the Lead Response agent) goes out up to a
    // minute after the form. Like the agent's own send, it dispatches inside
    // the customer's comms lock with the customer row locked, after
    // re-checking the row still exists and still has this phone, so a staff
    // correction or delete either lands first (refused: a not-sent block,
    // which releases the claim below) or waits until Twilio has the request.
    ...(revalidateRecipient ? {
      withSmsHandoff: dispatch => withSmsConsentLock(db, { phone: phoneFormatted, customerId: customer.id }, async (trx) => {
        const current = await delayedLeadReplyStillEligible(customer.id, phoneDigits, trx, { since: leadReceivedAt });
        return current.ok ? dispatch(trx) : current;
      }),
    } : {}),
    metadata: {
      original_message_type: 'auto_reply',
      customerLocationId: location.id,
      lead_source: leadSource.source,
    },
  }).catch(async (err) => {
    await resolveLeadAutoReplyClaim(phoneDigits, err?.providerOutcome || null);
    throw err;
  });
  if (!smsResult.sent) {
    logger.warn(`[lead-auto-reply] Auto-reply blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
  }
  // No quiet-hours requeue: lead_webhook_auto_reply is a customer-action
  // entry point (owner ruling 2026-08-29) — the menu answers the
  // customer's own form fill immediately, at any hour, so QUIET_HOURS_HOLD
  // cannot surface here and every result settles the once-ever claim
  // directly.
  await resolveLeadAutoReplyClaim(phoneDigits, smsResult);
}

// First-touch test-and-set for the Lead Response Agent's personalized SMS
// (owner ruling 2026-09-26): the agent's reply is the customer's first
// automated text for a phone with no prior lead_webhook_auto_reply send iff
// this wins the SAME claim the standard reply uses — one first-touch claim,
// shared by whichever automated text reaches the phone first. Fail closed:
// any error (including inside hasPriorLeadAutoReply, which already fails
// closed to "already sent") reports claimed:false, so the caller never
// appends the opt-out line or stamps a claim it can't be sure it won.
// A text actually reached the carrier: sent AND a real Twilio SM/MM sid.
// Success-shaped sentinels (template disabled, gate, owner silence) report
// sent:true with a placeholder id and reached nobody.
function isDeliveredSms(result) {
  return result?.sent === true && REAL_TWILIO_SID_RE.test(String(result.providerMessageId || ''));
}

async function claimLeadFirstTouch(phone, customerId, dbc = db) {
  // The messaging layer's own recipient normalizer: '(941) 555-0100' and
  // '+19415550100' reach the same handset, so they must hit the same claim
  // key and the same audit to_hash (the webhook already passes this form).
  const phoneFormatted = normalizeRecipient(phone) || '';
  const phoneDigits = phoneFormatted.slice(-10);
  try {
    if (await hasPriorLeadAutoReply(phoneFormatted, dbc)) {
      return { claimed: false, phoneDigits };
    }
    const claim = await dbc('lead_auto_reply_sends')
      .insert({ phone_digits: phoneDigits, customer_id: customerId, twilio_sid: null })
      .onConflict('phone_digits')
      .ignore()
      .returning('phone_digits');
    return { claimed: claim.length > 0, phoneDigits };
  } catch (err) {
    logger.warn(`[lead-auto-reply] claimLeadFirstTouch failed — fail closed (claimed:false): ${err.message}`);
    return { claimed: false, phoneDigits };
  }
}

/**
 * The webhook seeds lead_intake_status='awaiting_service', which expects an
 * answer to the standard reply. Once the Lead Response agent's personal text
 * is accepted by Twilio, that state no longer matches what the customer was
 * asked, so the next reply takes the normal AI draft path instead. Called at
 * the confirmed send itself, so later agent work (a session error, a queue
 * for review) cannot skip it. Guarded: only the untouched seed is cleared; a
 * state the form data already advanced (awaiting_address) or a reply already
 * moved on is left alone. Non-fatal.
 */
async function clearServiceMenuIntakeState(customerId, dbc = db) {
  if (!customerId) return;
  try {
    await dbc('customers')
      .where({ id: customerId, lead_intake_status: 'awaiting_service' })
      .update({ lead_intake_status: null });
  } catch (stateErr) {
    logger.warn(`[lead-auto-reply] intake state clear after agent send failed: ${stateErr.message}`);
  }
}

module.exports = {
  recipientStillCurrent,
  delayedLeadReplyStillEligible,
  clearServiceMenuIntakeState,
  LEAD_AUTO_REPLY_AUDIT_CUTOVER,
  hasPriorLeadAutoReply,
  resolveLeadAutoReplyClaim,
  sendLeadAutoReplyOnce,
  claimLeadFirstTouch,
  isDeliveredSms,
};
