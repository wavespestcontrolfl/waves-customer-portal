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
 * POST /api/public/estimates/:token/reserve/:scheduledServiceId/extend
 *   Pushes a live hold's expiry out by another DEFAULT_HOLD_MINUTES, capped
 *   at MAX_HOLD_MINUTES total lifetime since the hold's created_at (see
 *   services/slot-reservation.js's extendReservation). Same 10/min budget as
 *   /reserve.
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
const StripeService = require('../services/stripe');
const { getAvailableSlots, findEstimateSlots, MAX_SLOT_HORIZON_DAYS } = require('../services/estimate-slot-availability');
const { addETDays, etDateString } = require('../utils/datetime-et');
const slotReservation = require('../services/slot-reservation');
const {
  annualPrepayEligibleForEstimateData,
  buildPricingBundle,
  commercialAcceptDepositExempt,
  isCommercialAutoAcceptEstimate,
  isPestServiceName,
  shouldPersistPestOnlyRecurringChoice,
  estimateTrenchingReviewRequired,
  handleEstimateAsk,
  isEstimateAcceptActive,
  matchAcceptCustomerByPhone,
  isEstimateCustomerViewable,
  isRodentGuaranteeOnlyEstimate,
  isStructuralOneTimeOnlyEstimate,
  reconcileFrozenMembershipSnapshot,
  resolveAcceptOneTimeTotal,
  resolveEstimateInvoiceMode,
  resolveEstimateQuoteRequirement,
  resolveEstimateAcceptance,
  estimateRendersMonthlyBilling,
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
  createCardHoldSetupIntentForEstimate,
  resolveCardHoldPolicy,
} = require('../services/estimate-card-holds');
const {
  createRecurringCardSetupIntentForEstimate,
  replaceRecurringCardIntent,
  resolveRecurringCardPolicyForEstimate,
} = require('../services/recurring-card-on-file');
const { recordCheckoutStepReached, CHECKOUT_KIND } = require('../services/estimate-checkout-events');

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

// Cache/privacy parity with GET /:token/data (estimate-public.js): these
// responses are tokenized and can carry availability tied to a customer's
// address — no shared-browser or intermediary retention, no referrer leak of
// the tokenized URL. Stamped before any branch so every response path
// (including 4xx/429) carries them.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

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
// 'void' matches the services' terminal set (reserveSlot's ESTIMATE_TERMINAL
// list) so the router and service layers reject the same states.
const SLOT_BLOCKED_STATES = new Set(['accepted', 'declined', 'expired', 'void']);

// A persisted bermuda-suppression estimate takes NO money, holds, or slot
// reservations while GATE_BERMUDA_SUPPRESSION is off — the money-boundary
// mirror of the accept/send/manual-accept gates (codex #3272 r5 P0: a
// PaymentIntent minted gate-on must never finalize gate-off). Returns a
// sent 409 (caller must `return` it) or null when unaffected. Callers'
// row loads all carry estimate_data (`.first()` or an explicit column).
function rejectGatedSuppressionEstimate(res, estimate = {}) {
  const { estimateDataCarriesBermudaSuppression } = require('../services/pricing-engine/v1-legacy-mapper');
  if (estimateDataCarriesBermudaSuppression(estimate.estimate_data)
    && !require('../config/feature-gates').gateEnvValue('GATE_BERMUDA_SUPPRESSION')) {
    return res.status(409).json({
      error: 'This estimate includes an option that is temporarily unavailable. Please contact our office and we will refresh your quote.',
      code: 'BERMUDA_SUPPRESSION_GATED',
    });
  }
  return null;
}

// The DURABLE call-side verdict (codex P1, PR #3304 GH r10): when a
// quarantine could not write its estimate-side marker, the block lives on
// the CALL — and every route in this router (slots, holds, card intents,
// deposit finalize) reads the estimate only, so a quarantined wrong-lead
// estimate could still expose availability, reserve a scheduled service,
// mint a payment intent, and take money. Same generic 404 as an
// unviewable estimate.
async function rejectCallSideBlockedEstimate(res, estimate = {}) {
  const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
  let data = estimate?.estimate_data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  if (!data || typeof data !== 'object') return null;
  if (await callSideBlockForEstimateData(db, data, { estimateStatus: estimate?.status })) {
    return res.status(404).json({ error: 'Not found' });
  }
  return null;
}

function rejectIneligibleEstimate(res, estimate = {}) {
  // Parity with GET /:token/data's exposure gate (isEstimateCustomerViewable,
  // estimate-public.js): archived, unpublished (draft/scheduled), send_failed,
  // and past-expiry estimates must not expose availability or take holds —
  // same 404 shape /data uses. Callers must SELECT archived_at/status/
  // expires_at for this check to see them. This check runs FIRST: an archived
  // estimate whose status is also terminal (accepted/declined/…) must return
  // the same generic 404 as a missing token — a 409 here would make archived
  // tokens distinguishable from nonexistent ones.
  if (!isEstimateCustomerViewable(estimate)) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (SLOT_BLOCKED_STATES.has(estimate.status)) {
    return res.status(409).json({ error: 'Estimate is no longer active' });
  }
  const gated = rejectGatedSuppressionEstimate(res, estimate);
  if (gated) return gated;
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

// The estimate columns the page's slot gate reads (slotBrowseRefusal).
const SLOT_ESTIMATE_COLUMNS = ['id', 'status', 'expires_at', 'archived_at', 'estimate_data', 'monthly_total', 'annual_total', 'onetime_total', 'service_interest'];

// Everything GET /:token/available-slots can answer with INSTEAD of slots —
// the estimate is refused, terminal, or not self-schedulable (commercial,
// invoice-only renewal, trenching review). null = the page browses slots.
// Also the texting AI's gate (offerableEstimateSlots): it offers an estimate
// time only when this page would.
async function slotBrowseRefusal(estimate) {
  let refusal = null;
  const sink = { status(status) { return { json(body) { refusal = { status, body }; return refusal; } }; } };
  // Fail closed: a helper that refuses without the status().json() chain the
  // sink captures still refuses (generic 404, never a browsable estimate).
  if (await rejectCallSideBlockedEstimate(sink, estimate) || rejectIneligibleEstimate(sink, estimate)) {
    return refusal || { status: 404, body: { error: 'Not found' } };
  }
  if (isCommercialAutoEstimate(estimate)) {
    return {
      status: 200,
      body: {
        primary: [], expander: [], availableSlots: [], summary: null,
        commercialManualScheduling: true,
        message: 'A Waves team member will reach out to schedule your commercial service.',
      },
    };
  }
  // A guarantee-only renewal accepts through the payment-only invoice path —
  // there is NO visit to book, so the slot picker never renders. Return the
  // empty no-booking shape (mirroring the accept-time gate) so a crafted or
  // stale client can't browse slots for an estimate whose accept takes none.
  if (isRodentGuaranteeOnlyEstimate(estimate, parseEstimateData(estimate))) {
    return {
      status: 200,
      body: {
        primary: [], expander: [], availableSlots: [], summary: null,
        invoiceOnlyAcceptance: true,
        message: 'No appointment is needed — this renewal is accepted with an invoice.',
      },
    };
  }
  if (estimateTrenchingReviewRequired(parseEstimateData(estimate))) {
    return {
      status: 200,
      body: {
        primary: [], expander: [], availableSlots: [], summary: null,
        reviewBeforeBooking: true,
        message: 'A Waves specialist will confirm your termite trenching treatment path and schedule your visit.',
      },
    };
  }
  return null;
}

router.get('/:token/available-slots', async (req, res) => {
  const token = req.params.token;
  if (!token || !TOKEN_RE.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const estimate = await db('estimates')
      .where({ token })
      .first(...SLOT_ESTIMATE_COLUMNS);
    if (!estimate) {
      return res.status(404).json({ error: 'Not found' });
    }
    const refusal = await slotBrowseRefusal(estimate);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const windowDays = Number.parseInt(req.query.windowDays, 10);
    const opts = {};
    if (Number.isFinite(windowDays) && windowDays > 0 && windowDays <= MAX_SLOT_HORIZON_DAYS) {
      opts.windowDays = windowDays;
    }
    if (typeof req.query.timeOfDay === 'string' && req.query.timeOfDay.trim()) {
      opts.timeOfDay = req.query.timeOfDay.trim();
    }
    opts.serviceMode = resolveSlotServiceMode(estimate, req.query.serviceMode);
    if (typeof req.query.selectedFrequency === 'string' && req.query.selectedFrequency.trim()) {
      opts.selectedFrequency = req.query.selectedFrequency.trim();
    }
    // Bundle combo axes arrive JSON-encoded (?serviceCadences={"mosquito":
    // "seasonal9"}): the mosquito tier changes the seasonal filter/horizon
    // while selectedFrequency stays the pest cadence (codex r14 P1).
    if (typeof req.query.serviceCadences === 'string' && req.query.serviceCadences.trim()) {
      try {
        const parsed = JSON.parse(req.query.serviceCadences);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          opts.serviceCadences = parsed;
        }
      } catch { /* malformed axis param — ignore, stored-row profile applies */ }
    }
    // Specific-date browse: ?date=YYYY-MM-DD pins the lookup to a single day.
    // Horizon parity with reserveSlot (slot-reservation.js): the reserve path
    // rejects any slot past the horizon in ET, so browsing must not display
    // far-future days whose every slot would 409 on the first tap. Same ET
    // day-string compare, same strict `>` so the boundary day both displays
    // and reserves. Seasonal selections use the extended winter-gap horizon
    // (their default window opens at the next Feb 1, which can sit past the
    // standard 90 days on Nov 1–2 — codex r10 P2); resolved AFTER
    // serviceMode/selectedFrequency parse so the profile matches reserve's.
    // Silently substituting the default window (the windowDays treatment)
    // would mislead here — the customer asked for a specific day — so an
    // out-of-horizon date is a 400 like find-slots' out-of-bound query.
    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const slotAvailability = require('../services/estimate-slot-availability');
      // Guarded like slot-reservation's profile resolution — suites mock this
      // module down to the functions they assert on.
      const seasonalBrowse = typeof slotAvailability.resolveEstimateSlotProfile === 'function'
        && typeof slotAvailability.seasonalSelectionProfile === 'function'
        && slotAvailability.seasonalSelectionProfile(
          slotAvailability.resolveEstimateSlotProfile(estimate, opts),
        );
      const browseHorizonDays = seasonalBrowse && typeof slotAvailability.seasonalMaxHorizonDays === 'function'
        ? slotAvailability.seasonalMaxHorizonDays()
        : MAX_SLOT_HORIZON_DAYS;
      if (date > etDateString(addETDays(new Date(), browseHorizonDays))) {
        return res.status(400).json({ error: 'date is beyond the booking horizon' });
      }
      opts.dateFrom = date;
      opts.dateTo = date;
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
    if (err.code === 'COMBINED_VISIT_UNAVAILABLE') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    if (err.code === 'SLOT_UNAVAILABLE') {
      const unavailable = require('../services/scheduling/arrival-route').capacityError();
      return res.status(409).json({ error: unavailable.message, code: unavailable.code, retry: true });
    }
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
      .first('id', 'status', 'expires_at', 'archived_at', 'estimate_data', 'monthly_total', 'annual_total', 'onetime_total', 'service_interest');
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
    const callBlocked = await rejectCallSideBlockedEstimate(res, estimate);
    if (callBlocked) return callBlocked;
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
    const findServiceCadences = req.body?.serviceCadences && typeof req.body.serviceCadences === 'object'
      && !Array.isArray(req.body.serviceCadences)
      ? req.body.serviceCadences
      : undefined;
    try {
      const result = await findEstimateSlots(estimate.id, {
        query, serviceMode, selectedFrequency, serviceCadences: findServiceCadences,
      });
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
    if (err.code === 'COMBINED_VISIT_UNAVAILABLE') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    if (err.code === 'SLOT_UNAVAILABLE') {
      const unavailable = require('../services/scheduling/arrival-route').capacityError();
      return res.status(409).json({ error: unavailable.message, code: unavailable.code, retry: true });
    }
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
  // Bundle combo axes (codex r14 P1): the mosquito tier can travel as
  // serviceCadences.mosquito while selectedFrequency stays the pest cadence —
  // the reserve-side seasonal redemption check needs it.
  if (req.body?.serviceCadences && typeof req.body.serviceCadences === 'object'
    && !Array.isArray(req.body.serviceCadences)) {
    slotOpts.serviceCadences = req.body.serviceCadences;
  }

  try {
    const estimate = await db('estimates')
      .where({ token })
      .first('id', 'status', 'expires_at', 'archived_at', 'estimate_data', 'monthly_total', 'annual_total', 'onetime_total', 'service_interest');
    if (!estimate) {
      return res.status(404).json({ error: 'Not found' });
    }
    const callBlocked = await rejectCallSideBlockedEstimate(res, estimate);
    if (callBlocked) return callBlocked;
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
    if (err.code === 'COMBINED_VISIT_UNAVAILABLE') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    logger.error(`[estimate-slots-public:reserve] ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'unable to reserve slot', retry: true });
  }
});


// POST /:token/deposit-intent — RETIRED VERDICT STUB (owner ruling
// 2026-08-10). Acceptance deposits are permanently not-enforced and the
// mint/quote/finalize/reset machinery was removed — but the accept flow's
// client still consults this endpoint after a non-superseding card/hold
// 409 (its "is a deposit owed after all?" re-check) and treats any 409
// with an exemptReason as "nothing owed — proceed to accept". A 404 here
// would read as a failure and BLOCK those accepts. No PI is minted; no
// Stripe code exists behind this route.
// The quote/finalize/reset legs get the SAME verdict (pre-push P1): they
// were only reachable from inside an open deposit modal — impossible in
// live prod since the flag went dark 2026-07-10 — but a 409 here is also
// exactly what the kill-switch check returned when the flag was off, so
// the stubs preserve the live contract instead of swapping it for 404s.
for (const retiredDepositLeg of ['deposit-intent', 'deposit-quote', 'deposit-finalize', 'deposit-reset']) {
  router.post(`/:token/${retiredDepositLeg}`, depositLimiter, async (req, res) => {
    const token = req.params.token;
    if (!token || !TOKEN_RE.test(token)) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.status(409).json({ error: 'No deposit is required for this estimate', exemptReason: 'deposits_retired' });
  });
}

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
    const callBlocked = await rejectCallSideBlockedEstimate(res, estimate);
    if (callBlocked) return callBlocked;
    const suppressionGated = rejectGatedSuppressionEstimate(res, estimate);
    if (suppressionGated) return suppressionGated;
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

    // Auto-satisfy (spec §3.2: existing customers with a saved card are
    // never re-asked): a saved consented card backs the hold at accept, so
    // no capture modal — the 409 exemptReason makes the client fall through
    // to accept, where the gate resolves the same saved method. Lookup
    // failure mints normally (fail toward asking).
    try {
      // Phone-only estimates: resolve the same unambiguous customer match
      // the accept gate + transaction use, or an existing customer's saved
      // card is invisible here and they get re-asked (r4 P2).
      let holdCustomerId = estimate.customer_id || null;
      if (!holdCustomerId && estimate.customer_phone) {
        const { match } = await matchAcceptCustomerByPhone(estimate);
        holdCustomerId = match?.id || null;
      }
      const savedCard = holdCustomerId
        ? await require('../services/payment-method-consents').findConsentedChargeableCard(holdCustomerId)
        : null;
      if (savedCard?.stripe_payment_method_id) {
        return res.status(409).json({ error: 'A saved card already covers this booking', exemptReason: 'saved_method' });
      }
    } catch (err) {
      logger.warn(`[estimate-slots-public:card-hold-intent] saved-method check failed — minting capture intent: ${err.message}`);
    }

    const intent = await createCardHoldSetupIntentForEstimate(estimate);
    if (!intent) {
      return res.status(503).json({ error: 'Payments are temporarily unavailable. Please call us to confirm your service.' });
    }
    // The customer reached the save-a-card step — the only local evidence of
    // it (the SetupIntent lives in Stripe). Non-throwing; feeds the
    // payment-step-abandoned follow-up stage.
    await recordCheckoutStepReached(estimate.id, CHECKOUT_KIND.CARD_HOLD, intent.setupIntentId);
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

// POST /:token/recurring-card-intent — Stripe SetupIntent that saves the card
// powering Auto Pay on a RECURRING accept (dark until RECURRING_CARD_ON_FILE).
// No money is taken: the deposit is charged separately through /deposit-intent
// exactly as before, and completed applications later auto-charge the enrolled
// method. Gates mirror accept: token format, terminal/expired rejection, the
// quote gate, and the recurring card policy (one-time / invoice-mode / prepay /
// plan-member / payer-billed / already-on-Auto-Pay owe no card here). The
// client confirms the SetupIntent, then calls accept with
// recurringCardSetupIntentId.
router.post('/:token/recurring-card-intent', depositLimiter, async (req, res) => {
  const token = req.params.token;
  if (!token || !TOKEN_RE.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const estimate = await db('estimates').where({ token }).first();
    if (!estimate) return res.status(404).json({ error: 'Not found' });
    const callBlocked = await rejectCallSideBlockedEstimate(res, estimate);
    if (callBlocked) return callBlocked;
    const suppressionGated = rejectGatedSuppressionEstimate(res, estimate);
    if (suppressionGated) return suppressionGated;
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

    // The Auto Pay card only applies to the recurring lane — a one-time
    // request keeps its own card-hold intent endpoint.
    const treatAsOneTime = req.body?.serviceMode === 'one_time'
      || isStructuralOneTimeOnlyEstimate(estData, estimate);
    // Mirror accept's contact gate BEFORE capturing a card: a recurring accept
    // with no linked customer and no phone is rejected pre-commit
    // (CUSTOMER_CONTACT_REQUIRED — accept-time customer creation is
    // phone-keyed), so letting an email-only estimate confirm a SetupIntent
    // here would strand a captured payment method on an acceptance the server
    // will refuse (Codex #2668 P2). Same shape as /deposit-intent's
    // invoice-mode contact mirror.
    if (!treatAsOneTime && !estimate.customer_id && !estimate.customer_phone) {
      return res.status(400).json({ error: 'Please call Waves to complete this estimate.' });
    }
    // Commercial manual-billing accepts collect nothing at accept — the SAME
    // commercialAcceptDepositExempt predicate the accept gate and
    // /deposit-intent run. Without it, a commercial auto-priced recurring
    // estimate could capture a card the accept-side exemption never enrolls.
    {
      const lc = commercialLowConfidenceRange(estData);
      if (commercialAcceptDepositExempt({
        isCommercialAccept: isCommercialAutoAcceptEstimate(estimate),
        siteConfirmationHold: !treatAsOneTime && lc.hasLowConfidence && !lc.forceSiteQuote,
        treatAsOneTime,
        billByInvoice: resolveEstimateInvoiceMode(estimate, estData),
      })) {
        return res.status(409).json({ error: 'No card on file is required for this estimate', exemptReason: 'commercial_manual_billing' });
      }
    }
    const membership = await buildEstimateMembershipContext(estimate);
    const policy = await resolveRecurringCardPolicyForEstimate({
      estimate,
      membership,
      treatAsOneTime,
      billByInvoice: resolveEstimateInvoiceMode(estimate, estData),
      paymentMethodPreference: req.body?.paymentMethodPreference === 'prepay_annual' ? 'prepay_annual' : null,
    });
    if (!policy.required) {
      return res.status(409).json({ error: 'No card on file is required for this estimate', exemptReason: policy.exemptReason || null });
    }

    // "Use a different payment method": the customer already saved one on
    // this estimate's succeeded intent and wants to replace it. The service
    // mints the replacement first, then retires the old intent in Stripe
    // (the accept gate refuses it from here on; the deterministic mint
    // follows it to the replacement). Fails closed on an id that is not
    // this estimate's own capture.
    const replaceSetupIntentId = typeof req.body?.replaceSetupIntentId === 'string'
      ? req.body.replaceSetupIntentId.trim()
      : '';
    let intent = null;
    if (replaceSetupIntentId) {
      const replaced = await replaceRecurringCardIntent({ estimate, setupIntentId: replaceSetupIntentId });
      if (!replaced.ok) {
        if (replaced.reason === 'estimate_accepted') return res.status(409).json({ error: 'Estimate already accepted' });
        if (replaced.reason === 'estimate_inactive') return res.status(409).json({ error: 'Estimate is no longer active' });
        return res.status(replaced.reason === 'intent_mismatch' ? 400 : 503).json({
          error: 'We could not switch your payment method. Please refresh this page and try again.',
        });
      }
      intent = replaced.intent;
    } else {
      intent = await createRecurringCardSetupIntentForEstimate(estimate);
    }
    if (!intent) {
      return res.status(503).json({ error: 'Payments are temporarily unavailable. Please call us to confirm your service.' });
    }
    // The customer reached the save-a-card step — the only local evidence of
    // it (the SetupIntent lives in Stripe). Non-throwing; feeds the
    // payment-step-abandoned follow-up stage.
    await recordCheckoutStepReached(estimate.id, CHECKOUT_KIND.RECURRING_CARD, intent.setupIntentId);
    return res.json({
      success: true,
      clientSecret: intent.clientSecret,
      setupIntentId: intent.setupIntentId,
      // Tender families the intent allows (GATE_ACCEPT_ACH_CAPTURE adds
      // us_bank_account) — the capture UI keys its copy on this.
      paymentMethodTypes: intent.paymentMethodTypes,
      // Succeeded replay only: the tender already captured on the intent,
      // so the UI renders the matching consent instead of defaulting to card.
      capturedMethodType: intent.capturedMethodType || null,
      // Both estimate UIs bootstrap Stripe Elements from this response — the
      // public estimate pages have no other authenticated key source.
      publishableKey: require('../config/stripe-config').publishableKey,
    });
  } catch (err) {
    logger.error(`[estimate-slots-public:recurring-card-intent] ${err.message}`, { stack: err.stack });
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

const HOLD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /:token/reserve/:scheduledServiceId/extend — "extend my hold"
// (2026-09-11 incident: a customer whose 15-min hold ticked over while she
// was still entering payment believed she'd booked and paid). Pushes the
// hold's expiry out by another DEFAULT_HOLD_MINUTES, capped at
// MAX_HOLD_MINUTES total lifetime since the hold was created — same rate
// budget as /reserve since it's a write. Same token/estimate gates as
// /reserve; the underlying grace + cap contract lives in
// slot-reservation.js's extendReservation.
router.post('/:token/reserve/:scheduledServiceId/extend', reserveLimiter, async (req, res) => {
  const token = req.params.token;
  const scheduledServiceId = req.params.scheduledServiceId;
  if (!token || !TOKEN_RE.test(token)) {
    return res.status(404).json({ error: 'Not found' });
  }
  // UUID gate BEFORE any query (hold-grace self-audit): scheduled_services.id is a
  // uuid column, so a malformed id would raise 22P02 and surface as a 500 —
  // an error log, and a distinguishable response for what must be the same
  // generic 404 an unknown hold gets.
  if (!HOLD_ID_RE.test(String(scheduledServiceId || ''))) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const estimate = await db('estimates')
      .where({ token })
      .first('id', 'status', 'expires_at', 'archived_at', 'estimate_data', 'monthly_total', 'annual_total', 'onetime_total', 'service_interest');
    if (!estimate) {
      return res.status(404).json({ error: 'Not found' });
    }
    const callBlocked = await rejectCallSideBlockedEstimate(res, estimate);
    if (callBlocked) return callBlocked;
    const ineligible = rejectIneligibleEstimate(res, estimate);
    if (ineligible) return ineligible;
    // The SAME specialized no-booking guards /reserve applies (codex r5 P1),
    // as ONE predicate used twice: here on the pre-txn read, and again inside
    // the service under the estimate's row lock (codex r6 P1) — the route's
    // read can go stale while the txn waits, and these shapes live in
    // estimate_data, which the locked viewability check does not re-derive.
    const noBookingRefusal = (row) => {
      // The suppression gate belongs in the locked recheck too (codex r8 P2):
      // staff can reshape an estimate into a Bermuda-suppression shape after
      // the pre-txn rejectIneligibleEstimate passed, and extending then
      // answers 200 for a quote the customer is refused everywhere else,
      // holding capacity until the next refusal. Same body the pre-txn path
      // returns.
      const { estimateDataCarriesBermudaSuppression } = require('../services/pricing-engine/v1-legacy-mapper');
      if (estimateDataCarriesBermudaSuppression(row.estimate_data)
        && !require('../config/feature-gates').gateEnvValue('GATE_BERMUDA_SUPPRESSION')) {
        return {
          status: 409,
          body: {
            error: 'This estimate includes an option that is temporarily unavailable. Please contact our office and we will refresh your quote.',
            code: 'BERMUDA_SUPPRESSION_GATED',
          },
        };
      }
      if (isCommercialAutoEstimate(row)) {
        return {
          status: 409,
          body: {
            error: 'Commercial service is scheduled by our team — no self-booking.',
            commercialManualScheduling: true,
          },
        };
      }
      if (isRodentGuaranteeOnlyEstimate(row, parseEstimateData(row))) {
        return {
          status: 409,
          body: {
            error: 'No appointment is needed for this renewal — accept without booking.',
            invoiceOnlyAcceptance: true,
          },
        };
      }
      if (estimateTrenchingReviewRequired(parseEstimateData(row))) {
        return { status: 409, body: TRENCHING_REVIEW_409 };
      }
      return null;
    };
    const preTxnRefusal = noBookingRefusal(estimate);
    if (preTxnRefusal) return res.status(preTxnRefusal.status).json(preTxnRefusal.body);

    try {
      const { scheduledServiceId: extendedId, expiresAt } = await slotReservation.extendReservation({
        estimateId: estimate.id,
        scheduledServiceId,
        // Re-run under the estimate's row lock with the LOCKED row.
        revalidateEstimate: noBookingRefusal,
      });
      return res.json({
        scheduledServiceId: extendedId,
        expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
      });
    } catch (svcErr) {
      if (svcErr.code === 'RESERVATION_NOT_FOUND' || svcErr.code === 'ESTIMATE_NOT_FOUND' || svcErr.code === 'ESTIMATE_EXPIRED') {
        return res.status(404).json({ error: 'Not found' });
      }
      if (svcErr.code === 'ESTIMATE_NO_BOOKING' && svcErr.response) {
        // The locked revalidation refused — same body the pre-txn guard
        // uses, so the client's existing handling applies unchanged.
        return res.status(svcErr.response.status).json(svcErr.response.body);
      }
      if (svcErr.code === 'ESTIMATE_TERMINAL') {
        return res.status(409).json({ error: 'Estimate is no longer active' });
      }
      if (svcErr.code === 'HOLD_LIMIT_REACHED') {
        return res.status(409).json({
          error: 'Your time-slot hold has reached its limit — pick a time again',
          code: 'HOLD_LIMIT_REACHED',
          expiresAt: svcErr.expiresAt instanceof Date ? svcErr.expiresAt.toISOString() : svcErr.expiresAt,
        });
      }
      if (svcErr.code === 'SLOT_UNAVAILABLE') {
        return res.status(409).json({
          error: 'slot no longer available',
          code: 'SLOT_UNAVAILABLE',
          slotId: svcErr.slotId,
        });
      }
      if (svcErr.code === 'RESERVATION_EXPIRED') {
        // The blackout recheck's verdict (codex r10 P1): DEFINITIVE, not
        // retryable. Unmapped it fell through to the catch-all 500, which the
        // client treats as "no verdict" and keeps an unusable hold alive.
        return res.status(409).json({
          error: 'Your time-slot hold expired — pick a time again to finish signing up',
          code: 'RESERVATION_EXPIRED',
        });
      }
      throw svcErr;
    }
  } catch (err) {
    logger.error(`[estimate-slots-public:extend] ${err.message}`, { stack: err.stack });
    return res.status(500).json({ error: 'unable to extend hold', retry: true });
  }
});

// The slots the estimate page would show for one estimate, for the texting
// AI's OPEN TIMES (sms-shadow-drafter): the SAME gate (slotBrowseRefusal) and
// the same getAvailableSlots the page's GET runs (default window, the page's
// default service mode), so an offered time is one /reserve would take. null
// when the estimate is not this customer's, or the page would show none.
//
// `fresh` (the send-time recheck only): the same picker read UNCACHED and
// UNCAPPED. The page's default read serves a 5-minute cache other estimates'
// bookings never invalidate, and returns a curated cut (day rotation, scarce
// day pin, route order) in which one unrelated hold change can drop a still-
// bookable quoted slot — so the recheck asks for every slot the page's
// filters allow, straight from the calendar. The draft keeps the default cut.
const FRESH_MAX_SLOTS = 10000;

// Bundle combo axes (the page's serviceCadences memo): each non-pest axis'
// section default, skipping an axis with no rendered section exactly as the
// page does. null = the page sends none (not a bundle, or the bundle fell back
// to one synthetic section); false = cannot be reconstructed reliably (only
// some axes rendered, or no combo priced for the default selection).
function defaultComboCadences(pricing, sections, selectedFrequency, sectionDefault) {
  const combos = Array.isArray(pricing.serviceCadenceCombos) ? pricing.serviceCadenceCombos : [];
  if (!combos.length) return null;
  const axisKeys = Object.keys(combos[0]?.selection || {}).filter((k) => k !== 'pest_control');
  if (!axisKeys.length) return null;
  const cadences = {};
  for (const axis of axisKeys) {
    const section = sections.find((s) => s.key === axis);
    const key = section ? sectionDefault(section) : null;
    if (key) cadences[axis] = String(key);
  }
  const found = Object.keys(cadences).length;
  if (!found) return null;
  if (found !== axisKeys.length) return false;
  const priced = combos.some((combo) => {
    const sel = combo?.selection || {};
    const nonPest = Object.keys(sel).filter((k) => k !== 'pest_control');
    if (nonPest.length !== axisKeys.length || !axisKeys.every((k) => sel[k] === cadences[k])) return false;
    return sel.pest_control ? sel.pest_control === selectedFrequency : true;
  });
  return priced ? cadences : false;
}

// The selection the estimate page opens with — what SlotPicker.jsx sends as
// ?selectedFrequency= / ?serviceCadences= on its first fetch, before the
// customer touches anything. The page derives it from the /data `pricing`
// payload (EstimateViewPage.jsx pricingServices / defaultSelectedForServices /
// selectedPricingFrequencyKey / the serviceCadences memo); the server has no
// helper for it, so this mirrors that derivation over the SAME bundle /data
// serves (buildPricingBundle), keeping every axis the page sends:
//   selectedFrequency — the pest (else first recurring, else first) section's
//     default key (its `selected` / `recommended` frequency, else the first),
//     kept only when pricing.frequencies offers it, else frequencies[0];
//   serviceCadences   — bundles only: each non-pest combo axis' section
//     default key.
// Returns { selectedFrequency, serviceCadences } (either may be null, exactly
// as the page omits them), or null when the default cannot be reconstructed
// reliably (a combo axis with no section or default, or no combo priced for
// the default selection — accept would refuse it too): the caller withholds.
function pageDefaultSlotSelection(pricing) {
  if (!pricing || typeof pricing !== 'object') return null;
  const frequencies = Array.isArray(pricing.frequencies) ? pricing.frequencies : [];
  let sections = Array.isArray(pricing.services) ? pricing.services.filter(Boolean) : [];
  if (!sections.length && frequencies.length) {
    sections = [{ key: 'pest_control', isRecurring: true, frequencies, defaultFrequencyKey: frequencies[0]?.key || null }];
  }
  const sectionDefault = (section) => {
    const own = Array.isArray(section?.frequencies) ? section.frequencies : [];
    return section?.defaultFrequencyKey || own[0]?.key || null;
  };
  const primary = sections.find((s) => s.key === 'pest_control')
    || sections.find((s) => s.isRecurring)
    || sections[0];
  const primaryKey = primary ? sectionDefault(primary) : null;
  const selectedFrequency = frequencies.length
    ? (frequencies.some((f) => f?.key === primaryKey) ? primaryKey : (frequencies[0]?.key || null))
    : primaryKey;

  const cadences = defaultComboCadences(pricing, sections, selectedFrequency, sectionDefault);
  if (cadences === false) return null;
  const serviceCadences = cadences;
  return {
    selectedFrequency: selectedFrequency ? String(selectedFrequency) : null,
    serviceCadences,
  };
}

// A customer selection already saved on the estimate (accept writes it) is
// what resolveEstimateSlotProfile falls back to when no selectedFrequency is
// passed — that path stays exactly as it was.
function hasSavedCustomerSelection(estimate) {
  const selection = parseEstimateData(estimate).customerSelection;
  return !!(selection && (selection.serviceTierKey || selection.frequencyKey || selection.frequency));
}

// The texting AI's estimate for this customer, by the resolver's own two
// rules (estimate-conversion-agent resolveEstimateContext): the estimate is on
// the customer's record, or its customer_phone is the customer's own number —
// the phone fallback the resolver uses for an estimate with no (or another)
// customer_id. Both live drafters run only for a webhook-matched customer, so
// the customer's phone on file stands in for the texting number; a customer
// texting from some other number is offered nothing (fail closed).
function last10Digits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}
async function estimateBelongsToCustomer(estimate, customerId) {
  if (!customerId) return false;
  if (estimate.customer_id && String(estimate.customer_id) === String(customerId)) return true;
  const estimatePhone = last10Digits(estimate.customer_phone);
  if (!estimatePhone) return false;
  const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first('phone');
  return last10Digits(customer?.phone) === estimatePhone;
}

async function offerableEstimateSlots(estimateId, customerId, { fresh = false } = {}) {
  const estimate = await db('estimates').where({ id: estimateId }).first(...SLOT_ESTIMATE_COLUMNS, 'customer_id', 'customer_phone');
  if (!estimate || !(await estimateBelongsToCustomer(estimate, customerId))) return null;
  if (await slotBrowseRefusal(estimate)) return null;
  // The page's /data resolution for this estimate: its acceptance contract
  // decides whether the slot picker renders at all (quote-required, linked
  // existing appointment, invoice-only, commercial site-confirmation → no
  // picker, so no time the customer could pick), and its pricing bundle is
  // what the picker's first fetch derives the default selection from.
  // /data reconciles a stale frozen membership snapshot (in memory, never
  // persisted) before building either, so this does too: a lapsed plan can
  // reprice the default selection or make the estimate quote-required.
  let pricing;
  let full;
  try {
    full = await db('estimates').where({ id: estimate.id }).first();
    if (!full) return null;
    await reconcileFrozenMembershipSnapshot(full);
    pricing = await buildPricingBundle(full, { monthlyBilled: await estimateRendersMonthlyBilling(full) });
    const { acceptance } = await resolveEstimateAcceptance(full, parseEstimateData(full), pricing);
    if (acceptance?.mode !== 'standard_slot_pick') return null;
  } catch (err) {
    logger.warn(`[estimate-slots-public:offerable] page contract lookup failed (${err.message}); estimate times withheld`);
    return null;
  }
  const serviceMode = resolveSlotServiceMode(full, '');
  // The page's own first fetch (SlotPicker.jsx) always carries the default
  // selectedFrequency / serviceCadences of a recurring estimate — without them
  // the picker sizes the visit from frequencies[0] and unmodified companion
  // rows, a different duration / service mix than the customer's default.
  let selection = {};
  if (serviceMode !== 'one_time' && !hasSavedCustomerSelection(full)) {
    const derived = pageDefaultSlotSelection(pricing);
    if (!derived) return null;
    selection = {
      ...(derived.selectedFrequency ? { selectedFrequency: derived.selectedFrequency } : {}),
      ...(derived.serviceCadences ? { serviceCadences: derived.serviceCadences } : {}),
    };
  }
  try {
    return await getAvailableSlots(estimate.id, {
      serviceMode,
      ...selection,
      ...(fresh ? { bypassCache: true, maxResults: FRESH_MAX_SLOTS, expanderMaxResults: 0 } : {}),
    });
  } catch (err) {
    if (['ESTIMATE_NOT_FOUND', 'ESTIMATE_EXPIRED', 'ESTIMATE_TERMINAL'].includes(err.code)) return null;
    throw err;
  }
}

module.exports = router;
module.exports._internals = { offerableEstimateSlots, pageDefaultSlotSelection };
