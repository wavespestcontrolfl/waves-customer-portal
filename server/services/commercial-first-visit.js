// ============================================================
// commercial-first-visit.js — "Pick your first visit" after a commercial
// agreement is signed (GATE_COMMERCIAL_FIRST_VISIT; owner 2026-10-26, "OK GO"
// on decision page choice 1B: "The customer picks the first visit from open
// slots, the same way residential customers do. It books by itself, sized to
// the real visit length.").
//
// Before: signing was never acceptance (owner ruling 2026-09-24); the office
// marked the proposal won and booked the first visit by phone. With the gate
// on, the signer picks the first visit on the estimate page:
//   1. the open times come from the /book availability engine
//      (routes/booking.js buildBookingAvailability) at the customer's own
//      booking location, sized to the visit length and limited to pest techs;
//   2. the commit is the /book commit (createSelfBooking) as an internal PAID
//      visit: the proposal's per-visit price, invoiced on completion, linked
//      to the estimate, one first visit per estimate (estimateGuard);
//   3. the proposal is then marked won through the staff path
//      (estimate-manual-acceptance.js, which links the booked visit), the
//      series is seeded from the visit at the proposal's cadence, and the
//      office gets one alert.
//
// Scope (v1): an authored proposal that does not bill by invoice, whose
// recurring itemization is pest service programs only, every program on ONE
// whole cadence (12, 6, 4, 3, 2 or 1 visits a year), with no building line
// items and no corrective work, and a year of visits that equals the quoted
// annual price. Anything else keeps the office flow: the page says the team
// follows up, exactly as before.
//
// Commercial visits stay unlinked from the residential catalog (the rule
// slot-reservation.js cadenceCatalogKeyForProfile already applies, codex
// #3485 r10 P1): service_type 'Commercial Pest Control', service_id null.
// ============================================================

const db = require('../models/db');
const logger = require('./logger');

const SERVICE_TYPE = 'Commercial Pest Control';
// The /book funnel key: pest technicians only, and the pest expected-minutes
// credit, on the offer AND the commit (the commit's capability check reads
// SERVICE_TYPE, which classifies to the same pest category).
const SERVICE_KEY = 'pest_control';
const BOOKING_SOURCE = 'commercial_proposal_first_visit';
const ACCEPT_SOURCE = 'customer_first_visit_booking';
const DEFAULT_VISIT_MINUTES = 60;
// The /book commit's bounds (routes/booking.js MIN_CALLBACK_DURATION_MINUTES and MAX_BOOKING_DURATION_MINUTES): a
// shorter visit books the minimum, and a longer one stays with the office (the commit would book 60 minutes).
const MIN_VISIT_MINUTES = 15;
const MAX_VISIT_MINUTES = 90;
// Statuses that no longer hold a visit (the booking replay check's dead set, plus the spellings other writers use).
const DEAD_VISIT_STATUSES = ['cancelled', 'canceled', 'skipped', 'rescheduled', 'no_show'];
// Whole cadences only: the seeder's patternFromVisitsPerYear buckets (24 a year would read as monthly).
const PATTERN_FOR_VISITS = Object.freeze({ 12: 'monthly', 6: 'bimonthly', 4: 'quarterly', 3: 'triannual', 2: 'semiannual', 1: 'annual' });
const CADENCE_WORD = Object.freeze({ 12: 'monthly', 6: 'every-2-month', 4: 'quarterly', 3: 'every-4-month', 2: 'twice-a-year', 1: 'yearly' });
const ALERT_LABEL = '🏢 Commercial first visit self-booked:';
// Structured payment terms the win accepts outside invoice mode: none, or Auto Pay.
const ONLINE_PAYMENT_TERMS = new Set([undefined, null, '', 'autopay']);

const live = () => require('../config/feature-gates').commercialFirstVisitLive();

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function parseEstimateData(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

// The estimator's on-site minutes for the pest line, when it priced one.
function engineOnSiteMinutes(estimateData = {}) {
  const items = estimateData?.engineResult?.lineItems;
  if (!Array.isArray(items)) return null;
  const line = items.find((item) => /pest/i.test(String(item?.service || '')) && Number(item?.onSiteMin) > 0);
  return line ? Number(line.onSiteMin) : null;
}

// The visit length: the builder's per-program visit minutes when every
// program carries one (one visit does every program, so they add up), else
// the estimator's on-site minutes rounded up to 5, else an hour; never below
// the commit's minimum. Over MAX_VISIT_MINUTES the plan is null (firstVisitPlan).
function visitMinutesFor(programs, estimateData) {
  const authored = programs.map((program) => Number(program.visitMinutes));
  let minutes;
  if (authored.length && authored.every((n) => Number.isInteger(n) && n > 0)) {
    minutes = authored.reduce((sum, n) => sum + n, 0);
  } else {
    const engine = engineOnSiteMinutes(estimateData);
    minutes = engine ? Math.ceil(engine / 5) * 5 : DEFAULT_VISIT_MINUTES;
  }
  return Math.max(MIN_VISIT_MINUTES, minutes);
}

// The visit the signer may book, or null (the office books it). Pure.
// The online first-visit plan as { plan }, or why the office books the first visit as { reason } (owner 2026-11-01,
// proposal readiness: the builder shows the reason). firstVisitPlan keeps its plan-or-null contract for every other caller.
function firstVisitPlanCheck(estimate = {}) {
  // An invoice-mode (Net terms) proposal stays with the office: online booking is for Auto Pay or no terms.
  if (estimate.bill_by_invoice === true) return { reason: 'bill_by_invoice' };
  const { normalizeProposal, computeProposalTotals } = require('./estimate-proposal');
  const proposal = normalizeProposal(estimate);
  if (proposal.enabled !== true || proposal.synthesized === true) return { reason: 'not_authored' };
  // The win (estimate-manual-acceptance.js winCommercialProposal) refuses a proposal outside invoice mode whose
  // structured payment terms are anything but Auto Pay, so only those proposals book online.
  if (!ONLINE_PAYMENT_TERMS.has(proposal.commercialTerms?.paymentTerms)) return { reason: 'payment_terms' };
  // normalizeProposal keeps only priced programs (null when none) and corrective work as null or a non-empty list, so
  // with no building lines and no corrective work the proposal has no one-time total and every visit has a price.
  const programs = proposal.programs;
  if (!programs || proposal.correctiveWork || proposal.buildings.some((building) => building.lineItems.length)) return { reason: 'itemization' };
  // Pest programs only; a misting system (identity) is not a pest visit.
  if (!programs.every((program) => program.service === 'pest' && !program.identity)) return { reason: 'not_pest' };
  const cadences = new Set(programs.map((program) => program.frequencyPerYear));
  const visitsPerYear = [...cadences][0];
  const pattern = PATTERN_FOR_VISITS[visitsPerYear];
  if (cadences.size !== 1 || !pattern) return { reason: 'cadence' };
  const pricePerVisit = roundMoney(programs.reduce((sum, program) => sum + program.pricePerApplication, 0));
  const totals = computeProposalTotals(proposal);
  // Every visit bills the same amount, and a year of visits is the quoted annual price.
  if (roundMoney(pricePerVisit * visitsPerYear) !== totals.annualRecurring) return { reason: 'price' };
  const durationMinutes = visitMinutesFor(programs, parseEstimateData(estimate.estimate_data));
  if (durationMinutes > MAX_VISIT_MINUTES) return { reason: 'too_long' };
  return { plan: {
    visitsPerYear,
    pattern,
    pricePerVisit,
    // The tax the quote shows for one visit, rounded per application as computeProposalTotals rounds it.
    taxPerVisit: roundMoney(programs.filter((program) => program.taxable)
      .reduce((sum, program) => sum + roundMoney(program.pricePerApplication * totals.taxRate), 0)),
    // The win marks the customer commercial for a taxable proposal (proposal-win.js
    // flagProposalCustomerCommercialIfTaxable, the same first-invoice rule), before any completion invoice exists.
    flagsCommercial: require('./proposal-win').buildProposalFirstInvoice(proposal).taxableSubtotal > 0,
    // The premises the signed agreement names (commercial-proposal-agreement.js buildAgreementValues).
    propertyAddress: proposal.propertyAddress,
    durationMinutes,
    serviceType: SERVICE_TYPE,
    serviceKey: SERVICE_KEY,
  } };
}

function firstVisitPlan(estimate = {}) {
  return firstVisitPlanCheck(estimate).plan || null;
}

// Whether the visit's completion invoice charges the tax the quote shows for a visit. The completion mint
// (admin-schedule.js mintOrReuseScheduledServiceInvoice) passes no rate, so the customer's tax setup decides it
// (property type, county rate, a verified exemption, a tax-exempt payer); InvoiceService.previewInvoiceTotals is that
// same decision as a dry run, taken as of after the win (a taxable proposal's win marks the customer commercial
// first). A quote taxed any other way (mixed program flags, another rate, an exempt customer) stays with the office
// (Codex #6869 P1). Fails closed. It is not re-run inside the booking transaction: the mint reads the customer's tax
// setup again at completion, so no lock taken here could hold it.
async function completionTaxMatches(plan, customerId, conn = db) {
  try {
    const preview = await require('./invoice').previewInvoiceTotals({
      customerId, amount: plan.pricePerVisit, title: SERVICE_TYPE, database: conn, assumeCommercial: plan.flagsCommercial === true,
    });
    return roundMoney(preview?.tax_amount) === plan.taxPerVisit;
  } catch (err) {
    logger.warn(`[commercial-first-visit] tax check skipped for customer ${customerId}: ${err.code || 'error'}`);
    return false;
  }
}

// The estimate's live first visit (any visit linked to it that still holds a booking), or undefined.
async function linkedFirstVisit(estimateId, conn = db) {
  return conn('scheduled_services')
    .where({ source_estimate_id: estimateId })
    .whereNotIn('status', DEAD_VISIT_STATUSES)
    .orderBy('scheduled_date', 'asc')
    .first('id', 'scheduled_date', 'window_start', 'window_end', 'status');
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

const hhmm = (value) => (value ? String(value).slice(0, 5) : null);

function publicVisit(row) {
  return { date: dateOnly(row.scheduled_date), windowStart: hhmm(row.window_start), windowEnd: hhmm(row.window_end) };
}

function customerColumns() {
  return ['id', 'first_name', 'last_name', 'company_name', 'phone', 'email', 'account_id',
    'address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude'];
}

async function loadCustomer(customerId, conn = db) {
  if (!customerId) return null;
  return conn('customers').where({ id: customerId }).whereNull('deleted_at').first(...customerColumns());
}

// The customer-side half of eligibility, shared by the page, the signed-agreement alert and both routes: the customer
// account, whose address on file is the premises the signed agreement names (the booking, its pin and the series all
// run at the customer's stored address, so a proposal for other premises, another building or a corrected unit, stays
// with the office; Codex #6869 r2 P1), and a completion invoice taxed as the quote is. The customer, or null.
async function eligibleCustomer(plan, customerId, conn = db) {
  const customer = await loadCustomer(customerId, conn);
  if (!atSignedPremises(plan, customer)) return null;
  return (await completionTaxMatches(plan, customer.id, conn)) ? customer : null;
}

// Whether the customer's address on file is the premises the plan's signed agreement names (sameProperty: street,
// unit and zip).
function atSignedPremises(plan, customer) {
  const { sameProperty } = require('./estimate-consultation-offer');
  return !!customer && sameProperty(plan.propertyAddress, { line1: customer.address_line1, line2: customer.address_line2, zip: customer.zip });
}

// /data's cta.commercialFirstVisit, or null (nothing new on the payload):
//   { state: 'booked', visit }   a live visit is linked to the estimate (it can be accepted by now);
//   { state: 'pick', durationMinutes }   signed, still open, no visit yet, and `picker`: the page shows the picker;
//   { state: 'after_signing' }   open and not yet signed: the signing copy says the customer picks the visit next.
// `open` is the route's verdict (the agreement card's condition: open, customer-viewable, not a staff or draft
// preview); `picker` adds that the customer can tap it here (false for the document render).
async function firstVisitCtaFor(estimate, { open = false, picker = false, conn = db } = {}) {
  try {
    if (!live() || !estimate?.id) return null;
    const plan = firstVisitPlan(estimate);
    if (!plan) return null;
    const visit = await linkedFirstVisit(estimate.id, conn);
    if (visit) return { state: 'booked', visit: publicVisit(visit) };
    if (!open || !(await eligibleCustomer(plan, estimate.customer_id, conn))) return null;
    const agreement = require('./commercial-proposal-agreement');
    const { state } = await agreement.agreementStateForEstimate(estimate.id, conn);
    if (state !== 'signed') return { state: 'after_signing' };
    // Signed, but the proposal changed since: the office books it (never a visit under terms the customer did not sign).
    if (!picker || !(await agreement.signedQuoteMatches(estimate, conn))) return null;
    return { state: 'pick', durationMinutes: plan.durationMinutes };
  } catch (err) {
    logger.warn(`[commercial-first-visit] cta skipped for estimate ${estimate?.id}: ${err.code || 'error'}`);
    return null;
  }
}

// Whether the signer of this estimate's agreement can book the first visit online (the signed-agreement alert's copy):
// gate on, an eligible plan and customer, and no visit yet. Never throws (false on any failure).
async function firstVisitOnlineFor(estimateId, conn = db) {
  try {
    if (!live() || !estimateId) return false;
    const estimate = await conn('estimates').where({ id: estimateId }).first('id', 'customer_id', 'address', 'estimate_data', 'bill_by_invoice');
    const plan = estimate ? firstVisitPlan(estimate) : null;
    if (!plan || !(await eligibleCustomer(plan, estimate.customer_id, conn))) return false;
    return !(await linkedFirstVisit(estimate.id, conn));
  } catch (err) {
    logger.warn(`[commercial-first-visit] online check skipped for estimate ${estimateId}: ${err.code || 'error'}`);
    return false;
  }
}

// The builder's first-visit line (owner 2026-11-01, proposal readiness): { state: 'booked', visit } once a live visit is
// linked to the estimate, { state: 'online' } when the signer will book the first visit online, else
// { state: 'office', reason }. The checks are firstVisitCtaFor's and firstVisitOnlineFor's (the plan, the customer at the
// signed premises, the completion tax), which the customer page and the signed-agreement alert keep calling. The route
// asks only with GATE_COMMERCIAL_FIRST_VISIT on. Never throws: a failed read is { state: 'unknown' }.
async function firstVisitReadiness(estimate, conn = db) {
  try {
    const visit = await linkedFirstVisit(estimate.id, conn);
    if (visit) return { state: 'booked', visit: publicVisit(visit) };
    const check = firstVisitPlanCheck(estimate);
    if (!check.plan) return { state: 'office', reason: check.reason };
    const customer = await loadCustomer(estimate.customer_id, conn);
    if (!customer) return { state: 'office', reason: 'no_customer' };
    if (!atSignedPremises(check.plan, customer)) return { state: 'office', reason: 'address' };
    if (!(await completionTaxMatches(check.plan, customer.id, conn))) return { state: 'office', reason: 'tax' };
    return { state: 'online' };
  } catch (err) {
    logger.warn(`[commercial-first-visit] readiness skipped for estimate ${estimate?.id}: ${err.code || 'error'}`);
    return { state: 'unknown' };
  }
}

function refusal(status, code, error) {
  return { ok: false, status, code, error };
}

const CALL_US = 'Please call us at (941) 297-5749 and we will book your first visit with you.';

// The one eligibility read shared by the availability and the commit routes: the estimate as the route read it (open
// and customer-viewable, judged by the caller), plus the plan, the signed agreement, no visit yet and the customer.
async function bookingContext(estimate, { conn = db } = {}) {
  if (!live()) return { refusal: refusal(404, 'not_found', 'Estimate not found') };
  const plan = firstVisitPlan(estimate);
  if (!plan || !estimate.customer_id) return { refusal: refusal(404, 'not_found', 'Estimate not found') };
  // The customer signed THIS quote: an agreement signed before a later edit does not cover it.
  if (!(await require('./commercial-proposal-agreement').signedQuoteMatches(estimate, conn))) {
    return { refusal: refusal(404, 'not_found', 'Estimate not found') };
  }
  const visit = await linkedFirstVisit(estimate.id, conn);
  if (visit) return { refusal: { ...refusal(409, 'already_booked', 'Your first visit is already booked.'), visit: publicVisit(visit) } };
  const customer = await eligibleCustomer(plan, estimate.customer_id, conn);
  if (!customer) return { refusal: refusal(409, 'call_us', CALL_US) };
  const booking = require('../routes/booking')._internals;
  const location = await booking.customerBookingLocation(customer);
  if (!location) return { refusal: refusal(409, 'call_us', CALL_US) };
  return { plan, customer, location, booking };
}

function bookingRange(config, now = new Date()) {
  const { etDateString, addETDays } = require('../utils/datetime-et');
  return {
    rangeFrom: etDateString(addETDays(now, config.advance_days_min ?? 1)),
    rangeTo: etDateString(addETDays(now, config.advance_days_max ?? 14)),
  };
}

function availabilityFor(context, { rangeFrom, rangeTo, config, offer = false }) {
  const { booking, plan, location } = context;
  return booking.buildBookingAvailability({
    lat: location.lat,
    lng: location.lng,
    duration: plan.durationMinutes,
    serviceKey: plan.serviceKey,
    rangeFrom,
    rangeTo,
    config,
    today: new Date(),
    // The offer list only (GATE_CUSTOMER_ROUTE_CHECK); bookFirstVisit's rebuild omits `offer`.
    ...(offer ? { surface: 'commercial_first_visit' } : {}),
    selfServeNotice: true,
    // The commit is createSelfBooking, which re-verifies with traffic and persists the certified route order while
    // bookInsertionOffersLive() is live (the inspection page's contract, see inspection-public.js).
    capacityPlacement: booking.bookInsertionOffersLive(),
    bookArrivalGrace: true,
  });
}

// GET-side: the open first-visit times for a signed proposal. { ok, days, slots, nearby, rangeFrom, rangeTo,
// durationMinutes } or a refusal.
async function firstVisitAvailability(estimate, { conn = db } = {}) {
  const context = await bookingContext(estimate, { conn });
  if (context.refusal) return context.refusal;
  const config = await context.booking.loadBookingConfig();
  const range = bookingRange(config);
  const availability = await availabilityFor(context, { ...range, config, offer: true });
  return {
    ok: true,
    days: availability.days,
    slots: availability.slots,
    nearby: availability.nearby,
    rangeFrom: range.rangeFrom,
    rangeTo: range.rangeTo,
    durationMinutes: context.plan.durationMinutes,
  };
}

// The slot at `time` on `date` in a fresh availability build, or null.
function findSlot(availability, date, time) {
  const day = (availability?.days || []).find((entry) => entry.date === date);
  const slots = day?.slots || (availability?.slots || []).filter((slot) => slot.date === date);
  return (slots || []).find((slot) => String(slot.start_time || '').slice(0, 5) === time) || null;
}

// The booking transaction's re-check, on its own connection, under the per-estimate lock createSelfBooking takes:
// 'ineligible' when the gate was turned off, 'booked' when a first visit landed since the caller's read,
// 'ineligible' when the estimate is no longer open, its call-side verdict now blocks it, its plan changed, or its quote
// is no longer the signed one, else 'ok'. `openFor(row)` is the route's open-estimate verdict.
function estimateGuardFor(estimate, { openFor }) {
  const guard = {
    estimateId: estimate.id,
    // The row version the booking committed under (set by an 'ok' verdict; the booking holds the row until commit and
    // writes nothing to it): the accept pins it, so an edit after the booking (a new price, terms or invoice mode)
    // refuses the accept instead of marking unchecked terms won (pre-push audit P0).
    acceptPin: null,
    revalidate: async (trx) => {
      if (await linkedFirstVisit(estimate.id, trx)) return 'booked';
      const fresh = await trx('estimates').where({ id: estimate.id }).forShare().first();
      if (!fresh || String(fresh.customer_id || '') !== String(estimate.customer_id) || !openFor(fresh)) return 'ineligible';
      // The route's call-side verdict (estimate-public.js firstVisitEstimate), re-run on the held row and held through
      // the insert: a call-side rejection or linkage correction landing during the availability lookup refuses here.
      if (await require('../utils/estimate-claim-sql').callSideBlockedUnderLock(trx, fresh)) return 'ineligible';
      const plan = firstVisitPlan(fresh);
      const was = firstVisitPlan(estimate);
      if (!plan || !was || plan.pricePerVisit !== was.pricePerVisit || plan.taxPerVisit !== was.taxPerVisit
        || plan.durationMinutes !== was.durationMinutes || plan.pattern !== was.pattern) return 'ineligible';
      // The signed premises, against the customer row the booking holds (a unit or address correction during the
      // availability lookup can keep the same pin).
      const customer = await trx('customers').where({ id: fresh.customer_id }).forShare().first('address_line1', 'address_line2', 'zip');
      if (!atSignedPremises(plan, customer)) return 'ineligible';
      // The quote on this read is still the one the customer signed (no edit landed since the caller's check).
      if (!(await require('./commercial-proposal-agreement').signedQuoteMatches(fresh, trx))) return 'ineligible';
      // The kill switch, read last, after every lock wait above: a flip during the availability build or any of those
      // waits books nothing (no row lock holds an environment flip).
      if (!live()) return 'ineligible';
      guard.acceptPin = require('./estimate-manual-acceptance').estimateRowPin(fresh);
      return 'ok';
    },
  };
  return guard;
}

function errorLine(err) {
  return [err?.statusCode, err?.code || err?.name || 'error'].filter(Boolean).join(' ');
}

// The series after the first visit, seeded from it in its own transaction with the funnel's lock order (customer
// comms, then the customer row, then the series guard; routes/booking.js quarterly pest seeding). A customer who
// already runs a pest series keeps it, and this visit stays a one-off the office reconciles. Never throws.
async function seedSeries({ visit, customerId, plan, estimateId }) {
  try {
    const booking = require('../routes/booking')._internals;
    const RecurringAppointmentSeeder = require('./recurring-appointment-seeder');
    const { lockCustomerComms } = require('../utils/customer-comms-lock');
    const { lockCustomerAccountRows } = require('./customer-account-ownership');
    let ownerId = customerId;
    const outcome = await booking.runSeriesTxWithOwnerRetry(db, async (trx) => {
      await lockCustomerComms(trx, ownerId);
      await lockCustomerAccountRows(trx, [ownerId], { forUpdate: true });
      const parent = await booking.lockAndVerifySeriesParentOwner(trx, { parentId: visit.id, expectedCustomerId: ownerId });
      if (!parent || DEAD_VISIT_STATUSES.includes(parent.status)) return { skipped: 'visit_gone' };
      if (parent.is_recurring === true || parent.recurring_parent_id) return { skipped: 'already_recurring' };
      const { matches, guardError } = await RecurringAppointmentSeeder.checkActiveSeriesLocked(trx, {
        customerId: ownerId,
        serviceId: null,
        serviceType: SERVICE_TYPE,
        excludeParentId: parent.id,
      });
      if (guardError) logger.warn(`[commercial-first-visit] duplicate-series guard failed (seeding proceeds): ${errorLine(guardError)}`);
      if (matches.length > 0) return { kept: matches[0] };
      const seeded = await RecurringAppointmentSeeder.seedFollowUpsForParent(trx, parent, {
        pattern: plan.pattern,
        plannedCount: plan.visitsPerYear,
        skipWeekends: true,
        weekendShift: 'forward',
        durationMinutes: plan.durationMinutes,
        source: BOOKING_SOURCE,
        estimatedPrice: plan.pricePerVisit,
        sourceEstimateId: estimateId,
        // The agreement renews every 12 months until cancelled, so the series runs on (the price never carries a
        // remainder: a year of visits is the quoted annual price, firstVisitPlan).
        recurringOngoing: true,
        // Commercial visits stay unlinked: never bridge the label to a residential catalog row.
        childIdentity: { service_type: SERVICE_TYPE, service_id: null, service_key: null },
      });
      return { seeded: seeded.insertedCount || 0 };
    }, { onOwnerChange: (newOwnerId) => { ownerId = newOwnerId; } });
    return outcome;
  } catch (err) {
    logger.error(`[commercial-first-visit] FIX: series seeding failed for visit ${visit?.id} (estimate ${estimateId}): ${errorLine(err)}`);
    return { failed: true };
  }
}

// "Tue, Nov 3, 9 AM" (no ISO date: the alert rules refuse one in a headline or a why).
function visitDayLabel(date, windowStart) {
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const match = /^(\d{1,2}):(\d{2})/.exec(String(windowStart || ''));
  if (!match) return day;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const hour = ((h + 11) % 12) + 1;
  return `${day}, ${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h >= 12 ? 'PM' : 'AM'}`;
}

// The office's one alert for a self-booked first visit (a customer acting, so it always rings). What is left to do
// is the why: nothing but a look when the estimate is won and the series is set.
async function alertOffice({ estimate, customer, visit, plan, accepted, series }) {
  try {
    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { fitAction, tidyName } = require('./admin-alert-names');
    const name = tidyName(customer.company_name || [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Customer');
    const when = visitDayLabel(visit.date, visit.windowStart);
    let why;
    if (!accepted) why = `Booked online for ${when}; mark the estimate won and set the repeat visits.`;
    else if (series?.seeded > 0) why = `Booked online for ${when}; the estimate is won and the series is set.`;
    else if (series?.kept) why = `Booked online for ${when}; they already have a pest series, so check it.`;
    else why = `Booked online for ${when}; set the repeat visits from it.`;
    let seriesDetail;
    if (!accepted) seriesDetail = 'No repeat visits were added: set them from the proposal once it is won.';
    else if (series?.seeded > 0) seriesDetail = `${series.seeded} more ${CADENCE_WORD[plan.visitsPerYear]} visits were added after it.`;
    else if (series?.kept) seriesDetail = 'The customer already has a pest series, so this visit stays a one-off.';
    else seriesDetail = 'The repeat visits were not added: set the series from this visit.';
    await raiseAdminAlert('customer', {
      area: 'Schedule',
      action: fitAction('Schedule', name, [
        (who) => `check ${who}'s first commercial visit`,
        (who) => `check ${who}'s first visit`,
      ]),
      why,
      severity: 'needs-you',
      link: `/admin/estimates/${estimate.id}/proposal`,
      subject: { type: 'visit', id: String(visit.id) },
      doneWhen: 'visit_checked',
      who: 'person',
    }, {
      bell: true,
      dedupeKey: `commercial-first-visit:${estimate.id}`,
      detail: `${name} signed the Commercial Pest Service Agreement and booked the first visit online for ${when} (${plan.durationMinutes} minutes, $${plan.pricePerVisit.toFixed(2)} a visit plus tax). ${accepted ? 'The estimate was marked won.' : 'The estimate could not be marked won: mark it won by hand.'} ${seriesDetail}`,
      metadata: { estimateId: estimate.id, customerId: customer.id, scheduledServiceId: visit.id },
    });
  } catch (err) {
    logger.warn(`[commercial-first-visit] office alert failed for estimate ${estimate?.id}: ${err.code || 'error'}`);
  }
}

// POST-side: book the first visit at { date, time } for a signed proposal, then mark it won and seed the series.
// `openFor(row)` = the route's open-estimate verdict, re-run on the booking transaction's fresh read.
// createSelfBooking refusals this caller answers in its own words; any other 409 is a slot race (or a pin that moved
// under the booking fence) and any other failure is the call-us answer.
const BOOKING_REFUSALS = Object.freeze({
  ALREADY_BOOKED: ['already_booked', 'Your first visit is already booked.'],
  ESTIMATE_CHANGED: ['estimate_changed', 'This proposal just changed. Please refresh the page.'],
});
const SLOT_TAKEN = 'That time is no longer open. Please pick another.';

async function bookFirstVisit(estimate, { date, time, openFor }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return refusal(400, 'invalid', 'Pick a day and a time.');
  const context = await bookingContext(estimate);
  if (context.refusal) return context.refusal;
  const { booking, plan, customer, location } = context;
  const config = await booking.loadBookingConfig();
  const range = bookingRange(config);
  if (date < range.rangeFrom || date > range.rangeTo) return refusal(409, 'slot_taken', SLOT_TAKEN);
  // Anti-forgery: the slot must be in a fresh single-day build at the visit length (the inspection page's model).
  const slot = findSlot(await availabilityFor(context, { rangeFrom: date, rangeTo: date, config }), date, time);
  if (!slot) return refusal(409, 'slot_taken', SLOT_TAKEN);

  const guard = estimateGuardFor(estimate, { openFor });
  const result = await booking.createSelfBooking({
    slot_date: date,
    slot_start: slot.start_time,
    slot_end: slot.end_time,
    technician_id: slot.technician_id || null,
    customer_notes: null,
    source: BOOKING_SOURCE,
    source_estimate_id: estimate.id,
    authedCustomer: customer,
    payAtVisit: false,
    customersOnly: false,
    callbackVisit: {
      serviceKey: plan.serviceKey,
      serviceId: null,
      serviceType: plan.serviceType,
      durationMinutes: plan.durationMinutes,
      isCallback: false,
      dedupeLane: false,
      expectedLocation: location,
      alertLabel: ALERT_LABEL,
      billing: { estimatedPrice: plan.pricePerVisit },
      estimateGuard: guard,
    },
  });
  if (!result.ok) {
    const known = BOOKING_REFUSALS[result.code];
    // A first visit that landed after bookingContext's read (another tab won the estimate guard): answer it with the
    // booked visit, as bookingContext does, so the picker can show its date and time.
    if (result.code === 'ALREADY_BOOKED') {
      const booked = await linkedFirstVisit(estimate.id).catch(() => null);
      if (booked) return { ...refusal(409, ...known), visit: publicVisit(booked) };
    }
    if (known) return refusal(409, ...known);
    return result.status === 409 ? refusal(409, 'slot_taken', result.error) : refusal(result.status || 500, 'booking_failed', CALL_US);
  }

  // The visit this booking inserted (a replay answers the original booking at the same slot). The steps below each
  // stand on their own: without the row the accept refuses and the seeding skips, and the alert tells the office.
  const visitRow = await db('scheduled_services').where({ self_booking_id: result.body.booking.id }).first('id');
  const visit = { id: visitRow?.id, date, windowStart: hhmm(slot.start_time), windowEnd: hhmm(slot.end_time) };

  // Mark won through the staff path, pinned to the row version the booking committed under: it re-checks the row
  // under its own locks, promotes the customer and flags tax (the visit already carries source_estimate_id). A refusal
  // (an edit since the booking, among others) leaves the visit booked and tells the office. Every step after the
  // booking is safe to run again: the accept answers alreadyAccepted, the seeding skips a parent that is already
  // recurring, and the alert dedupes on the estimate.
  let accepted = false;
  try {
    const { markEstimateManuallyAccepted } = require('./estimate-manual-acceptance');
    if (!guard.acceptPin) throw Object.assign(new Error('no accept pin'), { code: 'no_accept_pin' });
    await markEstimateManuallyAccepted({
      estimateId: estimate.id,
      adminUserId: null,
      source: ACCEPT_SOURCE,
      bookedAppointmentIds: [visit.id],
      expected: guard.acceptPin,
    });
    accepted = true;
  } catch (err) {
    logger.error(`[commercial-first-visit] FIX: visit ${visit.id} booked but estimate ${estimate.id} was not marked won: ${errorLine(err)}`);
  }
  // A refused accept (an edit since the booking, among others) seeds nothing: a year of visits at terms the accept
  // could not confirm stays out, and the office sets the series from the proposal once it is won.
  const series = accepted ? await seedSeries({ visit, customerId: customer.id, plan, estimateId: estimate.id }) : null;
  await alertOffice({ estimate, customer, visit, plan, accepted, series });
  return { ok: true, visit: { date: visit.date, windowStart: visit.windowStart, windowEnd: visit.windowEnd } };
}

module.exports = {
  SERVICE_TYPE,
  SERVICE_KEY,
  BOOKING_SOURCE,
  ACCEPT_SOURCE,
  ALERT_LABEL,
  PATTERN_FOR_VISITS,
  MIN_VISIT_MINUTES,
  MAX_VISIT_MINUTES,
  firstVisitPlan,
  completionTaxMatches,
  visitMinutesFor,
  engineOnSiteMinutes,
  linkedFirstVisit,
  firstVisitOnlineFor,
  firstVisitReadiness,
  firstVisitCtaFor,
  firstVisitAvailability,
  bookFirstVisit,
  _private: { estimateGuardFor, seedSeries, findSlot, bookingContext, visitDayLabel },
};
