/**
 * Identity-trust + required-IDs validators.
 *
 * Used by send_customer_message to enforce two preconditions before any
 * outbound message reaches the provider:
 *
 *   1. validateRequiredIds(input, policy)
 *      Every purpose row in policy.requireIds lists the ID fields that
 *      must be set on the input. payment_link, billing, retention,
 *      review_request all require customerId; payment_link additionally
 *      requires invoiceId.
 *
 *   2. validateIdentityTrust(input, policy, contactState)
 *      Compares the supplied identityTrustLevel (or one inferred from
 *      contactState) to policy.minIdentityTrust. anonymous can only
 *      receive purpose=conversational on audience=lead. Anything that
 *      touches account/billing/payment requires phone_matches_customer
 *      or higher.
 */

const { trustAtLeast } = require('../policy');

function validateRequiredIds(input, policy) {
  const required = policy.requireIds || [];
  const missing = required.filter((field) => !input[field]);
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    code: 'MISSING_REQUIRED_IDS',
    reason: `Purpose "${input.purpose}" requires: ${missing.join(', ')}`,
  };
}

/**
 * Resolve an effective identity trust level. Prefers the explicit
 * input.identityTrustLevel. Falls back to inferring from contactState:
 *
 *   - if customer matched on phone   → phone_matches_customer
 *   - else if input.customerId set   → phone_matches_customer
 *     (the caller asserted identity by passing the ID; downstream
 *     wrappers can elevate to service_contact_authorized,
 *     authenticated_portal, or admin_operator when they have actual
 *     session/contact context)
 *   - else if input.estimate_token   → estimate_token_verified
 *     (passed through by the upstream estimate-view session)
 *   - else                           → anonymous
 */
function resolveTrustLevel(input, contactState) {
  if (input.identityTrustLevel) return input.identityTrustLevel;
  if (contactState && contactState.customer && input.to && contactState.customer.phone === input.to) {
    return 'phone_matches_customer';
  }
  if (input.customerId) return 'phone_matches_customer';
  if (input.estimateId) return 'estimate_token_verified';
  return 'anonymous';
}

function validateIdentityTrust(input, policy, contactState) {
  const resolvedTrust = resolveTrustLevel(input, contactState);
  if (!trustAtLeast(resolvedTrust, policy.minIdentityTrust)) {
    return {
      ok: false,
      code: 'IDENTITY_TRUST_TOO_LOW',
      reason: `Purpose "${input.purpose}" requires identityTrustLevel "${policy.minIdentityTrust}", got "${resolvedTrust}"`,
      resolvedTrust,
    };
  }
  return { ok: true, resolvedTrust };
}

module.exports = {
  validateRequiredIds,
  validateIdentityTrust,
  resolveTrustLevel,
};
