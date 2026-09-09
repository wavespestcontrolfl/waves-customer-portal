/**
 * Outbound voicemail text-back — when an admin click-to-call (portal Call
 * button → admin cell → press 1 → customer) lands on the CUSTOMER'S
 * voicemail, the customer leg is hung up before a message is left and the
 * customer gets one short "sorry we missed you" text instead.
 *
 * Owner-directed 2026-09-08 after the "did you just call me?" investigation:
 * several callbacks a week were customers who saw a 3–4 second missed call
 * from the main line with no voicemail and no idea why we rang. A text
 * answers that question for them.
 *
 * Detection lives in the voice webhook (/outbound-amd — Twilio answering-
 * machine detection on the dialed <Number>). This module owns the SEND
 * decision, in order:
 *   1. GATE_OUTBOUND_VOICEMAIL_SMS — customer-facing auto-send, fails CLOSED
 *      in every environment until the owner enables it. With the gate off
 *      the webhook never even requests machine detection, so the call flow
 *      is byte-identical to before this lane.
 *   2. Quiet hours — 8am–8pm ET only. Outside the window the customer leg
 *      is NOT hung up either: the admin hears the voicemail greeting and
 *      decides, exactly as before.
 *   3. One text per phone per 24h — an admin who redials the same number
 *      an hour later must not double-text (sms_log probe on message_type).
 *   4. The sendCustomerMessage policy pipeline: suppression (STOP),
 *      consent (transactional — we called about their own service), emoji
 *      fail-closed, line-type, audit log.
 *   5. Template kill switch — outbound_voicemail_missed_you is admin-
 *      editable and is_active-toggleable like every automated template.
 *
 * precheck() runs 1–3 and is called BEFORE the webhook hangs up the customer
 * leg: if the text cannot go, nothing changes for the admin on the call.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { isWithinSendWindowET } = require('./messaging/send-window');
const { isRealProviderSend } = require('./sms-auto-send');
const TWILIO_NUMBERS = require('../config/twilio-numbers');

const MESSAGE_TYPE = 'outbound_voicemail_missed_you';
const GATE = 'outboundVoicemailSms';
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Twilio AnsweredBy values that mean "a machine picked up". With
// machineDetection="Enable" the callback carries machine_start; the
// DetectMessageEnd variants are accepted too so a future mode switch needs
// no code change here. 'human', 'unknown', 'fax' → not voicemail.
function isVoicemailAnsweredBy(answeredBy) {
  return /^machine_/.test(String(answeredBy || '').trim());
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

// Same shape contract as the other text-back lanes: the dedupe probe and the
// pipeline-written sms_log rows must agree on ONE phone shape.
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

// " at (941) 297-5749" from the caller ID the customer just saw, or "" when
// it isn't a displayable 10-digit US number — the template's
// {callback_clause} slot keeps the sentence grammatical either way.
function callbackClause(callerId) {
  const digits = String(callerId || '').replace(/\D/g, '').replace(/^1/, '');
  if (digits.length !== 10) return '';
  return ` at (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * Everything that can be decided WITHOUT sending. Returns { ok: true } or
 * { ok: false, skipped } — the webhook only hangs up the customer leg on ok.
 */
async function precheck({ phone: rawPhone, now = new Date() } = {}) {
  if (!isEnabled(GATE)) return { ok: false, skipped: 'gate_off' };
  const phone = normalizePhoneE164(rawPhone);
  if (!phone) return { ok: false, skipped: 'missing_input' };
  if (!isWithinSendWindowET(now)) return { ok: false, skipped: 'quiet_hours' };

  // Fail closed on a probe failure: a double text is worse than a missed one.
  try {
    const since = new Date(now.getTime() - DEDUPE_WINDOW_MS);
    const prior = await db('sms_log')
      .where({ to_phone: phone, message_type: MESSAGE_TYPE })
      .where('created_at', '>=', since)
      .first('id');
    if (prior) return { ok: false, skipped: 'already_sent_recently' };
  } catch (e) {
    logger.warn(`[outbound-voicemail-sms] sms_log dedupe read failed — skipping (fail closed): ${e.code || e.name || 'db_error'}`);
    return { ok: false, skipped: 'dedupe_read_failed' };
  }
  return { ok: true, phone };
}

/**
 * Send the missed-you text. Callers are expected to have run precheck()
 * first; it is re-run here so a direct call is still safe.
 *
 * @param {object} p
 * @param {string}  p.phone        customer number (any format)
 * @param {string}  [p.customerId] linked customer, when the call had one
 * @param {string}  [p.firstName]  for the greeting; falls back to "there"
 * @param {string}  [p.callLogId]
 * @param {string}  [p.callSid]    the customer-leg CallSid (audit trail)
 * @param {string}  [p.callerId]   the number the customer saw ring
 */
async function sendOutboundVoicemailText({ phone: rawPhone, customerId = null, firstName = '', callLogId = null, callSid = null, callerId = null } = {}) {
  const pre = await precheck({ phone: rawPhone });
  if (!pre.ok) {
    logger.info(`[outbound-voicemail-sms] Skipped (${pre.skipped}) for ${maskPhone(rawPhone)}`);
    return { sent: false, skipped: pre.skipped };
  }
  const phone = pre.phone;

  const body = await renderSmsTemplate(MESSAGE_TYPE, {
    first_name: capitalizeName(firstName) || 'there',
    callback_clause: callbackClause(callerId),
    // Opt-out footer only for numbers we have NO customer record for — a
    // first automated text to a prospect carries the STOP line; an existing
    // customer already receives our transactional texts.
    optout_clause: customerId ? '' : ' Reply STOP to opt out.',
  }, {
    workflow: MESSAGE_TYPE,
    entity_type: customerId ? 'customer' : 'call_log',
    entity_id: customerId || callLogId || null,
  });
  if (!body) {
    logger.info(`[outbound-voicemail-sms] Template ${MESSAGE_TYPE} missing/disabled — text skipped for ${maskPhone(phone)}`);
    return { sent: false, skipped: 'template_disabled' };
  }

  // Reply from the line the customer just saw ring (matches the body's
  // {callback_clause}) — only when it's one of OUR managed numbers and not
  // the AI-assistant toll-free line, whose replies enter the AI chat flow
  // instead of the human comms inbox. Otherwise the location default applies.
  const fromNumber = callerId
    && callerId !== TWILIO_NUMBERS.tollFree?.number
    && TWILIO_NUMBERS.findByNumber(callerId)
    ? callerId : null;

  const result = await sendCustomerMessage({
    to: phone,
    body,
    channel: 'sms',
    audience: customerId ? 'customer' : 'lead',
    purpose: 'missed_call_followup',
    ...(customerId ? { customerId } : {}),
    identityTrustLevel: customerId ? 'phone_matches_customer' : 'phone_provided_unverified',
    consentBasis: { status: 'transactional_allowed', source: 'outbound_voicemail_text_back' },
    entryPoint: 'outbound_voicemail_sms',
    metadata: {
      original_message_type: MESSAGE_TYPE,
      call_sid: callSid || null,
      call_log_id: callLogId || null,
      ...(fromNumber ? { fromNumber } : {}),
    },
  });

  if (result.sent && isRealProviderSend(result)) {
    logger.info(`[outbound-voicemail-sms] Missed-you text sent to ${maskPhone(phone)} (call_log ${callLogId || 'n/a'})`);
    return { sent: true, providerMessageId: result.providerMessageId };
  }
  if (result.sent) {
    // Upstream suppression sentinel — no text actually left the system.
    logger.info(`[outbound-voicemail-sms] Suppression sentinel for ${maskPhone(phone)} (${result.providerMessageId || 'no-id'})`);
    return { sent: false, skipped: 'send_suppressed', code: result.providerMessageId || null };
  }
  if (result.blocked) {
    logger.info(`[outbound-voicemail-sms] Policy-blocked for ${maskPhone(phone)}: ${result.code || result.reason || 'blocked'}`);
    return { sent: false, skipped: 'policy_block', code: result.code || null };
  }
  logger.warn(`[outbound-voicemail-sms] Provider send failed for ${maskPhone(phone)}: ${result.code || result.reason || 'unknown'}`);
  return { sent: false, skipped: 'provider_failed', code: result.code || null };
}

module.exports = {
  MESSAGE_TYPE,
  GATE,
  DEDUPE_WINDOW_MS,
  isVoicemailAnsweredBy,
  precheck,
  sendOutboundVoicemailText,
  _private: { callbackClause, normalizePhoneE164, capitalizeName },
};
