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
 *     card_request purpose with operatorInitiated — never a cron, never an
 *     automation trigger.
 *   - tender is card_or_bank with INSTANT bank verification only (same
 *     precheck + policy as the estimate accept capture,
 *     GATE_ACCEPT_ACH_CAPTURE): a micro-deposit bank would leave the
 *     SetupIntent in requires_action for days and this page has no
 *     pending-verification state.
 *
 * DARK BY DEFAULT: inert unless GATE_AUTOPAY_SETUP_LINK=true AND (for the
 * SMS delivery) the autopay_setup_link template is active (seeded
 * inactive). Already-minted links keep working when the gate is later
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
 * The one entry point (operator surfaces only). Returns
 *   { requested, action: 'link_created' | 'sent' | 'auto_secured' | 'skipped', reason, secureUrl?, expiresAt? }
 * Never throws.
 */
async function requestAutopaySetupLink({ customerId, delivery = 'inline', trigger = 'admin' }) {
  try {
    if (!isAutopaySetupLinkEnabled()) return skip('gate_off');
    if (!customerId) return skip('no_customer');
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return skip('customer_not_found');

    const exempt = await payerExemption(customerId);
    if (exempt) return skip(exempt);

    const { customerOnAutopay } = require('./autopay-eligibility');
    if (await customerOnAutopay(customer)) return skip('autopay_already_active');

    // A consented, chargeable saved card covers the ask — enroll it and
    // send nothing (mirrors the visit lane's auto-secure, minus the row:
    // there is no visit to mark satisfied).
    const ConsentService = require('./payment-method-consents');
    const saved = await ConsentService.findConsentedChargeableCard(customerId);
    if (saved) {
      const { enrollConsentedMethod } = require('./autopay-enrollment');
      const enrollment = await enrollConsentedMethod({
        customerId,
        paymentMethodId: saved.id,
        source: 'save_card_consent',
        details: { via: PURPOSE, trigger },
      });
      if (enrollment?.enrolled || enrollment?.reason === 'already_enrolled') {
        return { requested: false, action: 'auto_secured', reason: 'saved_method_satisfied' };
      }
      return skip(`enrollment_refused:${enrollment?.reason || 'unknown'}`);
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
    let request = existing && (existing.status === 'completing' || !isExpired(existing)) ? existing : null;
    if (existing && !request) {
      await db('appointment_card_requests')
        .where({ id: existing.id, status: 'pending' })
        .update({ status: 'expired', updated_at: new Date() });
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

    if (delivery !== 'sms') {
      return { requested: true, action: 'link_created', reason: existing && request.id === existing.id ? 'request_exists' : 'created', ...linkMeta };
    }

    if (!customer.phone) return skip('no_customer_phone', linkMeta);
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
      logger.error(`[autopay-setup-link] send outcome UNCERTAIN for customer ${customerId}: ${sendErr.message}`);
      return skip('send_outcome_uncertain', linkMeta);
    }
    if (!result?.sent) return skip(result?.reason || 'send_blocked', linkMeta);
    await db('appointment_card_requests')
      .where({ id: request.id })
      .update({ sent_at: new Date(), updated_at: new Date() });
    logger.info(`[autopay-setup-link] link texted to customer ${customerId} (request ${request.id}, trigger ${trigger})`);
    return { requested: true, action: 'sent', reason: 'sent', ...linkMeta };
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
      if (existing
        && existing.metadata?.purpose === PURPOSE
        && String(existing.metadata?.request_id) === String(request.id)
        && ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'succeeded'].includes(existing.status)
        // A SUCCEEDED bank-capable intent is still replayed: the page
        // renders it and completion judges the captured tender (a bank
        // then refuses bank_not_allowed; a card completes).
        && (!bankNoLongerOffered || existing.status === 'succeeded')) {
        return {
          clientSecret: existing.client_secret,
          setupIntentId: existing.id,
          paymentMethodTypes: existingTypes,
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
      await db('appointment_card_requests')
        .where({ id: request.id })
        .update({ stripe_setup_intent_id: minted.setupIntentId, updated_at: new Date() });
    }
    return minted;
  }
  logger.error(`[autopay-setup-link] exhausted SetupIntent generations for request ${request.id} — all replays terminal`);
  return null;
}
const MAX_SETUP_INTENT_GENERATIONS = 5;

// GET /secure/:token payload for a kind='customer' row. Shares the visit
// lane's state vocabulary (ready / secured / closed) so the page renders
// with the same state machine; `kind` tells it which copy to use.
async function loadAutopaySetupPageData(request) {
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
  if (request.status === 'completed' || request.status === 'satisfied') return { state: 'secured', ...base };
  // Mid-completion (page POST or webhook holds the claim): the intent
  // succeeded, but the tail can still revert the row — say "finishing up",
  // never "set up" (pre-push Codex P1). The card form is not re-shown
  // either (a second entry mid-save is the worse failure).
  if (request.status === 'completing') return { state: 'saving', ...base };
  if (request.status !== 'pending' || isExpired(request) || !customer) return { state: 'closed', ...base };
  if (await payerExemption(request.customer_id)) return { state: 'closed', ...base };
  // Auto Pay turned on elsewhere since the link went out (portal, another
  // link) — heal the row and render secured rather than ask again.
  try {
    const { customerOnAutopay } = require('./autopay-eligibility');
    if (await customerOnAutopay(customer)) {
      await db('appointment_card_requests')
        .where({ id: request.id, status: 'pending' })
        .update({ status: 'satisfied', completed_at: new Date(), updated_at: new Date() });
      return { state: 'secured', ...base };
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
  return {
    state: 'ready',
    ...base,
    clientSecret: intent.clientSecret,
    setupIntentId: intent.setupIntentId,
    paymentMethodTypes: intent.paymentMethodTypes,
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
async function finishVerifiedCapture({ request, stripePaymentMethod, setupIntentId, ip = null, userAgent = null }) {
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
    const fresh = await db('appointment_card_requests').where({ id: request.id }).first('id', 'status', 'updated_at');
    if (fresh?.status === 'completed' || fresh?.status === 'satisfied') return { ok: true, alreadyCompleted: true };
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
      await revertClaim();
      return { ok: false, code: 'pm_ownership_mismatch' };
    }
    if (!saved) {
      const StripeService = require('./stripe');
      saved = await StripeService.savePaymentMethod(request.customer_id, stripePaymentMethodId, {
        enableAutopay: false,
        makeDefault: false,
      });
    }
    const ConsentService = require('./payment-method-consents');
    if (!(await ConsentService.hasEnrollmentScopedConsent(request.customer_id, stripePaymentMethodId))) {
      // The page rendered the locked consent for the tender the customer
      // picked (card or ACH variant) before confirmSetup.
      await ConsentService.recordConsent({
        customerId: request.customer_id,
        paymentMethodId: saved?.id || null,
        stripePaymentMethodId,
        source: PURPOSE,
        methodType: saved?.method_type || 'card',
        ip,
        userAgent,
      });
    }
    if (saved?.id) {
      await ConsentService.linkPaymentMethodId(stripePaymentMethodId, saved.id);
    }
    const { enrollConsentedMethod } = require('./autopay-enrollment');
    const enrollment = await enrollConsentedMethod({
      customerId: request.customer_id,
      paymentMethodId: saved?.id,
      source: 'save_card_consent',
      details: { via: PURPOSE, setup_intent_id: setupIntentId },
    });
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
async function completeAutopaySetupCapture({ request, setupIntentId, ip = null, userAgent = null }) {
  if (request.status === 'completed' || request.status === 'satisfied') return { ok: true, alreadyCompleted: true };
  if (!setupIntentId) return { ok: false, code: 'no_setup_intent' };
  let setupIntent = null;
  try {
    setupIntent = await require('./stripe').retrieveSetupIntent(setupIntentId);
  } catch (err) {
    logger.warn(`[autopay-setup-link] live SetupIntent verification failed: ${err.message}`);
    return { ok: false, code: 'verification_failed' };
  }
  if (!intentMatchesRequest(setupIntent, request.id)) return { ok: false, code: 'intent_mismatch' };
  return finishVerifiedCapture({
    request,
    stripePaymentMethod: setupIntent.payment_method,
    setupIntentId: setupIntent.id,
    ip,
    userAgent,
  });
}

// setup_intent.succeeded backstop (purpose autopay_setup_link): the browser
// never posted /complete. Same claim semantics as the visit lane's webhook
// entry — a fresh completing claim reports retryable, a stale one is adopted.
async function completeAutopaySetupCaptureFromWebhook(setupIntent) {
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
    return { ok: true, alreadyCompleted: true };
  }
  if (!intentMatchesRequest(setupIntent, request.id)) return { ok: false, code: 'intent_mismatch' };
  return finishVerifiedCapture({
    request,
    stripePaymentMethod: setupIntent.payment_method,
    setupIntentId: setupIntent.id,
  });
}

module.exports = {
  KIND,
  PURPOSE,
  TEMPLATE_KEY,
  isAutopaySetupLinkEnabled,
  requestAutopaySetupLink,
  loadAutopaySetupPageData,
  completeAutopaySetupCapture,
  completeAutopaySetupCaptureFromWebhook,
  _test: { isExpired, intentMatchesRequest, resolveTender },
};
