/**
 * send_customer_message — the canonical send path for every customer/lead-
 * facing outbound message. Internal sends (BI briefing) flow through the
 * same wrapper with audience: 'internal'.
 *
 * This module is the application-side enforcement layer. It is NOT a
 * compliance/legal solution by itself — carrier registration (A2P 10DLC),
 * consent-copy wording, privacy-policy language, and legal review remain
 * separate. What this layer guarantees:
 *
 *   1. No customer/lead-facing SMS bypasses the policy chain.
 *   2. Suppression is checked before every customer/lead send.
 *   3. Customer-facing emoji and exact-price leaks fail closed.
 *   4. Sensitive purposes (payment_link, billing) require identity context.
 *   5. Segment count is computed, logged, and enforced.
 *   6. Internal BI keeps its emoji/3-segment behavior via audience='internal'.
 *   7. Every send attempt — sent OR blocked — is recorded in the audit log.
 *
 * Validator chain order (deterministic):
 *
 *   normalize_recipient
 *   require_input_ids                  — required IDs present per policy
 *   load_contact_state                 — pull notification_prefs + customer
 *   load_suppression_state             — pull active suppression record
 *   check_suppression                  — STOP/wrong-number list
 *   check_consent_for_purpose          — sms_enabled + per-purpose flag/marketing
 *   validate_identity_trust            — identityTrustLevel >= policy.minIdentityTrust
 *   validate_no_customer_emoji         — fail closed when audience in [customer, lead]
 *   validate_no_price_leak             — fail closed when audience in [customer, lead]
 *   validate_segment_count             — GSM-7/UCS-2 aware
 *   persist_audit_log                  — every attempt, blocked or sent
 *   send_via_provider                  — twilio for sms; email/portal_chat in follow-up
 *   persist_delivery_attempt           — fold provider outcome into audit row
 *
 * Each validator returns { ok: true } | { ok: false, code, reason }. The
 * wrapper stops at the first non-ok result, persists an audit row marked
 * blocked, and returns without invoking the provider.
 *
 * @typedef {import('./policy').SendCustomerMessageInput} SendCustomerMessageInput
 */

const logger = require('../logger');
const policyModule = require('./policy');
const { loadContactState, checkConsentForPurpose } = require('./validators/consent');
const { loadSuppressionState, checkSuppression } = require('./validators/suppression');
const { validateRequiredIds, validateIdentityTrust, resolveTrustLevel } = require('./validators/identity');
const { validateNoCustomerEmoji, validateNoPriceLeak } = require('./validators/voice');
const { validateSegmentCount, countSegments } = require('./segment-counter');
const { persistAudit } = require('./audit');
const { sendViaTwilio } = require('./providers/twilio-sms');

/**
 * Normalize a phone string to E.164 (best-effort). Mirrors the existing
 * twilio.js normalizePhone — kept private here so the wrapper doesn't
 * depend on a non-exported twilio.js helper.
 */
function normalizeRecipient(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (trimmed.startsWith('+')) return trimmed;
  // Fall back to the input if we can't confidently normalize — twilio
  // will reject malformed numbers downstream and we'll log the failure.
  return trimmed;
}

/**
 * @param {SendCustomerMessageInput} input
 * @returns {Promise<{
 *   sent: boolean,
 *   blocked: boolean,
 *   reason?: string,
 *   code?: string,
 *   providerMessageId?: string,
 *   auditLogId?: string | null,
 *   segmentCount?: number,
 *   encoding?: 'GSM_7' | 'UCS_2',
 * }>}
 */
async function sendCustomerMessage(input) {
  // 1. Contract validation
  const contractCheck = validateContract(input);
  if (!contractCheck.ok) {
    logger.warn(`[send_customer_message] contract violation: ${contractCheck.reason}`);
    return { sent: false, blocked: true, code: 'CONTRACT_VIOLATION', reason: contractCheck.reason };
  }

  // 2. Resolve policy
  let policy;
  try {
    policy = policyModule.resolvePolicy(input.audience, input.purpose);
  } catch (err) {
    logger.warn(`[send_customer_message] unknown policy: ${err.message}`);
    return { sent: false, blocked: true, code: 'UNKNOWN_POLICY', reason: err.message };
  }

  // 3. Normalize recipient + clone input so downstream sees the canonical form
  const normalizedTo = normalizeRecipient(input.to);
  const sendInput = { ...input, to: normalizedTo };

  // 4. Load contact state once (consent + suppression share the lookup)
  let contactState = await loadContactState(sendInput);
  contactState = await loadSuppressionState(sendInput, contactState);

  // 5. Run validator pipeline. Each entry is { name, fn }; fn is invoked
  //    with (input, policy, contactState).
  const segmentMeta = countSegments(sendInput.body || '');
  const pipeline = [
    { name: 'require_input_ids',          fn: () => validateRequiredIds(sendInput, policy) },
    { name: 'check_suppression',          fn: () => checkSuppression(sendInput, policy, contactState) },
    { name: 'check_consent_for_purpose',  fn: () => checkConsentForPurpose(sendInput, policy, contactState) },
    { name: 'validate_identity_trust',    fn: () => validateIdentityTrust(sendInput, policy, contactState) },
    { name: 'validate_no_customer_emoji', fn: () => validateNoCustomerEmoji(sendInput, policy) },
    { name: 'validate_no_price_leak',     fn: () => validateNoPriceLeak(sendInput, policy) },
    { name: 'validate_segment_count',     fn: () => validateSegmentCount(sendInput, policy) },
  ];

  const validatorsPassed = [];
  let blockedBy = null;

  for (const step of pipeline) {
    const result = await step.fn();
    if (result && result.ok) {
      validatorsPassed.push(step.name);
    } else {
      blockedBy = { code: result.code, reason: result.reason, validator: step.name };
      break;
    }
  }

  const resolvedTrust = resolveTrustLevel(sendInput, contactState);

  // 6. If anything blocked, persist audit + return
  if (blockedBy) {
    const audit = await persistAudit({
      input: sendInput,
      policy,
      segmentMeta,
      validatorsPassed,
      validatorsFailed: [blockedBy.validator],
      blockedBy: { code: blockedBy.code, reason: blockedBy.reason },
      identityTrust: resolvedTrust,
      providerOutcome: null,
    });
    return {
      sent: false,
      blocked: true,
      code: blockedBy.code,
      reason: blockedBy.reason,
      auditLogId: audit.id,
      segmentCount: segmentMeta.segmentCount,
      encoding: segmentMeta.encoding,
    };
  }

  // 7. Dispatch to provider
  const providerOutcome = await dispatchToProvider(sendInput);

  // 8. Persist final audit row with provider outcome
  const audit = await persistAudit({
    input: sendInput,
    policy,
    segmentMeta,
    validatorsPassed,
    validatorsFailed: [],
    blockedBy: providerOutcome.sent ? null : { code: 'PROVIDER_FAILURE', reason: providerOutcome.error || 'unknown' },
    identityTrust: resolvedTrust,
    providerOutcome,
  });

  if (!providerOutcome.sent) {
    return {
      sent: false,
      blocked: false,
      code: 'PROVIDER_FAILURE',
      reason: providerOutcome.error || 'provider returned no message id',
      auditLogId: audit.id,
      segmentCount: segmentMeta.segmentCount,
      encoding: segmentMeta.encoding,
    };
  }

  return {
    sent: true,
    blocked: false,
    providerMessageId: providerOutcome.providerMessageId,
    auditLogId: audit.id,
    segmentCount: segmentMeta.segmentCount,
    encoding: segmentMeta.encoding,
  };
}

function validateContract(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: 'input must be an object' };
  }
  if (!input.to || typeof input.to !== 'string') {
    return { ok: false, reason: 'to (recipient) is required' };
  }
  const hasMedia = Array.isArray(input.metadata?.mediaUrls) && input.metadata.mediaUrls.length > 0;
  if (typeof input.body !== 'string') {
    return { ok: false, reason: 'body is required' };
  }
  if (!input.body.trim() && !hasMedia) {
    return { ok: false, reason: 'body or media is required' };
  }
  if (!policyModule.MESSAGE_CHANNELS.includes(input.channel)) {
    return { ok: false, reason: `channel must be one of: ${policyModule.MESSAGE_CHANNELS.join(', ')}` };
  }
  if (!policyModule.MESSAGE_AUDIENCES.includes(input.audience)) {
    return { ok: false, reason: `audience must be one of: ${policyModule.MESSAGE_AUDIENCES.join(', ')}` };
  }
  if (!policyModule.MESSAGE_PURPOSES.includes(input.purpose)) {
    return { ok: false, reason: `purpose must be one of: ${policyModule.MESSAGE_PURPOSES.join(', ')}` };
  }
  if (
    input.identityTrustLevel != null &&
    !policyModule.IDENTITY_TRUST_LEVELS.includes(input.identityTrustLevel)
  ) {
    return { ok: false, reason: `identityTrustLevel must be one of: ${policyModule.IDENTITY_TRUST_LEVELS.join(', ')}` };
  }
  return { ok: true };
}

/**
 * Per-channel provider routing. Only sms ships in this commit; email and
 * portal_chat dispatchers land when the corresponding call sites migrate.
 */
async function dispatchToProvider(input) {
  if (input.channel === 'sms') {
    return sendViaTwilio(input);
  }
  return {
    sent: false,
    error: `Provider for channel "${input.channel}" not yet wired in send_customer_message`,
  };
}

module.exports = {
  sendCustomerMessage,
  // Exposed for tests
  _internals: {
    validateContract,
    normalizeRecipient,
  },
};
