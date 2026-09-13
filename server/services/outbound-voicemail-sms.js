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
 *   3. Not while a technician is en route to / on site at the customer
 *      (the audit showed those calls are about access, right after the
 *      en-route + arrived texts), and not when the call being returned was
 *      a non-service contact (van complaint, solicitor, applicant, wrong
 *      number — owner ruling 2026-09-09).
 *   4. One text per phone per 24h — an admin who redials the same number
 *      an hour later must not double-text: an atomic sms_send_claims row
 *      (the same cross-process gate tech-line / estimate-public use) taken
 *      right before the send, released when nothing left; the sms_log probe
 *      stays as a cheap early exit.
 *   5. The sendCustomerMessage policy pipeline: suppression (STOP),
 *      consent (transactional — we called about their own service), emoji
 *      fail-closed, line-type, audit log.
 *   6. Reason → template (services/outbound-call-reason.js decides WHY we
 *      called: quote request / returning your call / saw your text /
 *      generic). Each template is admin-editable and is_active-toggleable;
 *      a disabled reason template falls back to the generic one, and a
 *      disabled generic template is the lane's kill switch.
 *   7. Never to a staff phone (the bridge's admin leg).
 *
 * Ordering contract with the webhook: the TEXT IS SENT FIRST and the
 * customer leg is hung up only on a real provider send (codex #4195 r1 P1 —
 * a disabled template or a policy block used to be discovered after the
 * hangup, with the admin told a text was going). AMD reports ~3–4 s into the
 * greeting and the send takes ~1–2 s, so the hangup still lands before the
 * beep on ordinary greetings; on a very short greeting a blank voicemail is
 * the worst case.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { isWithinSendWindowET } = require('./messaging/send-window');
const { isRealProviderSend, isAmbiguousProviderOutcome } = require('./sms-auto-send');
const TWILIO_NUMBERS = require('../config/twilio-numbers');

const { REASONS, visitInProgress, nonServiceCaller } = require('./outbound-call-reason');

const CLAIM_PREFIX = 'outbound_voicemail:';
const CLAIM_WINDOW = '24 hours';
// The four lane templates share one placeholder contract; the write-time
// guard (admin-sms-templates REQUIRED_TEMPLATE_PLACEHOLDERS) and this
// render-time check read the same list.
const REQUIRED_VARS = ['first_name', 'callback_clause', 'optout_clause'];

// One message_type for the whole lane (dedupe + sms_log history), one
// template per reason the resolver can honestly name. A deactivated reason
// template falls back to the generic one; a deactivated generic template is
// the lane's kill switch.
const MESSAGE_TYPE = 'outbound_voicemail_missed_you';
const GENERIC_TEMPLATE_KEY = 'outbound_voicemail_missed_you';
const REASON_TEMPLATE_KEYS = Object.freeze({
  [REASONS.QUOTE_REQUEST]: 'outbound_voicemail_quote_request',
  [REASONS.RETURNING_CALL]: 'outbound_voicemail_returning_call',
  [REASONS.SAW_TEXT]: 'outbound_voicemail_saw_text',
  [REASONS.GENERIC]: GENERIC_TEMPLATE_KEY,
});
const GATE = 'outboundVoicemailSms';
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

// The press-1 bridge dials the ADMIN first; on the auto-bridge rows
// call_log.to_phone is the admin cell. Reuse the number registry's staff
// and owned-line guard; retain the legacy bridge's default cell exclusion.
function isAdminPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '').slice(-10);
  return d === '9415993489' || TWILIO_NUMBERS.isInternalNumber(phone);
}

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

// Records created from a call or text with no name carry placeholders — the
// replay over real calls rendered "Hi Unknown". Those greet as "Hi there".
const PLACEHOLDER_NAMES = new Set(['unknown', 'unknown caller', 'n/a', 'na', 'none', 'customer', 'caller', 'test', '-', '?']);
function capitalizeName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  if (PLACEHOLDER_NAMES.has(trimmed.toLowerCase()) || !/[a-z]/i.test(trimmed)) return '';
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
 * { ok: false, skipped }. Passing this check still requires a real provider
 * send before the webhook can hang up the customer leg.
 */
async function precheck({ phone: rawPhone, customerId = null, relatedCallId = null, now = new Date() } = {}) {
  if (!isEnabled(GATE)) return { ok: false, skipped: 'gate_off' };
  const phone = normalizePhoneE164(rawPhone);
  if (!phone) return { ok: false, skipped: 'missing_input' };
  if (isAdminPhone(phone)) return { ok: false, skipped: 'admin_phone' };
  if (!isWithinSendWindowET(now)) return { ok: false, skipped: 'quiet_hours' };

  // The technician is at (or heading to) this customer's door: the call is
  // about access/address, the en-route + arrived texts just went out, and
  // any "why we called" text would be wrong. Fail closed on a probe error.
  try {
    if (await visitInProgress({ customerId, phone, before: now })) return { ok: false, skipped: 'visit_in_progress' };
    // The call being returned was not a service contact (a complaint about a
    // van, a solicitor, a job applicant, a wrong number): no text at all.
    if (await nonServiceCaller({ customerId, phone, relatedCallId, before: now })) return { ok: false, skipped: 'non_service_caller' };
  } catch (e) {
    logger.warn(`[outbound-voicemail-sms] context probe failed — skipping (fail closed): ${e.code || e.name || 'db_error'}`);
    return { ok: false, skipped: 'visit_probe_failed' };
  }

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

async function renderForReason(reason, vars, context) {
  const key = REASON_TEMPLATE_KEYS[reason] || GENERIC_TEMPLATE_KEY;
  const opts = { requiredVars: REQUIRED_VARS };
  let body = await renderSmsTemplate(key, vars, context, opts);
  let templateKey = key;
  if (!body && key !== GENERIC_TEMPLATE_KEY) {
    // Reason template missing/disabled → the generic copy is always true.
    body = await renderSmsTemplate(GENERIC_TEMPLATE_KEY, vars, context, opts);
    templateKey = GENERIC_TEMPLATE_KEY;
  }
  return { body, templateKey };
}

// Atomic per-phone claim: a fresh insert, or a takeover of a claim older than
// the window, in ONE statement (the pattern tech-line.js / estimate-public.js
// use on the same table — no advisory-lock transaction on the pool).
async function claimSend(phone) {
  const claim = await db.raw(
    `INSERT INTO sms_send_claims (claim_key) VALUES (?)
     ON CONFLICT (claim_key) DO UPDATE SET created_at = NOW()
     WHERE sms_send_claims.created_at < NOW() - interval '${CLAIM_WINDOW}'
     RETURNING id`,
    [CLAIM_PREFIX + phone],
  );
  return (claim?.rows || []).length > 0;
}
function releaseClaim(phone) {
  return db('sms_send_claims').where({ claim_key: CLAIM_PREFIX + phone }).del()
    .catch((err) => logger.warn(`[outbound-voicemail-sms] claim release failed for ${maskPhone(phone)} (${err?.code || err?.name || 'error'})`));
}
// An explicit uncertain provider outcome keeps the claim held because the
// provider may still hold the text. Legacy providers fall back to their
// retryable/deferred flags (tech-line rule).

// Fold a sendCustomerMessage result into this lane's outcome shape.
function classifyOutcome(result, { phone, reason, templateKey, callLogId }) {
  if (result.sent && isRealProviderSend(result)) {
    logger.info(`[outbound-voicemail-sms] Missed-you text (${reason}) sent to ${maskPhone(phone)} (call_log ${callLogId || 'n/a'})`);
    return { sent: true, providerMessageId: result.providerMessageId, reason, templateKey };
  }
  if (result.sent) {
    // Upstream suppression sentinel — no text actually left the system.
    logger.info(`[outbound-voicemail-sms] Suppression sentinel for ${maskPhone(phone)} (${result.providerMessageId || 'no-id'})`);
    return { sent: false, skipped: 'send_suppressed', code: result.providerMessageId || null, reason };
  }
  if (result.blocked) {
    logger.info(`[outbound-voicemail-sms] Policy-blocked for ${maskPhone(phone)}: ${result.code || result.reason || 'blocked'}`);
    return { sent: false, skipped: 'policy_block', code: result.code || null, reason };
  }
  logger.warn(`[outbound-voicemail-sms] Provider send failed for ${maskPhone(phone)}: ${result.code || result.reason || 'unknown'}`);
  return { sent: false, skipped: 'provider_failed', code: result.code || null, reason, ambiguous: isAmbiguousProviderOutcome(result) };
}

/**
 * Send the missed-you text. Runs precheck() itself, then takes the atomic
 * per-phone claim, renders, sends, and releases the claim when nothing left.
 *
 * @param {object} p
 * @param {string}  p.phone          customer number (any format)
 * @param {string}  [p.customerId]   linked customer, when the call had one
 * @param {string}  [p.firstName]    for the greeting; falls back to "there"
 * @param {string}  [p.callLogId]
 * @param {string}  [p.callSid]      the customer-leg CallSid (audit trail)
 * @param {string}  [p.callerId]     the number the customer saw ring
 * @param {string}  [p.reason]       a REASONS value from outbound-call-reason.js (default generic)
 * @param {string}  [p.relatedCallId] the inbound call a call-log callback is returning
 */
async function sendOutboundVoicemailText({ phone: rawPhone, customerId = null, firstName = '', callLogId = null, callSid = null, callerId = null, reason = REASONS.GENERIC, relatedCallId = null } = {}) {
  // Tech lines share the press-1 bridge, but never originate automated texts.
  // Recheck here for AMD callbacks that were issued before the dial guard.
  if (TWILIO_NUMBERS.isTechLine(normalizePhoneE164(callerId))) return { sent: false, skipped: 'tech_line', reason };
  const pre = await precheck({ phone: rawPhone, customerId, relatedCallId });
  if (!pre.ok) {
    logger.info(`[outbound-voicemail-sms] Skipped (${pre.skipped}) for ${maskPhone(rawPhone)}`);
    return { sent: false, skipped: pre.skipped, reason };
  }
  const phone = pre.phone;

  const claim = await acquireClaim(phone);
  if (claim.skipped) return { sent: false, skipped: claim.skipped, reason };

  const { body, templateKey } = await renderForReason(reason, {
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
    await releaseClaim(phone);
    logger.info(`[outbound-voicemail-sms] Template ${GENERIC_TEMPLATE_KEY} missing/disabled — text skipped for ${maskPhone(phone)}`);
    return { sent: false, skipped: 'template_disabled', reason };
  }

  const result = await sendCustomerMessage(buildSendInput({ phone, body, customerId, callerId, callSid, callLogId, reason, templateKey })).catch(async (err) => {
    // The pipeline carries Twilio's known result when the final audit write
    // fails. A real acceptance still owns the claim and permits the hangup;
    // never invite a second message just because its audit could not save.
    if (isRealProviderSend(err?.providerOutcome)) {
      logger.error(`[outbound-voicemail-sms] Text accepted but audit write failed (${err.code || err.name || 'error'}) for call_log ${callLogId || 'n/a'}`);
      return err.providerOutcome;
    }
    if (isAmbiguousProviderOutcome(err?.providerOutcome)) return err.providerOutcome;
    await releaseClaim(phone);
    throw err;
  });
  const outcome = classifyOutcome(result, { phone, reason, templateKey, callLogId });
  if (!outcome.sent && !outcome.ambiguous) await releaseClaim(phone);
  return outcome;
}

async function acquireClaim(phone) {
  try {
    return (await claimSend(phone)) ? { ok: true } : { skipped: 'already_sent_recently' };
  } catch (e) {
    logger.warn(`[outbound-voicemail-sms] send claim failed — skipping (fail closed): ${e.code || e.name || 'db_error'}`);
    return { skipped: 'claim_failed' };
  }
}

// Reply from the line the customer just saw ring (matches the body's
// {callback_clause}) — only when it's one of OUR managed numbers and not the
// AI-assistant toll-free line, whose replies enter the AI chat flow instead
// of the human comms inbox. Otherwise the location default applies.
function replyFromNumber(callerId) {
  return callerId
    && callerId !== TWILIO_NUMBERS.tollFree?.number
    && TWILIO_NUMBERS.findByNumber(callerId)
    ? callerId : null;
}

function buildSendInput({ phone, body, customerId, callerId, callSid, callLogId, reason, templateKey }) {
  const fromNumber = replyFromNumber(callerId);
  return {
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
      call_reason: reason,
      template_key: templateKey,
      ...(fromNumber ? { fromNumber } : {}),
    },
  };
}

module.exports = {
  MESSAGE_TYPE,
  GENERIC_TEMPLATE_KEY,
  REASON_TEMPLATE_KEYS,
  GATE,
  DEDUPE_WINDOW_MS,
  isVoicemailAnsweredBy,
  isAdminPhone,
  precheck,
  sendOutboundVoicemailText,
  CLAIM_PREFIX,
  CLAIM_WINDOW,
  _private: { callbackClause, normalizePhoneE164, capitalizeName, renderForReason, classifyOutcome, claimSend, releaseClaim },
};
