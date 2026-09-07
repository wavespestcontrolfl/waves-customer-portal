/**
 * Standalone "set up Auto Pay" link (owner ruling 2026-09-01) — the
 * customer-scoped sibling MODE of the appointment-card request lane, not a
 * sibling lane: rows live in appointment_card_requests with
 * kind='customer' and no visit, the page is the same /secure/:token, the
 * public router and the setup_intent.succeeded webhook route here by
 * `kind` / metadata.purpose, and the completion tail is the same
 * save → consent → enroll sequence every save surface runs.
 *
 * What differs from the visit-bound lane, deliberately:
 *   - no visit: no priced/live/past checks, no fee disclosure, no plan
 *     choice, no one-text-ever stamp (that column is per-visit). Liveness
 *     is `expires_at` (30 days) plus the row status.
 *   - operator-initiated ONLY (admin button): 'inline' hands the link back
 *     for copy/paste (no comm); 'sms' texts it through the canonical
 *     card_request purpose with operatorInitiated; 'email' sends the
 *     payment.autopay_setup_link email template through the email template
 *     library (audited email_messages row, suppressions, unsubscribe
 *     headers) — never a cron, never an automation trigger.
 *   - tender is card_or_bank with INSTANT bank verification only (same
 *     precheck + policy as the estimate accept capture,
 *     GATE_ACCEPT_ACH_CAPTURE): a micro-deposit bank would leave the
 *     SetupIntent in requires_action for days and this page has no
 *     pending-verification state.
 *
 * DARK BY DEFAULT: inert unless GATE_AUTOPAY_SETUP_LINK=true AND (for the
 * SMS delivery) the autopay_setup_link template is active (seeded
 * inactive) AND (for the email delivery) the payment.autopay_setup_link
 * email template is active. Already-minted links keep working when the gate is later
 * turned off — the gate governs new links, never strands a customer
 * mid-flow (same rule as the visit lane).
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { portalUrl } = require('../utils/portal-url');
const { sendCustomerMessage } = require('./messaging/send-customer-message');

const KIND = 'customer';
const PURPOSE = 'autopay_setup_link';
const TEMPLATE_KEY = 'autopay_setup_link';
const EMAIL_TEMPLATE_KEY = 'payment.autopay_setup_link';
const LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Same completion-claim lease as the visit lane.
const STALE_CLAIM_MS = 10 * 60 * 1000;

function isAutopaySetupLinkEnabled() {
  try {
    return require('../config/feature-gates').gates.autopaySetupLink === true;
  } catch {
    return false;
  }
}

function skip(reason, extra = {}) {
  return { requested: false, action: 'skipped', reason, ...extra };
}

function isExpired(request, now = new Date()) {
  return !!request?.expires_at && new Date(request.expires_at).getTime() <= now.getTime();
}

// Lanes whose billing IS "each completed visit is charged to the saved
// method" — the only cadence the setup copy promises. per_application
// always auto-collects at completion; per_visit does so ONLY while
// GATE_COMPLETION_AUTOPAY_CHARGE is on (GH Codex #3726 r5 P1: with that
// gate off, a per-visit customer's invoice takes the pay-link flow and the
// promise would be false).
function billingLaneSupported(customer) {
  try {
    const { mode } = require('./billing-lane').resolveBillingLane(customer);
    if (mode === 'per_application') return true;
    if (mode === 'per_visit') return require('../config/feature-gates').gates.completionAutopayCharge === true;
    return false;
  } catch {
    return false;
  }
}

// Consent vocabulary from the Stripe-verified type (GH Codex #3726 r3 P1):
// a legacy local row may carry a null or alias method_type, and the consent
// snapshot must follow what Stripe says the method IS.
function consentMethodTypeFor(stripeType) {
  return stripeType === 'us_bank_account' ? 'ach' : 'card';
}

// The ONE enrollment path for this lane (capture completion AND the office
// auto-enroll from a saved consented card — GH Codex #3726 P2): FOR UPDATE
// on the customer row, then the eligibility this lane promises (not
// archived, per-visit/per-application lane, not paused) judged under that
// lock, then enrollConsentedMethod in savepoint mode on the same handle
// (its own FOR UPDATE re-locks the row we hold — same transaction, no
// self-deadlock). Its confirmation email comes back as a closure and fires
// only after COMMIT (visit-lane pattern). Returns enrollConsentedMethod's
// result, or { enrolled:false, reason } with one of customer_deleted /
// lane_changed / autopay_paused.
async function enrollUnderCustomerLock({ customerId, paymentMethodId, details, authorizedAt = null }) {
  const { enrollConsentedMethod } = require('./autopay-enrollment');
  let deferredEnrollmentEmail = null;
  const enrollment = await db.transaction(async (trx) => {
    const locked = await trx('customers')
      .where({ id: customerId })
      .forUpdate()
      .first('id', 'deleted_at', 'billing_mode', 'waveguard_tier', 'monthly_rate', 'autopay_enabled', 'autopay_paused_until');
    if (!locked || locked.deleted_at) return { enrolled: false, reason: 'customer_deleted' };
    if (!billingLaneSupported(locked)) return { enrolled: false, reason: 'lane_changed' };
    // A PAUSE stands: enrollment would report already_enrolled and the
    // caller would say "set up" while nothing collects. Resuming is the
    // customer's or the office's explicit action — never a side effect.
    if (locked.autopay_enabled && require('./autopay-eligibility').isPaused(locked)) {
      return { enrolled: false, reason: 'autopay_paused' };
    }
    // Activated elsewhere between the GET and this POST (GH Codex P0):
    // enrollment would keep the healthy incumbent and report
    // already_enrolled, and the link would then tell the customer THEIR
    // submitted method is in charge. Judge it under the lock and close.
    {
      const full = await trx('customers').where({ id: customerId }).first();
      if (full && await require('./autopay-eligibility').customerOnAutopay(full, { db: trx })) {
        return { enrolled: false, reason: 'autopay_already_active' };
      }
    }
    const result = await enrollConsentedMethod({
      customerId,
      paymentMethodId,
      source: 'save_card_consent',
      details,
      ...(authorizedAt instanceof Date && !Number.isNaN(authorizedAt.getTime()) ? { authorizedAt } : {}),
      dbh: trx,
    });
    deferredEnrollmentEmail = result?.sendEnrollmentConfirmation || null;
    return result;
  });
  if (enrollment?.enrolled && deferredEnrollmentEmail) {
    try { deferredEnrollmentEmail(); } catch { /* best-effort */ }
  }
  return enrollment;
}

// Tender for the capture — identical policy to the accept capture: bank is
// offered only while the customer's ACH state is healthy, because
// enrollConsentedMethod refuses a bank target under needs_verification /
// suspended and a captured-then-refused bank would strand the link. A
// lookup failure fails toward card.
// At MINT a lookup failure fails toward card (offer the tender that is
// always accepted); at COMPLETION the caller passes throwOnError so a
// transient DB blip reads as retryable rather than a permanent policy
// refusal (pre-push Codex P1).
async function resolveTender(customerId, { throwOnError = false } = {}) {
  // ONE ACH-capture kill switch for every tokenized capture surface (pre-push
  // Codex P1): GATE_ACCEPT_ACH_CAPTURE off = card-only here too, at mint AND
  // at completion, so turning bank capture off cannot be bypassed by a
  // standalone link minted earlier.
  let achCaptureOn = false;
  try {
    achCaptureOn = require('../config/feature-gates').gates.acceptAchCapture === true;
  } catch { achCaptureOn = false; }
  if (!achCaptureOn) return 'card';
  try {
    const row = await db('customers').where({ id: customerId }).first('ach_status');
    if (row?.ach_status && row.ach_status !== 'active') return 'card';
    return 'card_or_bank';
  } catch (err) {
    if (throwOnError) throw err;
    logger.warn(`[autopay-setup-link] ach_status precheck failed for customer ${customerId} — card-only: ${err.message}`);
    return 'card';
  }
}

// Payer-billed accounts never set up homeowner Auto Pay (the invoices go
// to the payer's AP inbox). Fail toward EXEMPT on a lookup error — same
// direction as the visit lane's resolveExemption.
async function payerExemption(customerId) {
  try {
    const resolved = await require('./payer').resolveForInvoice({ customerId: String(customerId), throwOnError: true });
    if (resolved?.payerId) return 'payer_billed';
    return null;
  } catch (err) {
    logger.warn(`[autopay-setup-link] payer check failed — exempting: ${err.message}`);
    return 'payer_check_uncertain';
  }
}

/**
 * Side-effect-free eligibility — the front half of requestAutopaySetupLink,
 * shared with the composer's delivery seam so a draft that sat open while
 * the customer was archived / moved to a payer / enrolled / paused / changed
 * lane cannot text a stale setup credential (pre-push Codex P1). Resolves
 * { reason: null, customer } when a link may go out, else { reason }.
 */
async function setupLinkIneligibility(customerId) {
  if (!isAutopaySetupLinkEnabled()) return { reason: 'gate_off' };
  if (!customerId) return { reason: 'no_customer' };
  const customer = await db('customers').where({ id: customerId }).first();
  // Deletion is SOFT (deleted_at) — an archived customer never gets a
  // link (GH Codex P0).
  if (!customer || customer.deleted_at) return { reason: 'customer_not_found' };

  const exempt = await payerExemption(customerId);
  if (exempt) return { reason: exempt };

  const { customerOnAutopay, isPaused } = require('./autopay-eligibility');
  // failClosed: an unreadable payment_methods state must not read as "not
  // enrolled" — the throw becomes the mint's skip / the seam's 503
  // (GH Codex #3812 r7 P2).
  if (await customerOnAutopay(customer, { failClosed: true })) return { reason: 'autopay_already_active' };
  // A PAUSED enrollment is still configured (method + pointer intact) —
  // customerOnAutopay says false, but "set up" here would neither resume
  // the pause nor add anything (GH Codex #3726 r3 P2). Resuming is the
  // customer's/office's explicit action, never a side effect of this link.
  if (customer.autopay_enabled && isPaused(customer)) return { reason: 'autopay_paused' };
  // Per-visit and per-application lanes are the ones where "each completed
  // visit is charged" is TRUE. Monthly dues and annual prepay cover their
  // visits (no completion charge), one-time has no recurring relationship
  // — the page/SMS copy would misstate the cadence (GH Codex #3726 r3 P1).
  if (!billingLaneSupported(customer)) return { reason: 'unsupported_billing_lane' };
  return { reason: null, customer };
}

// The link went out on `channel` — stamp sent_at (pending rows only; a
// failed stamp must not read as a failed send, since an operator retry
// would send twice — GH Codex #3726 r1 P2).
async function markSent(request, customerId, channel, trigger) {
  try {
    // sent_at only — updated_at is the completion lease token and a
    // pending row's stamp must not disturb a claim taken meanwhile.
    await db('appointment_card_requests')
      .where({ id: request.id, status: 'pending' })
      .update({ sent_at: new Date() });
  } catch (stampErr) {
    logger.warn(`[autopay-setup-link] sent_at stamp failed for request ${request.id} (${channel} already sent): ${stampErr.message}`);
  }
  logger.info(`[autopay-setup-link] link sent by ${channel} to customer ${customerId} (request ${request.id}, trigger ${trigger})`);
  return { requested: true, action: 'sent', reason: 'sent', channel };
}

// The template library throws for a missing / inactive template or version
// (never a provider problem) — the office reads that as a dark lever.
function isTemplateLeverError(err) {
  if (err?.code === 'EMAIL_TEMPLATE_DISABLED') return true;
  return /template (not found|version not found)|active template not found/i.test(String(err?.message || ''));
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

// Email delivery: the account holder's own address (the link saves a
// payment method on THEIR account, so the billing-contact override does
// not apply), honoring the customer-level email opt-out. The template
// library owns the audit row, suppressions, and provider retry; an
// inactive/missing template throws there and is surfaced as a dark lever
// (same shape as the SMS template lever). Never throws.
async function emailSetupLink({ customer, customerId, request, secureUrl, trigger }) {
  const to = String(customer.email || '').trim();
  if (!isEmailLike(to)) return skip('no_customer_email');
  // Fail closed: an unreadable preference is not an enabled one (GH Codex
  // #3867 P2) — an opted-out customer must never get this optional email
  // because the prefs read blipped. Retryable skip instead.
  let prefs;
  try {
    prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
  } catch (err) {
    logger.warn(`[autopay-setup-link] notification_prefs lookup failed for customer ${customerId}: ${err.message}`);
    return skip('email_prefs_check_uncertain');
  }
  if (prefs?.email_enabled === false) return skip('email_opted_out');

  const EmailTemplateLibrary = require('./email-template-library');
  let result;
  try {
    result = await EmailTemplateLibrary.sendTemplate({
      templateKey: EMAIL_TEMPLATE_KEY,
      to,
      payload: {
        first_name: customer.first_name || 'there',
        secure_link: secureUrl,
        expires_on: request.expires_at
          ? new Date(request.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
          : '',
      },
      recipientType: 'customer',
      recipientId: customerId,
      // Every office click is a deliberate (re)send — a customer who lost the
      // email gets it again — so the key is per click (UUID, never a clock
      // value two clicks can share), not per row.
      triggerEventId: `autopay_setup_link_email:${request.id}:${trigger}`,
      idempotencyKey: `autopay_setup_link_email:${request.id}:${crypto.randomUUID()}`,
      // Stream / suppression group come from the template row
      // (service_operational — an invitation is operational outreach and
      // must honor that unsubscribe, like autopay.setup_invitation).
      categories: ['autopay_setup_link', 'payment_setup'],
      // Provider rejections echo the recipient address — never log them raw.
      suppressProviderErrorLog: true,
    });
  } catch (sendErr) {
    if (isTemplateLeverError(sendErr)) return skip('email_template_inactive');
    // Provider errors can echo the recipient address and the body (which
    // carries the bearer URL) — log only the error class/code.
    logger.error(`[autopay-setup-link] email send outcome UNCERTAIN for customer ${customerId}: ${String(sendErr?.code || sendErr?.name || 'error')}`);
    return skip('send_outcome_uncertain');
  }
  if (!result?.sent) return skip(result?.reason || 'send_blocked');
  return markSent(request, customerId, 'email', trigger);
}

/**
 * The one entry point (operator surfaces only). Returns
 *   { requested, action: 'link_created' | 'sent' | 'auto_secured' | 'skipped', reason, channel?, secureUrl?, expiresAt? }
 * ('sent' carries channel: 'sms' | 'email'.) Never throws.
 */
async function requestAutopaySetupLink({ customerId, delivery = 'inline', trigger = 'admin' }) {
  try {
    if (!['inline', 'sms', 'email'].includes(delivery)) delivery = 'inline';
    const eligibility = await setupLinkIneligibility(customerId);
    if (eligibility.reason) return skip(eligibility.reason);
    const { customer } = eligibility;

    // A consented, chargeable saved card covers the ask — enroll it and
    // send nothing (mirrors the visit lane's auto-secure, minus the row:
    // there is no visit to mark satisfied). An OPT-OUT is sacred: a
    // customer whose latest Auto Pay toggle is a disable is never
    // re-enrolled from an old consent by an office click — they get a
    // fresh link and a fresh checkbox instead (findConsentedChargeableCard
    // already returns null after an opt-out; the explicit check below
    // makes the contract visible here — pre-push Codex P0).
    const ConsentService = require('./payment-method-consents');
    const lastToggle = await db('autopay_log')
      .where({ customer_id: customerId })
      .whereIn('event_type', ['autopay_enabled', 'autopay_disabled'])
      .orderBy('created_at', 'desc')
      .first('event_type');
    const optedOut = lastToggle?.event_type === 'autopay_disabled';
    const saved = optedOut ? null : await ConsentService.findConsentedChargeableCard(customerId);
    if (saved) {
      // The ORIGINAL consent's moment rides into enrollment (pre-push Codex
      // P0): the unlocked opt-out read above can race a disable that commits
      // right after it — enrollConsentedMethod's in-lock guard then refuses
      // opted_out_after_authorization instead of overwriting the opt-out.
      let authorizedAt = null;
      try {
        const consentRow = await db('payment_method_consents')
          .where({ customer_id: customerId, stripe_payment_method_id: saved.stripe_payment_method_id })
          .orderBy('created_at', 'desc')
          .first('created_at');
        authorizedAt = consentRow?.created_at ? new Date(consentRow.created_at) : null;
      } catch (err) {
        logger.warn(`[autopay-setup-link] consent moment lookup failed for customer ${customerId}: ${err.message}`);
      }
      // No readable authorization moment → do not auto-enroll blind; mint a
      // link for a fresh checkbox instead.
      if (!(authorizedAt instanceof Date) || Number.isNaN(authorizedAt.getTime())) {
        logger.info(`[autopay-setup-link] no consent moment for saved pm ${saved.id} — minting a fresh link instead of auto-enrolling`);
      }
      // Same locked eligibility as capture completion (GH Codex P2): an
      // archive / lane move / pause that commits after the unlocked checks
      // above is judged under the customer lock before anything enrolls.
      const enrollment = authorizedAt instanceof Date && !Number.isNaN(authorizedAt.getTime())
        ? await enrollUnderCustomerLock({
          customerId,
          paymentMethodId: saved.id,
          details: { via: PURPOSE, trigger },
          authorizedAt,
        })
        : { enrolled: false, reason: 'no_consent_moment' };
      if (enrollment?.enrolled || enrollment?.reason === 'already_enrolled') {
        return { requested: false, action: 'auto_secured', reason: 'saved_method_satisfied' };
      }
      // Locked eligibility refusals are the same skips the unlocked checks
      // would have produced.
      if (enrollment?.reason === 'customer_deleted') return skip('customer_not_found');
      if (enrollment?.reason === 'autopay_already_active') return skip('autopay_already_active');
      if (enrollment?.reason === 'lane_changed') return skip('unsupported_billing_lane');
      if (enrollment?.reason === 'autopay_paused') return skip('autopay_paused');
      // An opt-out that won the race, or no readable consent moment: fall
      // through to a fresh link (fresh checkbox) rather than refusing.
      if (enrollment?.reason !== 'opted_out_after_authorization' && enrollment?.reason !== 'no_consent_moment') {
        return skip(`enrollment_refused:${enrollment?.reason || 'unknown'}`);
      }
    }

    // Dedup on the LIVE row — pending OR mid-completion (partial unique
    // index: one live standalone row per customer; a completing row is a
    // claim that can revert to pending, so it is live too). An expired
    // pending row is retired first so a fresh link can mint; a completing
    // row is never retired here (the completion tail owns it).
    const existing = await db('appointment_card_requests')
      .where({ customer_id: customerId, kind: KIND })
      .whereIn('status', ['pending', 'completing'])
      .first();
    // Expiry takes precedence over status (GH Codex #3726 r3 P2): an expired
    // pending row retires; an expired COMPLETING row retires only once its
    // claim is stale (a live claim's worker may still finish or revert).
    let request = existing && !isExpired(existing) ? existing : null;
    if (existing && !request) {
      if (existing.status === 'completing') {
        const claimAge = existing.updated_at ? Date.now() - new Date(existing.updated_at).getTime() : Infinity;
        if (claimAge <= STALE_CLAIM_MS) return skip('completion_in_progress');
        await db('appointment_card_requests')
          .where({ id: existing.id, status: 'completing' })
          .where('updated_at', '<', new Date(Date.now() - STALE_CLAIM_MS))
          .update({ status: 'expired', updated_at: new Date() });
      } else {
        await db('appointment_card_requests')
          .where({ id: existing.id, status: 'pending' })
          .update({ status: 'expired', updated_at: new Date() });
      }
    }
    if (!request) {
      const token = crypto.randomBytes(16).toString('base64url');
      try {
        const rows = await db('appointment_card_requests')
          .insert({
            kind: KIND,
            customer_id: customerId,
            status: 'pending',
            trigger,
            token,
            expires_at: new Date(Date.now() + LINK_TTL_MS),
          })
          .returning(['id', 'token', 'expires_at']);
        request = rows && rows[0];
      } catch (insertErr) {
        // Lost a race to the partial unique — adopt the winner's row.
        request = await db('appointment_card_requests')
          .where({ customer_id: customerId, kind: KIND })
          .whereIn('status', ['pending', 'completing'])
          .first();
        if (!request) throw insertErr;
      }
    }
    // The bearer link goes out UNSHORTENED (same ruling as the visit lane:
    // the generic shortener is too weak a credential for a payment page).
    const secureUrl = portalUrl(`/secure/${request.token}`);
    const linkMeta = { secureUrl, expiresAt: request.expires_at || null };

    // A row mid-completion is never handed out, texted or stamped (GH Codex
    // #3726 P2, #3812 r4 P2): the customer is finishing right now, its
    // updated_at is the completion lease token — a stamp here would break
    // the worker's guarded final write — and a copied/inserted link would
    // only be refused at send.
    if (request.status === 'completing') return skip('completion_in_progress', linkMeta);

    if (delivery === 'inline') {
      return { requested: true, action: 'link_created', reason: existing && request.id === existing.id ? 'request_exists' : 'created', ...linkMeta };
    }

    if (delivery === 'email') {
      const emailed = await emailSetupLink({ customer, customerId, request, secureUrl, trigger });
      return { ...emailed, ...linkMeta };
    }

    if (!customer.phone) return skip('no_customer_phone', linkMeta);
    // Third lever, surfaced instead of silently blocked in the pipeline
    // (GH Codex #3726 r1 P1): original_message_type 'autopay_setup_link'
    // classifies as an Auto Pay customer SMS, which sendCustomerMessage
    // refuses unless GATE_AUTOPAY_CUSTOMER_SMS is on.
    if (!require('../config/feature-gates').isEnabled('autopayCustomerSms')) return skip('autopay_sms_gate_off', linkMeta);
    const { renderTemplate } = require('./appointment-card-request');
    const body = await renderTemplate({ first_name: customer.first_name || 'there', secure_link: secureUrl }, TEMPLATE_KEY);
    if (!body) return skip('template_inactive', linkMeta);

    let result;
    try {
      result = await sendCustomerMessage({
        to: customer.phone,
        body,
        channel: 'sms',
        audience: 'customer',
        purpose: 'card_request',
        customerId,
        identityTrustLevel: 'phone_matches_customer',
        // Only ever an explicit office click — never automation.
        ...(trigger === 'admin' ? { operatorInitiated: true } : {}),
        metadata: { autopay_setup_request_id: request.id, trigger, original_message_type: TEMPLATE_KEY },
      });
    } catch (sendErr) {
      // Provider errors can echo the destination number AND the message
      // body (which carries the bearer URL) — log only the error class/code,
      // never the message (pre-push Codex P1).
      logger.error(`[autopay-setup-link] send outcome UNCERTAIN for customer ${customerId}: ${String(sendErr?.code || sendErr?.name || 'error')}`);
      return skip('send_outcome_uncertain', linkMeta);
    }
    if (!result?.sent) return skip(result?.reason || 'send_blocked', linkMeta);
    const sent = await markSent(request, customerId, 'sms', trigger);
    return { ...sent, ...linkMeta };
  } catch (err) {
    logger.error(`[autopay-setup-link] request failed for customer ${customerId}: ${err.message}`);
    return skip('request_failed');
  }
}

// Mint (or replay) the capture SetupIntent for a pending standalone row.
// createSetupIntent carries no idempotency key, so an existing confirmable
// intent on the row is replayed instead of minting a new one per page load.
async function mintOrReplaySetupIntent(request) {
  const StripeService = require('./stripe');
  // Current policy FIRST (pre-push Codex P1): a replayed intent that still
  // allows bank must not expose the bank tab once the kill switch is off or
  // the customer's ACH state turned unhealthy — the tender-salted
  // idempotency key below then mints a card-only generation instead.
  const tender = await resolveTender(request.customer_id);
  if (request.stripe_setup_intent_id) {
    try {
      const existing = await StripeService.retrieveSetupIntent(request.stripe_setup_intent_id);
      const existingTypes = existing?.payment_method_types || ['card'];
      const bankNoLongerOffered = tender === 'card' && existingTypes.includes('us_bank_account');
      // The reverse too (GH Codex P0): a card-only intent minted while bank
      // was off must not pin the link to card once bank becomes eligible —
      // a still-unconfirmed one is stale and the tender-salted key mints a
      // card_or_bank generation. A SUCCEEDED card intent is kept (a card is
      // already captured; nothing to widen).
      const bankNowOffered = tender === 'card_or_bank' && !existingTypes.includes('us_bank_account') && existing?.status !== 'succeeded';
      if (existing
        && existing.metadata?.purpose === PURPOSE
        && String(existing.metadata?.request_id) === String(request.id)
        && ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'succeeded'].includes(existing.status)
        // A bank-capable intent is never replayed once bank is no longer
        // offered — a SUCCEEDED bank intent would otherwise be immutable
        // and every refresh would loop on bank_not_allowed (GH Codex #3726
        // r1 P0); the card-only generation below gives the customer a way
        // to finish with a card.
        && !bankNoLongerOffered
        && !bankNowOffered) {
        // A SUCCEEDED replay already holds a method the customer will not
        // re-enter — the capture UI refuses a bank-capable succeeded replay
        // without its tender (GH Codex #3726 P1), so resolve it here, where
        // the secret key can (same contract as the recurring accept mint).
        let capturedMethodType = null;
        if (existing.status === 'succeeded' && existing.payment_method) {
          const pm = existing.payment_method;
          try {
            capturedMethodType = typeof pm === 'object' && pm?.type
              ? pm.type
              : (await StripeService.retrievePaymentMethod(typeof pm === 'string' ? pm : pm.id))?.type || null;
          } catch (err) {
            logger.warn(`[autopay-setup-link] captured method type lookup failed for replayed intent ${existing.id}: ${err.message}`);
          }
        }
        return {
          clientSecret: existing.client_secret,
          setupIntentId: existing.id,
          paymentMethodTypes: existingTypes,
          capturedMethodType,
        };
      }
    } catch (err) {
      logger.warn(`[autopay-setup-link] existing SetupIntent replay failed for request ${request.id} — minting fresh: ${err.message}`);
    }
  }
  // Deterministic idempotency per (request, tender, generation) — same
  // self-heal as the visit lane: concurrent page loads replay ONE intent
  // (pre-push Codex P1), and a canceled replay walks the salt forward.
  for (let generation = 0; generation < MAX_SETUP_INTENT_GENERATIONS; generation += 1) {
    const minted = await StripeService.createSetupIntent(request.customer_id, tender, {
      metadata: { purpose: PURPOSE, request_id: String(request.id) },
      verificationMethod: 'instant',
      idempotencyKey: `${PURPOSE}_${request.id}_${tender}${generation > 0 ? `_g${generation}` : ''}`,
    });
    if (minted.status === 'canceled') continue;
    if (minted.setupIntentId !== request.stripe_setup_intent_id) {
      // Persist ONLY on a still-pending row (GH Codex #3726 P2): a
      // concurrent tab/webhook may have completed the request against the
      // earlier intent — overwriting its stripe_setup_intent_id would tie
      // the row to an unused intent. A CAS miss means the row moved on; the
      // loader re-reads it instead of rendering a form that can't complete.
      const n = await db('appointment_card_requests')
        .where({ id: request.id, status: 'pending' })
        .update({ stripe_setup_intent_id: minted.setupIntentId, updated_at: new Date() });
      if (n !== 1) return { stale: true };
    }
    return { ...minted, capturedMethodType: null };
  }
  // Every deterministic generation is terminal at Stripe: this row can never
  // mint a usable intent again, and the partial unique would keep blocking a
  // replacement until expiry (GH Codex P2) — retire it so the office can
  // mint a fresh link.
  logger.error(`[autopay-setup-link] exhausted SetupIntent generations for request ${request.id} — retiring the link`);
  await db('appointment_card_requests')
    .where({ id: request.id, status: 'pending' })
    .update({ status: 'expired', updated_at: new Date() });
  return null;
}
const MAX_SETUP_INTENT_GENERATIONS = 5;

// GET /secure/:token payload for a kind='customer' row. Shares the visit
// lane's state vocabulary (ready / secured / closed) so the page renders
// with the same state machine; `kind` tells it which copy to use.
async function loadAutopaySetupPageData(request, { reloaded = false } = {}) {
  const customer = request.customer_id
    ? await db('customers').where({ id: request.customer_id }).first()
    : null;
  const base = {
    kind: KIND,
    firstName: customer?.first_name || null,
    serviceType: null,
    dateDisplay: null,
    windowDisplay: null,
    cancelFeeNote: null,
  };
  // Closure checks BEFORE any terminal success (GH Codex #3726 r5 P0): a
  // bearer link closes once its 30 days pass or its customer is gone —
  // deletion is SOFT (deleted_at), so an archived customer counts as gone —
  // even when the capture completed; the contract says the GET becomes closed.
  if (isExpired(request) || !customer || customer.deleted_at) return { state: 'closed', ...base };
  // Payer-billed accounts close too — before terminal success (GH Codex P0):
  // a customer moved to third-party billing after completing must not keep
  // seeing "Auto Pay is set up" for invoices that now route to the payer.
  if (await payerExemption(request.customer_id)) return { state: 'closed', ...base };
  // Only a capture COMPLETED through this link earns the secured copy — and
  // only while the enrollment is still LIVE and chargeable (GH Codex P1: a
  // customer who later disabled/paused Auto Pay or removed the method must
  // not keep reading "paid automatically"); otherwise the stale link is
  // closed. A standalone row never becomes 'satisfied' (external activation
  // retires it), so anything else terminal is closed too.
  if (request.status === 'completed') {
    try {
      const { customerOnAutopay } = require('./autopay-eligibility');
      return { state: (await customerOnAutopay(customer)) ? 'secured' : 'closed', ...base };
    } catch (err) {
      logger.warn(`[autopay-setup-link] live enrollment probe failed for request ${request.id} — closing: ${err.message}`);
      return { state: 'closed', ...base };
    }
  }
  // Mid-completion (page POST or webhook holds the claim): the intent
  // succeeded, but the tail can still revert the row — say "finishing up",
  // never "set up" (pre-push Codex P1). The card form is not re-shown
  // either (a second entry mid-save is the worse failure).
  if (request.status === 'completing') return { state: 'saving', ...base };
  if (request.status !== 'pending') return { state: 'closed', ...base };
  // Lane can change after the link went out (office moved the customer to
  // monthly dues) — the promised cadence would then be false.
  if (!billingLaneSupported(customer)) return { state: 'closed', ...base };
  // Auto Pay turned on elsewhere since the link went out (portal, another
  // link) — heal the row and render secured rather than ask again.
  try {
    const { customerOnAutopay } = require('./autopay-eligibility');
    if (await customerOnAutopay(customer)) {
      // Activated elsewhere → this link is no longer active: RETIRE it
      // (expired) so every later GET stays closed (GH Codex P0: a
      // 'satisfied' heal would revive to secured on refresh), never a
      // setup-success confirmation the link did not earn.
      await db('appointment_card_requests')
        .where({ id: request.id, status: 'pending' })
        .update({ status: 'expired', completed_at: new Date(), updated_at: new Date() });
      return { state: 'closed', ...base };
    }
  } catch (err) {
    logger.warn(`[autopay-setup-link] autopay-active probe failed for request ${request.id} — rendering the form: ${err.message}`);
  }
  let intent = null;
  try {
    intent = await mintOrReplaySetupIntent(request);
  } catch (err) {
    logger.error(`[autopay-setup-link] SetupIntent mint failed for request ${request.id}: ${err.message}`);
  }
  if (!intent) return { state: 'unavailable', ...base };
  if (intent.stale) {
    // The row left 'pending' under us (another tab / the webhook completed
    // it) — render the row's true state, once.
    if (reloaded) return { state: 'unavailable', ...base };
    const fresh = await db('appointment_card_requests').where({ id: request.id }).first();
    return fresh ? loadAutopaySetupPageData(fresh, { reloaded: true }) : { state: 'closed', ...base };
  }
  return {
    state: 'ready',
    ...base,
    clientSecret: intent.clientSecret,
    setupIntentId: intent.setupIntentId,
    paymentMethodTypes: intent.paymentMethodTypes,
    capturedMethodType: intent.capturedMethodType || null,
  };
}

function intentMatchesRequest(setupIntent, requestId) {
  return !!setupIntent
    && setupIntent.status === 'succeeded'
    && setupIntent.metadata?.purpose === PURPOSE
    && String(setupIntent.metadata?.request_id) === String(requestId)
    && !!setupIntent.payment_method;
}

async function alertNeedsReview({ customerId, requestId, reason }) {
  try {
    await require('./notification-service').notifyAdmin(
      'billing',
      'Auto Pay setup link — method not enrolled',
      `A customer saved a payment method from their Auto Pay setup link but it could not be enrolled (${reason}) — review their saved methods.`,
      { link: customerId ? `/admin/customers/${customerId}` : '/admin/dashboard', metadata: { customerId, appointmentCardRequestId: requestId, reason } },
    );
  } catch (e) { logger.warn(`[autopay-setup-link] review alert failed: ${e.message}`); }
}

// Shared completion tail: claim → save → consent → enroll → completed.
// Same claim mechanics as the visit lane (pending → completing mutex with a
// stale-claim lease; any failure reverts and stays retryable).
async function finishVerifiedCapture({ request, stripePaymentMethod, setupIntentId, latestAttempt = null, authorizedAt = null, ip = null, userAgent = null }) {
  const stripePaymentMethodId = typeof stripePaymentMethod === 'string' ? stripePaymentMethod : stripePaymentMethod?.id;
  // expires_at is the standalone row's liveness contract (pre-push Codex
  // P0): the page stops rendering at expiry, but a direct POST or a late
  // webhook must not enable Auto Pay from a link the customer was told is
  // no longer active. The SetupIntent stays succeeded at Stripe; the office
  // mints a fresh link if the customer still wants Auto Pay.
  if (isExpired(request)) return { ok: false, code: 'no_longer_needed' };
  // Payer re-check at completion distinguishes a CONFIRMED payer (permanent,
  // no_longer_needed) from a transient lookup failure (verification_failed
  // → the webhook retries) — the request-time helper's fail-toward-exempt
  // would otherwise consume the only durable retry (pre-push Codex P1).
  try {
    const resolved = await require('./payer').resolveForInvoice({ customerId: String(request.customer_id), throwOnError: true });
    if (resolved?.payerId) return { ok: false, code: 'no_longer_needed' };
  } catch (err) {
    logger.warn(`[autopay-setup-link] payer re-check failed at completion for request ${request.id}: ${err.message}`);
    return { ok: false, code: 'verification_failed' };
  }
  // Billing lane re-check at completion (pre-push Codex P0): the office can
  // move the customer to monthly dues / annual prepay between page load and
  // confirm — enabling per-visit Auto Pay then would authorize a cadence the
  // page no longer describes. Permanent refusal; a lookup failure is
  // retryable.
  try {
    const laneRow = await db('customers').where({ id: request.customer_id }).first('deleted_at', 'billing_mode', 'waveguard_tier', 'monthly_rate');
    // Archived (soft-deleted) BEFORE any save/consent work (GH Codex P0):
    // an ineligible token answers like an unknown one (generic 404).
    if (!laneRow || laneRow.deleted_at) return { ok: false, code: 'not_found' };
    if (!billingLaneSupported(laneRow)) return { ok: false, code: 'no_longer_needed' };
  } catch (err) {
    logger.warn(`[autopay-setup-link] billing-lane re-check failed at completion for request ${request.id}: ${err.message}`);
    return { ok: false, code: 'verification_failed' };
  }
  // Live tender policy at completion (pre-push Codex P0): an intent minted
  // card_or_bank stays confirmable after the customer's ACH state turns
  // unhealthy, and enrollment would then refuse ach_blocked — a PERMANENT
  // policy refusal the webhook must ack, not retry. Judge the captured
  // method's type against the policy now; an unreadable type on a bank
  // capture fails closed.
  let methodType = typeof stripePaymentMethod === 'object' && stripePaymentMethod?.type ? stripePaymentMethod.type : null;
  if (!methodType) {
    try {
      methodType = (await require('./stripe').retrievePaymentMethod(stripePaymentMethodId))?.type || null;
    } catch (err) {
      logger.warn(`[autopay-setup-link] captured method lookup failed for request ${request.id}: ${err.message}`);
      return { ok: false, code: 'verification_failed' };
    }
  }
  // The AUTHORIZATION moment is the CONFIRM: Stripe records it as the
  // SetupIntent's latest SetupAttempt (created at confirmSetup). That is
  // replay-safe (a POST replaying an old succeeded intent keeps the
  // original attempt time) and correct for a re-used PaymentMethod (whose
  // own `created` may be years old — pre-push Codex P1). The caller's
  // timestamp (webhook event time) is only the fallback when the attempt
  // cannot be read; a page POST supplies none (a replay must not mint a
  // fresh authorization time).
  const attemptRef = typeof latestAttempt === 'object' && latestAttempt ? latestAttempt : null;
  let attemptCreated = Number(attemptRef?.created);
  if (!Number.isFinite(attemptCreated) && typeof latestAttempt === 'string' && latestAttempt) {
    // The SDK has no SetupAttempt retrieve — expand it on the intent.
    try {
      const expanded = await require('./stripe').retrieveSetupIntent(setupIntentId, { expand: ['latest_attempt'] });
      attemptCreated = Number(expanded?.latest_attempt?.created);
    } catch (err) {
      logger.warn(`[autopay-setup-link] setup attempt lookup failed for request ${request.id}: ${err.message}`);
    }
  }
  if (Number.isFinite(attemptCreated) && attemptCreated > 0) authorizedAt = new Date(attemptCreated * 1000);
  if (methodType !== 'card') {
    let tender;
    try {
      tender = await resolveTender(request.customer_id, { throwOnError: true });
    } catch (err) {
      // Transient: the webhook rethrows verification_failed so Stripe
      // retries; a permanent refusal below is acked.
      logger.warn(`[autopay-setup-link] ACH-state lookup failed at completion for request ${request.id}: ${err.message}`);
      return { ok: false, code: 'verification_failed' };
    }
    if (tender !== 'card_or_bank') {
      logger.warn(`[autopay-setup-link] bank method refused at completion for request ${request.id} — tender no longer offered`);
      return { ok: false, code: 'bank_not_allowed' };
    }
  }

  // The claim stamp is this worker's LEASE TOKEN (pre-push Codex P1): every
  // later write by this worker (revert, completed) is guarded on
  // updated_at = claimStamp, so a stale-lease adopter (which stamps its own
  // token) and the original worker can never both own the row — the
  // loser's writes affect 0 rows and report completion_in_progress.
  const claimStamp = new Date();
  let claimed = await db('appointment_card_requests')
    .where({ id: request.id, status: 'pending' })
    .update({ status: 'completing', updated_at: claimStamp });
  if (claimed !== 1) {
    const fresh = await db('appointment_card_requests').where({ id: request.id }).first('id', 'status', 'updated_at', 'stripe_setup_intent_id');
    // The claim was lost to a completion — ack ONLY if it completed with
    // THIS intent (a losing tab's generation is intent_mismatch; GH Codex P1).
    const terminal = fresh ? terminalOutcome(fresh, setupIntentId) : null;
    if (terminal) return terminal;
    if (fresh?.status === 'completing' && fresh.updated_at
      && (Date.now() - new Date(fresh.updated_at).getTime()) > STALE_CLAIM_MS) {
      claimed = await db('appointment_card_requests')
        .where({ id: request.id, status: 'completing' })
        .where('updated_at', '<', new Date(Date.now() - STALE_CLAIM_MS))
        .update({ updated_at: claimStamp });
      if (claimed !== 1) return { ok: false, code: 'completion_in_progress' };
      logger.warn(`[autopay-setup-link] reclaimed stale completion claim for request ${request.id}`);
    } else {
      return { ok: false, code: 'completion_in_progress' };
    }
  }
  const revertClaim = async () => {
    try {
      await db('appointment_card_requests')
        .where({ id: request.id, status: 'completing', updated_at: claimStamp })
        .update({ status: 'pending', updated_at: new Date() });
    } catch (revertErr) {
      logger.warn(`[autopay-setup-link] claim revert failed for request ${request.id}: ${revertErr.message}`);
    }
  };

  try {
    let saved = await db('payment_methods').where({ stripe_payment_method_id: stripePaymentMethodId }).first();
    if (saved && String(saved.customer_id) !== String(request.customer_id)) {
      logger.warn(`[autopay-setup-link] pm ownership mismatch: pm ${stripePaymentMethodId} belongs to ${saved.customer_id}, request customer ${request.customer_id}`);
      await alertNeedsReview({ customerId: request.customer_id, requestId: request.id, reason: 'pm_ownership_mismatch' });
      // Permanent: the succeeded intent is bound to that method, so a
      // pending row would replay the same mismatch until expiry (GH Codex
      // P2). Retire the link; the office mints a fresh one after review.
      await db('appointment_card_requests')
        .where({ id: request.id, status: 'completing', updated_at: claimStamp })
        .update({ status: 'expired', updated_at: new Date() });
      return { ok: false, code: 'pm_ownership_mismatch' };
    }
    if (!saved) {
      const StripeService = require('./stripe');
      try {
        saved = await StripeService.savePaymentMethod(request.customer_id, stripePaymentMethodId, {
          enableAutopay: false,
          makeDefault: false,
          // A retry after the customer REMOVED the method (row deleted,
          // Stripe detached) must not resurrect it (GH Codex #3726 r3 P1) —
          // the succeeded SetupIntent attached it, so "not attached now"
          // means the customer took it off.
          requireAttached: true,
        });
      } catch (saveErr) {
        if (saveErr.code === 'PM_NOT_ATTACHED') {
          logger.info(`[autopay-setup-link] pm ${stripePaymentMethodId} no longer attached (customer removed it) — retiring request ${request.id}`);
          // The link's intent is spent; a fresh link is the office's call.
          await db('appointment_card_requests')
            .where({ id: request.id, status: 'completing', updated_at: claimStamp })
            .update({ status: 'expired', updated_at: new Date() });
          return { ok: false, code: 'method_removed' };
        }
        throw saveErr;
      }
    }
    const consentMethodType = consentMethodTypeFor(methodType);
    // A pre-existing local row for a Stripe-verified BANK method may carry a
    // null/alias method_type (legacy portal rows) — normalize it to the
    // vocabulary enrollment and charge routing recognize, or the row could
    // bypass the ACH-health guard and later be charged as a card (GH Codex
    // P1). Card rows are left alone.
    if (saved && consentMethodType === 'ach' && !['ach', 'us_bank_account'].includes(saved.method_type)) {
      await db('payment_methods').where({ id: saved.id }).update({ method_type: 'ach', updated_at: new Date() });
      saved = { ...saved, method_type: 'ach' };
    }
    const ConsentService = require('./payment-method-consents');
    // One ledger row per AUTHORIZATION EVENT (GH Codex #3726 r1 P1): a
    // consent recorded for this method before this link was minted (an
    // earlier enrollment the customer may since have opted out of) must not
    // suppress the fresh checkbox authorization; only retries of THIS
    // request (rows at/after the link's mint) dedupe.
    // Keyed on the AUTHORIZATION moment (the SetupIntent's creation) when
    // known — a re-authorization on the same link after an opt-out is a new
    // event with a new intent; the link's mint is only the fallback.
    const since = authorizedAt instanceof Date && !Number.isNaN(authorizedAt.getTime())
      ? authorizedAt
      : (request.created_at ? new Date(request.created_at) : null);
    // Scoped to THIS source (GH Codex #3726 P2): an identical consent the
    // customer gave through the portal meanwhile is its own ledger row and
    // must not stand in for this link's authorization record.
    const alreadyRecorded = await ConsentService.hasConsentSnapshotForVariant(request.customer_id, stripePaymentMethodId, {
      methodType: consentMethodType,
      source: PURPOSE,
      ...(since && !Number.isNaN(since.getTime()) ? { since } : {}),
    });
    if (!alreadyRecorded) {
      // The page rendered the locked consent for the tender the customer
      // picked (card or ACH variant) before confirmSetup — snapshot the
      // variant for the tender Stripe verified, never a legacy row alias.
      await ConsentService.recordConsent({
        customerId: request.customer_id,
        paymentMethodId: saved?.id || null,
        stripePaymentMethodId,
        source: PURPOSE,
        methodType: consentMethodType,
        ip,
        userAgent,
      });
    }
    if (saved?.id) {
      await ConsentService.linkPaymentMethodId(stripePaymentMethodId, saved.id);
    }
    const { enrollConsentedMethod } = require('./autopay-enrollment');
    // Lane re-judged UNDER THE CUSTOMER LOCK the enrollment itself takes
    // (GH Codex #3726 r5 P2): the unlocked pre-check above can go stale
    // between read and enrollment. One transaction: FOR UPDATE on the
    // customer row, lane verdict, then enrollConsentedMethod in savepoint
    // mode on the same handle (its own FOR UPDATE re-locks the row we hold —
    // same transaction, no self-deadlock). Its confirmation email comes back
    // as a closure and fires only after COMMIT (visit-lane pattern).
    const enrollment = await enrollUnderCustomerLock({
      customerId: request.customer_id,
      paymentMethodId: saved?.id,
      details: { via: PURPOSE, setup_intent_id: setupIntentId },
      // The authorization moment (GH Codex #3726 r3 P1): a retry (stale
      // lease / webhook) after the customer turned Auto Pay OFF must not
      // re-enable it — enrollConsentedMethod refuses
      // opted_out_after_authorization.
      authorizedAt,
    });
    // Policy refusals under the enrollment lock are PERMANENT (GH Codex
    // P2): a payer assignment / lane move / pause / ACH suspension that
    // committed between the unlocked prechecks and the lock cannot be
    // retried into success — retire the link and report the matching
    // permanent code instead of a retry loop with repeated alerts.
    const permanentUnderLock = {
      customer_deleted: 'not_found',
      autopay_already_active: 'no_longer_needed',
      lane_changed: 'no_longer_needed',
      autopay_paused: 'no_longer_needed',
      payer_billed: 'no_longer_needed',
      ach_blocked: 'bank_not_allowed',
    };
    if (!enrollment.enrolled && permanentUnderLock[enrollment.reason]) {
      logger.info(`[autopay-setup-link] ${enrollment.reason} under the lock for customer ${request.customer_id} — retiring request ${request.id}`);
      await db('appointment_card_requests')
        .where({ id: request.id, status: 'completing', updated_at: claimStamp })
        .update({ status: 'expired', updated_at: new Date() });
      return { ok: false, code: permanentUnderLock[enrollment.reason] };
    }
    if (!enrollment.enrolled && enrollment.reason === 'opted_out_after_authorization') {
      // PERMANENT (pre-push Codex P1): the customer turned Auto Pay off
      // after authorizing — no retry can change that, and a retryable
      // outcome would loop the link (page replay / webhook) forever. Retire
      // the link; the office mints a fresh one if the customer changes
      // their mind. The method stays saved (removable in the portal).
      logger.info(`[autopay-setup-link] opt-out after authorization for customer ${request.customer_id} — retiring request ${request.id}`);
      await db('appointment_card_requests')
        .where({ id: request.id, status: 'completing', updated_at: claimStamp })
        .update({ status: 'expired', updated_at: new Date() });
      return { ok: false, code: 'opted_out' };
    }
    if (!enrollment.enrolled && enrollment.reason !== 'already_enrolled') {
      logger.warn(`[autopay-setup-link] enrollment refused (${enrollment.reason}) for customer ${request.customer_id} — completion stays retryable`);
      await alertNeedsReview({ customerId: request.customer_id, requestId: request.id, reason: enrollment.reason });
      await revertClaim();
      return { ok: false, code: 'completion_failed' };
    }
    const finished = await db('appointment_card_requests')
      .where({ id: request.id, status: 'completing', updated_at: claimStamp })
      .update({
        status: 'completed',
        stripe_setup_intent_id: setupIntentId,
        stripe_payment_method_id: stripePaymentMethodId,
        payment_method_id: saved?.id || null,
        completed_at: new Date(),
        updated_at: new Date(),
      });
    if (finished !== 1) {
      // Lost the lease mid-tail (another worker adopted or reverted it).
      // The save/consent/enrollment above are idempotent — the lease owner
      // re-runs them and completes; report retryable, never success.
      logger.warn(`[autopay-setup-link] completion lease lost for request ${request.id} — not marking completed`);
      return { ok: false, code: 'completion_in_progress' };
    }
    logger.info(`[autopay-setup-link] Auto Pay set up for customer ${request.customer_id} (request ${request.id})`);
    return { ok: true };
  } catch (err) {
    logger.error(`[autopay-setup-link] completion failed for request ${request.id}: ${err.message}`);
    await alertNeedsReview({ customerId: request.customer_id, requestId: request.id, reason: err.message });
    await revertClaim();
    return { ok: false, code: 'completion_failed' };
  }
}

// POST /secure/:token/complete for a kind='customer' row — live-verify
// against Stripe (never the client's word), then the tail.
// A terminal row acks ONLY the intent it completed with (GH Codex P1): two
// tabs can hold different intent generations; the loser's method is
// attached at Stripe but never saved/consented/enrolled, so reporting it as
// completed would show a secured page for a method nothing will charge. A
// satisfied row (auto-secured, no intent of its own) acks any POST — the
// link is covered either way.
function terminalOutcome(request, setupIntentId) {
  if (request.status === 'satisfied') return { ok: true, alreadyCompleted: true };
  if (request.status === 'completed') {
    if (setupIntentId && request.stripe_setup_intent_id === setupIntentId) return { ok: true, alreadyCompleted: true };
    return { ok: false, code: 'intent_mismatch' };
  }
  return null;
}

async function completeAutopaySetupCapture({ request, setupIntentId, ip = null, userAgent = null }) {
  const terminal = terminalOutcome(request, setupIntentId);
  if (terminal) return terminal;
  if (!setupIntentId) return { ok: false, code: 'no_setup_intent' };
  let setupIntent = null;
  try {
    // latest_attempt expanded: its `created` is the confirm moment.
    setupIntent = await require('./stripe').retrieveSetupIntent(setupIntentId, { expand: ['latest_attempt'] });
  } catch (err) {
    logger.warn(`[autopay-setup-link] live SetupIntent verification failed: ${err.message}`);
    return { ok: false, code: 'verification_failed' };
  }
  if (!intentMatchesRequest(setupIntent, request.id)) return { ok: false, code: 'intent_mismatch' };
  return finishVerifiedCapture({
    request,
    stripePaymentMethod: setupIntent.payment_method,
    setupIntentId: setupIntent.id,
    // The confirm moment comes from the SetupAttempt; no POST-time fallback
    // (a replayed succeeded intent must keep its ORIGINAL authorization).
    latestAttempt: setupIntent.latest_attempt || null,
    ip,
    userAgent,
  });
}

// setup_intent.succeeded backstop (purpose autopay_setup_link): the browser
// never posted /complete. Same claim semantics as the visit lane's webhook
// entry — a fresh completing claim reports retryable, a stale one is adopted.
// eventCreatedAt: the webhook event's timestamp — the closest confirmation
// moment the backstop can know (never SetupIntent.created, the mint).
async function completeAutopaySetupCaptureFromWebhook(setupIntent, { eventCreatedAt = null } = {}) {
  const requestId = setupIntent?.metadata?.request_id;
  if (!requestId) return { ok: false, code: 'no_request_id' };
  const request = await db('appointment_card_requests').where({ id: requestId }).first();
  if (!request || request.kind !== KIND) return { ok: false, code: 'not_found' };
  if (request.status === 'completing'
    && request.updated_at
    && (Date.now() - new Date(request.updated_at).getTime()) <= STALE_CLAIM_MS) {
    return { ok: false, code: 'completion_in_progress' };
  }
  if (request.status !== 'pending' && request.status !== 'completing') {
    // Terminal: ack only the intent the row completed with (a stale
    // generation acks as intent_mismatch — permanent, never enrolled).
    return terminalOutcome(request, setupIntent?.id) || { ok: false, code: 'intent_mismatch' };
  }
  if (!intentMatchesRequest(setupIntent, request.id)) return { ok: false, code: 'intent_mismatch' };
  return finishVerifiedCapture({
    request,
    stripePaymentMethod: setupIntent.payment_method,
    setupIntentId: setupIntent.id,
    latestAttempt: setupIntent.latest_attempt || null,
    authorizedAt: eventCreatedAt instanceof Date && !Number.isNaN(eventCreatedAt.getTime()) ? eventCreatedAt : null,
  });
}

module.exports = {
  KIND,
  PURPOSE,
  TEMPLATE_KEY,
  EMAIL_TEMPLATE_KEY,
  isAutopaySetupLinkEnabled,
  setupLinkIneligibility,
  requestAutopaySetupLink,
  loadAutopaySetupPageData,
  completeAutopaySetupCapture,
  completeAutopaySetupCaptureFromWebhook,
  _test: { isExpired, intentMatchesRequest, resolveTender },
};
