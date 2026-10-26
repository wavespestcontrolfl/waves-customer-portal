// ============================================================
// estimate-assessment-public.js — "Book a free Waves Assessment first" from an
// open estimate (GATE_ESTIMATE_ASSESSMENT_FIRST; owner 2026-10-26, "OK GO" on
// decision page choice 3A).
//
// The /inspection booking page (inspection-public.js) belongs to a LEAD: its
// token is a signed lead token, and many estimates have no lead behind them.
// This router serves the same page contract keyed by the estimate's own
// token: the customer the estimate was sent to books one free Waves
// Assessment at the estimate's property. It reuses the inspection page's
// catalog, booking window, availability builder, slot match, commit
// (createSelfBooking with the assessment's internal callbackVisit and its
// per-customer assessment lane, which is the atomic dedupe) and success
// shape. The estimate stays open: an assessment is never a win (owner ruling
// 2026-09-08, services/assessment-booking.js), and the visit is not linked to
// the estimate (a linked visit would turn the estimate's accept into an
// existing-appointment accept).
//
// Eligible: an open, customer-viewable estimate (the durable call-side
// verdict, isEstimateCustomerViewable + isEstimateAcceptActive), not a
// property group, not drafted from a visit (that visit was the look), with a
// customer account whose stored address is the estimate's property (the
// consultation offer's sameProperty rule). A customer who already has an open
// Waves Assessment gets the page's already_booked state.
//
// Mounted in server/index.js on /api/public/estimate-assessment behind a
// pre-guard (privacy headers, the dark gate's 404 and the token format check
// land before the global limiter and the body parsers).
// ============================================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { noStore } = require('../middleware/no-store');
const { rateLimitKey } = require('../middleware/rate-limit-key');
const { estimateAssessmentFirstLive } = require('../config/feature-gates');

const router = express.Router();
router.use(noStore);
// The pre-guard already answered a dark gate; this keeps the router correct on its own.
router.use((req, res, next) => (estimateAssessmentFirstLive() ? next() : res.status(404).json({ error: 'not_found' })));

const limiter = (max, error) => rateLimit({
  windowMs: 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { error },
});
const readLimiter = limiter(30, 'Too many requests. Please try again in a minute.');
const findSlotsLimiter = limiter(15, 'Too many searches. Please try again in a minute.');
const commitLimiter = limiter(10, 'Too many booking attempts. Please try again in a minute.');

const SOURCE = 'estimate_assessment_link';
const ALERT_LABEL = '🔁 Free Waves Assessment booked from an estimate:';
const ALREADY_BOOKED_ERROR = 'You already have a Waves Assessment on the books.';
const CUSTOMER_COLUMNS = ['id', 'first_name', 'last_name', 'phone', 'email', 'account_id',
  'address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude'];

// Lazy: inspection-public and estimate-public are large route modules this file only borrows helpers from.
const inspection = () => require('./inspection-public')._internals;
const estimatePublic = () => require('./estimate-public');

function parseEstimateData(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

// The estimate a token names, or { notFound } (the generic 404) / { gone } (a viewable estimate that is no longer
// open: accepted or declined).
async function resolveEstimate(token) {
  const pub = estimatePublic();
  if (!pub.ESTIMATE_TOKEN_RE.test(String(token || ''))) return { notFound: true };
  const estimate = await db('estimates').where({ token }).first();
  if (!estimate) return { notFound: true };
  const data = parseEstimateData(estimate.estimate_data);
  const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
  if (await callSideBlockForEstimateData(db, data, { estimateStatus: estimate.status })) return { notFound: true };
  if (!pub.isEstimateCustomerViewable(estimate)) return { notFound: true };
  if (!pub.isEstimateAcceptActive(estimate)) return { gone: true };
  return { estimate, data };
}

// 'gone' (not offered for this estimate), 'already_booked' (an open Waves Assessment), else 'ok' with the customer.
// Shared with /data's offer (assessmentFirstFor), so the page never offers what this page refuses.
async function assessmentEligibility(estimate, data, conn = db) {
  if (estimate.estimate_group_id || data?.scheduled_service_id || !estimate.customer_id) return { state: 'gone' };
  const customer = await conn('customers').where({ id: estimate.customer_id }).whereNull('deleted_at').first(...CUSTOMER_COLUMNS);
  if (!customer?.address_line1) return { state: 'gone' };
  const { sameProperty } = require('../services/estimate-consultation-offer');
  if (!sameProperty(estimate.address, { line1: customer.address_line1, line2: customer.address_line2, zip: customer.zip })) {
    return { state: 'gone' };
  }
  const visit = await inspection().findOpenVisit(conn, customer.id, { assessmentOnly: true, futureOnly: true });
  if (visit) return { state: 'already_booked', customer, visit };
  return { state: 'ok', customer };
}

// The page's `lead` block, from the customer the estimate was sent to.
function customerPayload(customer) {
  const { addressDisplay, maskPhone } = inspection();
  return {
    first_name: customer.first_name || null,
    phone_masked: maskPhone(customer.phone),
    has_address: true,
    address_display: addressDisplay({ line1: customer.address_line1, city: customer.city, zip: customer.zip }),
  };
}

async function alreadyBookedBody(visit, lead) {
  const { visitShape, rescheduleUrlFor } = inspection();
  return {
    state: 'already_booked',
    lead,
    visit: visitShape(visit),
    rescheduleUrl: await rescheduleUrlFor(visit.id),
    code: 'ALREADY_BOOKED',
    error: ALREADY_BOOKED_ERROR,
  };
}

// The pin a booking for this customer commits at (the /book commit's own reader): the stored pin, else a
// staff-verified or canonical geocode of the stored address; null while a review holds it.
async function bookingLocationFor(customer) {
  return require('./booking')._internals.customerBookingLocation(customer);
}

// Everything a request needs once the estimate and customer are eligible: the location, the config, the window and
// the catalog. `blocked` is the GET-shaped answer when times cannot be offered.
async function bookingSetup(customer, lead) {
  const location = await bookingLocationFor(customer);
  if (!location) {
    return { blocked: { state: 'ok', lead, availability: null, needs_address: false, selfServeNotice: true, service_area_unavailable: true } };
  }
  const booking = require('./booking');
  const config = await booking._internals.loadBookingConfig();
  const range = inspection().bookingRange(config);
  const catalog = await inspection().loadAssessmentCatalog();
  if (!catalog.serviceId) {
    return { blocked: { state: 'ok', lead, availability: null, needs_address: false, selfServeNotice: true, booking_unavailable: true } };
  }
  return { booking, location, config, range, catalog };
}

// One request's resolution: the generic 404, a terminal page state, or the eligible estimate, customer and lead.
async function resolveRequest(token) {
  const found = await resolveEstimate(token);
  if (found.notFound) return { status: 404, body: { error: 'not_found' } };
  if (found.gone) return { body: { state: 'gone' } };
  const eligibility = await assessmentEligibility(found.estimate, found.data);
  if (eligibility.state === 'gone') return { body: { state: 'gone' } };
  const lead = customerPayload(eligibility.customer);
  if (eligibility.state === 'already_booked') return { body: await alreadyBookedBody(eligibility.visit, lead) };
  return { estimate: found.estimate, customer: eligibility.customer, lead };
}

function send(res, resolved) {
  return resolved.status ? res.status(resolved.status).json(resolved.body) : res.json(resolved.body);
}

router.get('/:token', readLimiter, async (req, res, next) => {
  try {
    const resolved = await resolveRequest(req.params.token);
    if (resolved.body) return send(res, resolved);
    const setup = await bookingSetup(resolved.customer, resolved.lead);
    if (setup.blocked) return res.json(setup.blocked);
    let availability = null;
    try {
      const built = await inspection().buildAvailabilityForLead(setup.location, { ...setup.range, config: setup.config, duration: setup.catalog.durationMinutes });
      availability = built ? inspection().shapeAvailability(built, setup.range) : null;
    } catch (err) {
      logger.error(`[estimate-assessment] availability failed for estimate ${resolved.estimate.id}: ${err.code || err.name || 'error'}`);
    }
    return res.json({
      state: 'ok',
      lead: resolved.lead,
      availability,
      needs_address: false,
      selfServeNotice: true,
      durationMinutes: setup.catalog.durationMinutes,
    });
  } catch (err) {
    next(err);
  }
});

// The Waves AI date search (the inspection page's own contract): { query } → summary + availability.
router.post('/:token/find-slots', findSlotsLimiter, async (req, res, next) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'query required' });
  if (query.length > 500) return res.status(400).json({ error: 'query too long' });
  try {
    const resolved = await resolveRequest(req.params.token);
    if (resolved.body) return send(res, resolved);
    const setup = await bookingSetup(resolved.customer, resolved.lead);
    if (setup.blocked) return res.status(503).json({ error: setup.blocked.booking_unavailable ? 'booking_unavailable' : 'service_area_unavailable' });
    const { parseWhen, summarizeWindow } = require('../services/scheduling/parse-when');
    const when = await parseWhen(query, inspection().searchParseOpts(setup.config));
    let availability = null;
    try {
      availability = await inspection().buildAvailabilityForLead(setup.location, {
        rangeFrom: when.dateFrom, rangeTo: when.dateTo, config: setup.config,
        duration: setup.catalog.durationMinutes, timeOfDay: when.timeOfDay,
      });
    } catch (err) {
      logger.error(`[estimate-assessment] find-slots availability failed for estimate ${resolved.estimate.id}: ${err.code || err.name || 'error'}`);
    }
    if (!availability) return res.status(503).json({ error: 'Slot search is unavailable right now. Please pick from the times below.' });
    const slotCount = (availability.days || []).reduce((n, d) => n + (Array.isArray(d.slots) ? d.slots.length : 0), 0);
    return res.json({
      summary: summarizeWindow(when, { count: slotCount, nearby: availability.nearby }),
      understood: when.understood,
      window: { date_from: when.dateFrom, date_to: when.dateTo },
      time_of_day: when.timeOfDay,
      availability: inspection().shapeAvailability(availability, setup.range),
    });
  } catch (err) {
    next(err);
  }
});

async function sendSlotTaken(res, setup, error) {
  let refreshed = null;
  try {
    refreshed = await inspection().buildAvailabilityForLead(setup.location, { ...setup.range, config: setup.config, duration: setup.catalog.durationMinutes });
  } catch (err) {
    logger.warn(`[estimate-assessment] refresh availability failed: ${err.code || err.name || 'error'}`);
  }
  return res.status(409).json({
    error: error || 'That time is no longer open. Here are the latest available times.',
    code: 'SLOT_TAKEN',
    availability: refreshed ? inspection().shapeAvailability(refreshed, setup.range) : null,
  });
}

// The booking transaction's re-check of this page's preflight read (AGENTS.md: the commit re-checks it on the locked
// row), under the per-estimate lock createSelfBooking takes (callbackVisit.estimateGuard): the estimate, share-locked,
// still open and customer-viewable for the same customer; its call-side verdict held under lock; still eligible on
// this transaction (not grouped or drafted from a visit, the customer's address still the estimate's property, no
// open assessment: 'booked'); and the gate read last, after every lock wait. 'ok', 'booked' or 'ineligible'.
function estimateGuardFor(estimate, customerId) {
  return {
    estimateId: estimate.id,
    revalidate: async (trx) => {
      const pub = estimatePublic();
      const fresh = await trx('estimates').where({ id: estimate.id }).forShare().first();
      if (!fresh || String(fresh.customer_id || '') !== String(customerId)
        || !pub.isEstimateCustomerViewable(fresh) || !pub.isEstimateAcceptActive(fresh)) return 'ineligible';
      if (await require('../utils/estimate-claim-sql').callSideBlockedUnderLock(trx, fresh)) return 'ineligible';
      const eligibility = await assessmentEligibility(fresh, parseEstimateData(fresh.estimate_data), trx);
      if (eligibility.state !== 'ok') return eligibility.state === 'already_booked' ? 'booked' : 'ineligible';
      return estimateAssessmentFirstLive() ? 'ok' : 'ineligible';
    },
  };
}

// The estimate the visit was booked from, for the office (internal notes, never customer-visible).
function officeNote(estimate, customerNote) {
  const number = String(estimate.estimate_slug || '').replace(/[^A-Za-z0-9-]/g, '') || String(estimate.id).split('-')[0].toUpperCase();
  return [`Booked from estimate ${number}.`, customerNote ? `Customer note: ${customerNote}` : null].filter(Boolean).join(' ');
}

// POST /:token — body { date: 'YYYY-MM-DD', time: 'HH:00', notes? }: books the free Waves Assessment.
router.post('/:token', commitLimiter, async (req, res, next) => {
  const { date, time, notes, invalid } = inspection().parseCommitBody(req.body);
  if (invalid) return res.status(400).json({ error: 'date (YYYY-MM-DD) and time (HH:00) required' });
  try {
    const resolved = await resolveRequest(req.params.token);
    if (resolved.body) return send(res, resolved);
    const setup = await bookingSetup(resolved.customer, resolved.lead);
    if (setup.blocked) return res.status(503).json({ error: setup.blocked.booking_unavailable ? 'booking_unavailable' : 'service_area_unavailable' });
    const windowFailure = inspection().commitWindowFailure(date, setup.range, setup.catalog);
    if (windowFailure) return res.status(windowFailure.status).json({ error: windowFailure.error });

    // Anti-forgery: the slot must be in a fresh single-day build at the catalog duration.
    const day = await inspection().buildAvailabilityForLead(setup.location, {
      rangeFrom: date, rangeTo: date, config: setup.config, duration: setup.catalog.durationMinutes,
    });
    const slot = inspection().findSlotIn(day, date, time);
    if (!slot) return sendSlotTaken(res, setup);
    // The kill switch again right before the booking: a flip during the availability build books nothing.
    if (!estimateAssessmentFirstLive()) return res.status(404).json({ error: 'not_found' });

    const result = await inspection().bookAssessmentVisit({
      booking: setup.booking,
      date,
      bookingSlot: slot,
      custRow: resolved.customer,
      catalog: setup.catalog,
      bookingLocation: setup.location,
      source: SOURCE,
      alertLabel: ALERT_LABEL,
      estimateGuard: estimateGuardFor(resolved.estimate, resolved.customer.id),
    });
    if (!result.ok) {
      if (result.code === 'ESTIMATE_CHANGED') {
        // The estimate stopped qualifying inside the booking transaction (closed, call-side blocked, moved, or the
        // gate went dark): the page's own answer for it now.
        if (!estimateAssessmentFirstLive()) return res.status(404).json({ error: 'not_found' });
        const again = await resolveRequest(req.params.token);
        if (again.body) return send(res, again);
      }
      if (result.code === 'ALREADY_BOOKED') {
        // The per-customer assessment lane caught one: answer with the visit that holds it, read afresh.
        const visit = await inspection().findOpenVisit(db, resolved.customer.id, { assessmentOnly: true, futureOnly: true });
        if (visit) return res.json(await alreadyBookedBody(visit, resolved.lead));
      }
      if (result.status === 409) {
        // A slot race, or the customer's pin moved under the booking fence: fresh times at the current pin.
        const fresh = await bookingSetup(resolved.customer, resolved.lead);
        if (fresh.blocked) return res.status(409).json({ error: result.error || 'That time is no longer open.', code: 'SLOT_TAKEN', availability: null });
        return sendSlotTaken(res, fresh, result.error);
      }
      return res.status(result.status || 500).json({ error: result.error || 'Booking is temporarily unavailable — please text or call us.' });
    }
    return res.json(await inspection().finishCommittedBooking({
      result, notes: officeNote(resolved.estimate, notes), date, bookingSlot: slot,
    }));
  } catch (err) {
    next(err);
  }
});

// /data's `assessmentFirst` for an estimate the customer is viewing, or null: the same eligibility this page applies
// (never offered where the page would answer gone or already_booked). `open` is /data's own accept-active verdict
// (never a staff, draft or document render). Never throws.
async function assessmentFirstFor(estimate, { open = false, estimateData = null } = {}) {
  try {
    if (!estimateAssessmentFirstLive() || !open || !estimate?.token) return null;
    const eligibility = await assessmentEligibility(estimate, estimateData || parseEstimateData(estimate.estimate_data));
    if (eligibility.state !== 'ok') return null;
    return { url: `/estimate/${encodeURIComponent(estimate.token)}/assessment` };
  } catch (err) {
    logger.warn(`[estimate-assessment] offer skipped for estimate ${estimate?.id}: ${err.code || 'error'}`);
    return null;
  }
}

router._internals = { assessmentEligibility, assessmentFirstFor, estimateGuardFor, resolveEstimate, officeNote, SOURCE, ALERT_LABEL };

module.exports = router;
