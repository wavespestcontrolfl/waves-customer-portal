/**
 * Dropped-call address-request text — texts a NEW prospect whose intake call
 * dropped mid-conversation before the service address was captured, asking
 * for the one field that blocks quoting/scheduling. Owner-directed
 * 2026-08-01 after the Juan case (12-minute engaged rodent call, dropped on
 * the forwarded leg at the exact address-exchange moment; Twilio Insights
 * showed clean quality — a handset/coverage one-off no config change fixes,
 * so this is the backstop).
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

const MESSAGE_TYPE = 'dropped_call_address_request';
const MIN_CALL_SECONDS = 120;
const QUIET_START_HOUR_ET = 8;   // inclusive — sends allowed from 08:00 ET
const QUIET_END_HOUR_ET = 20;    // exclusive — no sends at/after 20:00 ET

// Farewell detection over the transcript tail. A dropped call ends
// mid-thought; a normal call ends with some goodbye/thanks exchange in the
// last few turns. Checked against the LAST THREE turns only — "thanks" said
// mid-conversation must not read as a farewell.
const FAREWELL_RE = new RegExp(
  [
    '\\bbye\\b', 'good-?bye', 'bye-?bye',
    'see (you|ya)\\b', 'talk (to you|soon|later)',
    'have a (good|great|nice|wonderful)',
    'take care', 'sounds good',
    "you're welcome", 'appreciate (it|you)',
    'thank(s| you)',
  ].join('|'),
  'i'
);

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
  return !FAREWELL_RE.test(tail);
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

async function sendDroppedCallAddressRequest({ leadId, extracted = {}, call = {}, phone: rawPhone } = {}) {
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
    return await sendClaimed({ leadId, extracted, call, phone });
  } catch (err) {
    await clearLeadClaim(leadId);
    await releasePhoneClaim(phone);
    throw err;
  }
}

// Runs with the per-phone claim held. Every return path either keeps the
// claim (one-shot consumed) or releases it (config failure).
async function sendClaimed({ leadId, extracted, call, phone }) {
  const claimed = await db('leads')
    .where({ id: leadId })
    .whereRaw("COALESCE(extracted_data->>'dropped_call_sms_status', '') = ''")
    .update({
      extracted_data: db.raw(
        "jsonb_set(COALESCE(extracted_data, '{}'::jsonb), '{dropped_call_sms_status}', to_jsonb('claimed'::text))"
      ),
      updated_at: new Date(),
    });
  if (!claimed) return { sent: false, skipped: 'already_claimed' };

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
    // Policy block (STOP suppression, consent) — consumed on purpose: this
    // number must not be retried by a later drop either.
    await stampStatus(leadId, 'blocked');
    await stampPhoneClaim(phone, 'policy_block');
    logger.info(`[dropped-call-sms] Policy-blocked for ${maskPhone(phone)}: ${result.code || result.reason || 'blocked'}`);
    return { sent: false, skipped: 'policy_block' };
  }

  // Transient provider failure — never consumed: release for a later drop.
  await clearLeadClaim(leadId);
  await releasePhoneClaim(phone);
  logger.warn(`[dropped-call-sms] Provider send failed for ${maskPhone(phone)} (released): ${result.code || result.reason || 'send_failed'}`);
  return { sent: false, skipped: 'provider_failed' };
}

module.exports = {
  sendDroppedCallAddressRequest,
  endedAbruptly,
  MIN_CALL_SECONDS,
  _private: { callbackClause, withinSendWindowET, normalizePhoneE164, FAREWELL_RE },
};
