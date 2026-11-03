/**
 * Save a customer's card for Auto Pay with Tap to Pay on iPhone, no charge
 * ("Book at the Table", server side).
 *
 * The technician's Waves Admin app taps the customer's card or phone wallet
 * on a Stripe Terminal reader. A Terminal SetupIntent (payment_method_types
 * ['card_present']) saves it WITHOUT a charge. The SetupIntent's own
 * payment_method is a card_present method that can never be charged online;
 * the chargeable copy is SetupAttempt.payment_method_details.card_present.
 * generated_card (expand latest_attempt). Some tap methods have none, so an
 * empty generated_card is a clean refusal ("try another card"). Because the
 * SetupIntent is created with `customer`, Stripe attaches the generated card
 * to that customer. Auto Pay charges are off_session, which saved wallets
 * allow.
 *
 * This module holds the pieces the three /api/stripe/terminal save-card
 * routes share with the card-on-file lane (appointment-card-request.js):
 *   - resolving the request from the texted secure token and judging whether
 *     it may still be completed (mint + validate),
 *   - completing it from a succeeded SetupIntent (complete-setup), through the
 *     same finishVerifiedSecureCapture the /secure page uses, so the save,
 *     consent row, Auto Pay enrollment and enrollment email cannot drift
 *     between the two surfaces. The consent source is 'admin_tap_to_pay'.
 */

const db = require('../models/db');
const logger = require('./logger');

// The two shapes secure-card-public.js accepts (22-char base64url, or legacy
// 64-hex). Anything else is not a token.
const SECURE_TOKEN_RE = /^(?:[A-Za-z0-9_-]{22}|[a-f0-9]{64})$/;

const TAP_CONSENT_SOURCE = 'admin_tap_to_pay';

// Refusals the routes turn into 409s (mint, validate and complete share them).
const SAVE_CARD_REFUSALS = {
  request_not_pending: 'This card request is no longer open.',
  no_longer_needed: 'This appointment no longer needs a card on file.',
  plan_required: 'Choose how the customer wants to pay first.',
  not_supported: 'This request cannot be completed with Tap to Pay.',
  completion_in_progress: 'The card is already being saved. Try again in a moment.',
  completion_failed: 'We could not finish saving the card. Try again.',
  intent_mismatch: 'This card save does not match the request. Start again.',
  pm_ownership_mismatch: 'This card belongs to a different customer.',
  consent_echo_failed: 'We could not finish saving the card. Try again.',
  setup_not_succeeded: 'The card save did not finish. Tap the card again.',
  no_generated_card: 'This card cannot be saved for later charges. Try another card.',
};

function refusalBody(code) {
  return { error: SAVE_CARD_REFUSALS[code] || 'We could not save this card.', code };
}

/**
 * The request behind a secure token, resolved exactly as the public /secure
 * routes do (format gate, then a lookup by token). Unknown or malformed
 * tokens are the same `not_found`.
 */
async function resolveSaveCardRequest(secureToken) {
  const token = typeof secureToken === 'string' ? secureToken : '';
  if (!SECURE_TOKEN_RE.test(token)) return { ok: false, code: 'not_found' };
  const request = await db('appointment_card_requests').where({ token }).first();
  if (!request) return { ok: false, code: 'not_found' };
  return { ok: true, request };
}

/**
 * May this request still be completed with a Tap to Pay card save? Pending,
 * a visit-scoped row (a standalone Auto Pay row has no visit), the visit
 * still needs a card (live, priced, not past, no third-party payer), and the
 * plan rule: a recurring plan context needs the per_application selection.
 * Returns { ok: true } or { ok: false, code }.
 */
async function saveCardEligibility(request) {
  const { secureVisitStillNeedsCard } = require('./appointment-card-request');
  if (request.status !== 'pending') return { ok: false, code: 'request_not_pending' };
  if (request.kind === 'customer' || !request.scheduled_service_id || !request.customer_id) {
    return { ok: false, code: 'not_supported' };
  }
  const stillNeeded = await secureVisitStillNeedsCard(request);
  if (!stillNeeded.ok) return stillNeeded;
  const { buildSecurePlanContext } = require('./secure-appointment-plans');
  const planCtx = await buildSecurePlanContext({ request, visitId: request.scheduled_service_id });
  if (planCtx?.mode === 'recurring' && request.selected_plan !== 'per_application') {
    return { ok: false, code: 'plan_required' };
  }
  return { ok: true };
}

function idOf(value) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id || null;
}

// The chargeable card behind a succeeded Terminal SetupIntent, or null.
function generatedCardId(setupIntent) {
  const attempt = setupIntent?.latest_attempt;
  if (!attempt || typeof attempt !== 'object') return null;
  return idOf(attempt.payment_method_details?.card_present?.generated_card);
}

async function savedCardSummary(stripePaymentMethodId) {
  const row = await db('payment_methods')
    .where({ stripe_payment_method_id: stripePaymentMethodId })
    .first('card_brand', 'last_four', 'card_funding');
  return {
    brand: row?.card_brand ? String(row.card_brand).toLowerCase() : null,
    last4: row?.last_four || null,
    funding: row?.card_funding || null,
  };
}

// Reads the SetupIntent live (with its attempt) and judges it: this request's
// own Tap to Pay intent, on this customer, succeeded, with a chargeable
// generated card. Returns { ok: true, generatedCard } or { ok: false, code }.
async function verifyTerminalSetupIntent(request, setupIntentId) {
  let setupIntent;
  try {
    setupIntent = await require('./stripe').retrieveSetupIntent(setupIntentId, { expand: ['latest_attempt'] });
  } catch (err) {
    logger.warn(`[terminal-save-card] SetupIntent read failed for request ${request.id}: ${err.message}`);
    return { ok: false, code: 'verification_failed' };
  }
  if (!setupIntent || String(setupIntent.metadata?.appointment_card_request_id) !== String(request.id)
    || setupIntent.metadata?.source !== TAP_CONSENT_SOURCE) {
    return { ok: false, code: 'intent_mismatch' };
  }
  const customer = await db('customers').where({ id: request.customer_id }).first('stripe_customer_id');
  if (!customer?.stripe_customer_id || idOf(setupIntent.customer) !== customer.stripe_customer_id) {
    return { ok: false, code: 'intent_mismatch' };
  }
  if (setupIntent.status !== 'succeeded') return { ok: false, code: 'setup_not_succeeded' };
  const generatedCard = generatedCardId(setupIntent);
  if (!generatedCard) return { ok: false, code: 'no_generated_card' };
  return { ok: true, generatedCard };
}

/**
 * Verify the succeeded SetupIntent and finish the capture. `handoff` is the
 * validated terminal_handoff_tokens row (kind save_card). Returns
 * { ok: true, card } or { ok: false, code, status? } where a code is one of
 * SAVE_CARD_REFUSALS' keys, `not_found`, `verification_failed`, or
 * `consent_version_stale`.
 */
async function completeTerminalSetup({ handoff, setupIntentId, ip = null, userAgent = null }) {
  const request = await db('appointment_card_requests')
    .where({ id: handoff.appointment_card_request_id }).first();
  if (!request) return { ok: false, code: 'not_found' };

  // Retry after a finished save: the request already completed with THIS
  // SetupIntent, so answer with the saved card without touching Stripe.
  if (request.status === 'completed' && request.stripe_setup_intent_id === setupIntentId
    && request.stripe_payment_method_id) {
    return { ok: true, card: await savedCardSummary(request.stripe_payment_method_id) };
  }
  if (request.status !== 'pending' && request.status !== 'completing') {
    return { ok: false, code: 'request_not_pending' };
  }

  const verified = await verifyTerminalSetupIntent(request, setupIntentId);
  if (!verified.ok) return verified;
  const generatedCard = verified.generatedCard;

  const { finishVerifiedSecureCapture } = require('./appointment-card-request');
  const finished = await finishVerifiedSecureCapture({
    request,
    stripePaymentMethodId: generatedCard,
    setupIntentId,
    ip,
    userAgent,
    // The sticky-window echo is a /secure page artifact; the Tap to Pay
    // screen does not render that disclosure, so none is claimed.
    disclosureVersion: null,
    consentSource: TAP_CONSENT_SOURCE,
  });
  if (!finished.ok) return finished;

  const done = await db('appointment_card_requests').where({ id: request.id })
    .first('stripe_payment_method_id');
  return { ok: true, card: await savedCardSummary(done?.stripe_payment_method_id || generatedCard) };
}

module.exports = {
  SECURE_TOKEN_RE,
  TAP_CONSENT_SOURCE,
  SAVE_CARD_REFUSALS,
  refusalBody,
  resolveSaveCardRequest,
  saveCardEligibility,
  completeTerminalSetup,
  generatedCardId,
};
