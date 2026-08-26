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
const { toE164 } = require('../../../utils/phone');

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

  // Recipients with no notification_prefs row can still receive transactional
  // conversational REPLIES — they wrote in, they expect a reply. A missing
  // row means "never opted out": STOP handling upserts a prefs row with
  // sms_enabled=false (twilio-webhook), so any real opt-out is caught by the
  // sms_enabled gate below, never by row absence. Customers created through
  // paths that don't seed notification_prefs were previously stranded here
  // (NO_CONSENT_RECORD on manual replies from Communications/tech Messages).
  // For a KNOWN customer the missing row now resolves to the table defaults
  // (owner ruling 2026-08-25, guarded on positively loaded suppression
  // state). For recipients with NO customer record, reply evidence is still
  // required (hasInboundHistory — a prior inbound sms_log row from this
  // phone, loaded by loadContactState): purpose 'conversational' is reused
  // by flows that can START a thread, and a cold outbound to an unknown
  // no-row recipient must not bypass consent (Codex P1 on PR #3057).
  // Resolved below: the real row, or {} — the table defaults, everything
  // enabled — for a KNOWN customer whose row is missing (owner ruling
  // 2026-08-25: a missing prefs row must never strand a reachable customer;
  // rows are seeded at every intake path, so absence means a path skipped
  // the insert, never an opt-out — STOP handling upserts a row with
  // sms_enabled=false).
  let prefs = contactState ? contactState.prefs : null;

  if (!prefs) {
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
    if (contactState && contactState.customer) {
      // Known customer, no row → table defaults. Same fail-closed guard as
      // the customer-less conversational exception below: a pre-customer
      // STOP lives ONLY in messaging_suppression, so the defaults apply
      // only on POSITIVELY loaded suppression state (Codex P1 on 92cb96ae4
      // + P2 on 2396f5557). Every downstream gate — channel routing,
      // per-purpose toggles, the marketing consentBasis requirement —
      // still runs against the defaults, exactly as it would against a
      // freshly seeded row.
      if (contactState.suppressionLoaded !== true) {
        return {
          ok: false,
          code: 'CONSENT_LOOKUP_FAILED',
          reason: 'messaging_suppression state not positively loaded (lookup error or table missing) — required before missing-prefs-row default consent; retry advised',
        };
      }
      prefs = {};
    } else if (
      policy.requireConsent === 'transactional' &&
      input.purpose === 'conversational' &&
      contactState
    ) {
      // The exception only fires on POSITIVELY loaded suppression state
      // (suppressionLoaded is set by loadSuppressionState only when its
      // query succeeded). Suppression fails open for recipients with a
      // prefs row (sms_enabled still catches the common STOP case), but
      // here the prefs row is absent — a pre-customer STOP lives ONLY in
      // messaging_suppression (or, in the migration-not-applied state,
      // only as the inbound sms_log row that would read as reply
      // evidence), so unknown suppression state — transient DB error OR
      // missing table — must return the retryable code instead of
      // granting the exception (Codex P1 on 92cb96ae4 + P2 on 2396f5557).
      if (contactState.suppressionLoaded !== true) {
        return {
          ok: false,
          code: 'CONSENT_LOOKUP_FAILED',
          reason: 'messaging_suppression state not positively loaded (lookup error or table missing) — required before the no-prefs conversational exception; retry advised',
        };
      }
      if (contactState.hasInboundHistory === true) {
        return { ok: true };
      }
    }
    if (!prefs) {
      return {
        ok: false,
        code: 'NO_CONSENT_RECORD',
        reason: `No notification_prefs record found for recipient — required for purpose "${input.purpose}"`,
      };
    }
  }

  // Per-purpose delivery-channel column (sms | email | both). 'email' means
  // the customer chose email-only delivery for this notification type, so the
  // SMS leg is suppressed — the email version arrives via its own lane
  // (receipt / billing emails to the billing address). Only gates SMS: an
  // email send through the wrapper must not be blocked by an email-preferring
  // customer. And only when a deliverable email actually exists — the portal
  // UI can't save an email-only choice without one, but a direct API write
  // (or an email removed later) could; suppressing the text then would leave
  // the customer with NO channel, so SMS stays the fallback.
  // Checked BEFORE the sms_enabled master switch below: an email-only
  // customer who has also texted STOP must still read as CHANNEL_EMAIL_ONLY,
  // not SMS_OPTED_OUT — callers like the receipt-delivery queue treat the
  // channel preference as an expected skip. But NOT before the per-purpose
  // toggles: a customer who turned the notice type itself off (e.g.
  // payment_receipt=false) has opted out of the NOTICE, not just the text —
  // returning the email redirect would tell the Comms operator to email a
  // reminder the customer explicitly disabled (codex P1 on 5806621e). The
  // queue is indifferent: PURPOSE_OPTED_OUT maps to receipt_texts_opted_out,
  // which is both a non-actionable skip and in the stamp list, same as
  // channel_email_only.
  // channelGate 'opt_in' policies (billing, payment_receipt) only apply the
  // gate when the CALLER declares an email leg exists (input.hasEmailLeg) —
  // several sends are SMS-only with no email equivalent (billing-cron autopay
  // successes, invoice thank-yous, balance payment-received, the operator
  // Comms billing reminder), and suppressing those for an email-only customer
  // would leave them with no message at all. Flows with a real email sidecar
  // (the invoice receipt path) opt in.
  const purposeToggledOff = [].concat(policy.prefsColumn || [])
    .some((prefsColumn) => prefs[prefsColumn] === false);
  const channelGateApplies = policy.channelColumn
    && input.channel === 'sms'
    && !purposeToggledOff
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

  // Per-purpose pref column(s) (e.g. payment_receipt, service_reminder_24h).
  // NOTE: the billing purpose deliberately has NONE (owner ruling 2026-08-01
  // — billing notices carry no per-purpose opt-out; sms_enabled is the only
  // kill switch and billing_channel still routes delivery).
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
    // Marketing-grade purposes additionally require EXPLICIT stored opt-in:
    // the policy's prefsColumn must be exactly true on the row. NULL
    // (system-seeded default — the customer was never asked) or a missing
    // row is not consent regardless of the caller's consentBasis — several
    // senders manufacture an opted_in basis from row/customer timestamps
    // (renewal reminders, retention approvals), and this is the one choke
    // point they all pass through.
    // consentColumns (ANY-of) lets a purpose accept stored opt-in from more
    // than one toggle (purpose 'marketing' spans seasonal campaigns AND
    // promotions); absent, the policy's prefsColumn is the consent column.
    const consentColumns = [].concat(policy.consentColumns || policy.prefsColumn || []);
    const storedOptIn = consentColumns.length > 0
      && consentColumns.some((prefsColumn) => prefs[prefsColumn] === true);
    if (!storedOptIn) {
      return {
        ok: false,
        code: 'NO_MARKETING_CONSENT',
        reason: `Purpose "${input.purpose}" requires explicit stored opt-in (${consentColumns.join(' or ')} === true on notification_prefs) — a system-seeded default row is not captured consent.`,
      };
    }
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

  // Reply evidence for the no-prefs-row conversational exception: has this
  // phone ever texted US? Only queried when the consent decision actually
  // depends on it — prefs row missing, purpose conversational, and an
  // audience that requires the evidence (leads are exempted by the branch
  // above without it, and internal/tech/admin bypass consent entirely), so
  // the normal path and lead sends never pay for the un-indexed from_phone
  // scan (Codex P2 on 92cb96ae4). On query error we set lookupFailed so the
  // validator returns the retryable CONSENT_LOOKUP_FAILED instead of the
  // definitive NO_CONSENT_RECORD — a legit reply suppressed by a DB blip
  // must be retried, not dropped (Codex P1 on 92cb96ae4).
  state.hasInboundHistory = false;
  const needsReplyEvidence = !state.prefs
    && !state.lookupFailed
    && input.purpose === 'conversational'
    && !['lead', 'internal', 'tech', 'admin'].includes(input.audience);
  if (needsReplyEvidence) {
    // Twilio records sms_log.from_phone in canonical E.164, but input.to /
    // customer.phone can carry stored formatting (e.g. '+44 20 7946 0958',
    // '(941) 555-1234') that an exact match would miss — blocking the very
    // reply this evidence exists to allow (Codex P2 on 5fbf59c8b). Query
    // both the raw and toE164 forms of each candidate.
    //
    // Evidence must come from the ACTUAL destination: customer.phone only
    // contributes alternate formatting when it canonicalizes to the same
    // number as input.to. If they differ (e.g. the scheduled-replay path
    // sends a queued to_phone after the customer changed numbers), an
    // inbound on the customer's new number must not authorize the stale,
    // possibly reassigned destination (Codex P2 on 2396f5557).
    const custPhone = state.customer?.phone;
    const sameNumber = custPhone && input.to && toE164(custPhone) === toE164(input.to);
    const phones = [...new Set(
      [input.to, ...(sameNumber ? [custPhone] : [])]
        .flatMap((p) => [p, toE164(p)])
        .filter(Boolean),
    )];
    if (phones.length) {
      try {
        const inbound = await db('sms_log')
          .where({ direction: 'inbound' })
          .whereIn('from_phone', phones)
          .first('id');
        state.hasInboundHistory = Boolean(inbound);
      } catch (err) {
        logger.warn(`[messaging:consent] inbound-history lookup failed: ${err.message}`);
        state.lookupFailed = true;
      }
    }
  }

  return state;
}

module.exports = {
  checkConsentForPurpose,
  loadContactState,
};
