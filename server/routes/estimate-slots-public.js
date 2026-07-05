/**
 * Public slot-availability + reservation routes for the estimate view.
 *
 * GET /api/public/estimates/:token/available-slots
 *   Returns the soonest customer-facing time slots over the next 14 days,
 *   with route-optimal slots labeled in the payload. No auth — token is
 *   the only gate. Rate-limited at 30/min per IP.
 *
 * POST /api/public/estimates/:token/reserve
 *   Body: { slotId }. Creates a 15-minute hold on the chosen slot as a
 *   scheduled_services row with reservation_expires_at set. Rate-limited
 *   at 10/min (tighter than GET — actual writes). Subsequent accept call
 *   commits the reservation; abandoned reservations get reclaimed.
 *
 * POST /api/public/estimates/:token/ask
 *   Body: { question, selectedFrequency?, serviceMode?, askToken? }.
 *   Answers questions for the public estimate ask bar. Token link + askToken
 *   are the public gate; rate-limited at 20/min.
 *
 * Query params on GET:
 *   ?windowDays=14    override lookahead window
 *   ?expand=true      include full expander list (default true anyway)
 *   ?serviceMode=recurring|one_time
 *   ?selectedFrequency=quarterly|bi_monthly|monthly
 *
 * Errors:
 *   404 — token not found, or estimate expired (expires_at in past)
 *   409 — estimate in terminal state, or slot no longer available
 *   429 — rate limited
 *   5xx — sanitized; logged with full context server-side.
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { getAvailableSlots, findEstimateSlots } = require('../services/estimate-slot-availability');
const slotReservation = require('../services/slot-reservation');
const {
  annualPrepayEligibleForEstimateData,
  buildPricingBundle,
  estimateTrenchingReviewRequired,
  findLinkedUpcomingAppointment,
  handleEstimateAsk,
  isEstimateAcceptActive,
  isRodentGuaranteeOnlyEstimate,
  isStructuralOneTimeOnlyEstimate,
  reconcileFrozenMembershipSnapshot,
  resolveAcceptOneTimeTotal,
  resolveEstimateInvoiceMode,
  resolveEstimateQuoteRequirement,
  verifyEstimateAskToken,
} = require('./estimate-public');

// Termite trenching review-before-booking 409 — mirrors the accept-time gate so a
// slot hold or Stripe intent is never created for a priced trenching-only quote
// that /accept would reject (money-gate mirroring per AGENTS.md).
const TRENCHING_REVIEW_409 = {
  error: 'A Waves specialist will confirm your termite trenching treatment path and schedule your visit — this quote can’t be booked online.',
  reviewBeforeBooking: true,
  reason: 'termite_trenching_review',
};
const { buildEstimateMembershipContext } = require('../services/estimate-membership-context');
const { commercialLowConfidenceRange } = require('../services/estimate-delivery-options');
const {
  createDepositIntentForEstimate,
  resolveDepositPolicyForEstimate,
} = require('../services/estimate-deposits');
const {
  createCardHoldSetupIntentForEstimate,
  resolveCardHoldPolicy,
} = require('../services/estimate-card-holds');

const TOKEN_RE = /^[a-f0-9]{64}$|^[a-z0-9-]{3,80}$/i;
// Accept both the legacy admin slug tokens (nameSlug-8hex) AND the new
// 64-char hex format. Post-estimate-versions PR every new token will be
// 64-char hex; existing slug tokens remain valid for historical estimates
// and their customer links shouldn't break.

function parseEstimateData(estimate = {}) {
  if (!estimate.estimate_data) return {};
  if (typeof estimate.estimate_data !== 'string') return estimate.estimate_data || {};
  try {
    return JSON.parse(estimate.estimate_data);
  } catch {
    return {};
  }
}

function resolveSlotServiceMode(estimate = {}, requestedMode = '') {
  if (isStructuralOneTimeOnlyEstimate(parseEstimateData(estimate), estimate)) {
    return 'one_time';
  }
  return requestedMode === 'one_time' ? 'one_time' : 'recurring';
}

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
}));

// Commercial auto-priced estimates are NOT customer self-schedulable — the team
// sets up the (longer, route-sensitive) commercial visit schedule. Detect them
// so the slots lookup + reservation are blocked: a residential-length 45/60-min
// slot must never be reserved for a commercial job priced from tens of thousands
// of sqft. (The slot profiler falls back to service_interest and can't size the
// commercial visit; per the owner directive, commercial schedules manually.)
// Mirror the slot service's terminal/expired gate (estimate-slot-availability.js
// BLOCKED_STATES_FOR_SLOTS + expires_at) so the commercial manual-scheduling
// short-circuit can't return a 200 for an accepted/declined/expired estimate.
// Returns a sent response (caller must `return` it) or null when eligible.
const SLOT_BLOCKED_STATES = new Set(['accepted', 'declined', 'expired']);
function rejectIneligibleEstimate(res, estimate = {}) {
  if (SLOT_BLOCKED_STATES.has(estimate.status)) {
    return res.status(409).json({ error: 'Estimate is no longer active' });
  }
  if (estimate.expires_at && new Date(estimate.expires_at) < new Date()) {
    return res.status(404).json({ error: 'Not found' });
  }
  return null;
}

function isCommercialAutoEstimate(estimate = {}) {
  let data = estimate.estimate_data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = {}; } }
  data = data || {};
  if (data.commercialEstimatedPricing === true) return true;
  const isCommercialSvc = (s) => {
    const k = String(s?.service || s?.serviceKey || s?.name || '').toLowerCase();
    return k.includes('commercial_lawn') || k.includes('commercial_tree') || k.includes('commercial_pest')
      || k.includes('commercial_mosquito') || k.includes('commercial_termite') || k.includes('commercial_rodent');
  };
  // Quote-wizard/engine save → engineResult.lineItems; admin save → the mapped
  // result.recurring.services (v1-legacy-mapper). Check both shapes.
  const lineItems = Array.isArray(data.engineResult?.lineItems) ? data.engineResult.lineItems : [];
  if (lineItems.some((li) => li && li.estimatedPricing === true && isCommercialSvc(li) && Number(li.annual) > 0)) {
    return true;
  }
  const recurringRows = [
    ...(Array.isArray(data.result?.recurring?.services) ? data.result.recurring.services : []),
    ...(Array.isArray(data.recurring?.services) ? data.recurring.services : []),
  ];
  return recurringRows.some(isCommercialSvc);
}

router.get('/:token/available-slots', async (req, res) => {
  const token = req.params.token;
  if (!token || !TOKEN_RE.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const estimate = await db('estimates')
      .where({ token })
      .first('id', 'status', 'expires_at', 'estimate_data', 'monthly_total', 'annual_total', 'onetime_total', 'service_interest');
    if (!estimate) {
      return res.status(404).json({ error: 'Not found' });
    }
    const ineligible = rejectIneligibleEstimate(res, estimate);
    if (ineligible) return ineligible;
    if (isCommercialAutoEstimate(estimate)) {
      return res.json({
        primary: [], expander: [], availableSlots: [], summary: null,
        commercialManualScheduling: true,
        message: 'A Waves team member will reach out to schedule your commercial service.',
      });
    }
    // A guarantee-only renewal accepts through the payment-only invoice path —
    // there is NO visit to book, so the slot picker never renders. Return the
    // empty no-booking shape (mirroring the accept-time gate) so a crafted or
    // stale client can't browse slots for an estimate whose accept takes none.
    if (isRodentGuaranteeOnlyEstimate(estimate, parseEstimateData(estimate))) {
      return res.json({
        primary: [], expander: [], availableSlots: [], summary: null,
        invoiceOnlyAcceptance: true,
        message: 'No appointment is needed — this renewal is accepted with an invoice.',
      });
    }
    if (estimateTrenchingReviewRequired(parseEstimateData(estimate))) {
      return res.json({
        primary: [], expander: [], availableSlots: [], summary: null,
        reviewBeforeBooking: true,
        message: 'A Waves specialist will confirm your termite trenching treatment path and schedule your visit.',
      });
    }

    const windowDays = Number.parseInt(req.query.windowDays, 10);
    const opts = {};
    if (Number.isFinite(windowDays) && windowDays > 0 && windowDays <= 90) {
      opts.windowDays = windowDays;
    }
    // Specific-date browse: ?date=YYYY-MM-DD pins the lookup to a single day.
    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      opts.dateFrom = date;
      opts.dateTo = date;
    }
    if (typeof req.query.timeOfDay === 'string' && req.query.timeOfDay.trim()) {
      opts.timeOfDay = req.query.timeOfDay.trim();
    }
    opts.serviceMode = resolveSlotServiceMode(estimate, req.query.serviceMode);
    if (typeof req.query.selectedFrequency === 'string' && req.query.selectedFrequency.trim()) {
      opts.selectedFrequency = req.query.selectedFrequency.trim();
    }

    try {
      const result = await getAvailableSlots(estimate.id, opts);
      return res.json(result);
    } catch (svcErr) {
      if (svcErr.code === 'ESTIMATE_NOT_FOUND' || svcErr.code === 'ESTIMATE_EXPIRED') {
        return res.status(404).json({ error: 'Not found' });
      }
      if (svcErr.code === 'ESTIMATE_TERMINAL') {
        return res.status(409).json({ error: 'Estimate is no longer active' });
      }
      throw svcErr;
    }
  } catch (err) {
    logger.error(`[estimate-slots-public] ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'unable to load availability', retry: true });
  }
});

// Tighter per-route limiter for POST /reserve (actual writes — 10/min
// stacks below the router-level 30/min GET limiter).
const reserveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reservation attempts. Please try again in a minute.' },
});

const askLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many questions. Please try again in a minute.' },
});

// Deposit PaymentIntent creation — writes + a Stripe call per request, so
// it rides the same tight 10/min budget as /reserve.
const depositLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

// Bound the Waves AI date/time search (each call spends one cheap model call).
const findSlotsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many searches. Please try again in a minute.' },
});

// POST /:token/find-slots — Waves AI date/time search for the estimate page.
//   Body: { query, serviceMode?, selectedFrequency? }. Returns the same
//   primary/expander slot shape as /available-slots, plus a summary + nearby
//   flag. Token in the URL is the only gate (read-only, like /available-slots).
router.post('/:token/find-slots', findSlotsLimiter, async (req, res) => {
  const token = req.params.token;
  if (!token || !TOKEN_RE.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'query required' });
  if (query.length > 500) return res.status(400).json({ error: 'query too long' });

  try {
    const estimate = await db('estimates')
      .where({ token })
      .first('id', 'status', 'expires_at', 'estimate_data', 'monthly_total', 'annual_total', 'onetime_total', 'service_interest');
    if (!estimate) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Model-backed endpoint — same gate as /ask: require the short-lived signed
    // askToken bound to this estimate, on top of the URL token + rate limit.
    // The commercial short-circuit must come AFTER this gate so a bare URL-token
    // holder can't get a success payload without the signed askToken.
    if (!verifyEstimateAskToken(req, estimate)) {
      return res.status(403).json({ error: 'estimate_ask_forbidden' });
    }
    const ineligible = rejectIneligibleEstimate(res, estimate);
    if (ineligible) return ineligible;
    if (isCommercialAutoEstimate(estimate)) {
      return res.json({
        primary: [], expander: [], availableSlots: [], summary: null,
        commercialManualScheduling: true,
        message: 'A Waves team member will reach out to schedule your commercial service.',
      });
    }
    // No-visit guarantee-only renewal: same no-booking shape as
    // /available-slots — the AI date search must not surface bookable slots
    // for an estimate whose accept takes none.
    if (isRodentGuaranteeOnlyEstimate(estimate, parseEstimateData(estimate))) {
      return res.json({
        primary: [], expander: [], availableSlots: [], summary: null,
        invoiceOnlyAcceptance: true,
        message: 'No appointment is needed — this renewal is accepted with an invoice.',
      });
    }
    if (estimateTrenchingReviewRequired(parseEstimateData(estimate))) {
      return res.json({
        primary: [], expander: [], availableSlots: [], summary: null,
        reviewBeforeBooking: true,
        message: 'A Waves specialist will confirm your termite trenching treatment path and schedule your visit.',
      });
    }
    const serviceMode = resolveSlotServiceMode(estimate, req.body?.serviceMode);
    const selectedFrequency = typeof req.body?.selectedFrequency === 'string'
      ? req.body.selectedFrequency.trim()
      : '';
    try {
      const result = await findEstimateSlots(estimate.id, { query, serviceMode, selectedFrequency });
      return res.json(result);
    } catch (svcErr) {
      if (svcErr.code === 'ESTIMATE_NOT_FOUND' || svcErr.code === 'ESTIMATE_EXPIRED') {
        return res.status(404).json({ error: 'Not found' });
      }
      if (svcErr.code === 'ESTIMATE_TERMINAL') {
        return res.status(409).json({ error: 'Estimate is no longer active' });
      }
      throw svcErr;
    }
  } catch (err) {
    logger.error(`[estimate-slots-public:find-slots] ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'unable to search availability', retry: true });
  }
});

router.post('/:token/ask', askLimiter, (req, res, next) => {
  const token = req.params.token;
  if (!token || !TOKEN_RE.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }
  return handleEstimateAsk(req, res, next);
});

// POST /:token/reserve — create a 15-min hold on a slot
router.post('/:token/reserve', reserveLimiter, async (req, res) => {
  const token = req.params.token;
  if (!token || !TOKEN_RE.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const slotId = req.body && typeof req.body.slotId === 'string' ? req.body.slotId.trim() : '';
  if (!slotId) {
    return res.status(400).json({ error: 'slotId required' });
  }
  const requestedServiceMode = req.body?.serviceMode === 'one_time' ? 'one_time' : 'recurring';
  const selectedFrequency = typeof req.body?.selectedFrequency === 'string'
    ? req.body.selectedFrequency.trim()
    : '';
  const slotOpts = {};
  if (selectedFrequency) slotOpts.selectedFrequency = selectedFrequency;

  try {
    const estimate = await db('estimates')
      .where({ token })
      .first('id', 'status', 'expires_at', 'estimate_data', 'monthly_total', 'annual_total', 'onetime_total', 'service_interest');
    if (!estimate) {
      return res.status(404).json({ error: 'Not found' });
    }
    const ineligible = rejectIneligibleEstimate(res, estimate);
    if (ineligible) return ineligible;
    if (isCommercialAutoEstimate(estimate)) {
      return res.status(409).json({
        error: 'Commercial service is scheduled by our team — no self-booking.',
        commercialManualScheduling: true,
      });
    }
    // A guarantee-only renewal has no visit: reserving would mint a
    // scheduled_services hold that accept could then commit — a phantom
    // Rodent Control appointment for a warranty that books nothing. Reject
    // here AND at accept (both halves of the gate, per the half-gate lesson).
    if (isRodentGuaranteeOnlyEstimate(estimate, parseEstimateData(estimate))) {
      return res.status(409).json({
        error: 'No appointment is needed for this renewal — accept without booking.',
        invoiceOnlyAcceptance: true,
      });
    }
    if (estimateTrenchingReviewRequired(parseEstimateData(estimate))) {
      return res.status(409).json(TRENCHING_REVIEW_409);
    }

    slotOpts.serviceMode = resolveSlotServiceMode(estimate, requestedServiceMode);

    try {
      const { scheduledServiceId, expiresAt } = await slotReservation.reserveSlot({
        estimateId: estimate.id,
        slotId,
        ...slotOpts,
      });
      return res.status(201).json({
        scheduledServiceId,
        expiresAt,
        slotConfirmed: { slotId },
      });
    } catch (svcErr) {
      if (svcErr.code === 'INVALID_SLOT_ID') {
        return res.status(400).json({ error: 'invalid slotId format' });
      }
      if (svcErr.code === 'ESTIMATE_NOT_FOUND' || svcErr.code === 'ESTIMATE_EXPIRED') {
        return res.status(404).json({ error: 'Not found' });
      }
      if (svcErr.code === 'ESTIMATE_TERMINAL') {
        return res.status(409).json({ error: 'Estimate is no longer active' });
      }
      if (svcErr.code === 'SLOT_UNAVAILABLE') {
        // Refresh slot availability for the estimate so the caller can
        // re-render without another round trip.
        let fresh = null;
        try {
          fresh = await getAvailableSlots(estimate.id, slotOpts);
        } catch (freshErr) {
          logger.warn(`[estimate-slots-public] fresh slots lookup failed: ${freshErr.message}`);
        }
        return res.status(409).json({
          error: 'slot no longer available',
          slotId: svcErr.slotId,
          nextBest: fresh?.primary?.[0] || null,
          availableSlots: fresh,
        });
      }
      throw svcErr;
    }
  } catch (err) {
    logger.error(`[estimate-slots-public:reserve] ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'unable to reserve slot', retry: true });
  }
});

// POST /:token/deposit-intent — Stripe PaymentIntent for the required
// acceptance deposit (flat $49 recurring / $99 one-time, pricing_config-
// authoritative; ESTIMATE_DEPOSIT_REQUIRED rollout switch). Gates mirror
// accept exactly: estimate-token format gate, terminal/expired rejection,
// the accept-time quote gate (never collect money for an estimate accept
// will reject), and the deposit policy itself (existing plan customers owe
// nothing; prepay-annual owes the $49 like any recurring accept — it credits
// against the annual invoice minted at accept). serviceMode picks the amount
// class — one-time accepts pay the heavier flat amount, credited against
// their completed-visit invoice. The client pays the intent, then calls
// accept with depositPaymentIntentId; the intent is idempotent per
// estimate+amount, so retries reuse it.
router.post('/:token/deposit-intent', depositLimiter, async (req, res) => {
  const token = req.params.token;
  if (!token || !TOKEN_RE.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const estimate = await db('estimates').where({ token }).first();
    if (!estimate) return res.status(404).json({ error: 'Not found' });
    if (estimate.status === 'accepted') return res.status(409).json({ error: 'Estimate already accepted' });
    if (!isEstimateAcceptActive(estimate)) return res.status(409).json({ error: 'Estimate is no longer active' });
    await reconcileFrozenMembershipSnapshot(estimate);

    const estData = parseEstimateData(estimate);
    const pricingBundle = await buildPricingBundle(estimate);
    const quoteRequirement = resolveEstimateQuoteRequirement(pricingBundle, estData);
    if (quoteRequirement.quoteRequired) {
      return res.status(409).json({ error: 'Estimate is no longer active' });
    }
    if (estimateTrenchingReviewRequired(estData)) {
      return res.status(409).json(TRENCHING_REVIEW_409);
    }

    const membership = await buildEstimateMembershipContext(estimate);
    const isOneTimeOnly = isStructuralOneTimeOnlyEstimate(estData, estimate);
    // Mirror accept's one-time availability gate before choosing the amount
    // class: serviceMode arrives from the client, and a one_time request on
    // an estimate whose accept would reject one-time mode must not create
    // the heavier $99 intent — the customer would be overcharged for an
    // acceptance that can only proceed as recurring ($49).
    if (req.body?.serviceMode === 'one_time' && !isOneTimeOnly) {
      const oneTimeChoicePrice = resolveAcceptOneTimeTotal(estimate, pricingBundle);
      const canChooseOneTime = !!estimate.show_one_time_option && oneTimeChoicePrice > 0;
      if (!canChooseOneTime) {
        return res.status(400).json({ error: 'one-time option is not available for this estimate' });
      }
    }
    const oneTime = req.body?.serviceMode === 'one_time' || isOneTimeOnly;
    // Mirror accept's annual-prepay availability gate BEFORE collecting money:
    // a prepay-annual accept is rejected for an ineligible service mix (and
    // the frozen-snapshot existing-customer case), so a stale/crafted client
    // requesting prepay must not pay a deposit for an acceptance shape the
    // server will 400. Live existing plan customers never reach the mint —
    // the deposit policy 409-exempts them below.
    if (req.body?.paymentMethodPreference === 'prepay_annual' && !annualPrepayEligibleForEstimateData(estData)) {
      return res.status(400).json({ error: 'annual prepay is not available for this estimate' });
    }
    // Mirror accept's invoice-mode customer gate BEFORE collecting money:
    // accept rejects an invoice-mode estimate (admin flag OR derived
    // guarantee-only renewal) with no linked customer and no customer phone —
    // it can't create/deliver the invoice — so minting the deposit here first
    // would strand money on an acceptance the server will reject.
    if (resolveEstimateInvoiceMode(estimate, estData) && !estimate.customer_id && !estimate.customer_phone) {
      return res.status(400).json({ error: 'Please call Waves to complete this estimate.' });
    }
    // The ForEstimate wrapper adds the LIVE plan-customer fallback — legacy
    // customer-linked estimates have no membershipSnapshot, and minting an
    // intent here would charge a current WaveGuard member who owes nothing.
    const policy = await resolveDepositPolicyForEstimate({
      estimate,
      membership,
      oneTime,
      // Effective invoice mode (admin flag OR derived guarantee-only renewal)
      // — mirrors accept, so a guarantee-only deposit never demands a booking
      // (noVisit also lifts the plan-customer booking commitment gate: a
      // renewal has no appointment to book).
      oneTimeUninvoiced: oneTime && !resolveEstimateInvoiceMode(estimate, estData),
      noVisit: isRodentGuaranteeOnlyEstimate(estimate, estData),
    });
    // A narrow low-confidence commercial RECURRING accept is held for on-site
    // price confirmation — whatever the billing mode, no money moves at accept
    // (invoice-mode holds the first-invoice mint; non-invoice bills per
    // application after the confirmed visit), so there's nothing to credit a
    // deposit against. Exempt it here too (matches the accept handler + the
    // /data deposit policy), so a "no payment now" estimate never collects a
    // deposit at the confirm step.
    if (!oneTime) {
      const lc = commercialLowConfidenceRange(estData);
      if (lc.hasLowConfidence && !lc.forceSiteQuote) {
        return res.status(409).json({ error: 'No deposit is required for this estimate', exemptReason: 'commercial_manual_billing' });
      }
    }
    if (!policy.required) {
      return res.status(409).json({ error: 'No deposit is required for this estimate', exemptReason: policy.exemptReason || null });
    }
    // Mirror accept's appointment gate BEFORE collecting money: a one-time
    // uninvoiced accept with no booking is rejected (APPOINTMENT_REQUIRED at
    // accept), so minting the PI first would charge $99 for an acceptance
    // that cannot complete — the same live-reservation / linked-appointment
    // lookup accept validates against must succeed here first.
    if (policy.slotRequired) {
      const booking = await findLinkedUpcomingAppointment(estimate, estData);
      if (!booking) {
        return res.status(400).json({
          error: 'Please pick your first appointment before paying the deposit',
          code: 'APPOINTMENT_REQUIRED',
        });
      }
    }

    const intent = await createDepositIntentForEstimate(estimate, { oneTime });
    if (!intent) {
      return res.status(503).json({ error: 'Payments are temporarily unavailable. Please call us to confirm your service.' });
    }
    // Ledger already covers the policy amount (e.g. paid the one-time $99,
    // then switched back to recurring) — nothing to charge; the client can
    // proceed straight to accept.
    if (intent.alreadySatisfied) {
      return res.json({
        success: true,
        alreadySatisfied: true,
        amount: 0,
        requiredAmount: intent.requiredAmount,
        receivedTotal: intent.receivedTotal,
      });
    }
    return res.json({
      success: true,
      clientSecret: intent.clientSecret,
      // `amount` is the top-up this intent charges; requiredAmount is the
      // full policy amount the gate will verify against the ledger.
      amount: intent.amount,
      requiredAmount: intent.requiredAmount,
      receivedTotal: intent.receivedTotal,
      paymentIntentId: intent.paymentIntentId,
      // Both estimate UIs bootstrap Stripe Elements from this response —
      // the public estimate pages have no other authenticated key source.
      publishableKey: require('../config/stripe-config').publishableKey,
    });
  } catch (err) {
    logger.error(`[estimate-slots-public:deposit-intent] ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /:token/card-hold-intent — Stripe SetupIntent to capture the card that
// HOLDS a one-time visit (dark until ONE_TIME_CARD_HOLD). No money is taken:
// the saved card is charged the final total on completion, and a flat no-show
// fee only if the customer cancels inside the window or isn't home. Gates
// mirror accept: token format, terminal/expired rejection, the quote gate, the
// one-time availability gate, and the card-hold policy (recurring / invoice-
// mode / prepay owe no hold). The client confirms the SetupIntent, then calls
// accept with cardHoldSetupIntentId.
router.post('/:token/card-hold-intent', depositLimiter, async (req, res) => {
  const token = req.params.token;
  if (!token || !TOKEN_RE.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const estimate = await db('estimates').where({ token }).first();
    if (!estimate) return res.status(404).json({ error: 'Not found' });
    if (estimate.status === 'accepted') return res.status(409).json({ error: 'Estimate already accepted' });
    if (!isEstimateAcceptActive(estimate)) return res.status(409).json({ error: 'Estimate is no longer active' });
    await reconcileFrozenMembershipSnapshot(estimate);

    const estData = parseEstimateData(estimate);
    const pricingBundle = await buildPricingBundle(estimate);
    const quoteRequirement = resolveEstimateQuoteRequirement(pricingBundle, estData);
    if (quoteRequirement.quoteRequired) {
      return res.status(409).json({ error: 'Estimate is no longer active' });
    }
    if (estimateTrenchingReviewRequired(estData)) {
      return res.status(409).json(TRENCHING_REVIEW_409);
    }

    // The hold only applies to a one-time booking — mirror accept's one-time
    // availability gate before minting the intent so a one_time request on an
    // estimate whose accept would reject one-time mode never captures a card.
    const isOneTimeOnly = isStructuralOneTimeOnlyEstimate(estData, estimate);
    if (req.body?.serviceMode === 'one_time' && !isOneTimeOnly) {
      const oneTimeChoicePrice = resolveAcceptOneTimeTotal(estimate, pricingBundle);
      const canChooseOneTime = !!estimate.show_one_time_option && oneTimeChoicePrice > 0;
      if (!canChooseOneTime) {
        return res.status(400).json({ error: 'one-time option is not available for this estimate' });
      }
    }
    const treatAsOneTime = req.body?.serviceMode === 'one_time' || isOneTimeOnly;

    const policy = resolveCardHoldPolicy({
      treatAsOneTime,
      // Effective invoice mode (admin flag OR derived guarantee-only renewal)
      // — mirrors accept's card-hold gate: invoice-mode accepts owe no hold.
      billByInvoice: resolveEstimateInvoiceMode(estimate, estData),
      paymentMethodPreference: req.body?.paymentMethodPreference === 'prepay_annual' ? 'prepay_annual' : null,
    });
    if (!policy.required) {
      return res.status(409).json({ error: 'No card hold is required for this estimate', exemptReason: policy.exemptReason || null });
    }

    const intent = await createCardHoldSetupIntentForEstimate(estimate);
    if (!intent) {
      return res.status(503).json({ error: 'Payments are temporarily unavailable. Please call us to confirm your service.' });
    }
    return res.json({
      success: true,
      clientSecret: intent.clientSecret,
      setupIntentId: intent.setupIntentId,
      noShowFeeAmount: intent.noShowFeeAmount,
      cancelWindowHours: intent.cancelWindowHours,
      // Both estimate UIs bootstrap Stripe Elements from this response — the
      // public estimate pages have no other authenticated key source.
      publishableKey: require('../config/stripe-config').publishableKey,
    });
  } catch (err) {
    logger.error(`[estimate-slots-public:card-hold-intent] ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

// DELETE /:token/reserve/:scheduledServiceId — release a live hold
// when the customer taps "Change my pick" or closes the tab. Narrow —
// only deletes rows still in reservation state (no customer_id). Safe
// to spam; always returns 200 so the client never has to special-case
// "already released."
router.delete('/:token/reserve/:scheduledServiceId', async (req, res) => {
  const token = req.params.token;
  const scheduledServiceId = req.params.scheduledServiceId;
  if (!token || !TOKEN_RE.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const estimate = await db('estimates').where({ token }).first('id');
    if (!estimate) return res.status(404).json({ error: 'Not found' });
    const result = await slotReservation.releaseReservation({
      scheduledServiceId,
      estimateId: estimate.id,
    });
    return res.json({ ok: true, released: result.released });
  } catch (err) {
    logger.error(`[estimate-slots-public:release] ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'unable to release reservation' });
  }
});

module.exports = router;
