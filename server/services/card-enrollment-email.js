/**
 * Card-enrollment confirmation emails (owner directive 2026-07-13, from
 * the Auto Pay authorization-form question): give the customer a COPY of
 * the card authorization they just granted — card-network stored-
 * credential guidance recommends delivering the agreement at enrollment.
 *
 *   sendAutopayEnrollmentConfirmation — fired from enrollConsentedMethod
 *     on a FRESH enrollment (never already_enrolled): the exact locked
 *     consent text (per method type) rides as {{authorization_text}}.
 *   sendCardHoldConfirmation — fired post-commit from the one-time accept:
 *     visit-scoped terms with the fee line composed from the FROZEN
 *     hold-row values (no_show_fee_amount / cancel_window_hours), never
 *     live config — the email must match what the customer was shown.
 *
 * GATED OFF by default: nothing sends unless GATE_CARD_ENROLLMENT_EMAILS
 * === 'true' (owner flips — customer comms are owner-authorized only).
 * Best-effort by contract: callers fire-and-forget; a template/SendGrid
 * failure never affects enrollment or the accept. Idempotent per
 * (customer, method, consent version) / per estimate, so webhook-backstop
 * re-runs, consent-row races, and accept retries can't double-send.
 */

const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { CARD_CONSENT_TEXT } = require('./payment-method-consent-text');
const {
  consentVersionQualifiesForEnrollment,
  NON_ENROLLMENT_CONSENT_SOURCES,
} = require('./payment-method-consents');
const { portalUrl } = require('../utils/portal-url');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const BILLING_EMAIL = 'billing@wavespestcontrol.com';

// Quantified card-fee disclosure for the hold confirmation, extracted
// VERBATIM from the canonical consent copy — the same derivation the
// capture UI uses (PaymentPreferenceButtons.CARD_SURCHARGE_DISCLOSURE),
// so the rate can never drift from the versioned consent module into a
// second hardcoded constant (AGENTS.md classifies a disclosure figure
// drifting from the server surcharge policy as a P0). Fail-safe: if the
// consent copy is reworded so the phrase can't be extracted, disclose
// unquantified rather than a possibly-stale number.
const SURCHARGE_RATE_PHRASE = (CARD_CONSENT_TEXT.match(/up to \d+(?:\.\d+)?%/) || [])[0];
const CARD_SURCHARGE_LINE = SURCHARGE_RATE_PHRASE
  ? `A credit card surcharge of ${SURCHARGE_RATE_PHRASE} may apply; debit cards, prepaid cards, and bank transfers have no added card surcharge.`
  : 'A credit card surcharge may apply; debit cards, prepaid cards, and bank transfers have no added card surcharge.';

function emailsEnabled() {
  return process.env.GATE_CARD_ENROLLMENT_EMAILS === 'true';
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

// "your Visa ending 4242" — degrades to a generic line when the mirror row
// hasn't landed yet (the Stripe attach is post-commit best-effort).
function cardLineFor(pm) {
  const brand = clean(pm?.card_brand);
  const last4 = clean(pm?.last_four);
  if (brand && last4) return `your ${brand.charAt(0).toUpperCase()}${brand.slice(1)} ending ${last4}`;
  if (last4) return `your card ending ${last4}`;
  return 'your card on file';
}

async function loadCustomerEmail(customerId) {
  const customer = await db('customers')
    .where({ id: customerId })
    .first('id', 'first_name', 'email');
  const email = clean(customer?.email);
  if (!email || !email.includes('@')) return { customer: null, email: null };
  return { customer, email };
}

// "your Chase Bank account ending 6789" — bank twin of cardLineFor.
function bankLineFor(pm) {
  const bank = clean(pm?.bank_name);
  const last4 = clean(pm?.bank_last_four || pm?.last_four);
  if (bank && last4) return `your ${bank} account ending ${last4}`;
  if (last4) return `your bank account ending ${last4}`;
  return 'your bank account on file';
}

// The "How Auto Pay works" timing line must match the customer's actual
// billing mode (Codex #2698 r3): monthly-billed accounts are charged
// monthly_rate by the monthly billing cron, not after each visit, so the
// per-service sentence would state the wrong timing/amount basis on their
// authorization copy. Column-guarded like the autopay GET route —
// pre-migration DBs default to the per-service copy. The tender phrase
// follows the method family: cards are CHARGED, bank accounts are DEBITED
// (the ACH consent's own verb).
async function chargeTimingLine(customerId, { tender = 'your card', verb = 'charged' } = {}) {
  let mode = null;
  let monthlyRate = 0;
  let resolvedMonthly = true; // read failure keeps the legacy monthly copy
  try {
    const row = await db('customers').where({ id: customerId }).first('billing_mode', 'monthly_rate', 'waveguard_tier');
    mode = row?.billing_mode || null;
    monthlyRate = Number(row?.monthly_rate) || 0;
    // GUARD 3c parity (Codex r9): the cron now runs NULL rows through the
    // lane resolver, so a tier-less/sentinel-tier row with a lingering rate
    // is never dues-charged — the monthly line must follow the same verdict
    // or the enrollment email authorizes a monthly debit that will not run.
    const { resolveBillingLane } = require('./billing-lane');
    resolvedMonthly = resolveBillingLane(row || {}).mode === 'monthly_membership';
  } catch { /* billing_mode column absent pre-migration */ }
  const Tender = `${tender.charAt(0).toUpperCase()}${tender.slice(1)}`;
  if (mode === 'annual_prepay') {
    // Term is prepaid; echo the consent's own scope rather than promising
    // a charge cadence the annual flow doesn't have.
    return `${Tender} is ${verb} for your service invoices as agreed, and you get a receipt every time.`;
  }
  // The explicit per-visit lanes are INVOICE-on-completion — the saved
  // method is never auto-charged after a visit (that collection behavior
  // belongs to per_application only; admin-dispatch's auto-charge block is
  // gated on it) — so the copy must promise an invoice, not an off-session
  // charge (Codex r7).
  if (mode === 'per_visit' || mode === 'one_time') {
    return `After each completed service, we send your invoice — ${tender} on file makes paying it quick.`;
  }
  // The monthly line is promised only when the dues cron will actually run:
  // explicit non-monthly lanes are skipped by GUARD 3b (per_application
  // falls through to the auto-charge line below even with a lingering
  // monthly_rate — Codex r6), and NULL modes follow the lane resolver
  // exactly as the cron's GUARD 3c does (Codex r9).
  if (resolvedMonthly && monthlyRate > 0) {
    return `${Tender} is ${verb} your monthly plan amount on your billing day each month, and you get a receipt every time.`;
  }
  return `After each completed service, ${tender} is ${verb} that service's amount automatically, and you get a receipt every time.`;
}

async function sendAutopayEnrollmentConfirmation({ customerId, paymentMethodRowId } = {}) {
  try {
    if (!emailsEnabled() || !customerId || !paymentMethodRowId) return null;
    const { customer, email } = await loadCustomerEmail(customerId);
    if (!customer) {
      logger.info(`[card-enrollment-email] no usable email for customer ${customerId}; skipping autopay confirmation`);
      return null;
    }
    const pm = await db('payment_methods')
      .where({ id: paymentMethodRowId, customer_id: customerId })
      .first('id', 'stripe_payment_method_id', 'card_brand', 'last_four', 'method_type', 'bank_name', 'bank_last_four');
    // Method family selects the template (Codex #2698 r1 established the
    // rule; the portal ACH lane shipped the bank variant): card wording
    // over an ACH debit authorization — or vice versa — is wrong on both
    // counts. Unknown method families still skip.
    const methodType = clean(pm?.method_type || 'card').toLowerCase();
    const isBank = methodType === 'ach' || methodType === 'us_bank_account';
    if (pm && methodType !== 'card' && !isBank) {
      logger.info(`[card-enrollment-email] unknown method family (${methodType}) for customer ${customerId}; autopay confirmation skipped (no matching template)`);
      return null;
    }
    // The customer's copy must be the EXACT text they agreed to — the
    // STORED ledger snapshot, not whatever copy is deployed at send time
    // (a consent-version wording bump must never rewrite history —
    // Codex #2698 r1). The agreement of record is the newest ENROLLMENT-
    // SCOPED, enrollment-QUALIFYING consent (Codex r3): hold-scoped rows
    // ('estimate_card_hold') only authorize one visit's completion charge,
    // and pre-v8 rows never authorized recurring charges — a later hold on
    // the same card, or a legacy row, must never become "Your
    // authorization" in this email. No qualifying row → NO send: an
    // authorization copy is a copy of a stored agreement, never fabricated
    // from the currently-deployed text.
    if (!pm?.stripe_payment_method_id) {
      logger.info(`[card-enrollment-email] no stripe payment method row for customer ${customerId}; autopay confirmation skipped (no agreement of record)`);
      return null;
    }
    const consentRows = await db('payment_method_consents')
      .where({ customer_id: customerId, stripe_payment_method_id: pm.stripe_payment_method_id })
      .select('id', 'source', 'consent_text_version', 'consent_text_snapshot', 'created_at');
    const consentRow = (consentRows || [])
      .filter((r) => !NON_ENROLLMENT_CONSENT_SOURCES.has(r.source)
        && consentVersionQualifiesForEnrollment(r.consent_text_version)
        && clean(r.consent_text_snapshot))
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0] || null;
    if (!consentRow) {
      logger.info(`[card-enrollment-email] no enrollment-scoped consent for customer ${customerId}; autopay confirmation skipped (no agreement of record)`);
      return null;
    }
    const templateKey = isBank ? 'autopay.enrollment_confirmation_ach' : 'autopay.enrollment_confirmation';
    const timingLine = await chargeTimingLine(customerId, isBank
      ? { tender: 'your bank account', verb: 'debited' }
      : { tender: 'your card', verb: 'charged' });
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey,
      to: email,
      payload: {
        first_name: clean(customer.first_name) || 'there',
        ...(isBank
          ? { bank_line: bankLineFor(pm), debit_timing_line: timingLine }
          : { card_line: cardLineFor(pm), charge_timing_line: timingLine }),
        authorization_text: clean(consentRow.consent_text_snapshot),
        customer_portal_url: portalUrl('/login'),
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: BILLING_EMAIL,
      },
      recipientType: 'customer',
      recipientId: customerId,
      // Keyed on the CONSENT VERSION, not the row id (Codex r2 + r3): the
      // browser /consent path and the Stripe webhook can race on the same
      // SetupIntent and insert TWO rows for one authorization — both
      // snapshot the same deployed version, so version-keying collapses
      // the duplicate that row-id keying double-sent. The r2 behavior it
      // must keep: a re-authorization under BUMPED consent copy is a new
      // agreement → new version → fresh copy; a re-authorization under
      // identical copy is deduped — the customer already holds a verbatim
      // copy of that exact agreement for this method.
      idempotencyKey: `${templateKey}:${customerId}:${paymentMethodRowId}:${consentRow.consent_text_version}`,
      triggerEventId: `${templateKey}:${customerId}:${paymentMethodRowId}:${consentRow.consent_text_version}`,
      categories: ['autopay_enrollment_confirmation'],
      suppressProviderErrorLog: true,
    });
    logger.info(`[card-enrollment-email] autopay confirmation sent for customer ${customerId} (${isBank ? 'bank' : 'card'})`);
    return result;
  } catch (err) {
    const reason = err.status
      ? `SendGrid ${err.status}`
      : EmailTemplateLibrary.redactEmailAddresses(err.message);
    logger.error(`[card-enrollment-email] autopay confirmation failed for customer ${customerId}: ${reason}`);
    return null;
  }
}

// Auto Pay setup INVITATION — the email leg of the appointment card-request
// funnel (owner delivery rule 2026-07-23: an invite goes out on BOTH
// channels). Fired by requestCardForAppointment strictly AFTER the SMS
// leg's one-text-ever claim resolved to a dispatched text, so this email
// can never revive a visit the funnel skipped, exempted, or auto-secured —
// every eligibility rule stays enforced in one place. Idempotent per visit:
// a stale-claim retry that re-enters the funnel can't double-send the
// email any more than it can re-text.
async function sendAutopaySetupInvitation({ customerId, scheduledServiceId, serviceType, dateLine = '', secureUrl } = {}) {
  try {
    if (!emailsEnabled() || !customerId || !scheduledServiceId || !secureUrl) return null;
    const { customer, email } = await loadCustomerEmail(customerId);
    if (!customer) {
      logger.info(`[card-enrollment-email] no usable email for customer ${customerId}; skipping setup invitation`);
      return null;
    }
    // Billing-mode-aware timing copy (Codex #2952): a monthly-membership
    // customer who saves this card is charged monthly dues on their
    // billing day — a hard-coded "only charged after a completed service"
    // sentence would misstate when they're charged.
    const timingLine = await chargeTimingLine(customerId);
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'autopay.setup_invitation',
      to: email,
      payload: {
        first_name: clean(customer.first_name) || 'there',
        service_type: clean(serviceType) || 'service',
        date_line: dateLine || '',
        secure_link: secureUrl,
        charge_timing_line: timingLine,
        customer_portal_url: portalUrl('/login'),
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: BILLING_EMAIL,
      },
      recipientType: 'customer',
      recipientId: customerId,
      idempotencyKey: `autopay.setup_invitation:${scheduledServiceId}`,
      triggerEventId: `autopay.setup_invitation:${scheduledServiceId}`,
      categories: ['autopay_setup_invitation'],
      suppressProviderErrorLog: true,
    });
    logger.info(`[card-enrollment-email] setup invitation sent for visit ${scheduledServiceId}`);
    return result;
  } catch (err) {
    const reason = err.status
      ? `SendGrid ${err.status}`
      : EmailTemplateLibrary.redactEmailAddresses(err.message);
    logger.error(`[card-enrollment-email] setup invitation failed for visit ${scheduledServiceId}: ${reason}`);
    return null;
  }
}

async function sendCardHoldConfirmation({ estimateId, customerId } = {}) {
  try {
    if (!emailsEnabled() || !estimateId || !customerId) return null;
    const { customer, email } = await loadCustomerEmail(customerId);
    if (!customer) {
      logger.info(`[card-enrollment-email] no usable email for customer ${customerId}; skipping card-hold confirmation`);
      return null;
    }
    // FROZEN terms from the hold row — the same values the customer was
    // shown and recordCardHoldHeld persisted; live config must never move
    // the fee/window this email states.
    const hold = await db('estimate_card_holds')
      .where({ estimate_id: estimateId, status: 'held' })
      .orderBy('created_at', 'desc')
      .first('no_show_fee_amount', 'cancel_window_hours', 'stripe_payment_method_id');
    if (!hold) {
      logger.info(`[card-enrollment-email] no held row for estimate ${estimateId}; skipping card-hold confirmation`);
      return null;
    }
    const pm = hold.stripe_payment_method_id
      ? await db('payment_methods')
        .where({ customer_id: customerId, stripe_payment_method_id: hold.stripe_payment_method_id })
        .first('card_brand', 'last_four')
      : null;
    const fee = Number(hold.no_show_fee_amount);
    const windowHours = Number(hold.cancel_window_hours);
    const feeLine = Number.isFinite(fee) && fee > 0 && Number.isFinite(windowHours) && windowHours > 0
      ? `A $${fee.toFixed(2)} fee applies only if you cancel within ${windowHours} hours of your visit or we cannot get access.`
      : 'No fee applies unless we cannot complete your visit.';
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'cardhold.confirmation',
      to: email,
      payload: {
        first_name: clean(customer.first_name) || 'there',
        card_line: cardLineFor(pm),
        fee_line: feeLine,
        // The capture UI disclosed the card surcharge alongside the hold
        // terms (Codex r3) — the customer's copy must carry the same term.
        surcharge_line: CARD_SURCHARGE_LINE,
        customer_portal_url: portalUrl('/login'),
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: BILLING_EMAIL,
      },
      recipientType: 'customer',
      recipientId: customerId,
      idempotencyKey: `cardhold.confirmation:${estimateId}`,
      triggerEventId: `cardhold.confirmation:${estimateId}`,
      categories: ['cardhold_confirmation'],
      suppressProviderErrorLog: true,
    });
    logger.info(`[card-enrollment-email] card-hold confirmation sent for estimate ${estimateId}`);
    return result;
  } catch (err) {
    const reason = err.status
      ? `SendGrid ${err.status}`
      : EmailTemplateLibrary.redactEmailAddresses(err.message);
    logger.error(`[card-enrollment-email] card-hold confirmation failed for estimate ${estimateId}: ${reason}`);
    return null;
  }
}

module.exports = {
  sendAutopayEnrollmentConfirmation,
  sendAutopaySetupInvitation,
  sendCardHoldConfirmation,
  _private: { cardLineFor, emailsEnabled },
};
