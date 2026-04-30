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
 *   2. STOP/HELP behavior is deterministic and template-based.
 *   3. Suppression is checked before every customer/lead send.
 *   4. Customer-facing emoji and exact-price leaks fail closed.
 *   5. Sensitive purposes (payment_link, billing) require identity context.
 *   6. Segment count is computed, logged, and enforced.
 *   7. Internal BI keeps its emoji/3-segment behavior via audience='internal'.
 *   8. Every send attempt — sent OR blocked — is recorded in the audit log.
 *
 * Validator chain order (deterministic):
 *
 *   normalize_recipient
 *   require_input_ids                  — required IDs present per policy
 *   load_contact_state                 — pull notification_prefs, suppression
 *   check_suppression                  — STOP/wrong-number list
 *   check_consent_for_purpose          — sms_enabled + per-purpose flag/marketing
 *   validate_identity_for_purpose      — identityTrustLevel >= policy.minIdentityTrust
 *   validate_no_customer_emoji         — fail closed when audience in [customer, lead]
 *   validate_no_price_leak             — fail closed when audience in [customer, lead]
 *   validate_segment_count             — GSM-7/UCS-2 aware
 *   persist_audit_log
 *   send_via_provider                  — twilio for sms, gmail for email, etc.
 *   persist_delivery_attempt
 *
 * Validators are pure functions where possible; DB lookups live in
 * load_contact_state and the audit step. Each validator returns
 * { ok: true } | { ok: false, code, reason } and the wrapper stops at
 * the first non-ok result, recording the block in the audit log.
 *
 * @typedef {import('./policy').SendCustomerMessageInput} SendCustomerMessageInput
 */

const logger = require('../logger');
const policyModule = require('./policy');

/**
 * Validator chain. Each validator is invoked with (input, policy, contactState)
 * and must return { ok: true } or { ok: false, code, reason }.
 *
 * Wired in commit 2 — this commit lands the contract + harness only.
 */
const VALIDATOR_PIPELINE = [
  // 'require_input_ids',
  // 'check_suppression',
  // 'check_consent_for_purpose',
  // 'validate_identity_for_purpose',
  // 'validate_no_customer_emoji',
  // 'validate_no_price_leak',
  // 'validate_segment_count',
];

/**
 * @param {SendCustomerMessageInput} input
 * @returns {Promise<{
 *   sent: boolean,
 *   blocked: boolean,
 *   reason?: string,
 *   code?: string,
 *   providerMessageId?: string,
 *   auditLogId?: string,
 *   segmentCount?: number,
 *   encoding?: 'GSM_7' | 'UCS_2',
 * }>}
 */
async function sendCustomerMessage(input) {
  const validation = validateContract(input);
  if (!validation.ok) {
    logger.warn(`[send_customer_message] contract violation: ${validation.reason}`);
    return { sent: false, blocked: true, code: 'CONTRACT_VIOLATION', reason: validation.reason };
  }

  let policy;
  try {
    policy = policyModule.resolvePolicy(input.audience, input.purpose);
  } catch (err) {
    logger.warn(`[send_customer_message] unknown policy: ${err.message}`);
    return { sent: false, blocked: true, code: 'UNKNOWN_POLICY', reason: err.message };
  }

  // Validator pipeline lands in commit 2. Stub: contract-only path so the
  // wrapper compiles, loads, and is wire-able by call sites without behavior
  // change. Until validators are wired, customer/lead audiences refuse to
  // send (fail-closed) so an early call-site migration can't accidentally
  // bypass the chain. Internal audience is allowed through for the BI
  // briefing migration test that lands in commit 6.
  if (input.audience === 'customer' || input.audience === 'lead') {
    return {
      sent: false,
      blocked: true,
      code: 'PIPELINE_NOT_WIRED',
      reason: 'Validator pipeline not yet wired — refusing customer/lead send. Land commits 2-4 before migrating call sites.',
    };
  }

  // Internal/admin/tech audiences pass straight through to provider for now.
  // (Validators still apply once wired.)
  return dispatchToProvider(input, policy);
}

function validateContract(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: 'input must be an object' };
  }
  if (!input.to || typeof input.to !== 'string') {
    return { ok: false, reason: 'to (recipient) is required' };
  }
  if (!input.body || typeof input.body !== 'string') {
    return { ok: false, reason: 'body is required' };
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
 * Provider dispatch. Lands per-channel routing in commit 5; this stub
 * exists so the contract test in commit 7 has something to call.
 */
async function dispatchToProvider(input, policy) {
  // Channel-specific provider routing wires up in commit 5.
  return {
    sent: false,
    blocked: true,
    code: 'PROVIDER_NOT_WIRED',
    reason: 'Provider dispatch not wired — see commit 5.',
  };
}

module.exports = {
  sendCustomerMessage,
  // Exposed for tests in commit 7
  _internals: {
    validateContract,
    VALIDATOR_PIPELINE,
  },
};
