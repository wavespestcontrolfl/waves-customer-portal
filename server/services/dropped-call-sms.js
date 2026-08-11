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
const { readCachedLineType, cacheLineType, lookupLineType, NON_SMS_LINE_TYPES } = require('./messaging/validators/line-type');
const { isWithinSendWindowET } = require('./messaging/send-window');
// sent:true is necessary but not sufficient — upstream suppressions (gate
// off, template disabled, owner kill switch) report sent:true with a
// sentinel providerMessageId and no SMS leaves the system.
const { isRealProviderSend } = require('./sms-auto-send');
const { recordSuppression } = require('./messaging/validators/suppression');
const TWILIO_NUMBERS = require('../config/twilio-numbers');

// A Twilio 21610 is the RECIPIENT's opt-out verdict, not a feature-local
// fact — feed the canonical suppression store so EVERY SMS workflow stops
// texting this number, not just this lane (codex P1). Best-effort: a failed
// write never breaks the calling path (the claim/card verdict still holds
// locally).
async function recordProviderOptOutSuppression(phone, source) {
  try {
    // recordSuppression resolves { ok: false } on a swallowed DB error — it
    // does NOT reject (codex P1) — so the escalation must check the result,
    // not rely on the catch.
    const result = await recordSuppression({ phone, reason: 'opt_out', source });
    if (result?.ok === false) throw Object.assign(new Error('suppression write reported failure'), { code: 'suppression_write_failed' });
  } catch (e) {
    // A failed write here means OTHER workflows may keep texting an
    // opted-out number — that must never fail silently (codex P1). The
    // admin bell is the backstop: the office records the suppression by
    // hand. Notification itself is best-effort too.
    logger.warn(`[dropped-call-sms] global opt-out suppression write FAILED for ${maskPhone(phone)}: ${e.code || e.name || 'db_error'}`);
    try {
      await require('./notification-service').notifyAdmin(
        'system',
        'Opt-out suppression write failed',
        `A Twilio 21610 opt-out for ${maskPhone(phone)} could not be saved to the suppression list (${source}). Add this number to the do-not-text list manually — other SMS workflows cannot see the opt-out until it is recorded.`,
        // bell: true — a compliance backstop must ring even when the bell
        // policy would suppress the 'system' category (codex P1): this alert
        // exists precisely for the case where the canonical suppression
        // write failed and other workflows can still text an opted-out
        // number.
        { bell: true, metadata: { source, error: e.code || e.name || 'db_error' } },
      );
    } catch (notifyErr) {
      logger.error(`[dropped-call-sms] opt-out suppression failure notify also failed: ${notifyErr.code || notifyErr.name || 'error'}`);
    }
  }
}

const MESSAGE_TYPE = 'dropped_call_address_request';
const MIN_CALL_SECONDS = 120;
// A drop text is a SPEED play — "our call just dropped". An old call
// reaching the send path (admin force-reprocess, processAllPending backfill)
// must never text hours or days later (codex P1).
const MAX_CALL_AGE_MS = 24 * 60 * 60 * 1000;

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
    // "see you" only as a closing — "I don't see you in our system" is an
    // OPEN question mid-intake, not a farewell (codex P2).
    "(?<!(?:do|ca)n'?t )see (you|ya)\\b(?! in\\b)", 'talk (to you|soon|later)',
    'have a (good|great|nice|wonderful)',
    'take care(?! of\\b)',
  ].join('|'),
  'i'
);
const WEAK_FAREWELL_RE = new RegExp(
  [
    'sounds good', "you're welcome", 'appreciate (it|you)', 'thank(s| you)',
    // Ordinary closings without a literal goodbye — "No, that's all" is a
    // completed call, not a drop (codex P1).
    "that'?s (all|it)", 'nothing else', "(i'?m|we'?re) (good|all set)", 'all set',
  ].join('|'),
  'i'
);
// POSITIVE drop evidence, tier 1: the final utterance trails off without
// sentence-terminal punctuation (mid-thought cutoff), or tier 2: the tail
// carries connection-trouble language. Absence of a farewell alone is NOT
// enough to call a completed conversation "dropped" (codex P1) — a
// customer-facing "our call dropped" text needs precision over recall.
const CONNECTION_TROUBLE_RE = /can you hear me|are you (there|still there)|hello\?|you cut out|lost you\b|breaking up/i;
function finalTurnTrailsOff(finalTurn) {
  // Strip the speaker label, then require the utterance to END mid-thought:
  // no . ! or ? terminal (a comma, dash, or bare word is cutoff evidence).
  const text = String(finalTurn || '').replace(/^\s*(Agent|Caller)\s*:\s*/i, '').trim();
  if (!text) return false;
  return !/[.!?]["')\]]?$/.test(text);
}

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
function eligibleNewProspect({ customerId, createdCustomerFromCall, isOutbound, v2Status, callNature, doNotContactRequested } = {}) {
  return isOutbound !== true
    && (!customerId || createdCustomerFromCall === true)
    && v2Status === 'valid'
    && callNature === 'new_lead'
    // The caller explicitly asked not to be contacted on the call itself —
    // the transactional consent basis cannot stand against that (codex P1).
    && doNotContactRequested !== true;
}

/**
 * True when the transcript looks like a call that died mid-conversation:
 * enough turns to be a real exchange, and no farewell language anywhere in
 * the last three turns. Deterministic — no model call.
 */
function endedAbruptly(transcription) {
  // Fold diarized continuation lines into their turns (mirrors the
  // processor's speakerTurns contract): a turn starts at a "Speaker:" label
  // and absorbs unlabelled wrap lines — counting physical lines as turns
  // both inflates the turn count and mis-identifies the final utterance
  // (codex P2).
  const turns = [];
  for (const line of String(transcription || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^[A-Za-z][A-Za-z0-9 ]{0,20}:/.test(t)) turns.push(t);
    else if (turns.length) turns[turns.length - 1] += ` ${t}`;
    else turns.push(t);
  }
  if (turns.length < 4) return false; // too short to judge — not "abrupt"
  const tail = turns.slice(-3).join(' ');
  const finalTurn = turns[turns.length - 1];
  if (STRONG_FAREWELL_RE.test(tail)) return false;
  // A weak farewell counts only at the CLOSE of the final utterance and
  // never outranks positive cutoff evidence — "Thanks — now what is your
  // service add" cut mid-word is a drop, not a thank-you ending (codex P2).
  const finalText = String(finalTurn).replace(/^\s*[A-Za-z][A-Za-z0-9 ]{0,20}:\s*/, '').trim();
  const trailsOff = finalTurnTrailsOff(finalTurn);
  if (!trailsOff && WEAK_FAREWELL_RE.test(finalText.slice(-32))) return false;
  return trailsOff || CONNECTION_TROUBLE_RE.test(tail);
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

// Boundary source is the shared customer-SMS window module — this fence
// predates GATE_SMS_SEND_WINDOW and stays live regardless of the gate (the
// gate check lives in the canonical-path validator, not in the bounds), but
// the 8/20 ET hours themselves must have exactly one owner so a future
// hours change can't update one fence and leave the other stale.
function withinSendWindowET(now = new Date()) {
  return isWithinSendWindowET(now);
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

// Success-path variant: transitions ONLY from the in-flight 'claimed' state
// so a bounce verdict that raced in first is never overwritten.
async function stampPhoneClaimIfClaimed(phone, outcome, providerSid = null) {
  try {
    await db('dropped_call_sms_claims').where({ phone, outcome: 'claimed' })
      .update({ outcome, ...(providerSid ? { provider_sid: providerSid } : {}) });
  } catch (e) {
    logger.warn(`[dropped-call-sms] conditional phone claim stamp failed for ${maskPhone(phone)}: ${e.code || e.name || 'db_error'}`);
  }
}

async function stampStatusIfClaimed(leadId, status) {
  try {
    await db('leads').where({ id: leadId })
      .whereRaw("COALESCE(extracted_data->>'dropped_call_sms_status', '') = 'claimed'")
      .update({
        extracted_data: db.raw(
          "jsonb_set(COALESCE(extracted_data, '{}'::jsonb), '{dropped_call_sms_status}', to_jsonb(?::text))",
          [status]
        ),
        updated_at: new Date(),
      });
  } catch (e) {
    logger.warn(`[dropped-call-sms] conditional status stamp failed for lead ${leadId}: ${e.code || e.name || 'db_error'}`);
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

  // Freshness BEFORE any claim: reprocessed/backfilled old calls are
  // card-only. No created_at on the row = can't prove freshness = no text.
  const callAgeMs = call.created_at ? Date.now() - new Date(call.created_at).getTime() : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(callAgeMs) || callAgeMs > MAX_CALL_AGE_MS) {
    logger.info(`[dropped-call-sms] Call too old for a drop text (lead ${leadId}) — skipped`);
    return { sent: false, skipped: 'call_too_old' };
  }

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
      .insert({ phone, lead_id: leadId, outcome: 'claimed', call_log_id: call.id || null })
      .onConflict('phone')
      .ignore()
      .returning('phone');
    phoneClaimed = Array.isArray(inserted) ? inserted.length > 0 : !!inserted;
  } catch (e) {
    logger.warn(`[dropped-call-sms] phone claim insert failed — skipping (fail closed): ${e.code || e.name || 'db_error'}`);
    return { sent: false, skipped: 'claim_insert_failed' };
  }
  if (!phoneClaimed) {
    // Stale in-flight claims: a worker that died between the claim insert
    // and completion leaves outcome='claimed' forever. But a crash can also
    // land AFTER Twilio accepted and before any stamp/log write — whether a
    // text went out is UNKNOWABLE, so re-sending risks a double text and
    // the one-text-per-phone-EVER contract wins over delivery (codex P1):
    // the stale row is consumed as dispatch_unknown, never re-claimed for a
    // fresh send. This still un-wedges the state machine (the row leaves
    // 'claimed', so bounce handling and reporting see a terminal outcome).
    try {
      const consumed = await db('dropped_call_sms_claims')
        .where({ phone, outcome: 'claimed' })
        .where('created_at', '<', new Date(Date.now() - 60 * 60 * 1000))
        .update({ outcome: 'dispatch_unknown' });
      if (consumed) logger.info(`[dropped-call-sms] Stale in-flight claim for ${maskPhone(phone)} consumed as dispatch_unknown`);
    } catch (e) {
      logger.warn(`[dropped-call-sms] stale claim consume failed: ${e.code || e.name || 'db_error'}`);
    }
    return { sent: false, skipped: 'already_sent_to_phone' };
  }

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
    // The address must STILL be missing at claim time — a concurrent call or
    // an operator can populate leads.address between detection and this
    // dispatch, and texting for information already on file is the exact
    // noise this lane must never make (codex P1). Atomic with the claim.
    .where(function addressStillMissing() {
      this.whereNull('address').orWhere('address', '');
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
    if (NON_SMS_LINE_TYPES.has(lineType)) {
      if (lineType === 'landline') {
        await stampStatus(leadId, 'blocked');
        await stampPhoneClaim(phone, 'landline'); // keep — a landline stays a landline
      } else {
        // fixedVoip is a REVERSIBLE block (LINETYPE_BLOCK_FIXED_VOIP): no text
        // was sent, so releasing BOTH claims keeps the one-text-per-phone
        // invariant while letting a future call event re-evaluate under the
        // then-current set. A 'blocked' lead stamp would wedge the reused open
        // lead row at the claim predicate; the activity note is the audit
        // trail instead.
        await clearLeadClaim(leadId);
        await releasePhoneClaim(phone);
      }
      await logActivity(leadId, 'note', `Dropped-call address text skipped — caller number is a ${lineType}`, {
        message_type: MESSAGE_TYPE,
        reason: lineType,
      });
      logger.info(`[dropped-call-sms] Skipping ${maskPhone(phone)} — ${lineType}`);
      return { sent: false, skipped: lineType };
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

  // Final ownership + address recheck IMMEDIATELY before dispatch: the
  // line-type, template, and policy awaits above leave a window where
  // another flow can reassign the reusable lead or capture the address
  // (codex P1). A changed lead releases both claims and skips.
  const leadNow = await db('leads').where({ id: leadId }).first('customer_id', 'address');
  const ownershipStillOk = !!leadNow
    && (expectedCustomerId ? (!leadNow.customer_id || String(leadNow.customer_id) === String(expectedCustomerId)) : !leadNow.customer_id);
  const addressStillMissing = !!leadNow && !String(leadNow.address || '').trim();
  if (!ownershipStillOk || !addressStillMissing) {
    await clearLeadClaim(leadId);
    await releasePhoneClaim(phone);
    logger.info(`[dropped-call-sms] Pre-dispatch recheck failed for lead ${leadId} (${!ownershipStillOk ? 'ownership changed' : 'address now on file'}) — released, not sent`);
    return { sent: false, skipped: !ownershipStillOk ? 'lead_ownership_changed' : 'address_now_on_file' };
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
      // Reply from the line the prospect just dialed (matches the
      // {callback_clause} in the body); only when it's one of OUR managed
      // numbers AND not the AI-assistant toll-free line — a reply to that
      // line enters the AI chat flow instead of the human comms inbox
      // (codex P1). Otherwise the location-aware default applies.
      ...(call.to_phone
        && call.to_phone !== TWILIO_NUMBERS.tollFree?.number
        && TWILIO_NUMBERS.findByNumber(call.to_phone)
        ? { fromNumber: call.to_phone } : {}),
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
    // Conditional 'sent' stamps: a fast delivery callback can land BEFORE
    // these run and stamp 'undelivered'/'opted_out' from the in-flight
    // 'claimed' state — the sender must never overwrite that verdict.
    await stampStatusIfClaimed(leadId, 'sent');
    await stampPhoneClaimIfClaimed(phone, 'sent', result.providerMessageId || null);
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

  // KNOWN pre-dispatch blocks (the outbound sms-guard rejecting a bad
  // template render, or a provider-level feature gate) never reached
  // Twilio — nothing ambiguous about them. Release the one-shot so a later
  // drop can text once the copy/config is fixed (codex P2). Detection is by
  // the classifier's reason string — the only surface the shared pipeline
  // exposes for these.
  if (/guard blocked|gate blocked/i.test(String(result.reason || ''))) {
    await clearLeadClaim(leadId);
    await releasePhoneClaim(phone);
    logger.warn(`[dropped-call-sms] Pre-dispatch block for ${maskPhone(phone)} (released): ${result.reason}`);
    return { sent: false, skipped: 'pre_dispatch_block', code: result.code || null };
  }
  if (result.terminal) {
    // Synchronous terminal Twilio rejection — the number will never accept
    // this text; keep the one-shot so a later drop doesn't retry it. The
    // meaningful value is providerErrorCode (result.code is the generic
    // PROVIDER_FAILURE): 21610 = recipient unsubscribed, an OPT-OUT the card
    // must render as do-not-contact, never "call them back"; 21614/invalid
    // destination = not SMS-capable, still callable.
    const providerCode = String(result.providerErrorCode || result.code || 'terminal');
    // SENDER-side terminal codes (21606: configured From cannot send;
    // 21608: trial-account destination restriction) are OUR config problem,
    // not the recipient's — fixing the sender makes a later send viable, so
    // the recipient's one-shot must not be consumed (codex P2).
    if (providerCode === '21606' || providerCode === '21608') {
      await clearLeadClaim(leadId);
      await releasePhoneClaim(phone);
      logger.warn(`[dropped-call-sms] Sender-side terminal rejection for ${maskPhone(phone)} (released): ${providerCode}`);
      return { sent: false, skipped: 'sender_config_terminal', code: providerCode };
    }
    const optedOut = providerCode === '21610';
    if (optedOut) await recordProviderOptOutSuppression(phone, 'dropped_call_sms_21610');
    await stampStatus(leadId, 'blocked');
    await stampPhoneClaim(phone, optedOut ? 'opted_out' : 'provider_terminal');
    logger.info(`[dropped-call-sms] Terminal provider rejection for ${maskPhone(phone)}: ${providerCode}`);
    return {
      sent: false,
      skipped: optedOut ? 'policy_block' : 'provider_terminal',
      code: optedOut ? 'SUPPRESSED_PROVIDER_OPT_OUT_21610' : providerCode,
    };
  }
  // Twilio 20429 (rate limit) rejects messages.create outright — no SID was
  // minted, nothing was accepted, nothing ambiguous (codex P2): release for
  // a later drop.
  if (String(result.providerErrorCode || '') === '20429') {
    await clearLeadClaim(leadId);
    await releasePhoneClaim(phone);
    logger.warn(`[dropped-call-sms] Rate-limited pre-accept for ${maskPhone(phone)} (released)`);
    return { sent: false, skipped: 'provider_rate_limited' };
  }
  // Provider failure with AMBIGUOUS acceptance (a timeout/network error can
  // fire after Twilio accepted the message but before the SID response
  // arrived) — releasing here could let a later drop send a SECOND text,
  // violating one-text-per-phone-EVER (codex P1). The contract wins over
  // delivery: keep the one-shot, stamped dispatch_unknown; the card still
  // tells the office to call.
  await stampStatus(leadId, 'blocked');
  await stampPhoneClaim(phone, 'dispatch_unknown');
  logger.warn(`[dropped-call-sms] Provider send failed for ${maskPhone(phone)} (one-shot kept, dispatch_unknown): ${result.code || result.reason || 'send_failed'}`);
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
const BOUNCE_RETRY_DELAY_MS = 90 * 1000;

async function handleUndeliveredAddressRequest({ sid, status, errorCode, to, isRetry = false } = {}) {
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
      const claim = await trx('dropped_call_sms_claims').where({ phone }).first('lead_id', 'outcome', 'provider_sid', 'call_log_id');
      if (!claim || !claim.lead_id) return { handled: false, reason: 'no_claim_lead' };
      // Without a SID-bound sms_log row, the ONLY safe correlation is the
      // provider SID stamped on the claim at send time — /status dispatches
      // this handler for EVERY failed outbound SMS, and phone-plus-recency
      // would let another message's bounce (whose own sms_log insert also
      // raced) mutate this claim's lead and card (codex P1). No stored SID
      // (the callback beat the sent-stamp too) → refuse; the row-present
      // path and the processor's post-insert reconcile cover that window.
      if (!row && claim.provider_sid !== sid) {
        return { handled: false, reason: 'no_log_row_and_sid_mismatch' };
      }
      // (A callback that beats BOTH correlation writes — no sms_log row AND
      // no provider_sid yet — reaches the mismatch return above; the caller
      // schedules one delayed retry for that sub-second window.)
      // Atomic idempotency gate: exactly one callback (Twilio retries them)
      // flips 'sent' -> 'undelivered'; every later one sees 0 rows.
      // Wins from BOTH states: 'sent' (normal) and 'claimed' (the callback
      // raced in after Twilio accepted but before the sender's own stamp —
      // a carrier bounce implies the send happened). The sender's stamp is
      // conditional on 'claimed', so it can never overwrite this verdict.
      const flipped = await trx('dropped_call_sms_claims')
        .where({ phone })
        .whereIn('outcome', ['sent', 'claimed'])
        .update({ outcome: String(errorCode || '') === '21610' ? 'opted_out' : 'undelivered' });
      if (!flipped) return { handled: false, reason: 'already_handled_or_not_sent' };

      const lead = await trx('leads')
        .where('id', claim.lead_id)
        .where('status', 'new')
        .whereNull('deleted_at')
        .first('id');

      const now = new Date();
      // A DELAYED opt-out (21610 on the delivery callback) is the same
      // do-not-contact verdict as a synchronous one — the card and note must
      // never instruct a callback for it, and the follow-up pull below must
      // NOT queue outreach for it (codex P1).
      const optedOut = String(errorCode || '') === '21610';
      if (optedOut) await recordProviderOptOutSuppression(phone, 'dropped_call_sms_bounce_21610');
      if (lead) {
        if (!optedOut) {
          await trx('leads')
            .where({ id: lead.id })
            .where(function followUpMissingOrLater() {
              this.whereNull('next_follow_up_at').orWhere('next_follow_up_at', '>', now);
            })
            .update({ next_follow_up_at: now, updated_at: now });
        }
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
          description: optedOut
            ? `Dropped-call address request rejected (error 21610 — recipient has opted out of SMS). Do NOT text this number; check contact preferences before any outreach.`
            : `Dropped-call address request never arrived (${codeText}). Call the prospect instead.`,
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
      // Scoped to the claim's originating call: a repeat dropped call can
      // have its own card on the same phone (outcome already_sent_to_phone)
      // and a delayed bounce for the FIRST message must not rewrite it
      // (codex P1). Claims from before the column existed fall back to the
      // phone match.
      let cardQuery = trx('triage_items')
        .where({ reason_code: 'call_dropped_mid_intake' })
        .whereIn('status', ['open', 'in_progress']);
      if (claim.call_log_id) cardQuery = cardQuery.where({ call_log_id: claim.call_log_id });
      else cardQuery = cardQuery.whereRaw("payload->>'caller_phone' = ?", [phone]);
      await cardQuery
        .update({
          payload: optedOut
            ? trx.raw("COALESCE(payload, '{}'::jsonb) || jsonb_build_object('address_request_sms', 'undelivered', 'address_request_sms_code', 'SUPPRESSED_PROVIDER_OPT_OUT_21610')")
            : trx.raw("COALESCE(payload, '{}'::jsonb) || jsonb_build_object('address_request_sms', 'undelivered')"),
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

// One bounded in-process retry for the sub-second window where the carrier
// callback beats BOTH correlation writes (sms_log insert AND provider_sid
// stamp): /status has already answered 200 so Twilio will not retry, and a
// refused-once bounce would leave the card permanently 'sent'. Best-effort
// by design (lost on process restart — the window it covers is
// milliseconds wide and double-covered by the processor's post-insert
// reconcile for the card-insert leg).
async function handleUndeliveredAddressRequestWithRetry(args = {}) {
  const first = await handleUndeliveredAddressRequest(args);
  if (first.handled || !['no_log_row_and_sid_mismatch', 'already_handled_or_not_sent', 'no_claim_lead', 'error'].includes(first.reason)) {
    return first;
  }
  setTimeout(() => {
    handleUndeliveredAddressRequest({ ...args, isRetry: true })
      .then((second) => {
        if (second.handled) logger.info('[dropped-call-sms] delayed bounce retry remediated after correlation race');
      })
      .catch((e) => logger.warn(`[dropped-call-sms] delayed bounce retry failed: ${e.code || e.name || 'error'}`));
  }, BOUNCE_RETRY_DELAY_MS);
  return first;
}

// Post-insert reconciliation (processor phase 2): a bounce callback can
// land BETWEEN the awaited send and the card insert — its card flip updates
// zero rows, and the fresh card would permanently say 'sent'. After
// inserting the card, the processor asks the claim row (the bounce
// handler's authority) for a terminal bounce verdict: 'undelivered' OR
// 'opted_out' (a delayed 21610 must carry its do-not-contact code onto the
// fresh card, never an outreach instruction).
async function terminalBounceOutcome(rawPhone) {
  try {
    const phone = normalizePhoneE164(rawPhone);
    if (!phone) return null;
    const claim = await db('dropped_call_sms_claims').where({ phone }).first('outcome', 'call_log_id');
    if (claim?.outcome === 'undelivered' || claim?.outcome === 'opted_out') {
      return { outcome: claim.outcome, callLogId: claim.call_log_id || null };
    }
    return null;
  } catch (e) {
    logger.warn(`[dropped-call-sms] post-insert outcome check failed: ${e.code || e.name || 'db_error'}`);
    return null;
  }
}

module.exports = {
  sendDroppedCallAddressRequest,
  handleUndeliveredAddressRequest,
  handleUndeliveredAddressRequestWithRetry,
  terminalBounceOutcome,
  endedAbruptly,
  detectDroppedMidIntake,
  eligibleNewProspect,
  MIN_CALL_SECONDS,
  _private: { callbackClause, withinSendWindowET, normalizePhoneE164, STRONG_FAREWELL_RE, WEAK_FAREWELL_RE },
};
