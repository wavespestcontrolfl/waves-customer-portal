/**
 * Dropped-call address-request text — texts a NEW prospect whose intake call
 * dropped mid-conversation before the service address was captured, asking
 * for the one field that blocks quoting/scheduling. Owner-directed
 * 2026-08-01 after a live case: a long, engaged intake call dropped on the
 * forwarded leg at the exact address-exchange moment (Twilio Insights showed
 * clean quality — a handset/coverage one-off no config change fixes, so
 * this is the backstop).
 *
 * Called from call-recording-processor.js on the lead path ONLY — the
 * eligibility that makes this safe lives at the call site AND here:
 *   caller side (processor): genuine prospect (v2 call_nature not in the
 *   non-customer set, not spam, not voicemail), no existing customer, real
 *   conversation (>= MIN_CALL_SECONDS), transcript ends with no farewell,
 *   street address missing.
 *   send side (this module), in order:
 *   1. GATE_DROPPED_CALL_SMS — customer-facing auto-send, fails CLOSED in
 *      every environment until the owner enables it.
 *   2. Quiet hours — sends only 8am–8pm ET; outside the window the one-shot
 *      is NOT consumed (the triage card still tells the office to call
 *      back).
 *   3. One text per phone number EVER — DB-atomic claim on
 *      dropped_call_sms_claims (phone PRIMARY KEY, INSERT ... ON CONFLICT
 *      DO NOTHING), belt-and-suspenders sms_log history check, plus an
 *      atomic per-lead claim on leads.extracted_data.
 *   4. Landline pre-check via the shared phone_line_types cache + one paid
 *      Twilio Lookup per uncached number.
 *   5. The sendCustomerMessage policy pipeline: suppression (STOP), consent
 *      (transactional basis — they called us about service), emoji fail-
 *      closed, audit log.
 *   6. Template kill switch — dropped_call_address_request is admin-editable
 *      and is_active-toggleable like every automated template.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { readCachedLineType, cacheLineType, lookupLineType } = require('./messaging/validators/line-type');
// sent:true is necessary but not sufficient — upstream suppressions (gate
// off, template disabled, owner kill switch) report sent:true with a
// sentinel providerMessageId and no SMS leaves the system.
const { isRealProviderSend } = require('./sms-auto-send');

const MESSAGE_TYPE = 'dropped_call_address_request';
const MIN_CALL_SECONDS = 120;
const QUIET_START_HOUR_ET = 8;   // inclusive — sends allowed from 08:00 ET
const QUIET_END_HOUR_ET = 20;    // exclusive — no sends at/after 20:00 ET

// Farewell detection over the transcript tail. A dropped call ends
// mid-thought; a normal call ends with a goodbye exchange. Two tiers: STRONG
// farewells (bye / see you / talk soon / take care) count anywhere in the
// last three turns; WEAK acknowledgements (sounds good / thanks /
// appreciate it) are everyday mid-conversation phrases — "Sounds good —
// what's your service address?" right before the line dies must NOT read as
// a goodbye — so they count only in the FINAL utterance (codex P2).
const STRONG_FAREWELL_RE = new RegExp(
  [
    '\\bbye\\b', 'good-?bye', 'bye-?bye',
    'see (you|ya)\\b', 'talk (to you|soon|later)',
    'have a (good|great|nice|wonderful)',
    'take care',
  ].join('|'),
  'i'
);
const WEAK_FAREWELL_RE = new RegExp(
  [
    'sounds good', "you're welcome", 'appreciate (it|you)', 'thank(s| you)',
  ].join('|'),
  'i'
);

/**
 * Full drop-mid-intake detection: long enough to be a real conversation,
 * no service address captured by EITHER extraction leg (V1 flat or the
 * canonical V2 service_address — V2 can hold the street when primary
 * adoption is off or V1 missed it), and an abrupt transcript ending.
 */
function detectDroppedMidIntake({ durationSeconds, transcription, extracted = {}, v2Extraction = null } = {}) {
  const v1Street = String(extracted.address_line1 || '').trim();
  const v2Street = String(v2Extraction?.property?.service_address?.street_line_1 || '').trim();
  return Number(durationSeconds) >= MIN_CALL_SECONDS
    && !v1Street
    && !v2Street
    && endedAbruptly(transcription);
}

/**
 * Whether the caller is a prospect the automatic text may go to. A customer
 * record CREATED FROM THIS CALL is still a new prospect (Step 3 mints one
 * for any named live caller, address or not) — only a PRE-EXISTING linked
 * customer is excluded. Inbound only: the transactional consent basis is
 * "they called us", and on outbound legs to_phone is the prospect's own
 * number. call_nature must be POSITIVELY 'new_lead' (fail closed).
 */
function eligibleNewProspect({ customerId, createdCustomerFromCall, isOutbound, v2Status, callNature } = {}) {
  return isOutbound !== true
    && (!customerId || createdCustomerFromCall === true)
    && v2Status === 'valid'
    && callNature === 'new_lead';
}

/**
 * True when the transcript looks like a call that died mid-conversation:
 * enough turns to be a real exchange, and no farewell language anywhere in
 * the last three turns. Deterministic — no model call.
 */
function endedAbruptly(transcription) {
  const turns = String(transcription || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (turns.length < 4) return false; // too short to judge — not "abrupt"
  const tail = turns.slice(-3).join(' ');
  const finalTurn = turns[turns.length - 1];
  return !STRONG_FAREWELL_RE.test(tail) && !WEAK_FAREWELL_RE.test(finalTurn);
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

// Same shape contract as voicemail-lead-sms: the claim key, the sms_log
// dedupe, and the pipeline-written rows must agree on ONE phone shape.
function normalizePhoneE164(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (trimmed.startsWith('+')) return trimmed;
  return trimmed;
}

function capitalizeName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// " at (941) 216-6229" from the line the caller dialed, or "" when it isn't
// a displayable 10-digit US number — the template's {callback_clause} slot
// keeps the sentence grammatical either way.
function callbackClause(dialedLine) {
  const digits = String(dialedLine || '').replace(/\D/g, '').replace(/^1/, '');
  if (digits.length !== 10) return '';
  return ` at (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function withinSendWindowET(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  }).format(now));
  return hour >= QUIET_START_HOUR_ET && hour < QUIET_END_HOUR_ET;
}

async function stampStatus(leadId, status) {
  try {
    await db('leads').where({ id: leadId }).update({
      extracted_data: db.raw(
        "jsonb_set(COALESCE(extracted_data, '{}'::jsonb), '{dropped_call_sms_status}', to_jsonb(?::text))",
        [status]
      ),
      updated_at: new Date(),
    });
  } catch (e) {
    logger.warn(`[dropped-call-sms] status stamp failed for lead ${leadId}: ${e.code || e.name || 'db_error'}`);
  }
}

async function logActivity(leadId, activityType, description, metadata = {}) {
  try {
    await db('lead_activities').insert({
      lead_id: leadId,
      activity_type: activityType,
      description,
      performed_by: 'AI Call Processor',
      metadata: JSON.stringify(metadata),
    });
  } catch (e) {
    logger.warn(`[dropped-call-sms] lead activity insert failed for lead ${leadId}: ${e.code || e.name || 'db_error'}`);
  }
}

async function releasePhoneClaim(phone) {
  try {
    await db('dropped_call_sms_claims').where({ phone }).del();
  } catch (e) {
    logger.warn(`[dropped-call-sms] phone claim release failed for ${maskPhone(phone)}: ${e.code || e.name || 'db_error'}`);
  }
}

async function stampPhoneClaim(phone, outcome) {
  try {
    await db('dropped_call_sms_claims').where({ phone }).update({ outcome });
  } catch (e) {
    logger.warn(`[dropped-call-sms] phone claim stamp failed for ${maskPhone(phone)}: ${e.code || e.name || 'db_error'}`);
  }
}

// Release always clears BOTH claims (see voicemail-lead-sms clearLeadClaim
// for why: the pipeline reuses the same open lead row for a repeat caller).
async function clearLeadClaim(leadId) {
  try {
    await db('leads').where({ id: leadId }).update({
      extracted_data: db.raw("COALESCE(extracted_data, '{}'::jsonb) - 'dropped_call_sms_status'"),
      updated_at: new Date(),
    });
  } catch (e) {
    logger.warn(`[dropped-call-sms] lead claim clear failed for lead ${leadId}: ${e.code || e.name || 'db_error'}`);
  }
}

async function sendDroppedCallAddressRequest({ leadId, extracted = {}, call = {}, phone: rawPhone, expectedCustomerId = null } = {}) {
  if (!isEnabled('droppedCallSms')) {
    logger.info(`[dropped-call-sms] Gate off — text skipped for lead ${leadId || 'unknown'}`);
    return { sent: false, skipped: 'gate_off' };
  }
  const phone = normalizePhoneE164(rawPhone);
  if (!leadId || !phone) return { sent: false, skipped: 'missing_input' };

  // Quiet hours BEFORE any claim: an evening drop still gets its triage card
  // ("call them back"); the one-shot stays available in case a later
  // scheduler rail wants to pick it up.
  if (!withinSendWindowET()) {
    logger.info(`[dropped-call-sms] Outside 8am-8pm ET window — text skipped for lead ${leadId}`);
    return { sent: false, skipped: 'quiet_hours' };
  }

  // Belt-and-suspenders history check; the ATOMIC gate is the claim insert.
  try {
    const prior = await db('sms_log')
      .where({ to_phone: phone, message_type: MESSAGE_TYPE })
      .first('id');
    if (prior) return { sent: false, skipped: 'already_sent_to_phone' };
  } catch (e) {
    logger.warn(`[dropped-call-sms] sms_log dedupe read failed — skipping (fail closed): ${e.code || e.name || 'db_error'}`);
    return { sent: false, skipped: 'dedupe_read_failed' };
  }

  let phoneClaimed = false;
  try {
    const inserted = await db('dropped_call_sms_claims')
      .insert({ phone, lead_id: leadId, outcome: 'claimed' })
      .onConflict('phone')
      .ignore()
      .returning('phone');
    phoneClaimed = Array.isArray(inserted) ? inserted.length > 0 : !!inserted;
  } catch (e) {
    logger.warn(`[dropped-call-sms] phone claim insert failed — skipping (fail closed): ${e.code || e.name || 'db_error'}`);
    return { sent: false, skipped: 'claim_insert_failed' };
  }
  if (!phoneClaimed) return { sent: false, skipped: 'already_sent_to_phone' };

  try {
    return await sendClaimed({ leadId, extracted, call, phone, expectedCustomerId });
  } catch (err) {
    await clearLeadClaim(leadId);
    await releasePhoneClaim(phone);
    throw err;
  }
}

// Runs with the per-phone claim held. Every return path either keeps the
// claim (one-shot consumed) or releases it (config failure).
async function sendClaimed({ leadId, extracted, call, phone, expectedCustomerId = null }) {
  // Ownership predicate mirrors the processor's enrichment write: a reusable
  // lead claimed by ANOTHER customer between lookup and here must not be
  // stamped or texted (codex P1 — lead ownership race). Zero rows = lost.
  const claimed = await db('leads')
    .where({ id: leadId })
    .where(function ownershipGuard() {
      if (expectedCustomerId) this.whereNull('customer_id').orWhere('customer_id', expectedCustomerId);
      else this.whereNull('customer_id');
    })
    .whereRaw("COALESCE(extracted_data->>'dropped_call_sms_status', '') = ''")
    .update({
      extracted_data: db.raw(
        "jsonb_set(COALESCE(extracted_data, '{}'::jsonb), '{dropped_call_sms_status}', to_jsonb('claimed'::text))"
      ),
      updated_at: new Date(),
    });
  if (!claimed) {
    // Lost either to same-lead idempotency or to the ownership race — the
    // phone one-shot was never consumed for a text; release it.
    await releasePhoneClaim(phone);
    return { sent: false, skipped: 'lead_claim_lost' };
  }

  // Landline pre-check (shared cache; at most one paid Lookup per number).
  // Fails open on lookup errors — the reactive 30006 suppression backstops.
  try {
    let lineType = null;
    const cached = await readCachedLineType(phone);
    if (cached.state === 'hit') {
      lineType = cached.lineType;
    } else if (cached.state === 'miss') {
      lineType = await lookupLineType(phone);
      if (lineType) await cacheLineType(phone, lineType);
    }
    if (lineType === 'landline') {
      await stampStatus(leadId, 'blocked');
      await stampPhoneClaim(phone, 'landline'); // keep — a landline stays a landline
      await logActivity(leadId, 'note', 'Dropped-call address text skipped — caller number is a landline', {
        message_type: MESSAGE_TYPE,
        reason: 'landline',
      });
      logger.info(`[dropped-call-sms] Skipping ${maskPhone(phone)} — landline`);
      return { sent: false, skipped: 'landline' };
    }
  } catch (e) {
    logger.warn(`[dropped-call-sms] line-type pre-check failed (continuing): ${e.code || e.name || 'lookup_error'}`);
  }

  const body = await renderSmsTemplate(MESSAGE_TYPE, {
    first_name: capitalizeName(extracted.first_name) || 'there',
    callback_clause: callbackClause(call.to_phone),
  }, {
    workflow: MESSAGE_TYPE,
    entity_type: 'lead',
    entity_id: leadId,
  });
  if (!body) {
    // Template missing/admin-disabled — the kill switch. Never consumed the
    // one-shot: release BOTH claims so re-enabling lets a later drop text.
    await clearLeadClaim(leadId);
    await releasePhoneClaim(phone);
    logger.info(`[dropped-call-sms] Template ${MESSAGE_TYPE} missing/disabled — text skipped for lead ${leadId}`);
    return { sent: false, skipped: 'template_disabled' };
  }

  const result = await sendCustomerMessage({
    to: phone,
    body,
    channel: 'sms',
    audience: 'lead',
    purpose: 'missed_call_followup',
    leadId,
    identityTrustLevel: 'phone_provided_unverified',
    consentBasis: { status: 'transactional_allowed', source: 'dropped_call_text_back' },
    entryPoint: 'dropped_call_sms',
    metadata: {
      original_message_type: MESSAGE_TYPE,
      call_sid: call.twilio_call_sid || null,
    },
  });

  if (result.sent && !isRealProviderSend(result)) {
    // Upstream suppression sentinel — no text actually left. Never consumed
    // the one-shot: release BOTH claims and report the suppression instead
    // of telling the card to wait for a reply that was never sent.
    await clearLeadClaim(leadId);
    await releasePhoneClaim(phone);
    logger.info(`[dropped-call-sms] Suppression sentinel for ${maskPhone(phone)} (${result.providerMessageId || 'no-id'}) — released, not sent`);
    return { sent: false, skipped: 'send_suppressed', code: result.providerMessageId || null };
  }
  if (result.sent) {
    await stampStatus(leadId, 'sent');
    await stampPhoneClaim(phone, 'sent');
    await logActivity(leadId, 'sms_sent', `Auto-texted address request after dropped call to ${maskPhone(phone)}`, {
      message_type: MESSAGE_TYPE,
      call_sid: call.twilio_call_sid || null,
    });
    logger.info(`[dropped-call-sms] Address request texted to ${maskPhone(phone)} for lead ${leadId}`);
    return { sent: true };
  }

  if (result.blocked) {
    // Transient infrastructure blocks (a consent-lookup DB failure, or any
    // block the pipeline marks retryable) never consumed the one-shot —
    // release BOTH claims so a later drop from this prospect can retry.
    // Only TERMINAL policy blocks (STOP suppression, consent denial) consume
    // it: that number must not be retried by a later drop either.
    if (result.retryable || result.code === 'CONSENT_LOOKUP_FAILED') {
      await clearLeadClaim(leadId);
      await releasePhoneClaim(phone);
      logger.warn(`[dropped-call-sms] Transient policy block for ${maskPhone(phone)} (released): ${result.code || 'blocked'}`);
      return { sent: false, skipped: 'policy_block_transient' };
    }
    // Only RECIPIENT verdicts (STOP-list suppressions, opt-outs, explicit
    // no-consent) consume the one-shot — the number itself must never be
    // retried. Content/config blocks (EMOJI_FOR_CUSTOMER on an admin-edited
    // template, contract violations) say nothing about the recipient: no
    // SMS left, release BOTH claims so a later drop can text once the
    // config is fixed (codex P2).
    const recipientTerminal = /^SUPPRESSED_|OPTED_OUT|OPT_OUT|NO_CONSENT_RECORD|NO_MARKETING_CONSENT|DNC|WRONG_NUMBER/.test(String(result.code || ''));
    if (!recipientTerminal) {
      await clearLeadClaim(leadId);
      await releasePhoneClaim(phone);
      logger.warn(`[dropped-call-sms] Config/content block for ${maskPhone(phone)} (released): ${result.code || 'blocked'}`);
      return { sent: false, skipped: 'policy_block_config', code: result.code || null };
    }
    await stampStatus(leadId, 'blocked');
    await stampPhoneClaim(phone, 'policy_block');
    logger.info(`[dropped-call-sms] Policy-blocked for ${maskPhone(phone)}: ${result.code || result.reason || 'blocked'}`);
    // The code rides to the triage card: a DNC/wrong-number suppression must
    // render as "do not contact", never as "call them back" (codex P1).
    return { sent: false, skipped: 'policy_block', code: result.code || null };
  }

  if (result.terminal) {
    // Synchronous terminal Twilio rejection — the number will never accept
    // this text; keep the one-shot so a later drop doesn't retry it. The
    // meaningful value is providerErrorCode (result.code is the generic
    // PROVIDER_FAILURE): 21610 = recipient unsubscribed, an OPT-OUT the card
    // must render as do-not-contact, never "call them back"; 21614/invalid
    // destination = not SMS-capable, still callable.
    const providerCode = String(result.providerErrorCode || result.code || 'terminal');
    const optedOut = providerCode === '21610';
    await stampStatus(leadId, 'blocked');
    await stampPhoneClaim(phone, optedOut ? 'opted_out' : 'provider_terminal');
    logger.info(`[dropped-call-sms] Terminal provider rejection for ${maskPhone(phone)}: ${providerCode}`);
    return {
      sent: false,
      skipped: optedOut ? 'policy_block' : 'provider_terminal',
      code: optedOut ? 'SUPPRESSED_PROVIDER_OPT_OUT_21610' : providerCode,
    };
  }
  // Transient provider failure — never consumed: release for a later drop.
  await clearLeadClaim(leadId);
  await releasePhoneClaim(phone);
  logger.warn(`[dropped-call-sms] Provider send failed for ${maskPhone(phone)} (released): ${result.code || result.reason || 'send_failed'}`);
  return { sent: false, skipped: 'provider_failed' };
}

/**
 * Delivery-status bounce handler (wired into the Twilio /status callback,
 * next to the voicemail quote-link handler). Twilio accepting the message
 * (result.sent) is NOT delivery — a later undelivered/failed callback
 * (30006 landline past the fail-open pre-check is the common case) means
 * the prospect never saw the address request while the lead and card say
 * "sent — watch for their reply".
 *
 * Correlation and idempotency ride the one-shot claim row, NOT sms_log:
 * twilio.js dispatches to the provider BEFORE its best-effort sms_log
 * insert, so a fast callback can arrive with no visible log row (and the
 * insert can fail outright) — an sms_log-gated handler would return
 * not-ours forever and the card would stay "sent" (codex P1). The atomic
 * gate is the claim-outcome flip 'sent' -> 'undelivered' (one row, one
 * winner across Twilio callback retries); the sms_log row, when present,
 * is used only to reject callbacks that belong to a DIFFERENT message type
 * and for a best-effort metadata breadcrumb. Remediation: stamp the lead
 * undelivered, pull its follow-up to NOW (earlier-only), leave a
 * call-instead timeline note, and flip the open dropped-call card's
 * address_request_sms payload to 'undelivered'. Best-effort by contract —
 * never throws.
 */
async function handleUndeliveredAddressRequest({ sid, status, errorCode, to } = {}) {
  try {
    if (!sid) return { handled: false, reason: 'no_sid' };
    // sms_log by sid alone: a row of another message_type means this bounce
    // is not ours. A MISSING row is NOT disqualifying (the send-then-log
    // race) — the claim row below is the authority.
    const row = await db('sms_log')
      .where({ twilio_sid: sid, direction: 'outbound' })
      .first('id', 'to_phone', 'message_type');
    if (row && row.message_type !== MESSAGE_TYPE) return { handled: false, reason: 'not_address_request' };
    const phone = normalizePhoneE164(to || row?.to_phone);
    if (!phone) return { handled: false, reason: 'no_phone' };

    return await db.transaction(async (trx) => {
      const claim = await trx('dropped_call_sms_claims').where({ phone }).first('lead_id', 'outcome', 'created_at');
      if (!claim || !claim.lead_id) return { handled: false, reason: 'no_claim_lead' };
      // Without a SID-bound sms_log row, phone-alone correlation could
      // misattribute an UNRELATED SMS's bounce to this claim (codex P1).
      // The send-then-log race window is seconds — accept the log-less path
      // only while the claim is fresh; a stale claim without a matching log
      // row is somebody else's bounce.
      if (!row) {
        const ageMs = Date.now() - new Date(claim.created_at || 0).getTime();
        if (!Number.isFinite(ageMs) || ageMs > 15 * 60 * 1000) {
          return { handled: false, reason: 'no_log_row_and_claim_stale' };
        }
      }
      // Atomic idempotency gate: exactly one callback (Twilio retries them)
      // flips 'sent' -> 'undelivered'; every later one sees 0 rows.
      const flipped = await trx('dropped_call_sms_claims')
        .where({ phone, outcome: 'sent' })
        .update({ outcome: 'undelivered' });
      if (!flipped) return { handled: false, reason: 'already_handled_or_not_sent' };

      const lead = await trx('leads')
        .where('id', claim.lead_id)
        .where('status', 'new')
        .whereNull('deleted_at')
        .first('id');

      const now = new Date();
      if (lead) {
        await trx('leads')
          .where({ id: lead.id })
          .where(function followUpMissingOrLater() {
            this.whereNull('next_follow_up_at').orWhere('next_follow_up_at', '>', now);
          })
          .update({ next_follow_up_at: now, updated_at: now });
        await trx('leads').where({ id: lead.id }).update({
          extracted_data: trx.raw(
            "jsonb_set(COALESCE(extracted_data, '{}'::jsonb), '{dropped_call_sms_status}', to_jsonb(?::text))",
            ['undelivered']
          ),
          updated_at: now,
        });
        const codeText = String(errorCode || '') === '30006'
          ? 'error 30006 — landline, this number cannot receive SMS'
          : `status ${status}${errorCode ? `, error ${errorCode}` : ''}`;
        await trx('lead_activities').insert({
          lead_id: lead.id,
          activity_type: 'note',
          description: `Dropped-call address request never arrived (${codeText}). Call the prospect instead.`,
          performed_by: 'AI Call Processor',
          metadata: JSON.stringify({ message_type: MESSAGE_TYPE, delivery_status: status || null, error_code: errorCode || null }),
        });
      }
      // Flip the open card even when the lead is no longer open — the card
      // outlives lead status changes and must stop saying "watch for a
      // reply". Payload key match on the caller phone the card was built
      // with; the card may not exist YET (bounce raced the processor's
      // insert) — the processor reconciles from the claim outcome after its
      // insert, so a zero-row update here is safe.
      await trx('triage_items')
        .where({ reason_code: 'call_dropped_mid_intake' })
        .whereIn('status', ['open', 'in_progress'])
        .whereRaw("payload->>'caller_phone' = ?", [phone])
        .update({
          payload: trx.raw("COALESCE(payload, '{}'::jsonb) || jsonb_build_object('address_request_sms', 'undelivered')"),
          updated_at: now,
        });
      if (row) {
        await trx('sms_log').where({ id: row.id }).update({
          metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('address_request_bounce_handled_at', to_jsonb(now()::text))"),
          updated_at: now,
        }).catch(() => {});
      }
      logger.info(`[dropped-call-sms] Undelivered address request for lead ${claim.lead_id} (${maskPhone(phone)}) — remediated`);
      return { handled: true, leadId: claim.lead_id };
    });
  } catch (e) {
    logger.warn(`[dropped-call-sms] undelivered address-request handling failed: ${e.code || e.name || 'error'}`);
    return { handled: false, reason: 'error' };
  }
}

// Post-insert reconciliation (processor phase 2): a bounce callback can
// land BETWEEN the awaited send and the card insert — its card flip updates
// zero rows, and the fresh card would permanently say 'sent'. After
// inserting the card, the processor asks the claim row (the bounce
// handler's authority) whether the outcome already flipped.
async function sentOutcomeAlreadyUndelivered(rawPhone) {
  try {
    const phone = normalizePhoneE164(rawPhone);
    if (!phone) return false;
    const claim = await db('dropped_call_sms_claims').where({ phone }).first('outcome');
    return claim?.outcome === 'undelivered';
  } catch (e) {
    logger.warn(`[dropped-call-sms] post-insert outcome check failed: ${e.code || e.name || 'db_error'}`);
    return false;
  }
}

module.exports = {
  sendDroppedCallAddressRequest,
  handleUndeliveredAddressRequest,
  sentOutcomeAlreadyUndelivered,
  endedAbruptly,
  detectDroppedMidIntake,
  eligibleNewProspect,
  MIN_CALL_SECONDS,
  _private: { callbackClause, withinSendWindowET, normalizePhoneE164, STRONG_FAREWELL_RE, WEAK_FAREWELL_RE },
};
