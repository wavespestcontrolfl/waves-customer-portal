/**
 * Consent validator. Reads notification_prefs (existing table) for the
 * recipient and confirms that the requested purpose is permitted.
 *
 * Maps each (purpose, audience) to either:
 *   - 'transactional' — sms_enabled=true is enough; per-purpose flag (if
 *                       defined on the policy row) must also be true
 *   - 'marketing'     — both sms_enabled=true AND a marketing-grade consent
 *                       capture record (or the audience-wide marketing flag)
 *   - 'none'          — bypass (internal_briefing, BI to operator)
 *
 * Returns standard validator shape: { ok: true } | { ok: false, code, reason }.
 */

const db = require('../../../models/db');
const logger = require('../../logger');

/**
 * @param {import('../policy').SendCustomerMessageInput} input
 * @param {Object} policy - resolved policy from policy.resolvePolicy
 * @param {Object} contactState - { prefs?, customer?, suppression? } loaded by load_contact_state
 * @returns {Promise<{ ok: boolean, code?: string, reason?: string }>}
 */
async function checkConsentForPurpose(input, policy, contactState) {
  // Bypass — internal briefings / admin-operator-only flows.
  if (policy.requireConsent === 'none') {
    return { ok: true };
  }

  // Internal/tech audiences never need customer consent.
  if (input.audience === 'internal' || input.audience === 'tech' || input.audience === 'admin') {
    return { ok: true };
  }

  // If the lookup itself FAILED (DB error inside loadContactState) we
  // can't tell whether the recipient has a consent record or not.
  // Surface a distinct CONSENT_LOOKUP_FAILED code so callers can retry
  // instead of permanently suppressing — NO_CONSENT_RECORD means
  // "lookup succeeded, no record found", which is a legitimate denial.
  // Codex P1 on PR #545: previously a DB blip during consent lookup
  // silently dropped legitimate sends as NO_CONSENT_RECORD with no
  // retry path. Callers like review-request now re-queue on this code.
  if (contactState && contactState.lookupFailed) {
    return {
      ok: false,
      code: 'CONSENT_LOOKUP_FAILED',
      reason: 'Could not load notification_prefs / customer record (DB error during lookup) — retry advised',
    };
  }

  // Anonymous leads with no customer record can receive transactional
  // conversational replies — they wrote in, they expect a reply. Anything
  // beyond that needs a customer record + sms_enabled=true.
  if (!contactState || !contactState.prefs) {
    if (
      input.audience === 'lead' &&
      policy.requireConsent === 'transactional' &&
      input.consentBasis &&
      ['transactional_allowed', 'opted_in'].includes(input.consentBasis.status)
    ) {
      return { ok: true };
    }
    if (
      input.audience === 'lead' &&
      policy.requireConsent === 'transactional' &&
      input.purpose === 'conversational'
    ) {
      return { ok: true };
    }
    return {
      ok: false,
      code: 'NO_CONSENT_RECORD',
      reason: `No notification_prefs record found for recipient — required for purpose "${input.purpose}"`,
    };
  }

  const prefs = contactState.prefs;

  // Per-purpose delivery-channel column (sms | email | both). 'email' means
  // the customer chose email-only delivery for this notification type, so the
  // SMS leg is suppressed — the email version arrives via its own lane
  // (receipt / billing emails to the billing address). Only gates SMS: an
  // email send through the wrapper must not be blocked by an email-preferring
  // customer. And only when a deliverable email actually exists — the portal
  // UI can't save an email-only choice without one, but a direct API write
  // (or an email removed later) could; suppressing the text then would leave
  // the customer with NO channel, so SMS stays the fallback.
  // Checked BEFORE the opt-out switches below: an email-only customer who has
  // also texted STOP (or toggled a purpose off) must still read as
  // CHANNEL_EMAIL_ONLY, not SMS_OPTED_OUT — callers like the receipt-delivery
  // queue treat the channel preference as an expected skip but an opt-out on
  // the SMS leg as an actionable failure, and would retry forever a receipt
  // whose email leg already delivered. The SMS is suppressed either way.
  // channelGate 'opt_in' policies (billing, payment_receipt) only apply the
  // gate when the CALLER declares an email leg exists (input.hasEmailLeg) —
  // several sends are SMS-only with no email equivalent (billing-cron autopay
  // successes, invoice thank-yous, balance payment-received, the operator
  // Comms billing reminder), and suppressing those for an email-only customer
  // would leave them with no message at all. Flows with a real email sidecar
  // (the invoice receipt path) opt in.
  const channelGateApplies = policy.channelColumn
    && input.channel === 'sms'
    && (policy.channelGate !== 'opt_in' || input.hasEmailLeg === true);
  if (channelGateApplies && prefs[policy.channelColumn] === 'email') {
    // email_enabled=false is the portal-wide email opt-out: every receipt /
    // billing email leg skips it, so an address on file is NOT deliverable —
    // suppressing the SMS too would drop the notice entirely. The portal UI
    // now locks the dropdowns to Text in that state, but pre-existing rows
    // and direct preference writes can still carry channel='email'.
    const deliverableEmail = prefs.email_enabled !== false
      && (prefs.billing_email || contactState.customer?.email);
    if (deliverableEmail) {
      return {
        ok: false,
        code: 'CHANNEL_EMAIL_ONLY',
        reason: `Recipient prefers email-only delivery for the "${policy.channelColumn}" notification type`,
      };
    }
    logger.warn(`[messaging:consent] ${policy.channelColumn}='email' but no billing/account email on file — SMS stays the fallback, subject to the opt-out gates`);
  }

  // Master kill-switch. Set to false on STOP keyword (existing twilio-webhook
  // logic) and on any opt-out detection by detectOptOut().
  if (prefs.sms_enabled === false) {
    return {
      ok: false,
      code: 'SMS_OPTED_OUT',
      reason: 'Recipient has opted out of SMS (sms_enabled=false on notification_prefs)',
    };
  }

  // Per-purpose pref column(s) (e.g. billing_reminder, service_reminder_24h).
  // A policy may name several (payment_receipt honors both the legacy
  // receipt kill switch and the portal texts toggle) — ALL must be non-false.
  for (const prefsColumn of [].concat(policy.prefsColumn || [])) {
    if (prefs[prefsColumn] === false) {
      return {
        ok: false,
        code: 'PURPOSE_OPTED_OUT',
        reason: `Recipient has disabled the "${prefsColumn}" notification type`,
      };
    }
  }

  // Marketing-grade consent. We require either:
  //   - the consentBasis on the input is { status: 'opted_in', ... }
  //   - or the customer has a stored marketing-consent flag (when wired)
  //
  // We don't yet have a dedicated marketing_consent column, so for now
  // marketing-grade purposes require an explicit consentBasis on the input
  // shaped like { status: 'opted_in', source, capturedAt }. Customer-level
  // flag wiring lands in a follow-up.
  if (policy.requireConsent === 'marketing') {
    const cb = input.consentBasis;
    if (!cb || cb.status !== 'opted_in') {
      return {
        ok: false,
        code: 'NO_MARKETING_CONSENT',
        reason: `Purpose "${input.purpose}" requires marketing consent. consentBasis.status must be "opted_in".`,
      };
    }
  }

  return { ok: true };
}

/**
 * Load the recipient's notification_prefs + minimal customer record into
 * contactState. Pure read, no writes.
 */
async function loadContactState(input) {
  // lookupFailed signals a transient DB error during the consent
  // lookup. The validator distinguishes this from a clean "no record
  // found" outcome so callers can retry instead of suppressing on a
  // DB blip (codex P1 on PR #545).
  const state = { prefs: null, customer: null, lookupFailed: false };

  // Try by customerId first (cheapest, indexed lookup).
  if (input.customerId) {
    try {
      state.prefs = await db('notification_prefs').where({ customer_id: input.customerId }).first();
      state.customer = await db('customers').where({ id: input.customerId }).first('id', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'city');
    } catch (err) {
      logger.warn(`[messaging:consent] customer lookup failed: ${err.message}`);
      state.lookupFailed = true;
    }
  }

  // Fall back to phone match if no customerId. Important for inbound-reply
  // flows where the wrapper is invoked with only `to` set.
  if (!state.customer && input.to) {
    try {
      const cust = await db('customers').where({ phone: input.to }).first('id', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'city');
      if (cust) {
        state.customer = cust;
        state.prefs = await db('notification_prefs').where({ customer_id: cust.id }).first();
        // Phone-match recovery: if the customerId path threw above
        // (setting lookupFailed=true) but we successfully loaded the
        // customer here via phone, contact state IS now valid — clear
        // the flag so checkConsentForPurpose evaluates against actual
        // prefs instead of hard-failing on CONSENT_LOOKUP_FAILED.
        // Codex P2 on PR #545: previously a transient blip on the
        // customerId lookup poisoned the result even when the
        // phone-match fallback recovered.
        state.lookupFailed = false;
      }
    } catch (err) {
      logger.warn(`[messaging:consent] phone-match lookup failed: ${err.message}`);
      state.lookupFailed = true;
    }
  }

  return state;
}

module.exports = {
  checkConsentForPurpose,
  loadContactState,
};
