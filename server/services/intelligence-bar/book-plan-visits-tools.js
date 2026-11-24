/**
 * Intelligence Bar — book a plan's visits again
 * server/services/intelligence-bar/book-plan-visits-tools.js
 *
 * `book_plan_visits` (owner 2026-11-24: "book a recurring plan from the bar") books a RECURRING visit
 * series for one EXISTING customer who already has, or once had, a plan for the same service — a
 * quarterly pest customer whose series ran out or was cancelled. It is the narrow re-cut of the closed
 * start_program card (PR #6100, 21 Codex rounds): it books visits only. No bill, no welcome text.
 *
 *   unconfirmed → a PREVIEW that changes nothing: the customer (first name, last initial), the address,
 *                 the service and cadence, EVERY planned visit date (the Schedule create's own date plan,
 *                 planCreateSeriesDates), the technician, the price per visit as the handler will stamp
 *                 it, and whether the booking confirmation text goes. The preview carries `_version`, a
 *                 hash of the exact request body plus everything the card judged.
 *   confirmed   → re-plans and refuses on any drift from the card (the route hands the card's `_version`
 *                 back as `_verified_book_plan_version`), then runs the Schedule screen's own create
 *                 handler ONCE, in process, through createScheduleBooking (POST /admin/schedule). That
 *                 handler owns validation, the duplicate-series guard, the booking transaction and the
 *                 post-commit effects; this module adds no writer and never copies handler logic.
 *
 * Narrow allow-list (owner design 2026-11-24). Everything else is refused with a plain reason:
 *   - the customer is live and active, and already has (or had) a recurring series for the SAME service family
 *     (a brand-new program starts through the estimate: accept_estimate);
 *   - no open series for that service already exists (the handler's duplicate-series 409 also surfaces; the
 *     override is never passed);
 *   - the earlier series ran at the SAME saved property (its stamped property_id equals the booking property, which must
 *     be active); an older row with no property stamp does not qualify and is sent to the estimate;
 *   - no inspection-credit offer is open (paused ones included): a booking would record it and can mint credit;
 *   - no other visit holds any planned slot (any overlap refuses, probed at the service's real duration);
 *   - no price, discount, add-on, booster, tier, monthly-rate or prepay change: the body carries no pricing
 *     field, a priced discount or add-on line refuses, a customer on annual prepay refuses, and a booking whose
 *     tier / monthly-rate sync would write the customer row refuses;
 *   - no linked estimate and no separate program.
 *
 * The card pins values, but the Schedule handler re-reads and re-decides inside its own transaction. So Confirm also
 * hands the handler the approved plan (createScheduleBooking's internal `approvedBooking`), and the handler asserts it
 * right before commit: same inserted dates, same stamped price, property and technician, no setup fee, no tier or
 * monthly-rate write, no prepay term refresh. Anything else rolls the booking back (code APPROVED_BOOKING_CHANGED).
 *
 * Dark behind GATE_IB_BOOK_PLAN_VISITS (ibBookPlanVisitsLive, strict 'true'; needs GATE_IB_PLATFORM).
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { ibBookPlanVisitsLive } = require('../../config/feature-gates');
const { validScheduleDate, sameDayWindowElapsed, deriveWindowEnd } = require('../../utils/datetime-et');
const { resolveBillingLane } = require('../billing-lane');
const { dateOnlyString } = require('../../utils/date-only');

const MAX_VISIT_COUNT = 12;
const LAWN_ROUNDS_PATTERN = 'lawn_rounds_9';
// Handler answers that mean "the booking is no longer the one the card showed".
const STALE_CARD_CODES = new Set(['APPROVED_BOOKING_CHANGED', 'PRICE_DIVERGED', 'CUSTOMER_CHANGED_RETRY']);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ESTIMATE_PATH = 'Start a new plan through the estimate (accept_estimate).';
const NO_CHANGE_LINE = 'No price, discount or add-on is set. The WaveGuard tier and the monthly rate do not change. No welcome text and no invoice are sent.';

// The catalog's own cadence names (services.frequency, service-library VALID_FREQUENCIES) and the
// recurringPattern the Schedule create stores for each. Every-6-weeks is the modal's 'custom' + 42 days.
const CADENCES = {
  monthly: { label: 'monthly', pattern: 'monthly' },
  every_6_weeks: { label: 'every 6 weeks', pattern: 'custom', intervalDays: 42 },
  seasonal_feb_oct: { label: 'monthly, February to October', pattern: 'seasonal_feb_oct' },
  bimonthly: { label: 'every 2 months', pattern: 'bimonthly' },
  quarterly: { label: 'quarterly', pattern: 'quarterly' },
  semiannual: { label: 'twice a year', pattern: 'semiannual' },
  annual: { label: 'yearly', pattern: 'annual' },
};

const BOOK_PLAN_VISITS_TOOL = {
  name: 'book_plan_visits',
  description: `Book a RECURRING visit series for ONE existing customer who already has, or once had, a plan for the SAME service (for example a quarterly pest customer whose series ran out or was cancelled). It runs the Schedule screen's own create handler. The first call is a PREVIEW and changes nothing: the confirmation card shows the customer (first name and last initial), the address, the service and cadence, every planned visit date, the technician, the price per visit as the Schedule screen will stamp it, and whether the booking confirmation text goes. Only Confirm books.
The booking confirmation text for the first visit goes by default (send_texts true). Set send_texts false ONLY when the operator asks to book without a text. No welcome text and no invoice are sent, and no price, discount, add-on, booster, WaveGuard tier or monthly rate is changed.
Refused before any card: a customer with no plan for this service (start it through the estimate: accept_estimate), an open series for the service already booked, a customer on annual prepay, a booking that would change the customer's WaveGuard tier or monthly rate, a service that is not a catalog plan service, a cadence other than the catalog's, and a customer with more than one active property and no property_id. Relay a refusal as it is; do not send the operator to another screen.
service_type is a catalog name ("Quarterly Pest Control Service", "Bi-Monthly Lawn Care Service"); close words resolve to one catalog service or the tool lists the choices. recurring_pattern defaults to the service's catalog cadence. visit_count (2 to ${MAX_VISIT_COUNT}) books exactly that many visits; leave it out for an ongoing plan, which books the first four visits and keeps adding later ones itself. time_window is required: "morning", "afternoon" or a time on the hour like "9:00 AM". Admin only.
Use for: "book Pat back on quarterly pest starting Dec 3 at 9", "put her quarterly lawn plan back on the schedule".`,
  input_schema: {
    type: 'object',
    properties: {
      customer_id: { type: 'string', format: 'uuid', description: 'customers.id of the customer to book' },
      service_type: { type: 'string', description: 'Catalog service name (the plan service)' },
      scheduled_date: { type: 'string', format: 'date', description: 'First visit date, YYYY-MM-DD' },
      time_window: { type: 'string', description: '"morning", "afternoon", or a time on the hour like "9:00 AM"' },
      recurring_pattern: { type: 'string', enum: Object.keys(CADENCES), description: 'Optional. Defaults to the service\'s catalog cadence; any other value is refused.' },
      visit_count: { type: 'integer', minimum: 2, maximum: MAX_VISIT_COUNT, description: 'Optional total visits. Omit for an ongoing plan.' },
      technician_name: { type: 'string', description: 'Optional technician name' },
      technician_id: { type: 'string', format: 'uuid', description: 'Optional exact technician id (after an ambiguous name)' },
      property_id: { type: 'string', format: 'uuid', description: 'Optional saved property id; required when the customer has more than one active property' },
      send_texts: { type: 'boolean', description: 'Default true: the first visit sends the booking confirmation. Set false only when the operator asks for no text.' },
    },
    required: ['customer_id', 'service_type', 'scheduled_date', 'time_window'],
  },
};

const BOOK_PLAN_VISITS_TOOLS = [BOOK_PLAN_VISITS_TOOL];

const refuse = (error, code, extra = {}) => ({ error: `${error} Nothing was booked.`, ...(code ? { code } : {}), ...extra });
const money = (n) => `$${Number(n).toFixed(2)}`;
const uuid = (v) => (v == null ? '' : String(v).trim().toLowerCase());

function weekdayDate(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return `${day} (${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}

function privateName(customer) {
  const first = String(customer.first_name || '').trim();
  const last = String(customer.last_name || '').trim();
  return [first, last ? `${last[0].toUpperCase()}.` : ''].filter(Boolean).join(' ') || 'the customer';
}

function hashOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// The exact catalog row the request names, or a refusal. Only an active catalog plan service books here.
async function resolveService(serviceType) {
  const Tools = require('./tools');
  const services = await db('services').where({ is_active: true });
  const match = Tools.resolveBookingCatalogRowWithClose(Array.isArray(services) ? services : [], serviceType);
  if (match.ambiguous) {
    return refuse(`"${serviceType}" names several catalog services (${match.ambiguous.map((r) => r.name).join(', ')}). Ask the operator which one and propose again with the exact name.`, 'service_ambiguous');
  }
  const row = match.row;
  if (!row) return refuse(`"${serviceType}" is not a catalog service, so the bar can't book a plan for it.`, 'service_not_in_catalog');
  if (String(row.service_key || '').startsWith('area_addon_')) {
    return refuse(`"${row.name}" is an add-on treatment priced and limited from an estimate, so the bar can't book it by name.`, 'addon_by_name_unsupported');
  }
  if (row.billing_type !== 'recurring' || !CADENCES[row.frequency]) {
    return refuse(`"${row.name}" is not a recurring plan service with a set cadence in the catalog. ${ESTIMATE_PATH}`, 'not_a_plan_service');
  }
  return { row, bookedType: row.name };
}

// Does this customer already have (or had) a recurring series for the same service family at the booking property? The
// duplicate-series guard's own family classifier (duplicateGuardFamilyKey) decides the family, over every series parent in any
// status, so a cancelled or run-out series counts. The parent's STAMPED property_id must equal the booking property (active,
// resolved by resolveProperty); a legacy row with no property stamp does not qualify.
async function hadPlanForService(customerId, catalogRow, bookingProperty) {
  const { duplicateGuardFamilyKey } = require('../recurring-appointment-seeder');
  const target = duplicateGuardFamilyKey(catalogRow.name);
  const parents = await db('scheduled_services')
    .where({ customer_id: customerId, is_recurring: true })
    .whereNull('recurring_parent_id')
    .select('id', 'service_id', 'service_type', 'property_id');
  return (parents || []).some((p) => {
    const sameFamily = (p.service_id != null && String(p.service_id) === String(catalogRow.id))
      || (p.service_type && duplicateGuardFamilyKey(p.service_type) === target);
    return !!sameFamily && !!p.property_id && String(p.property_id) === String(bookingProperty.property_id);
  });
}

// An open series for the service (the handler's duplicate-series guard, asked now so no card is made).
async function openSeriesFor(customerId, catalogRow, bookingProperty) {
  const Seeder = require('../recurring-appointment-seeder');
  let scope = null;
  if (bookingProperty) {
    scope = await require('../estimate-converter').buildSeriesAddressScope(db, {
      property_id: bookingProperty.property_id,
      address: [
        [bookingProperty.service_address_line1, bookingProperty.service_address_line2].filter(Boolean).join(' '),
        bookingProperty.service_address_city,
        `${bookingProperty.service_address_state} ${bookingProperty.service_address_zip}`,
      ].join(', '),
    }, customerId);
  }
  return Seeder.findActiveRecurringSeries(db, {
    customerId, serviceId: catalogRow.id, serviceType: catalogRow.name, serviceAddressScope: scope,
  });
}

// Annual prepay: the create's post-commit refresh (refreshActiveTermsForCustomer) would touch a term. Asked through the
// refresh's own selection (refreshableTermsForCustomer), as reprice_future_visits does, so a term that ends before the first
// visit and a cancelled end-at-term agreement still inside its paid window both count.
async function prepayTermRefusal(customer) {
  if (resolveBillingLane(customer).mode === 'annual_prepay' || customer.billing_mode === 'annual_prepay') {
    return refuse("This customer is billed by annual prepay, and booking a series can change a prepay term. The bar can't book a plan for an annual-prepay customer.", 'annual_prepay_customer');
  }
  let terms = [];
  try {
    terms = await require('../annual-prepay-renewals').refreshableTermsForCustomer(customer.id);
  } catch (err) {
    logger.warn(`[intelligence-bar:book-plan-visits] prepay term read failed: ${err.message}`);
    return refuse("Could not check this customer's annual prepay terms, so the bar can't tell whether a booking would touch one.", 'prepay_check_failed');
  }
  return terms.length ? refuse("This customer has an annual prepay term the booking would refresh. The bar can't book a plan for them.", 'annual_prepay_term') : null;
}

// A bait-station program can owe a setup fee on its first visit (the handler's direct rodent setup resolver). The card
// shows no setup fee, so any program that would owe one is refused; the handler's transaction checks the same thing.
async function setupFeeRefusal(customerId, catalogRow) {
  const owed = await require('../secure-appointment-plans').directRodentSetupForRow(db, {
    customer_id: customerId, service_id: catalogRow.id, service_type: catalogRow.name,
  });
  return owed > 0
    ? refuse(`Restarting ${catalogRow.name} would add a bait-station setup fee of $${Number(owed).toFixed(2)} to the first visit. The card can't show that, so the bar can't book it.`, 'setup_fee_owed')
    : null;
}

// The property the visits land on: the named one, else the customer's only active property. Always an active, fully
// addressed saved property (its stamp), because the plan history is matched on it and the booking stamps it. A customer with
// several active properties must name one; a customer with none cannot be booked here.
async function resolveProperty(customerId, propertyId) {
  const Tools = require('./tools');
  let id = propertyId;
  if (!id) {
    const active = await db('customer_properties').where({ customer_id: customerId, active: true }).limit(2).select('id');
    if (active.length === 0) {
      return { refusal: { error: `This customer has no saved active property, so the plan visits have no address to match. ${ESTIMATE_PATH}`, code: 'no_saved_property' } };
    }
    if (active.length === 1) id = active[0].id;
  }
  const proposal = await Tools.ibBookingPropertyProposal(customerId, id);
  if (proposal.error) return { refusal: { error: proposal.error, code: proposal.code, ...(proposal.properties ? { properties: proposal.properties } : {}) } };
  return { stamp: proposal.stamp };
}

async function resolveTechnician(input) {
  const Tools = require('./tools');
  if (input.technician_id) {
    const tech = await Tools.resolveActiveTechnicianById(input.technician_id);
    return tech ? { tech } : { refusal: refuse('That technician was not found or can no longer take visits.', 'technician_not_found') };
  }
  if (input.technician_name) {
    const tech = await Tools.resolveTechnicianByName(input.technician_name);
    if (!tech) return { refusal: refuse('No active technician matches that name. Retry with a corrected name or leave the technician out.', 'technician_not_found') };
    if (tech.error) return { refusal: { error: `${tech.error} Nothing was booked.`, code: 'technician_ambiguous', candidates: tech.candidates } };
    return { tech };
  }
  return { tech: null };
}

// An inspection-credit offer, paused ones included: a booking records the customer's booking event and can mint credit on it,
// money the card does not show. Refused here; the handler's transaction checks it again under the credit lock.
async function inspectionCreditRefusal(customerId) {
  let amount = 0;
  try {
    const projected = await require('../inspection-credit').projectRedeemableOfferAmount(customerId, { includePaused: true });
    amount = Number(projected?.amount ?? projected) || 0;
  } catch (err) {
    logger.warn(`[intelligence-bar:book-plan-visits] inspection credit read failed: ${err.message}`);
    return refuse("Could not check this customer's inspection credit, so the bar can't tell whether the booking would redeem one.", 'credit_check_failed');
  }
  return amount > 0
    ? refuse(`This customer has $${amount.toFixed(2)} of open inspection-credit offers (paused ones included). Booking can redeem them, and the card can't show that, so the bar can't book it.`, 'booking_with_credit_unsupported')
    : null;
}

// Any other visit in a planned slot, at the window the handler will really book (the service's duration), tech-blind like the
// handler's own probe. Any overlap refuses (the handler's transaction refuses one too).
async function overlapRefusal({ dates, windowStart, durationMinutes, technicianId }) {
  const WindowRules = require('../scheduling/window-rules');
  let windowEnd;
  try {
    ({ window_end: windowEnd } = WindowRules.assertAdminAppointmentWindow({ windowStart, windowEnd: null, durationMinutes }));
  } catch (err) {
    if (err?.status === 422) return refuse(err.message, 'invalid_appointment_window');
    throw err;
  }
  for (const date of dates) {
    const clash = await db.transaction((trx) => WindowRules.probeSlotOverlap({ trx, date, windowStart, windowEnd, technicianId: technicianId || null }));
    if (clash.length) {
      return refuse(`Another visit already holds ${weekdayDate(date)} at that time. Pick another time or day, or book it from the Schedule screen, which warns and books anyway.`, 'slot_overlap');
    }
  }
  return null;
}

// The planned visits for the request: the Schedule create's own series-date plan, never a copy of it.
async function planDates(body, bookingProperty) {
  const AdminSchedule = require('../../routes/admin-schedule');
  const { pattern, intervalDays } = await AdminSchedule.lawnRoundsSeriesForBooking(db, {
    pattern: body.recurringPattern, intervalDays: body.recurringIntervalDays, serviceType: body.serviceType, serviceId: body.serviceId,
  });
  const seriesDates = new Set([body.scheduledDate]);
  const plannedChildDates = [];
  const monthAnchorOpts = AdminSchedule.seriesMonthAnchorOpts({
    isRecurring: true, recurringPattern: pattern, scheduledDate: body.scheduledDate, recurringNth: undefined, recurringWeekday: undefined,
  });
  const plan = await AdminSchedule.planCreateSeriesDates(db, {
    customerId: body.customerId, scheduledDate: body.scheduledDate, bookingProperty, isRecurring: true, recurringPattern: pattern,
    recurringIntervalDays: intervalDays, recurringCount: body.recurringCount, recurringOngoing: body.recurringOngoing,
    monthAnchorOpts, skipWeekends: body.skipWeekends, weekendShift: body.weekendShift, seriesDates, plannedChildDates,
  });
  return { dates: [body.scheduledDate, ...plannedChildDates], shortfall: plan.shortfallWarning, pattern };
}

// The per-visit price the handler stamps, from the handler's own price builder over the same inputs.
async function priceFor({ customer, catalogRow, scheduledDate, bookingProperty }) {
  const AdminSchedule = require('../../routes/admin-schedule');
  await AdminSchedule.primePercentDiscountExclusions().catch(() => {});
  const recurringMembershipBooking = AdminSchedule.bookingCreatesWaveGuardCoverage({
    isRecurring: true, isCallback: false, serviceType: catalogRow.name, serviceRecord: catalogRow, customer, scheduledDate,
  });
  let pricing;
  try {
    pricing = await AdminSchedule.buildAppointmentPricing({
      serviceRecord: catalogRow, serviceType: catalogRow.name, serviceId: catalogRow.id, customer, recurringMembershipBooking,
      refillContext: { propertyId: bookingProperty?.property_id || null, sourceEstimateId: null, isRecurring: true },
    });
  } catch (err) {
    return { refusal: refuse(`The Schedule screen would not price this visit: ${err.message}`, 'pricing_refused') };
  }
  if (pricing.primaryDiscount || pricing.appointmentDiscount || (pricing.addonLines || []).length) {
    return { refusal: refuse('The price of this booking would carry a discount or an add-on. The bar books plan visits at the plain catalog price only.', 'price_would_change') };
  }
  // A dues-covered member's series (monthly lane, no payer) carries no per-visit price: the dues cover it.
  const duesCovered = !customer.payer_id && resolveBillingLane(customer).mode === 'monthly_membership';
  const price = duesCovered || pricing.finalPrice == null || !(Number(pricing.finalPrice) > 0) ? null : Number(pricing.finalPrice);
  if (price == null && !duesCovered) {
    const verdict = AdminSchedule.recurringWithoutBillableAmount({
      isRecurring: true, recurringFloorPrice: 0, customer, createInvoiceOnComplete: true, typedOneTimeBilling: false, isCallback: false, serviceType: catalogRow.name,
    });
    if (verdict) {
      return { refusal: refuse(`"${catalogRow.name}" has no catalog price and nothing in this customer's billing would invoice its visits, so the bar can't book it without a price.`, 'no_billable_amount') };
    }
  }
  return { price, duesCovered, finalPrice: Number(pricing.finalPrice) || 0 };
}

// The request body for createScheduleBooking: no pricing field, no estimate, no override.
function bodyFor({ input, catalogRow, cadence, windowStart, technicianId, propertyId, visitCount, sendTexts, expectedPrice }) {
  return {
    customerId: uuid(input.customer_id),
    scheduledDate: input.scheduled_date,
    serviceType: catalogRow.name,
    serviceId: catalogRow.id,
    windowStart,
    ...(technicianId ? { technicianId } : {}),
    ...(propertyId ? { propertyId } : {}),
    isRecurring: true,
    recurringPattern: cadence.pattern,
    ...(cadence.intervalDays ? { recurringIntervalDays: cadence.intervalDays } : {}),
    ...(visitCount ? { recurringCount: visitCount, recurringOngoing: false } : { recurringOngoing: true }),
    // The Schedule modal's own create-invoice default for a priced visit; the handler strips it for a dues-covered series.
    createInvoice: true,
    // The handler's own price check (PRICE_DIVERGED): its pricing must equal the catalog price the card showed.
    expected_price: expectedPrice,
    sendConfirmationSms: sendTexts,
  };
}

function addressOf(customer, stamp) {
  if (stamp) {
    return [[stamp.service_address_line1, stamp.service_address_line2].filter(Boolean).join(' '), stamp.service_address_city,
      [stamp.service_address_state, stamp.service_address_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  }
  return [[customer.address_line1, customer.address_line2].filter(Boolean).join(' '), customer.city,
    [customer.state, customer.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

// What the plan changes on the customer row: the handler's own tier / monthly-rate sync, asked read-only.
async function planSyncRefusal({ customerId, catalogRow, dates }) {
  const { bookingWouldChangeCustomerPlan } = require('../self-booking-plan-sync');
  const newRows = dates.map((d) => ({
    service_type: catalogRow.name, service_key: catalogRow.service_key, service_name: catalogRow.name,
    catalog_billing_type: catalogRow.billing_type, scheduled_date: d, is_recurring: true, status: 'pending', is_callback: false,
  }));
  const verdict = await bookingWouldChangeCustomerPlan({ customerId, newRows });
  if (!verdict.writes) return null;
  return refuse('Booking this series would also change the customer\'s WaveGuard tier or monthly rate. The bar books plan visits only when billing stays as it is. Change the plan from the estimate or the customer page.', 'billing_would_change');
}

// The full card for one call, or { error, code } the model relays. Reads only.
async function planBooking(input) {
  if (!ibBookPlanVisitsLive()) {
    return refuse('Booking plan visits from the bar is not switched on yet (GATE_IB_BOOK_PLAN_VISITS), so the bar can\'t do it from here yet.', 'book_plan_visits_not_enabled');
  }
  const customerId = uuid(input.customer_id);
  if (!customerId) return refuse('customer_id is required.', 'invalid_input');
  const dateStr = validScheduleDate(input.scheduled_date);
  if (!dateStr) return refuse(`scheduled_date must be a valid YYYY-MM-DD date that is not in the past (got "${input.scheduled_date}").`, 'invalid_date');
  const sendTexts = input.send_texts !== false;

  const Tools = require('./tools');
  const windowRefusal = Tools.ibBookingWindowRefusal(input.time_window);
  if (windowRefusal) return refuse(windowRefusal.error, windowRefusal.code);
  const windowStart = Tools.parseTimeWindowStart(input.time_window).start;
  if (!windowStart) return refuse('time_window is required: "morning", "afternoon" or a time on the hour like "9:00 AM".', 'time_window_required');

  const customer = await db('customers').where({ id: customerId }).first();
  if (!customer) return refuse('No customer with that id.', 'customer_not_found');
  if (customer.deleted_at) return refuse('This customer record is no longer live (deleted or merged).', 'customer_not_live');
  if (customer.active !== true) return refuse(`${privateName(customer)} is not an active customer. ${ESTIMATE_PATH}`, 'customer_not_active');

  const service = await resolveService(input.service_type);
  if (service.error) return service;
  const { row: catalogRow } = service;
  const catalogCadence = CADENCES[catalogRow.frequency];
  if (input.recurring_pattern && input.recurring_pattern !== catalogRow.frequency) {
    return refuse(`"${catalogRow.name}" is a ${catalogCadence.label} plan in the catalog, so it can't be booked ${CADENCES[input.recurring_pattern]?.label || input.recurring_pattern}. Use the catalog service with that cadence.`, 'cadence_not_in_catalog');
  }
  const cadence = catalogCadence;

  // Today's first visit: its window must not already be over (create_appointment's own rule, at the service's duration).
  const durationMinutes = Number(catalogRow.default_duration_minutes) > 0 ? Number(catalogRow.default_duration_minutes) : 60;
  if (sameDayWindowElapsed(dateStr, deriveWindowEnd(windowStart, durationMinutes) || windowStart)) {
    return refuse('That time has already passed today. Pick a later window or a future date.', 'window_elapsed');
  }

  const notHeldRetired = await require('../service-library').retiredServicesNotHeldBy({
    customerId, serviceTypes: [catalogRow.name], recurrence: { pattern: cadence.pattern, intervalDays: cadence.intervalDays },
  });
  if (notHeldRetired.length) {
    return refuse(`${notHeldRetired.map((r) => r.name).join(', ')} is retired for new sales and this customer is not on that plan.`, 'retired_service');
  }

  const property = await resolveProperty(customerId, input.property_id);
  if (property.refusal) return refuse(property.refusal.error.replace(/ Nothing was (proposed|booked)\.?$/, ''), property.refusal.code, property.refusal.properties ? { properties: property.refusal.properties } : {});
  const bookingProperty = property.stamp;

  if (!(await hadPlanForService(customerId, catalogRow, bookingProperty))) {
    return refuse(`${privateName(customer)} has no earlier ${catalogRow.name} plan, so this would be a brand-new program. ${ESTIMATE_PATH}`, 'new_program');
  }
  const open = await openSeriesFor(customerId, catalogRow, bookingProperty);
  if (open.length) {
    const next = open[0].next_upcoming_date ? ` Its next visit is ${open[0].next_upcoming_date}.` : '';
    return refuse(`${privateName(customer)} already has an open ${catalogRow.name} series.${next} Move or extend that series instead of booking another.`, 'duplicate_series');
  }
  const prepay = await prepayTermRefusal(customer);
  if (prepay) return prepay;
  const setupFee = await setupFeeRefusal(customerId, catalogRow);
  if (setupFee) return setupFee;
  const credit = await inspectionCreditRefusal(customerId);
  if (credit) return credit;

  const tech = await resolveTechnician(input);
  if (tech.refusal) return tech.refusal;

  const visitCount = Number.isInteger(input.visit_count) ? input.visit_count : null;
  if (visitCount != null && (visitCount < 2 || visitCount > MAX_VISIT_COUNT)) return refuse(`visit_count must be 2 to ${MAX_VISIT_COUNT}.`, 'invalid_input');
  const priced = await priceFor({ customer, catalogRow, scheduledDate: dateStr, bookingProperty });
  if (priced.refusal) return priced.refusal;
  const body = bodyFor({
    input: { ...input, scheduled_date: dateStr }, catalogRow, cadence, windowStart,
    technicianId: tech.tech?.id || null, propertyId: bookingProperty.property_id, visitCount, sendTexts,
    expectedPrice: priced.finalPrice,
  });
  const planned = await planDates(body, bookingProperty);
  if (planned.dates.length < 2) return refuse('The Schedule screen could not place a second visit for this cadence and date.', 'no_plan_dates');
  const syncRefusal = await planSyncRefusal({ customerId, catalogRow, dates: planned.dates });
  if (syncRefusal) return syncRefusal;
  const overlap = await overlapRefusal({ dates: planned.dates, windowStart, durationMinutes, technicianId: tech.tech?.id || null });
  if (overlap) return overlap;

  const windowLabel = Tools.clockLabel(`${windowStart}:00`);
  const visits = planned.dates.map((date, i) => ({ number: i + 1, date, weekday: WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()], window: windowLabel }));
  const technicianLabel = tech.tech ? tech.tech.name : null;
  // The cadence the Schedule create will really write: a residential six-week lawn plan becomes the nine fixed lawn rounds.
  const effectivePattern = planned.pattern;
  const cadenceLabel = effectivePattern === LAWN_ROUNDS_PATTERN ? 'nine lawn rounds a year' : cadence.label;
  const pins = {
    effective_pattern: effectivePattern,
    body,
    dates: planned.dates,
    price: priced.price,
    dues_covered: priced.duesCovered,
    catalog: { id: String(catalogRow.id), name: catalogRow.name, frequency: catalogRow.frequency, base_price: catalogRow.base_price == null ? null : Number(catalogRow.base_price) },
    property: { id: bookingProperty.property_id, address: addressOf(customer, bookingProperty), lat: bookingProperty.lat ?? null, lng: bookingProperty.lng ?? null },
    // The address the card showed (the customer's own when no saved property was named).
    address: addressOf(customer, bookingProperty),
    technician: tech.tech ? String(tech.tech.id) : null,
    customer: {
      id: String(customer.id), active: customer.active === true, billing_mode: customer.billing_mode || null, payer_id: customer.payer_id || null,
      monthly_rate: customer.monthly_rate == null ? null : Number(customer.monthly_rate), tier: customer.waveguard_tier || null,
    },
    send_texts: sendTexts,
  };

  return {
    preview: true,
    customer_id: customerId,
    customer_name: privateName(customer),
    address: addressOf(customer, bookingProperty),
    service: catalogRow.name,
    cadence: cadenceLabel,
    cadence_pattern: effectivePattern,
    ongoing: visitCount == null,
    visits,
    visit_count_shown: visits.length,
    technician: technicianLabel,
    price_per_visit: priced.price == null ? null : money(priced.price),
    price_note: priced.duesCovered ? 'covered by the customer\'s monthly dues (no per-visit price is stamped)' : null,
    send_texts: sendTexts,
    notifies_customer: sendTexts,
    ...(planned.shortfall ? { shortfall: planned.shortfall } : {}),
    _version: hashOf(pins),
    _body: body,
    // What the handler asserts inside its booking transaction before commit (createScheduleBooking's approvedBooking).
    _approved: {
      dates: planned.dates, price: priced.price, propertyId: bookingProperty.property_id, technicianId: tech.tech ? String(tech.tech.id) : null,
      address: { line1: bookingProperty.service_address_line1, line2: bookingProperty.service_address_line2, city: bookingProperty.service_address_city, state: bookingProperty.service_address_state, zip: bookingProperty.service_address_zip },
    },
  };
}

// Card lines (authorization-contract.js reads these for the curated card).
function cardLines(preview) {
  const lines = [];
  lines.push({ kind: 'customer', text: `Booked for ${preview.customer_name} at ${preview.address}` });
  lines.push({ kind: 'operational', text: `Service: ${preview.service}, ${preview.cadence}` });
  for (const v of preview.visits || []) lines.push({ kind: 'operational', text: `Visit ${String(v.number).padStart(2, '0')} · ${weekdayDate(v.date)} · ${v.window}` });
  if (preview.ongoing) lines.push({ kind: 'operational', text: `Ongoing plan: these are the first ${preview.visit_count_shown} visits. The plan adds later visits itself on ${preview.cadence_pattern === LAWN_ROUNDS_PATTERN ? 'the nine fixed lawn rounds' : 'the same cadence'}.` });
  if (preview.shortfall) lines.push({ kind: 'operational', text: preview.shortfall });
  lines.push({ kind: 'operational', text: `Technician: ${preview.technician || 'none picked (the plan leaves the visits unassigned)'}` });
  lines.push({ kind: 'billing', text: preview.price_per_visit ? `Price per visit: ${preview.price_per_visit}, the catalog price, as the Schedule screen stamps it` : `Price per visit: ${preview.price_note || 'none stamped'}` });
  lines.push({ kind: 'billing', text: NO_CHANGE_LINE });
  if (preview.send_texts) {
    lines.push({ kind: 'comms', text: 'The first visit sends its booking confirmation by text or email, per the customer\'s settings. It does not send if they turned it off or were already confirmed for another visit at this time. Texts after 8 PM wait until 8 AM.' });
    lines.push({ kind: 'comms', text: 'To book without that confirmation, ask for "book without a text" and a new card is shown.' });
  } else {
    lines.push({ kind: 'comms', text: 'No booking confirmation text goes, as asked.' });
  }
  lines.push({ kind: 'comms', text: 'Reminder texts before each visit go out later, as for every booked visit.' });
  return lines;
}

// The approved plan, re-derived — or the refusal when anything changed since the card.
async function verifiedPlan(input) {
  const pinned = input._verified_book_plan_version;
  if (!pinned) return { refusal: { error: 'Use the confirmation card to approve this booking.' } };
  const plan = await planBooking(input);
  if (plan.error) return { refusal: { ...plan, preview_changed: true } };
  if (plan._version !== pinned) {
    return { refusal: { error: 'The customer, the visit dates, the price or the address changed after the card was shown. Nothing was booked. Ask again for a fresh confirmation card.', preview_changed: true } };
  }
  return { plan };
}

async function actorFor(actionContext) {
  const technicianId = actionContext?.technicianId || null;
  let technicianName = null;
  if (technicianId) {
    try { technicianName = (await db('technicians').where({ id: technicianId }).first('name'))?.name || null; } catch { technicianName = null; }
  }
  return { technicianId, technicianName };
}

function replyRefusal(reply) {
  const json = reply.json || {};
  if (reply.status === 409 && Array.isArray(json.existingSeries || json.existing_series || json.conflicts)) {
    return refuse('The customer already has an open series for this service, so the Schedule screen refused a second one.', 'duplicate_series', { status: reply.status });
  }
  return refuse(json.error || `The Schedule screen refused the booking (${reply.status}).`, json.code || 'schedule_refused', {
    status: reply.status, ...(STALE_CARD_CODES.has(json.code) ? { preview_changed: true } : {}),
  });
}

async function commit(input, actionContext) {
  const verified = await verifiedPlan(input);
  if (verified.refusal) return verified.refusal;
  const { plan } = verified;
  const { createScheduleBooking } = require('../../routes/admin-schedule');
  let reply;
  try {
    // The one booking call: exactly the body the card pinned.
    reply = await createScheduleBooking({ body: plan._body, actor: await actorFor(actionContext), approvedBooking: plan._approved });
  } catch (err) {
    if (err?.status && err.status < 500 && err.isOperational) {
      return refuse(err.message, err.code || 'schedule_refused', { status: err.status, ...(STALE_CARD_CODES.has(err.code) ? { preview_changed: true } : {}) });
    }
    logger.error(`[intelligence-bar:book-plan-visits] booking interrupted for ${plan.customer_id}: ${err?.code || err?.name || 'error'}`);
    return {
      outcome_unknown: true, code: 'execution_interrupted',
      error: 'The booking was interrupted. Some visits may have been booked. Check the customer\'s schedule before trying again.',
    };
  }
  if (!(reply.status === 200 || reply.status === 201) || !reply.json?.id) return replyRefusal(reply);
  const json = reply.json;
  const booked = Array.isArray(json.appointments) ? json.appointments : [];
  logger.info(`[intelligence-bar:book-plan-visits] ${plan.customer_id}: ${booked.length} visit(s) booked`);
  const warnings = Array.isArray(json.warnings) ? json.warnings : [];
  return {
    success: true,
    customer_id: plan.customer_id,
    service: plan.service,
    visits_booked: json.recurringCreated ?? booked.length,
    dates: booked.map((a) => dateOnlyString(a.date)).filter(Boolean).sort(),
    confirmation_text: plan.send_texts ? 'requested for the first visit (it sends only if the customer\'s settings allow)' : 'not sent, as asked',
    warnings,
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    message: `${plan.customer_name}'s ${plan.service} plan is booked: ${booked.length} visit${booked.length === 1 ? '' : 's'}.`,
  };
}

async function executeBookPlanVisitsTool(toolName, input = {}, actionContext = {}) {
  if (actionContext && actionContext.isAdmin === false) {
    return { error: 'Booking plan visits is limited to admin accounts', code: 'permission_denied' };
  }
  try {
    switch (toolName) {
      case 'book_plan_visits': {
        // Only /confirm-action sets confirmed (route-derived, never a model param).
        if (input.confirmed !== true) {
          return await planBooking(input);
        }
        if (!ibBookPlanVisitsLive()) {
          return { error: 'Booking plan visits from the bar is turned off (GATE_IB_BOOK_PLAN_VISITS). Nothing was booked.', code: 'gate_off' };
        }
        return await commit(input, actionContext);
      }
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:book-plan-visits] ${toolName} failed (${err.code || err.name || 'error'}): ${err.message}`);
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The booking was interrupted. Some visits may have been booked. Check the customer\'s schedule before trying again.' }
      : { error: 'Could not prepare the booking card' };
  }
}

module.exports = { BOOK_PLAN_VISITS_TOOLS, executeBookPlanVisitsTool, cardLines, bookPlanVisitsLive: ibBookPlanVisitsLive, _private: { planBooking, CADENCES } };
