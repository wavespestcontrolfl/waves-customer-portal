// Schedule-screen booking — the body of POST /api/admin/schedule, moved
// verbatim out of routes/admin-schedule.js (owner 2026-10-06) so the
// Intelligence Bar's "start a recurring program" tool and the Schedule
// screen run the exact same booking code. The route is now a thin wrapper:
// it passes the request body and the acting user in, and answers with the
// { status, json } this returns. Errors the route used to hand to next()
// are rethrown unchanged.
//
// The post-commit side-effects still run in a setImmediate scheduled before
// this returns; the caller's response goes out first because setImmediate
// fires only after the awaiting caller's continuation has run.
//
// Callers outside the admin-schedule router must prime the percent-discount
// exclusion catalog first (the router's own router.use does it for this
// route) — see primePercentDiscountExclusions / assertPercentExclusionCatalogReady.
const db = require('../models/db');
const logger = require('../services/logger');
const { isEnabled, discountStackingLive } = require('../config/feature-gates');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const { assertAssignableTechnician } = require('../services/technician-eligibility');
const { acquireOccupancyLocks, findConflictingVisits } = require('../services/scheduling/occupancy');
const {
  ADMIN_OCCUPANCY_EXCLUDE_STATUSES, assertAdminAppointmentWindow, slotOverlapWarning,
} = require('../services/scheduling/window-rules');
const { clearOfBlackout } = require('../services/scheduling/blackout-nudge');
const { SEASONAL_FEB_OCT, customerPrefersNoWeekends } = require('../services/recurring-appointment-seeder');
const { anchorSoleProperty } = require('../services/customer-properties');
const { completeScheduledServiceInsert } = require('../services/booking/create-scheduled-service');
const {
  capsSnapshotFromPricing, copyStampedServiceAddressFields, stampPricingRegimeMarker, stampPrimaryLineDiscount,
} = require('../services/booking/visit-financial-stamps');
const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');
const { isNewRecurringSignupCandidate, sendNewRecurringWelcome } = require('../services/new-recurring-welcome-sms');
const { isReService } = require('../services/re-service');
const reserviceOfficeRequest = require('../services/reservice-office-request');
const { resolveBillingLane } = require('../services/billing-lane');
const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const { resolveSeriesChildIdentity } = require('../services/service-catalog-names');
const { stampSeriesPrepaid } = require('../services/prepaid-series');
const { syncCustomerWaveGuardPlanFromScheduledServices } = require('../services/self-booking-plan-sync');
const { visitsPerYearForCadence, prepayCoverageCadenceForPattern } = require('../services/prepay-cadence');

const reply = (status, json) => ({ status, json });

// Does an unowned (customer_id NULL) quote's captured contact match the customer
// we're about to book it against? Compares the last 10 phone digits (phones are
// stored mixed E.164 / 10-digit) or a lowercased email. Used to gate attaching a
// lead/standalone estimate to a customer — never pair a quote with a stranger.
function estimateContactMatchesCustomer(estimate, customer) {
  if (!estimate || !customer) return false;
  const digits10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  const ep = digits10(estimate.customer_phone);
  const cp = digits10(customer.phone);
  if (ep && ep.length === 10 && ep === cp) return true;
  const ee = String(estimate.customer_email || '').trim().toLowerCase();
  const ce = String(customer.email || '').trim().toLowerCase();
  return !!(ee && ee === ce);
}

// Phone-agent double-booking guard (owner ruling 2026-09-28).
//
// The AI phone agent books visits straight from calls — inbound always, and
// outbound too once GATE_CALL_OUTBOUND_BOOKING is on. Nothing stopped a
// staff member from then booking the SAME visit again by hand on this
// screen: the agent's booking and the office's hand-booking never checked
// each other. The reverse order (office books first, the agent's call tries
// to book the same visit) is already covered at call-processing time by
// call-recording-processor's findAttachableCallAppointment, which attaches
// to or holds the existing visit instead of creating a duplicate. This is
// the uncovered direction — the agent books first, so it's the office's
// manual create that needs the check.
//
// Same shape as the duplicate-series guard above: a fast preflight before
// any pricing/tech/insert work, fail-open on a query error (protective, not
// load-bearing), and an explicit, logged override
// (allowCallBookingDuplicate: true) for the rare intentional second visit.
function callBookingConflictBody(existingVisits) {
  return {
    code: 'duplicate_call_booking',
    error: 'The phone agent already booked this visit for this customer.',
    existingVisits: existingVisits.map((v) => ({
      id: v.id,
      serviceType: v.service_type,
      // The line that matched — the visit's own service, or the add-on on
      // it that shares a line with the request (codex #5183 r3 P2).
      matchedService: v.matched_service || v.service_type,
      scheduledDate: v.scheduled_date_label,
      windowStart: v.window_start_label || null,
      status: v.status,
    })),
  };
}

// Every service line this create books — the primary and each add-on,
// which persist on the same visit (codex #5183 r1 P1): catalog ids, every
// normalized name, and the names of lines that carry NO id (legacy / ad-hoc
// lines, matched by name alone).
function requestedServiceLines(serviceType, serviceId, serviceAddons) {
  const lines = [{ id: serviceId, name: serviceType }, ...(Array.isArray(serviceAddons)
    ? serviceAddons.map((a) => ({ id: a?.serviceId, name: a?.name || a?.serviceName }))
    : [])];
  const norm = (n) => String(n || '').trim().toLowerCase();
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  return {
    ids: uniq(lines.map((l) => (l.id ? String(l.id) : null))),
    names: uniq(lines.map((l) => norm(l.name))),
    idlessNames: uniq(lines.filter((l) => !l.id).map((l) => norm(l.name))),
  };
}

// One side of the service-line match (a visit's own service or one add-on):
// the same catalog id — a renamed service keeps its id (codex #5183 r2 P1) —
// or, where either side has no id, the same normalized name.
function sameServiceLine(qb, idCol, nameCol, lines) {
  if (lines.ids.length) qb.orWhereRaw(`${idCol}::text = ANY(?)`, [lines.ids]);
  if (lines.names.length) qb.orWhereRaw(`${idCol} IS NULL AND LOWER(TRIM(${nameCol})) = ANY(?)`, [lines.names]);
  if (lines.idlessNames.length) qb.orWhereRaw(`LOWER(TRIM(${nameCol})) = ANY(?)`, [lines.idlessNames]);
}

// sameServiceLine's rule for one stored line, in JS: which line of a
// matched visit (its own service or an add-on) the request collided with.
function lineMatches(id, name, lines) {
  const norm = String(name || '').trim().toLowerCase();
  if (id && lines.ids.includes(String(id))) return true;
  return (!id && lines.names.includes(norm)) || lines.idlessNames.includes(norm);
}

// Live, call-booked visits for this customer within ±1 day of ANY of the
// dates the create will book — the anchor, and for a series every generated
// occurrence and booster (codex #5183 r3 P1) — that share a service line
// with the request by their own service or one of their add-ons. Parent
// visits, plus the follow-up visit a call promised (a phone_call child of
// the call's booking — ensureCallFollowUpVisit; codex #5183 r3 P1). `conn`
// is the booking transaction for the locked re-check.
async function findExistingCallBookings({ conn = db, customerId, lines, dates, propertyId }) {
  const days = [...new Set((dates || []).filter(Boolean).map((d) => String(d).slice(0, 10)))];
  if ((!lines.names.length && !lines.ids.length) || !days.length) return [];
  const query = conn('scheduled_services as ss')
    .where('ss.customer_id', customerId)
    .where((qb) => qb.whereNull('ss.parent_service_id').orWhere('ss.booking_source', 'phone_call'))
    // Live visits only (scheduled-service-statuses.js): a completed, skipped
    // or no-show call booking is not a visit the office could double-book.
    .whereIn('ss.status', require('../services/scheduled-service-statuses').NONTERMINAL_SCHEDULED_SERVICE_STATUSES)
    .where((qb) => qb.where('ss.booking_source', 'phone_call').orWhereNotNull('ss.source_call_log_id'))
    .where((qb) => {
      sameServiceLine(qb, 'ss.service_id', 'ss.service_type', lines);
      qb.orWhereExists(function sharedAddonLine() {
        this.select(conn.raw('1')).from('scheduled_service_addons as a')
          .whereRaw('a.scheduled_service_id = ss.id')
          .where((aq) => sameServiceLine(aq, 'a.service_id', 'a.service_name', lines));
      });
    })
    .whereRaw('EXISTS (SELECT 1 FROM unnest(?::date[]) AS d(day) WHERE ss.scheduled_date BETWEEN d.day - 1 AND d.day + 1)', [days]);
  if (propertyId) {
    query.where((qb) => qb.where('ss.property_id', propertyId).orWhereNull('ss.property_id'));
  }
  const rows = await query
    .select(
      'ss.id', 'ss.status', 'ss.service_type', 'ss.service_id',
      conn.raw("to_char(ss.scheduled_date, 'YYYY-MM-DD') as scheduled_date_label"),
      conn.raw("to_char(ss.window_start, 'HH24:MI') as window_start_label"),
    )
    .orderBy('ss.scheduled_date', 'asc')
    .orderBy('ss.window_start', 'asc');
  // A visit that matched only through an add-on reports that add-on's line.
  const viaAddon = rows.filter((r) => !lineMatches(r.service_id, r.service_type, lines)).map((r) => r.id);
  const addons = viaAddon.length
    ? await conn('scheduled_service_addons').whereIn('scheduled_service_id', viaAddon).select('scheduled_service_id', 'service_id', 'service_name')
    : [];
  return rows.map((r) => ({
    ...r,
    matched_service: viaAddon.includes(r.id)
      ? addons.find((a) => a.scheduled_service_id === r.id && lineMatches(a.service_id, a.service_name, lines))?.service_name || null
      : null,
  }));
}

// The property the guard scopes to: the operator's chosen address, else the
// linked estimate's (a booking from a quote for another saved property is
// not a duplicate of this one — codex #5183 r2 P2), else none.
async function callBookingGuardPropertyId(conn, { bookingProperty, linkedEstimateId }) {
  if (bookingProperty?.property_id) return bookingProperty.property_id;
  if (!linkedEstimateId) return null;
  const est = await conn('estimates').where({ id: linkedEstimateId }).first('property_id');
  return est?.property_id || null;
}

// The guard's verdict for one create: the 409 body, or null to proceed (no
// match, an override that covers every match, or — preflight only — a
// failed lookup, which fails open). The override covers only the visits the
// operator reviewed: a match that arrived after the box was shown is a new
// conflict (codex #5183 r2 P2).
async function callBookingDuplicateConflict({ conn = db, failOpen = true, override, reviewedIds, customerId, lines, dates, bookingProperty, linkedEstimateId }) {
  try {
    const propertyId = await callBookingGuardPropertyId(conn, { bookingProperty, linkedEstimateId });
    const existing = await findExistingCallBookings({ conn, customerId, lines, dates, propertyId });
    if (!existing.length) return null;
    const reviewed = new Set(override === true && Array.isArray(reviewedIds) ? reviewedIds.map(String) : []);
    if (!existing.every((v) => reviewed.has(String(v.id)))) return callBookingConflictBody(existing);
    logger.warn(`[schedule] allowCallBookingDuplicate override: booking customer ${customerId} again alongside reviewed phone-agent-booked visit(s) ${existing.map((v) => v.id).join(', ')}`);
    return null;
  } catch (guardErr) {
    if (!failOpen) throw guardErr;
    logger.warn(`[schedule] call-booking duplicate guard failed (booking proceeds): ${guardErr.message}`);
    return null;
  }
}

// Throws the conflict for the route's catch to answer with its 409 — the
// preflight (fails open on a lookup error) and the locked re-check inside the
// booking transaction (passes the trx and `failOpen: false`: an error there
// aborts the create, and a conflict rolls it back) share this one exit.
async function assertNoCallBookingConflict(guard) {
  const conflict = await callBookingDuplicateConflict(guard);
  if (conflict) throw Object.assign(new Error('The phone agent already booked this visit for this customer.'), { callBookingConflict: conflict });
}

// body  — the booking request (the route's req.body).
// actor — who is booking: { technicianId, technicianName } (the route's
//         req.technicianId and req.technician?.name).
// Returns { status, json }; any error the route used to pass to next() is
// rethrown.
async function createScheduleBooking({ body, actor }) {
  // Lazy: these helpers are shared with the rest of the schedule router, and
  // requiring the route module at load time would be a route-load cycle.
  const {
    MONTH_RECURRENCE_INTERVALS, addonLineRecurrence, assertNoDiscountStackGroupConflict,
    assertPrepayTotalMatchesPricing, assertPriceMatchesPricing, bookingCreatesWaveGuardCoverage,
    buildAppointmentPricing, calculateVisitFinancialsForAddons, classifyAppointmentTag,
    computeBoosterDates, customerEligibleForFreeCallback, dateOnly,
    discountStackGroupRowsForPricing, duplicateSeriesConflictBody, filterAddonLinesForDate, getZone,
    httpError, insertScheduledServiceAddons, loadSeriesBlackoutDates, nextRecurringDate,
    occurrenceFloorPrice, recurrenceOrdinalOptions, recurringCandidateTooCloseToAnchor,
    recurringWithoutBillableAmount, refreshAnnualPrepayTermsForCustomer, restackLiveVisitFinancials,
    retiredSaleKeysVouchedByAcceptedEstimate, seasonalSafeShift, shiftPastWeekend,
    windowIntakeFromBody,
  } = require('../routes/admin-schedule').scheduleBookingHelpers;
  try {
    const {
      customerId, technicianId, scheduledDate, windowStart: windowStartRaw, windowEnd: windowEndRaw,
      serviceType, timeWindow, notes, isRecurring, recurringPattern, recurringCount, recurringOngoing,
      recurringNth, recurringWeekday, recurringIntervalDays,
      skipWeekends, weekendShift,
      boosterMonths,
      discountId, discountType, discountAmount,
      createInvoice,
      sendConfirmation, serviceId, serviceAddons, assignmentMode, primaryLineDiscount,
      primaryLinePrice, estimatedPrice, estimatedDuration, urgency, internalNotes, customerNotes, isCallback,
      parentServiceId, sendConfirmationSms, sendTechNotification, sourceEstimateId,
      sendCardOnFileLink,
      // The operator's explicit service address for a multi-property customer
      // (customer_properties.id). Absent → the sole-property anchor below.
      propertyId,
    } = body;

    const separateProgram = body.duplicateSeriesOverride;
    if (separateProgram !== undefined) {
      if (!isEnabled('separateRecurringProgram')) return reply(409, { error: 'Separate recurring programs are not enabled.' });
      if (!isRecurring || typeof separateProgram?.reason !== 'string'
        || separateProgram.reason.trim().length < 5 || separateProgram.reason.trim().length > 500
        || !Array.isArray(separateProgram.existingSeriesIds) || !separateProgram.existingSeriesIds.length
        || separateProgram.existingSeriesIds.length > 100
        || separateProgram.existingSeriesIds.some((id) => !/^[a-zA-Z0-9-]{1,80}$/.test(String(id)))) {
        return reply(400, { error: 'Review the existing programs and provide a reason (5–500 characters) for a separate program.' });
      }
    }

    // Window intake by explicit presence (windowIntakeFromBody, shared with
    // update-details): both absent / both cleared = a windowless booking;
    // an end without a start is asymmetric and refused (it used to insert
    // window_start NULL beside a real end — a row invisible to occupancy).
    // The pair is normalized below by assertAdminAppointmentWindow once the
    // duration is known.
    const createWindowIntake = windowIntakeFromBody(body);
    let windowStart = createWindowIntake.clearBoth ? null : (createWindowIntake.windowStart ?? null);
    let windowEnd = createWindowIntake.clearBoth ? null : (createWindowIntake.windowEnd ?? null);
    if (!windowStart && windowEnd) {
      throw Object.assign(
        httpError(422, 'Appointment end was supplied without a start — set a start time (HH:MM, on the hour) as well'),
        { code: 'INVALID_APPOINTMENT_WINDOW' },
      );
    }
    void windowStartRaw; void windowEndRaw;
    if (!customerId || !scheduledDate || !serviceType) return reply(400, { error: 'customerId, scheduledDate, serviceType required' });

    // GitHub round 4 P0 (PR #4656): mirrors calculateUpdateFinancials
    // (server/services/invoice.js, #4655) and InvoiceService.create's own
    // gate check (#4658) — same field name, same error shape/code, so the
    // client's existing generic POST-failure handling (surfacing e.message)
    // already covers it with no special-casing needed. The freshness probe
    // the client runs before submit only confirms the gate FOR THAT PROBE
    // REQUEST; nothing bound the pricing/prepaid regime this WRITE actually
    // saves under to what was previewed. A gate flip (or a rolling deploy
    // routing the probe and this POST to pods reading different values)
    // between the two requests let the probe pass while this route would
    // have saved (and, for body.prepaid.totalAmount below, STAMPED
    // VERBATIM with no server-side recomputation against the actual
    // per-visit price) under the OPPOSITE regime — a booking whose prepaid
    // total silently disagreed with what the visits actually bill.
    // undefined (no field sent) skips the check entirely — every existing
    // caller, and any client older than this slice, stays byte-identical.
    // Checked before ANY read or write below.
    const expectedDiscountStacking = body?.expected_discount_stacking;
    if (expectedDiscountStacking !== undefined && expectedDiscountStacking !== discountStackingLive()) {
      return reply(409, {
        error: 'Discount rules changed since this was previewed — reload and try again',
        code: 'DISCOUNT_STACKING_GATE_DIVERGED',
      });
    }

    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return reply(404, { error: 'Customer not found' });

    // Duplicate-series guard: a second ACTIVE recurring series of the same
    // service family for one customer is almost always a booking mistake —
    // the verified cause of customers holding two live quarterly series
    // (double visits, double billing). Admins CAN intentionally run two
    // programs (e.g. different scopes of the same family) by passing
    // allowDuplicateSeries: true — an explicit, logged escape hatch.
    // Fail-open on guard errors: protective, not load-bearing.
    //
    // This route-entry check is a fast PREFLIGHT (rejects the common case
    // before any pricing/tech work); it runs outside the series-creating
    // transaction, so it cannot stop two concurrent creates on its own. The
    // race-safe backstop is the locked re-check inside the transaction below.
    // Explicit service address (New Appointment "Service address" picker).
    // Same gate as the Edit-appointment address dropdown: both are "the
    // office chooses which of the customer's properties a visit lands on".
    // Resolved to the scheduled_services stamp up front so the duplicate-
    // series guards, zone, tech matching and the insert all see the chosen
    // property; the sole-property anchor stays the default when nothing was
    // chosen. The linked-estimate mismatch check runs once the quote loads.
    let bookingProperty = null;
    let bookingSeriesScope = null;
    if (propertyId !== undefined && propertyId !== null && propertyId !== '') {
      if (!isEnabled('editApptAddress')) throw httpError(409, 'Appointment address changes are not enabled.');
      bookingProperty = await require('../services/customer-properties').bookingPropertyStamp({ customerId, propertyId });
      // Per-property duplicate-series scope (codex #3998 r2 P1): the same
      // shape the estimate converter hands the guards, so an active pest
      // series at the customer's home does not 409 a new one at the rental,
      // while a second series at the SAME property is still refused.
      bookingSeriesScope = await require('../services/estimate-converter').buildSeriesAddressScope(db, {
        property_id: bookingProperty.property_id,
        address: [
          [bookingProperty.service_address_line1, bookingProperty.service_address_line2].filter(Boolean).join(' '),
          bookingProperty.service_address_city,
          `${bookingProperty.service_address_state} ${bookingProperty.service_address_zip}`,
        ].join(', '),
      }, customerId);
    }

    if (isRecurring) {
      try {
        const RecurringAppointmentSeeder = require('../services/recurring-appointment-seeder');
        const existingSeries = await RecurringAppointmentSeeder.findActiveRecurringSeries(db, {
          customerId,
          serviceId: serviceId || null,
          serviceType,
          serviceAddressScope: bookingSeriesScope,
        });
        const canCreate = separateProgram
          ? RecurringAppointmentSeeder.separateProgramMatches(existingSeries, separateProgram.existingSeriesIds)
          : body.allowDuplicateSeries === true || existingSeries.length === 0;
        if (!canCreate) return reply(409, duplicateSeriesConflictBody(existingSeries));
        if (!separateProgram && existingSeries.length > 0 && body.allowDuplicateSeries === true) {
          logger.warn(`[schedule] allowDuplicateSeries override: booking a second active "${serviceType}" series for customer ${customerId} alongside existing parent(s) ${existingSeries.map((s) => s.id).join(', ')}`);
        }
      } catch (guardErr) {
        if (separateProgram) throw guardErr;
        logger.warn(`[schedule] duplicate-series guard failed (booking proceeds): ${guardErr.message}`);
      }
    }

    const linkedEstimateId = sourceEstimateId || body.source_estimate_id || null;
    // Phone-agent double-booking guard. A fast preflight on the anchor date;
    // the locked re-check inside the booking transaction (right after the
    // customer lock) is the race-safe backstop and covers every date a
    // series books. The
    // override is "Book another anyway" for exactly the visits it listed.
    const callBookingGuard = {
      override: body.allowCallBookingDuplicate,
      reviewedIds: body.callBookingReviewedIds,
      customerId,
      lines: requestedServiceLines(serviceType, serviceId, serviceAddons),
      dates: [scheduledDate],
      bookingProperty,
      linkedEstimateId,
    };
    await assertNoCallBookingConflict(callBookingGuard);
    // Optional: accept the linked open quote as annual prepay on book (creates
    // the pending prepay invoice + renewal term in the same step as the
    // booking). Only 'prepay_annual' is honored; anything else falls through
    // to the standard verbal-yes accept. Ineligible combinations downgrade to
    // a standard accept with a booking warning — never a half-applied prepay.
    const bookingBillingTerm = body.billingTerm === 'prepay_annual' ? 'prepay_annual' : 'standard';
    let linkedEstimate = null;
    let estimateAutoAccepted = false;
    let annualPrepayResult = null;
    const bookingWarnings = [];
    if (linkedEstimateId) {
      linkedEstimate = await db('estimates')
        .where({ id: linkedEstimateId })
        .first(
          'id', 'customer_id', 'customer_phone', 'customer_email', 'status', 'estimate_data', 'expires_at',
          'monthly_total', 'annual_total', 'onetime_total', 'bill_by_invoice', 'show_one_time_option',
          'property_id',
        );
      if (!linkedEstimate) return reply(404, { error: 'Linked estimate not found' });
      // A quote priced for one property must not book at another: the
      // estimate's own linkage would otherwise re-stamp the visit to the
      // quoted address after commit and silently undo the operator's choice.
      if (bookingProperty && linkedEstimate.property_id && String(linkedEstimate.property_id) !== String(bookingProperty.property_id)) {
        throw Object.assign(httpError(422, 'This estimate was quoted for a different property. Choose that address or book without the estimate.'), { code: 'ESTIMATE_PROPERTY_MISMATCH' });
      }
      // Reject only a genuine MISMATCH (estimate owned by a different customer).
      // A lead / standalone quote carries customer_id = NULL — that's bookable:
      // it gets attached to this customer on book (below) so the customer-keyed
      // acceptance/conversion can run against them. (EstimateConverter refuses a
      // null-customer estimate, so the attach must happen before acceptance.)
      if (linkedEstimate.customer_id && String(linkedEstimate.customer_id) !== String(customerId)) {
        return reply(400, { error: 'Linked estimate belongs to a different customer' });
      }
      // An UNOWNED quote can only be paired with a customer it was actually
      // prepared for: require its captured contact (phone or email) to match the
      // booking customer BEFORE any rows are created. Without this, a stale
      // defaultEstimateId or a swapped customer selection could attach (and
      // accept) any null-customer quote against any customer. Fail-closed: a
      // quote with no captured contact can't be confidently associated.
      if (!linkedEstimate.customer_id && !estimateContactMatchesCustomer(linkedEstimate, customer)) {
        return reply(400, { error: 'This quote was prepared for a different contact. Link it to this customer on the Estimates page before booking from it.' });
      }
      // Gate which statuses may be linked BEFORE any scheduled_services rows are
      // created: an accepted win, or a live open quote the customer can still
      // say yes to (sent/viewed, not lapsed). Anything else — draft / declined /
      // expired / sending — is rejected up front so a stale modal or crafted
      // request can't book against (and fire confirmations for) a quote the
      // customer never accepted.
      const BOOKABLE_ESTIMATE_STATUSES = ['accepted', 'sent', 'viewed'];
      if (!BOOKABLE_ESTIMATE_STATUSES.includes(linkedEstimate.status)) {
        return reply(400, { error: `Cannot book from an estimate that is ${linkedEstimate.status}. Only accepted, sent, or viewed estimates can be linked.` });
      }
      if (linkedEstimate.status !== 'accepted' && linkedEstimate.expires_at && new Date(linkedEstimate.expires_at) < new Date()) {
        return reply(400, { error: 'This estimate has expired. Revive it on the Estimates page before booking from it.' });
      }
      // A suppression-carrying estimate cannot be BOOKED while
      // GATE_BERMUDA_SUPPRESSION is off. This must run in the preflight,
      // BEFORE the appointment transaction: the accept-on-book failure
      // handler below deliberately KEEPS the booking when acceptance fails,
      // so the manual-acceptance gate alone would still schedule (and
      // possibly prepay-stamp) the disabled add-on (codex #3272 r6).
      // Applies to the already-accepted link path too — scheduling the
      // program is exactly what the kill switch must stop.
      {
        const { estimateDataCarriesBermudaSuppression } = require('../services/pricing-engine/v1-legacy-mapper');
        if (estimateDataCarriesBermudaSuppression(linkedEstimate.estimate_data)
          && !require('../config/feature-gates').gateEnvValue('GATE_BERMUDA_SUPPRESSION')) {
          return reply(409, {
            error: 'This estimate includes the bermudagrass-suppression add-on, which is currently disabled (GATE_BERMUDA_SUPPRESSION). Re-enable the gate or rebuild the estimate without the add-on before booking from it.',
            code: 'BERMUDA_SUPPRESSION_GATED',
          });
        }
      }
      // A not-yet-accepted quote on the retired 4x/quarterly T&S cadence
      // (retired 2026-09-24) must not be booked-and-accepted here: the
      // appointment commits BEFORE the best-effort acceptance, which would
      // then refuse it (codex P1 r9). Already-accepted plans still book.
      if (linkedEstimate.status !== 'accepted') {
        const { recurringTreeShrubRowAtRetiredCadence } = require('../routes/estimate-public');
        let data = linkedEstimate.estimate_data || {};
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = {}; } }
        if (recurringTreeShrubRowAtRetiredCadence(data)) {
          return reply(409, {
            error: 'This estimate’s tree & shrub plan uses a retired schedule. Requote it with the 6x or 9x program before booking from it.',
            code: 'RETIRED_TREE_SHRUB_CADENCE',
          });
        }
      }
    }
    // Retired-for-sale catalog rows (quarterly T&S, retired 2026-09-24) book
    // only for a customer already on that plan — the same exception the
    // new-appointment picker applies (service-library getServices sellable).
    // Runs AFTER the linked estimate is loaded (codex r18 P1): an ACCEPTED
    // quote carrying the retired plan is grandfathering evidence in its own
    // right (retiredSaleKeysVouchedByAcceptedEstimate) — "Mark Won, then
    // book" has no live visit yet for the holder test to find.
    const vouchedByQuote = retiredSaleKeysVouchedByAcceptedEstimate(linkedEstimate);
    const notHeldRetired = (await require('../services/service-library').retiredServicesNotHeldBy({
      customerId,
      serviceIds: [serviceId, ...(Array.isArray(serviceAddons) ? serviceAddons.map((a) => a?.serviceId) : [])],
      // Names too, id or not: an ID-less add-on persists by name alone —
      // each with its OWN cadence when it carries one (codex r22: a live 6x
      // T&S add-on posted with a quarterly pattern is the retired plan under
      // the parent's monthly recurrence).
      serviceTypes: [serviceType, ...(Array.isArray(serviceAddons) ? serviceAddons.map((a) => ({
        label: a?.name || a?.serviceName,
        recurrence: addonLineRecurrence({ recurringPattern: a?.recurringPattern || a?.cadence, recurringIntervalDays: a?.recurringIntervalDays ?? a?.intervalDays }),
      })) : [])],
      // The structured cadence too (codex r20): an ID-less "Tree & Shrub
      // Care" booked quarterly is the retired plan by another name.
      recurrence: isRecurring ? { pattern: recurringPattern, intervalDays: recurringIntervalDays } : null,
    })).filter((r) => !vouchedByQuote.has(r.service_key));
    if (notHeldRetired.length) {
      return reply(409, {
        error: `${notHeldRetired.map((r) => r.name).join(', ')} is retired for new sales and this customer is not on that plan.`,
        code: 'RETIRED_SERVICE_NOT_SELLABLE',
      });
    }
    // Booking from a phone "yes": a sent/viewed quote the customer accepted
    // verbally gets its win recorded AFTER the appointment commits (below), so
    // a booking failure never leaves an orphaned acceptance. Until that runs we
    // only link an already-accepted estimate — an open quote is linked once its
    // acceptance lands, keeping source_estimate_id pointed only at recorded wins.
    const acceptEstimateOnBook = !!(linkedEstimate && linkedEstimate.status !== 'accepted');
    // An UNOWNED quote (customer_id NULL) must be attached to this customer
    // post-commit before it can carry source_estimate_id — otherwise a lost
    // attach race would leave the appointment linked to a quote that now belongs
    // to someone else. Defer linking for it too (covers the already-accepted
    // unowned case, which acceptEstimateOnBook does not).
    const estimateNeedsAttach = !!(linkedEstimate && !linkedEstimate.customer_id);
    const insertLinkId = (acceptEstimateOnBook || estimateNeedsAttach) ? null : linkedEstimateId;
    // While the estimate link is deferred, the rows carry no
    // source_estimate_id yet, so the sole-property anchor cannot see that an
    // estimate owns their address (GH codex #3837 r2 P1): a quote for a NEW
    // address would anchor the whole series to the customer's old property,
    // and the post-commit linkage only stamps rows still NULL. Leave the
    // parent AND its spawned children unanchored — the linkage stamps them.
    const propertyOwnedByEstimateLinkage = !!linkedEstimateId && !insertLinkId;

    // Resolve the prepay-on-book decision now that the estimate is validated.
    // Honor billingTerm='prepay_annual' ONLY for a server-eligible open quote on
    // a recurring booking with a derivable coverage count, no add-ons, and no
    // in-person prepay collection — otherwise downgrade to a standard accept +
    // warn, so we never half-apply prepay (a booked visit with no invoice/term,
    // or a term whose coverage can't reconcile with what was booked). Coverage
    // uses the BOOKED service_type/cadence + the operator's visit count so the
    // term stamps THIS booked series prepaid on payment (no completion
    // double-bill) instead of seeding a duplicate one.
    let bookingBillingTermEffective = bookingBillingTerm;
    let annualPrepayCoverage = null;
    if (bookingBillingTerm === 'prepay_annual') {
      const { prepayBookingEligibility } = require('../services/estimate-manual-acceptance');
      const { parseAnnualPrepayVisitCount } = require('../routes/admin-customers')._private;
      const downgrade = (warning) => {
        bookingBillingTermEffective = 'standard';
        bookingWarnings.push(warning);
      };
      const visitOverride = body.prepayVisitCount !== undefined && body.prepayVisitCount !== null && body.prepayVisitCount !== ''
        ? parseAnnualPrepayVisitCount(body.prepayVisitCount)
        : {};
      // The modal books an every-6-weeks series as recurringPattern='custom'
      // with recurringIntervalDays=42 (the scheduler's representation). For
      // prepay cadence math that IS every_6_weeks — the coverage seeder
      // supports it — so normalize before deriving coverage, else valid
      // 6-week quotes downgrade as unsupported-cadence.
      const prepayBookedPattern = (recurringPattern === 'custom' && Number(recurringIntervalDays) === 42)
        ? 'every_6_weeks'
        : recurringPattern;
      const coverageVisitCount = visitOverride.visitCount || visitsPerYearForCadence(prepayBookedPattern);
      const prepayCoverageCadence = prepayCoverageCadenceForPattern(prepayBookedPattern);
      const hasAddons = Array.isArray(serviceAddons) && serviceAddons.length > 0;
      const hasBoosters = Array.isArray(boosterMonths) && boosterMonths.length > 0;
      // The quote's (single) recurring service name + cadence — sourced
      // through the same acceptanceServiceLists extractor the eligibility
      // check and converter use, so engine-backed estimates (quote wizard /
      // IB drafts, whose recurring rows live only under
      // estimate_data.engineResult.lineItems) resolve too instead of silently
      // skipping the mismatch guards. Both guard the same invariant: the
      // prepay invoice prices the QUOTED plan, so coverage must stamp that
      // plan — a different booked service would cover the wrong visits while
      // the quoted service billed normally, and a different booked cadence
      // (quoted quarterly, booked monthly) would stamp 12 visits as covered
      // for a 4-visit annual price. Fuzzy (canonical-key) name match
      // tolerates label drift like "Pest Control" vs "Quarterly Pest Control
      // Service".
      const { quoteRecurringName, quoteRecurringCadence } = (() => {
        try {
          const data = typeof linkedEstimate?.estimate_data === 'string'
            ? JSON.parse(linkedEstimate.estimate_data)
            : (linkedEstimate?.estimate_data || {});
          const { acceptanceServiceLists } = require('../routes/estimate-public');
          const converter = require('../services/estimate-converter');
          const list = acceptanceServiceLists(data).recurringSvcList || [];
          const svc = list[0] || {};
          // For PEST plans the accepted customerSelection.frequency IS the
          // visit cadence the customer chose — the plan the quoted annual is
          // priced for — and beats stale or missing quote-time line cadence
          // (the converter's primaryUsesAcceptFrequency rule). Pest only:
          // for lawn the selection stores the BILLING cadence, not the visit
          // cadence, and must never be read as one.
          const pestSelectionCadence = converter.recurringServiceKey(svc) === 'pest_control'
            ? prepayCoverageCadenceForPattern(data.customerSelection?.frequency)
            : null;
          // The line's RAW frequency fields through the coverage mapper
          // FIRST: every_6_weeks is a supported coverage cadence but the
          // shared normalizeRecurringPattern inside explicitServiceCadence
          // doesn't know it — the literal key normalizes to null and its 9
          // visits/year alias to bimonthly — so a 6-week quote would never
          // match its 6-week booking and always downgrade (pre-push P1).
          // 9 visits/year with no frequency token is the same plan
          // (cadenceFromEstimateLine maps it to custom/42 for the modal, so
          // the booking arrives as every_6_weeks and must match here too).
          // Only these exact shapes short-circuit; everything else still
          // resolves through the converter's full precedence.
          const rawLineVisits = Number(svc.visitsPerYear ?? svc.visits_per_year ?? svc.visits ?? svc.apps);
          const rawLineCadence = [svc.frequency, svc.frequencyKey, svc.frequency_key, svc.recurringPattern, svc.recurring_pattern]
            .map((value) => prepayCoverageCadenceForPattern(value))
            .find(Boolean)
            || (rawLineVisits === 9 ? 'every_6_weeks' : null);
          return {
            // Engine lineItems rows carry `service` (canonical key) / `label`
            // rather than the manual rows' name fields — accept either shape.
            quoteRecurringName: svc.name || svc.serviceName || svc.service_name || svc.service || svc.label || null,
            // Pest selection first, then the SAME converter logic conversion
            // uses (frequency-ish fields, then visitsPerYear/apps-style visit
            // counts, then pattern text in the display name — see
            // explicitServiceCadence), normalized through the same mapper as
            // the booked pattern so the comparison is apples-to-apples. Null
            // when unresolvable — the guard below fails CLOSED on that,
            // never skips.
            quoteRecurringCadence: pestSelectionCadence
              || rawLineCadence
              || prepayCoverageCadenceForPattern(converter.explicitServiceCadence(svc)),
          };
        } catch { return { quoteRecurringName: null, quoteRecurringCadence: null }; }
      })();
      const { serviceMatchesCoverage } = require('../services/annual-prepay-renewals');
      const prepayEligibility = (linkedEstimate && acceptEstimateOnBook)
        // The prospective booking customer (codex round-2 P2): an unowned
        // quote (customer_id NULL, matched only by captured contact) is
        // attached to THIS customer only after booking succeeds, so the
        // live-customer check needs it explicitly here or it silently skips
        // — the accept guard sees the now-linked customer_id and rejects
        // AFTER the appointment is already committed.
        ? await prepayBookingEligibility(linkedEstimate, db, customerId)
        : null;
      if (!linkedEstimate || !acceptEstimateOnBook) {
        downgrade('Appointment booked as standard — annual prepay on book needs an open (not yet accepted) linked quote. Use the estimate’s Annual Prepay action instead.');
      } else if (!prepayEligibility.eligible) {
        // Operator-facing WHY for the common blockers — eligibility now also
        // mirrors the accept's own guards, so "not eligible" spans more than
        // the service-mix rule and a bare generic message would send the
        // operator hunting.
        const reasonPhrase = {
          one_time_items: 'the quote includes a one-time charge that a one-step prepay booking would neither schedule nor invoice',
          manager_approval_pending: 'the quote still needs manager approval before it can be accepted',
          commercial_risk_review: 'the quote needs its commercial business type set first',
          status_not_acceptable: 'only sent or viewed quotes can be accepted while booking',
          expired: 'the quote has expired',
          multi_service: 'annual prepay covers a single recurring service and this quote has more than one',
          live_plan_unknown: 'the system could not confirm the customer’s plan status just now (a transient lookup issue)',
        }[prepayEligibility.reason]
          || 'this quote is not prepay-eligible for one-step booking (it needs a single recurring service)';
        if (prepayEligibility.reason === 'existing_customer') {
          // The estimate's own Annual Prepay action rejects for the SAME
          // reason (both read the identical guard), so pointing the
          // operator at it — the generic message below — sends them
          // straight back to another rejection (codex round-3 P3). This
          // customer already has a live plan; add-on coverage bills at the
          // visit or per-application, or gets folded into the existing plan.
          downgrade('Appointment booked as standard — this customer already has a live plan, so annual prepay is not offered for an add-on service. Bill the new service at the visit (or per-application), or add it to the customer’s existing plan instead.');
        } else {
          downgrade(`Appointment booked, but annual prepay was not applied — ${reasonPhrase}. Use the estimate’s Annual Prepay action instead.`);
        }
      } else if (visitOverride.error) {
        downgrade(`Appointment booked as standard — annual prepay visit count is invalid (${visitOverride.error}).`);
      } else if (!isRecurring || !coverageVisitCount) {
        downgrade('Appointment booked as standard — annual prepay needs a recurring visit with a known cadence (or an explicit covered-visit count).');
      } else if (!prepayCoverageCadence) {
        downgrade('Appointment booked as standard — annual prepay isn’t supported for this visit cadence (the year’s coverage schedule can’t be derived from it). Book on a monthly / every-6-weeks / bimonthly / quarterly / triannual / semiannual / annual cadence, or set up prepay from Customer 360.');
      } else if (visitOverride.visitCount && visitsPerYearForCadence(prepayBookedPattern)
        && visitOverride.visitCount !== visitsPerYearForCadence(prepayBookedPattern)) {
        // The covered-visit count is FIXED by the cadence for quote-derived
        // prepay — the invoice prices exactly that plan. Any other count
        // corrupts money: higher → splitCoverageAmount divides the prepaid
        // total by more visits than the term can seed (excess prepaid value
        // never stamps, later visits bill again); lower → the full quoted
        // annual is invoiced but only that many visits stamp covered and the
        // rest of the year bills again on top. The modal no longer sends a
        // count; this rejects crafted/stale requests. Fail closed.
        downgrade(`Appointment booked as standard — the covered-visit count for a ${prepayBookedPattern} annual prepay is fixed at ${visitsPerYearForCadence(prepayBookedPattern)} by the quoted plan (got ${visitOverride.visitCount}). Omit the count to use the cadence default.`);
      } else if (!quoteRecurringCadence) {
        // Can't prove the booked cadence matches the quoted plan — fail
        // CLOSED (money correctness), never skip the comparison: the prepay
        // invoice prices the quoted plan, so an unverifiable cadence could
        // stamp the wrong number of covered visits for that price.
        downgrade('Appointment booked as standard — the quoted plan’s cadence could not be determined, so annual prepay can’t verify the booked series matches what was sold. Use the estimate’s Annual Prepay action or set up prepay from Customer 360.');
      } else if (quoteRecurringCadence !== prepayCoverageCadence) {
        // The prepay invoice prices the QUOTED cadence's annual — booking a
        // different cadence would stamp a different number of visits as
        // covered for that price (quoted quarterly → booked monthly = 12
        // covered visits for a 4-visit annual). Fail closed.
        downgrade(`Appointment booked as standard — annual prepay must be booked on the quoted cadence (${quoteRecurringCadence}), not ${prepayCoverageCadence}: the prepay invoice prices the quoted plan. Re-quote or set up prepay from Customer 360.`);
      } else if (hasAddons) {
        downgrade('Appointment booked as standard — annual prepay can’t be combined with add-on lines (coverage would suppress their billing at completion). Book the add-ons as a separate appointment or bill standard.');
      } else if (hasBoosters) {
        downgrade('Appointment booked as standard — annual prepay can’t be combined with booster months (boosters would compete with the covered visits for the year’s coverage). Set up prepay from Customer 360, or book without boosters.');
      } else if (body.prepaid) {
        downgrade('Appointment booked as standard — collecting a prepayment in person and invoicing an annual prepay are mutually exclusive. Pick one.');
      } else if (quoteRecurringName && !serviceMatchesCoverage({ service_type: serviceType }, quoteRecurringName)) {
        downgrade(`Appointment booked as standard — annual prepay must be booked for the quoted recurring service (${quoteRecurringName}), not ${serviceType}.`);
      } else {
        // Don't mint a SECOND overlapping prepay term/invoice — mirror the
        // Customer 360 overlap guard as a fast preflight. The atomic advisory
        // lock inside the accept transaction is the race-safe backstop.
        let overlapTerm = null;
        try {
          overlapTerm = await db('annual_prepay_terms')
            .where({ customer_id: customerId })
            .where(function overlapStatus() {
              this.whereIn('status', ['payment_pending', 'active', 'renewal_pending', 'renewed', 'switch_plan'])
                .orWhere(function lapsedRenewalStillInTerm() {
                  this.where('status', 'cancelled').andWhere('renewal_decision', 'cancel');
                });
            })
            .andWhere('term_end', '>=', dateOnly(scheduledDate) || scheduledDate)
            .first('id', 'term_end');
        } catch { overlapTerm = null; }
        if (overlapTerm) {
          downgrade('Appointment booked as standard — this customer already has an annual prepay term covering this date. Manage prepay from Customer 360 to avoid a duplicate invoice/term.');
        } else {
          annualPrepayCoverage = {
            coverageServiceType: String(serviceType).slice(0, 100),
            coverageVisitCount,
            // The NORMALIZED coverage cadence, never the raw booking pattern —
            // see prepayCoverageCadenceForPattern.
            coverageCadence: prepayCoverageCadence,
          };
        }
      }
    }

    // An annual-prepay booking MUST bill per application until the prepay
    // invoice is paid — the per-visit coverage stamp is what suppresses
    // billing after payment, and the seeder's own coverage rows are
    // deliberately create_invoice_on_complete=true. The modal always sends
    // createInvoice for these; forcing it here means a crafted/omitted flag
    // can't book a prepay series whose pending-window completions bill
    // nothing (codex P2).
    const createInvoiceEffective = bookingBillingTermEffective === 'prepay_annual' ? true : !!createInvoice;

    // Billing lane (explicit customers.billing_mode; legacy inference for
    // NULL): a monthly-membership customer's RECURRING series is covered by
    // dues, so its rows must not carry per-visit price stamps or the
    // create-invoice default — those stamps are exactly how members got
    // double-billed (completion honors an explicit price on one-off visits
    // only). A one-off (non-recurring) booking for a member keeps its price
    // and bills normally. A prepay_annual BOOKING is excluded outright
    // (checked on the booking term, not the resolved lane): the customer's
    // CURRENT lane may still read monthly_membership while the annual
    // acceptance is in flight, and the pending-prepay path depends on the
    // forced create_invoice_on_complete + price stamps to bill completions
    // that land before the annual invoice is paid (Codex r1 P1).
    // A payer-billed customer's visits invoice the AP payer at completion —
    // dues coverage never applies (membershipDuesCoverVisit is payer-
    // guarded) — so stripping the price would underbill the payer's invoice
    // down to the monthly_rate fallback or nothing (Codex r8 P1). The
    // booking-time signal is the customer's DEFAULT payer: per-job payers
    // only attach post-booking via the payer PATCH, and an office attaching
    // one to an already-stripped member row must (re)price the row there —
    // the schedule card's payer prediction surfaces the missing amount.
    const memberSeriesCovered = bookingBillingTermEffective !== 'prepay_annual'
      && !customer?.payer_id
      && resolveBillingLane(customer).mode === 'monthly_membership' && !!isRecurring;
    const createInvoiceStamp = memberSeriesCovered ? false : createInvoiceEffective;
    // A priced ADD-ON riding a covered member visit keeps a price stamp so
    // the one-per-series review alert fires and Charge Now surfaces the
    // billable amount — but the stamp is the ADD-ON-ONLY total (pre-
    // discount), never the base+add-on subtotal: the base is covered by
    // dues, and stamping the full price would surface/mint a $100 plan
    // visit + $20 add-on as $120 instead of the billable $20 (Codex r2+r3).
    // Base-only rows stay stamp-free.
    //
    // GitHub Codex round 3 on #4642 (PRRT_kwDOR3YQi86kmS5M): `a.price` is
    // the line's OWN net (gross minus its own line discount only) —
    // stackVisitDiscounts deliberately keeps each line's ALLOCATED SHARE
    // of an appointment-level credit as a separate field
    // (appointmentCreditDollars, threaded through buildAppointmentPricing
    // / restackLiveVisitFinancials's addonDollars — see their own
    // comments), never folded into net. Reading `.price` alone here
    // dropped that allocated share from the covered-member's stamped
    // add-on total: a $100 add-on at 20% off with a $15 allocated fixed
    // appointment credit stamped $83 (net alone) instead of the real $68
    // (net minus its $15 share) — inflating the amount surfaced for an
    // add-on that already got part of the credit applied to it.
    const addonOnlyTotal = (lines) => (lines || []).reduce((sum, a) => {
      const price = Number(a?.price);
      if (!(price > 0)) return sum;
      const share = Number(a?.appointmentCreditDollars) || 0;
      return sum + Math.max(0, price - share);
    }, 0);

    const zone = bookingProperty
      ? getZone(bookingProperty.service_address_city, bookingProperty.service_address_zip)
      : getZone(customer?.city, customer?.zip);
    // Owner directive (2026-07-03): every service call defaults to 60 minutes;
    // the service-record default or an explicit tech-entered duration wins below.
    let duration = 60;

    // Look up service from services table for duration/pricing
    let serviceRecord = null;
    if (serviceId) {
      try {
        serviceRecord = await db('services').where({ id: serviceId }).first();
        if (serviceRecord?.default_duration_minutes) duration = serviceRecord.default_duration_minutes;
      } catch (e) { logger.warn(`[schedule] services table lookup failed: ${e.message}`); }
    }

    // Explicit override from the client (multi-service groups send the
    // summed line-item duration so estimated_duration_minutes matches the
    // actual time window). Wins over the heuristic + service-record default.
    const parsedExplicitDuration = Number.parseInt(estimatedDuration, 10);
    if (Number.isInteger(parsedExplicitDuration) && parsedExplicitDuration > 0) {
      duration = parsedExplicitDuration;
    }

    // Shared admin window rules (scheduling/window-rules.js): on-the-hour,
    // >= 08:00, end > start, end <= day end; the end is derived from the
    // duration when not supplied. Previously any string was persisted
    // ("8am" stored with a NaN-derived end, 06:30 booked before opening).
    let computedEnd = windowEnd || null;
    if (windowStart) {
      const normalizedWindow = assertAdminAppointmentWindow({ windowStart, windowEnd, durationMinutes: duration });
      windowStart = normalizedWindow.window_start;
      windowEnd = normalizedWindow.window_end;
      computedEnd = normalizedWindow.window_end;
    }

    // Auto-assign tech if requested
    let resolvedTechId = technicianId || null;
    if (assignmentMode === 'auto') {
      try {
        const TechMatcher = require('../services/tech-matcher');
        const match = await TechMatcher.findBestTech({ customerId, date: scheduledDate, serviceType, zone });
        if (match?.technicianId) resolvedTechId = match.technicianId;
      } catch (e) { logger.warn(`[schedule] Auto-assign failed, leaving unassigned: ${e.message}`); }
    } else if (assignmentMode === 'unassigned') {
      resolvedTechId = null;
    }

    // Merge notes
    const combinedNotes = [notes, customerNotes].filter(Boolean).join('\n') || null;
    // seasonal_feb_oct derives its anchor from the date like every other
    // month-based cadence; monthly_nth_weekday stays raw passthrough because
    // there the operator supplies nth/weekday explicitly.
    const monthAnchorOpts = (isRecurring
      && (MONTH_RECURRENCE_INTERVALS[recurringPattern] || recurringPattern === SEASONAL_FEB_OCT))
      ? recurrenceOrdinalOptions(scheduledDate, { nth: recurringNth, weekday: recurringWeekday })
      : { nth: recurringNth, weekday: recurringWeekday };

    // Re-service rows (pest_re_service / lawn_re_service) ARE callbacks by
    // definition — the new-appointment modal never sends `isCallback`, so
    // derive it server-side from the catalog row. Persisted `is_callback`
    // drives callback reporting + completion invoice suppression downstream.
    // Computed BEFORE pricing: the membership-booking evidence below must
    // exclude callbacks, mirroring the tier sync.
    const resolvedIsCallback = isCallback
      || isReService({ serviceKey: serviceRecord?.service_key, serviceName: serviceRecord?.name, serviceType });

    // Office "Customer's words" on a pest/lawn re-service (GATE_RESERVICE
    // _OFFICE_REQUEST): trimmed + capped here, source decided by re-reading
    // the suggestion the client named — never taken from the client. Only the
    // primary row below is stamped; null = nothing saved (gate off, not a
    // pest/lawn re-service, or empty words).
    const officeCustomerRequest = (isEnabled('reserviceOfficeRequest')
      && resolvedIsCallback
      && reserviceOfficeRequest.isOfficeRequestServiceKey(serviceRecord?.service_key)
      && body.customerRequest && typeof body.customerRequest === 'object')
      ? await reserviceOfficeRequest.resolveCustomerRequest(db, customerId, body.customerRequest)
      : null;

    // A recurring booking that creates WaveGuard plan coverage IS the
    // membership sale — let the "any member" discount floor see that, since
    // the customer row's tier is only stamped after the series commits.
    const recurringMembershipBooking = bookingCreatesWaveGuardCoverage({
      isRecurring: !!isRecurring,
      isCallback: resolvedIsCallback,
      serviceType,
      serviceRecord,
      customer,
      scheduledDate,
    });

    const pricing = await buildAppointmentPricing({
      serviceRecord,
      serviceType,
      serviceId,
      estimatedPrice,
      primaryLinePrice,
      primaryLineDiscount,
      serviceAddons,
      discountId,
      discountType,
      discountAmount,
      customer,
      recurringMembershipBooking,
    });

    // GitHub round 5 P1 (Codex, on 3c7214fa45): two picks in the same
    // non-stackable stack_group (the WaveGuard tiers, promo, relationship)
    // — one on a line, one on the appointment-level slot spanning onto
    // that same line, or two different lines each carrying one — must
    // never both actually persist. Before this, enforcement was entirely
    // client-side (existingSelectionConflict in CreateAppointmentModal.jsx),
    // with no server backstop: a client bypass, or the gate simply being
    // off (which already skips that client check), let two conflicting
    // tiers both save. Checked here, before ANY write (the transaction
    // below has not opened yet) — a conflict throws a plain operational
    // 400, not the transaction's own rollback path, since nothing has
    // been written for it to roll back.
    //
    // GitHub round 5 P1 follow-up (Codex, blocked push 5): a failed
    // stack_group lookup must FAIL CLOSED (a retryable error), never
    // silently proceed as if the conflict check found nothing — the
    // exact silent-disable this whole check exists to prevent, just
    // moved one layer down.
    let stackGroupRows;
    try {
      stackGroupRows = await discountStackGroupRowsForPricing(pricing);
    } catch (e) {
      throw Object.assign(
        httpError(503, 'Could not confirm the discount rules for this booking — try again'),
        { code: 'DISCOUNT_STACK_GROUP_LOOKUP_FAILED' },
      );
    }
    assertNoDiscountStackGroupConflict(stackGroupRows);
    // Codex pre-push audit P0 (round 6, blocked push 8): the group's own
    // per-visit price, bound to the SAME previewed number the client
    // displayed and posted expected_discount_stacking alongside — see
    // assertPriceMatchesPricing's own comment for why this is needed even
    // with the regime unchanged.
    assertPriceMatchesPricing({ expectedPrice: body?.expected_price, finalPrice: pricing.finalPrice });

    // Re-service callbacks default to $0 for WaveGuard customers, but an operator
    // can still enter an explicit charge (e.g. a re-service that also handled a
    // billable extra). `buildAppointmentPricing` has already parsed that operator
    // amount into `pricing.finalPrice`, so only zero it out when NO explicit
    // price was provided — otherwise the charge is silently lost. This flag is
    // reused for the recurring child + booster rows so callback suppression and
    // callback reporting propagate to every generated visit, not just the first.
    const positiveMoneyInput = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0; };
    // Add-on lines are operator-entered charges too — `buildAppointmentPricing`
    // already folded them into `pricing.finalPrice`. Treat a priced add-on as an
    // explicit price so a re-service that addressed a billable extra isn't zeroed
    // back to $0 (which would also zero the generated child/booster visits).
    const addonHasExplicitPrice = Array.isArray(serviceAddons)
      && serviceAddons.some((a) => positiveMoneyInput(a?.basePrice ?? a?.grossPrice ?? a?.price));
    const explicitPriceProvided = positiveMoneyInput(primaryLinePrice)
      || positiveMoneyInput(estimatedPrice)
      || addonHasExplicitPrice;
    const zeroCallbackPrice = resolvedIsCallback && customerEligibleForFreeCallback(customer) && !explicitPriceProvided;

    let finalPrice = pricing.finalPrice;
    if (zeroCallbackPrice) finalPrice = 0;
    const appointmentDiscountType = pricing.appointmentDiscount?.discountType || null;
    const appointmentDiscountAmount = pricing.appointmentDiscount?.discountAmount ?? null;
    const createdAppointments = [];
    let svc;

    const cols = await db('scheduled_services').columnInfo();
    const addonCols = pricing.addonLines.length > 0
      ? await db('scheduled_service_addons').columnInfo()
      : {};
    let shouldSendNewRecurringWelcome = isRecurring
      ? await isNewRecurringSignupCandidate(customerId)
      : false;

    // Track all scheduled_date strings created for this parent series
    // (parent itself, recurring children, AND boosters). Hoisted so the
    // booster spawn block below can dedupe against base-series dates —
    // certain cadence/month combos (e.g. monthly Jan 15 + April booster
    // → Apr 15 already on the calendar) would otherwise double-book.
    // Generated BEFORE the transaction so every date the series will write
    // is known up front: rung 1 must cover all of them (Codex #3443 P1 —
    // occupancy:<parent-date> does not serialize occupancy:<child-date>).
    const seriesDates = new Set();
    seriesDates.add(dateOnly(scheduledDate) || '');
    const plannedChildDates = [];
    const plannedBoosterDates = [];

    // Recurring instances (Ongoing mode still pre-seeds a 4-visit rolling window for UX)
    const parsedRecurringCount = Number.parseInt(recurringCount, 10);
    const plannedCount = isRecurring
      ? (recurringOngoing ? 4 : (Number.isInteger(parsedRecurringCount) && parsedRecurringCount > 1 ? parsedRecurringCount : 4))
      : 0;
    const rOpts = { ...monthAnchorOpts, intervalDays: recurringIntervalDays };
    const shiftDir = weekendShift === 'back' ? 'back' : 'forward';
    // B6 (owner ruling 2026-08-27): a customer whose saved property
    // preference names a weekday has said "not weekends" — generated
    // children/booster DATES honor it even when the operator left the
    // skip-weekends box unticked. The STAMPED flag stays the operator's
    // raw value: every generator and the rebooker consult the preference
    // LIVE, so removing it restores weekend eligibility without touching
    // series rows. The ANCHOR date itself never moves — the operator
    // picked it deliberately.
    const skipWeekendsEffective = !!skipWeekends
      || (isRecurring && recurringPattern ? await customerPrefersNoWeekends(db, customerId) : false);
    // Blackout days (one-off + weekly days off) over the series horizon —
    // every generated child/booster date runs through the shared nudge.
    const seriesBlackoutDates = (isRecurring && recurringPattern)
      ? await loadSeriesBlackoutDates(db, dateOnly(scheduledDate))
      : null;
    if (isRecurring && recurringPattern && plannedCount > 1) {
      // Iterate by inserts, not by attempts: when skip-weekends collapses
      // consecutive recurrences onto the same shifted weekday (e.g. custom
      // interval=1 over Sat+Sun → Mon), we still need plannedCount-1 children
      // inserted, not plannedCount-1 attempts. Cap iterations to avoid an
      // infinite loop if the pattern is degenerate.
      const maxAttempts = (plannedCount - 1) * 4 + 30;
      let attempt = 1;
      while (plannedChildDates.length < plannedCount - 1 && attempt < maxAttempts) {
        const rawNext = nextRecurringDate(scheduledDate, recurringPattern, attempt, rOpts);
        attempt++;
        const nextDateStr = seasonalSafeShift(rawNext, recurringPattern, skipWeekendsEffective, shiftDir, seriesBlackoutDates);
        if (!nextDateStr) continue;
        if (recurringCandidateTooCloseToAnchor(scheduledDate, recurringPattern, nextDateStr)) continue;
        if (seriesDates.has(nextDateStr)) continue;
        seriesDates.add(nextDateStr);
        plannedChildDates.push(nextDateStr);
      }
      // Blackout/day-off exhaustion must not silently shrink the requested
      // plan (mirror of the visit-count top-up's shortfall reporting): tell
      // the office what was actually placed instead of returning success on
      // an undersized series nobody can see.
      if (plannedChildDates.length < plannedCount - 1) {
        const placed = plannedChildDates.length + 1;
        logger.warn(`[schedule/create] recurring series wanted ${plannedCount} visit(s), placed ${placed} — every remaining candidate within ${maxAttempts} cadence steps is blacked out, on a closed weekday, or a duplicate`);
        bookingWarnings.push(`Recurring plan requested ${plannedCount} visits but only ${placed} could be placed — the remaining dates fall on blackout days or closed weekdays. Adjust the days-off/blackout settings or add the missing visits manually.`);
      }
    }

    // Booster months — extra one-off visits on top of the base series
    // (e.g. quarterly pest + summer-month boosters). Pre-seed the next 12
    // months from the initial date.
    if (isRecurring && Array.isArray(boosterMonths) && boosterMonths.length > 0) {
      const cleaned = Array.from(new Set(boosterMonths.map((m) => parseInt(m)).filter((m) => m >= 1 && m <= 12))).sort((a, b) => a - b);
      const dates = computeBoosterDates(scheduledDate, cleaned, 12);
      let droppedBoosters = 0;
      for (const rawDate of dates) {
        const boosterDate = clearOfBlackout(shiftPastWeekend(rawDate, skipWeekendsEffective, shiftDir), seriesBlackoutDates, { skipWeekends: skipWeekendsEffective });
        // A null nudge = the blackout walk exhausted — that booster is a
        // SOLD billable visit that would otherwise vanish silently while
        // the create still returns 201. Count it and warn below (the
        // series-date dedupe skip right after is fine — that date is
        // already served by the base series).
        if (!boosterDate) { droppedBoosters++; continue; }
        // Skip if this date already has a row on the series (parent or
        // recurring child). Common case: monthly Jan 15 → child Apr 15
        // PLUS April booster → Apr 15 collision.
        if (seriesDates.has(boosterDate)) continue;
        seriesDates.add(boosterDate);
        plannedBoosterDates.push(boosterDate);
      }
      if (droppedBoosters > 0) {
        logger.warn(`[schedule/create] ${droppedBoosters} booster visit(s) could not be placed — blackout/closed-day nudge exhausted`);
        bookingWarnings.push(`${droppedBoosters} booster visit${droppedBoosters === 1 ? '' : 's'} could not be placed — the date${droppedBoosters === 1 ? ' falls' : 's fall'} in an extended blackout/closed-day stretch. Adjust the days-off/blackout settings or add ${droppedBoosters === 1 ? 'it' : 'them'} manually.`);
      }
    }

    // Billable-amount gate, evaluated on the ACTUAL generated series. Every
    // date this booking will write is known here (parent + children +
    // boosters, the same list rung 1 locks below), so the floor is computed
    // by running the REAL per-date pricing — filterAddonLinesForDate +
    // calculateVisitFinancialsForAddons, exactly what the insert loop uses —
    // over every one of them and taking the minimum.
    //
    // This replaced a hand-written "is this add-on durable?" predicate that
    // was wrong in both directions across three Codex rounds: first it
    // dropped every cadence-bearing add-on (false 409 on add-on-priced
    // series), then it kept cadence-matched ones while ignoring skipWeekends
    // / weekendShift, so a weekend-shifted child could silently lose the
    // add-on that justified the booking and complete unbilled. Asking the
    // pricing code what each date actually costs cannot drift from what the
    // insert loop then writes.
    {
      const gateDates = [dateOnly(scheduledDate), ...plannedChildDates, ...plannedBoosterDates].filter(Boolean);
      // The amount the row will ACTUALLY carry. memberSeriesCovered strips the
      // primary price from the parent and every child (dues are meant to cover
      // them) and disables create_invoice_on_complete, so gating on the
      // calculated price let an explicit monthly_membership customer with
      // monthly_rate 0 pass on a catalog price and then receive rows with
      // neither a price nor collectible dues (Codex P0). For covered rows the
      // stamp is addon-only — mirror that exactly.
      // Booster rows are is_recurring:false — completion bills them as one-off
      // visits at their OWN price, so the member-series stripping deliberately
      // does not touch them (:5488). Applying the covered-member addon-only
      // rule to booster dates understated them and could 409 a legitimately
      // priced series whose boosters carry the primary price (Codex P1).
      const boosterDateSet = new Set(plannedBoosterDates);
      const floorForDate = (targetDate) => {
        const lines = filterAddonLinesForDate(pricing.addonLines, scheduledDate, targetDate, seriesBlackoutDates, skipWeekendsEffective);
        // Codex pre-push audit P1 (deferred fast-follow from the original
        // push): routed through occurrenceFloorPrice so the gate reads the
        // SAME restacked pricing the insert loop stamps with — see that
        // function's own comment for the concrete under-count this fixes.
        return occurrenceFloorPrice(pricing, lines, {
          memberSeriesCovered, isBoosterDate: boosterDateSet.has(targetDate), addonOnlyTotal,
        });
      };
      const recurringFloorPrice = zeroCallbackPrice
        ? 0
        : gateDates.reduce((min, d) => Math.min(min, floorForDate(d)), Infinity);
      // Completion's typed-one-time mint trigger, resolved from the same
      // authority admin-dispatch reads (Codex P1).
      const gateProfile = await resolveCompletionProfileForScheduledService(
        { service_id: serviceId || null, service_type: serviceType },
      ).catch(() => null);
      const unbillable = recurringWithoutBillableAmount({
        isRecurring,
        recurringFloorPrice: Number.isFinite(recurringFloorPrice) ? recurringFloorPrice : 0,
        customer,
        createInvoiceOnComplete: createInvoiceStamp,
        typedOneTimeBilling: gateProfile
          ? String(gateProfile.billingType || '').toLowerCase() === 'one_time'
          : null,
        isCallback: resolvedIsCallback,
        serviceType,
      });
      if (unbillable) return reply(409, unbillable);
    }

    let waveguardPlanSync = null;
    // Rodent-bait setup stamped inside the booking transaction; an
    // accept-on-book success retires it (the acceptance bills the setup from
    // the estimate's frozen disclosure), a failed attach/accept leaves it so
    // the first completion still collects (codex #3591 r62 P1).
    let directRodentSetupStamp = 0;
    await db.transaction(async (trx) => {
      // Rung 1 (scheduling/occupancy.js ORDERING CONTRACT) — the date-wide
      // occupancy lock, FIRST statement of the trx, before the comms lock
      // and every row lock below. The admin creator was the one committing
      // writer with no lock and no global probe: its uncommitted insert was
      // invisible to every other writer's tech-blind check, and it never
      // checked anyone else's. Every date this series writes (parent +
      // generated children + boosters) is locked here, deduped and in
      // ascending date order, so two multi-date writers sharing any subset
      // of dates take them in the same relative order. Each timed row is
      // probed right before its own insert (same trx, under these locks).
      await acquireOccupancyLocks(trx, [dateOnly(scheduledDate), ...plannedChildDates, ...plannedBoosterDates]);
      // Rung 6 (scheduling/occupancy.js ORDERING CONTRACT) — BEFORE the
      // customers row lock below: every scheduled_services insert in this
      // trx (parent, recurring children, boosters) serializes against a
      // concurrent merge-undo of this customer. estimate-converter takes
      // the same lock in the same position, so the #3011 customer-row →
      // series-advisory order below is unchanged relative to it.
      await lockCustomerComms(trx, customerId);
      // Phone-agent double-booking backstop: the call pipeline inserts its
      // booking under this same customer lock, so re-checking here — not
      // only in the preflight above, before the slow pricing reads — sees
      // any booking it committed in between (codex #5183 r1 P1). An error
      // here aborts the create rather than failing open.
      await assertNoCallBookingConflict({
        ...callBookingGuard, conn: trx, failOpen: false, dates: [dateOnly(scheduledDate), ...plannedChildDates, ...plannedBoosterDates],
      });
      // Post-lock revalidation (r23): the pre-transaction snapshot loaded
      // the customer BEFORE this acquire — if a merge-undo held the lock
      // and cleared inherited address/service-contact fields while we
      // waited, the zone/pricing derived from that snapshot and the
      // unstamped visit's live-resolved comms would both bind to state the
      // undo just removed. The lock alone proves nothing; re-read and
      // abort with a retryable shape when the booking-relevant fields
      // moved (an admin reloads and re-books against the live record).
      {
        const CONTACT_SLOT_COLS = [1, 2, 3].flatMap((n) => {
          const pfx = n === 1 ? 'service_contact' : `service_contact${n}`;
          return [`${pfx}_name`, `${pfx}_phone`, `${pfx}_email`, `${pfx}_role`];
        });
        // Billing/pricing inputs join the fingerprint (r35): the booking's
        // series-coverage, invoice-on-complete stamp, and pricing were
        // computed from the pre-lock customer, and completion resolves
        // payer/billing LIVE — a cleared inherited payer/mode/fee must
        // retry the booking, not commit stale price state.
        const BILLING_FINGERPRINT_COLS = ['payer_id', 'billing_mode', 'per_application_fee', 'waveguard_tier', 'monthly_rate'];
        const freshCustomer = await trx('customers')
          .where({ id: customerId })
          .first('address_line1', 'address_line2', 'city', 'state', 'zip', ...CONTACT_SLOT_COLS, ...BILLING_FINGERPRINT_COLS);
        // The COMPLETE address tuple (r24): a merge can backfill ONLY
        // address_line2 (a street-only winner absorbing the loser's
        // apartment/unit), so a line1/city/zip comparison passes while the
        // undo clears the unit out from under the visit — dispatch would
        // go to the wrong unit.
        // ALL FOUR members of every slot (r30): email-only service contacts
        // are supported, and name/email/role can move while the phones stay
        // identical — a phones-only fingerprint let the undo clear an
        // email-only slot out from under the new visit's report recipients.
        const commsDep = (row) => [
          row?.address_line1 || '', row?.address_line2 || '', row?.city || '', row?.state || '', row?.zip || '',
          ...CONTACT_SLOT_COLS.map((c) => row?.[c] || ''),
          ...BILLING_FINGERPRINT_COLS.map((c) => String(row?.[c] ?? '')),
        ].join('|');
        if (!freshCustomer || commsDep(freshCustomer) !== commsDep(customer)) {
          const err = new Error('The customer record changed while booking (address or service contacts moved) — reload the customer and book again.');
          err.statusCode = 409;
          err.isOperational = true;
          err.code = 'CUSTOMER_CHANGED_RETRY';
          throw err;
        }
        // Linked-estimate ownership revalidates under the fence too (r36):
        // a journaled estimate a merge-undo just returned would stamp the
        // restored loser's source_estimate_id onto a kept-customer visit.
        if (linkedEstimateId) {
          const freshLinkedEstimate = await trx('estimates')
            .where({ id: linkedEstimateId }).forShare().first('id', 'customer_id', 'property_id');
          if (!freshLinkedEstimate
            || (freshLinkedEstimate.customer_id && String(freshLinkedEstimate.customer_id) !== String(customerId))) {
            const estErr = new Error('The linked estimate changed while booking (a merge was undone) — reload and book again.');
            estErr.statusCode = 409;
            estErr.isOperational = true;
            estErr.code = 'CUSTOMER_CHANGED_RETRY';
            throw estErr;
          }
          // The preflight property compare re-runs under the fence (codex
          // #4015 r2 P2): a quote re-pointed at another property while this
          // booking waited on its locks must not be linked to a visit at the
          // operator's chosen address.
          if (bookingProperty && freshLinkedEstimate.property_id
            && String(freshLinkedEstimate.property_id) !== String(bookingProperty.property_id)) {
            throw Object.assign(httpError(422, 'This estimate was quoted for a different property. Choose that address or book without the estimate.'), { code: 'ESTIMATE_PROPERTY_MISMATCH' });
          }
        }
      }
      // Global lock order for recurring creators: CUSTOMER ROW first, series
      // advisory lock second — the same order estimate-converter uses (it
      // updates the customer, then waits on the advisory lock). Taking the
      // advisory lock below first and the customer row later (inside the
      // WaveGuard sync at the end of this transaction) is the opposite
      // order and deadlocks against a concurrent conversion for the same
      // customer (Codex #3011 r6 P1).
      if (isRecurring) {
        await trx('customers').where({ id: customerId }).forUpdate().first('id');
      }
      // Race-safe duplicate-series backstop (P0: check-then-insert race).
      // The preflight above ran OUTSIDE this transaction, so two concurrent
      // recurring creates for the same customer + service family could both
      // see "no series" and both commit one. Re-run the guard here — inside
      // the transaction that creates the series — under the shared
      // per-customer/family advisory lock: the loser waits on the winner's
      // commit and then sees its series. The explicit allowDuplicateSeries
      // escape hatch bypasses it exactly as it bypasses the preflight, and
      // guard ERRORS stay fail-open (checkActiveSeriesLocked never throws;
      // its savepoint keeps a failed guard query from aborting this
      // transaction). A hit throws a tagged error the route catch maps to
      // the same 409 the preflight returns.
      if (isRecurring && (body.allowDuplicateSeries !== true || separateProgram)) {
        const RecurringAppointmentSeeder = require('../services/recurring-appointment-seeder');
        const { matches, guardError } = await RecurringAppointmentSeeder.checkActiveSeriesLocked(trx, {
          customerId,
          serviceId: serviceId || null,
          serviceType,
          serviceAddressScope: bookingSeriesScope,
        });
        if (separateProgram && guardError) throw guardError;
        if (guardError) logger.warn(`[schedule] locked duplicate-series guard failed (booking proceeds): ${guardError.message}`);
        const canCreate = separateProgram
          ? RecurringAppointmentSeeder.separateProgramMatches(matches, separateProgram.existingSeriesIds)
          : matches.length === 0;
        if (!canCreate) {
          const dupErr = new Error('duplicate_recurring_series');
          dupErr.duplicateRecurringSeries = matches;
          throw dupErr;
        }
      }
      // Save-time eligibility on the writing trx (422 TECH_NOT_ASSIGNABLE) —
      // covers a stale picker and the auto-assign path alike; recurring
      // children below inherit this row's tech, so one check fences both.
      await assertAssignableTechnician(resolvedTechId, { conn: trx, date: String(scheduledDate).slice(0, 10) });
      // The recurring-child and booster loops below insert this SAME
      // resolvedTechId on OTHER dates (tech-out P1) — the parent-date check
      // above can't see a tech marked out on one of those occurrence dates.
      // plannedChildDates/plannedBoosterDates are fully computed (and
      // locked) above, so every distinct destination date is checked once,
      // here, before either insert loop runs — an absence on any occurrence
      // date refuses the whole create instead of partially inserting a series.
      if (resolvedTechId) {
        const childBoosterDates = new Set([...plannedChildDates, ...plannedBoosterDates].filter(Boolean));
        for (const occDate of childBoosterDates) {
          await assertAssignableTechnician(resolvedTechId, { conn: trx, date: occDate });
        }
      }
      const insertData = {
        customer_id: customerId, technician_id: resolvedTechId,
        scheduled_date: scheduledDate, window_start: windowStart, window_end: computedEnd,
        service_type: serviceType, status: 'pending',
        time_window: timeWindow, zone, estimated_duration_minutes: duration,
        notes: combinedNotes, is_recurring: isRecurring || false, recurring_pattern: recurringPattern,
      };

      // Operator-chosen property: stamp identity + service address + coords
      // on the parent; children and boosters inherit through
      // copyStampedServiceAddressFields, and the sole-property anchor below
      // sees property_id already set and leaves it alone.
      if (bookingProperty) {
        // Re-validated UNDER the booking transaction (codex #4015 r1 P2): the
        // preflight snapshot was read before the occupancy / customer locks,
        // so a concurrent edit or deactivation of the chosen property must
        // refuse here (422, rolls back) rather than commit a stale address
        // or a now-inactive property_id.
        const freshProperty = await require('../services/customer-properties')
          .bookingPropertyStamp({ customerId, propertyId }, trx, { lock: true });
        // zone / tech match were derived from the preflight snapshot: any
        // drift (address edited between the reads) is refused as a retry
        // rather than committed with stale derived values.
        if (JSON.stringify(freshProperty) !== JSON.stringify(bookingProperty)) {
          throw Object.assign(httpError(409, 'The chosen address changed while saving. Reload and choose the address again.'), { code: 'PROPERTY_CHANGED_RETRY' });
        }
        for (const [field, value] of Object.entries(freshProperty)) {
          if (cols[field]) insertData[field] = value;
        }
      }
      // Property identity for the visit-group stamp (GH codex r4 P2):
      // manual bookings have no estimate-linkage regroup, so an unstamped
      // property makes maybeGroupRow refuse forever — and spawned
      // children/extensions inherit whatever the parent carries
      // (copyStampedServiceAddressFields). Only the customer's SOLE active
      // property is unambiguous; multi-property customers stay
      // office-placed. Never overrides an explicit stamp.
      if (cols.property_id && insertData.property_id === undefined && !propertyOwnedByEstimateLinkage) {
        insertData.property_id = await require('../services/customer-properties')
          .soleActivePropertyId(customerId, trx);
      }
      // Add new workflow columns (safe — migration may not have run yet)
      if (cols.service_id && serviceId) insertData.service_id = serviceId;
      if (cols.service_key_snapshot) insertData.service_key_snapshot = pricing.primaryServiceKey || null;
      if (cols.service_category_snapshot) insertData.service_category_snapshot = pricing.primaryServiceCategory || null;
      if (cols.estimated_price) {
        if (memberSeriesCovered) {
          const addonStamp = addonOnlyTotal(pricing.addonLines);
          if (addonStamp > 0) insertData.estimated_price = addonStamp;
        } else if (finalPrice != null) insertData.estimated_price = finalPrice;
      }
      if (cols.primary_line_price && pricing.primaryBase != null) insertData.primary_line_price = pricing.primaryBase;
      if (cols.urgency) insertData.urgency = urgency || 'routine';
      if (cols.internal_notes && internalNotes) insertData.internal_notes = internalNotes;
      if (cols.is_callback) insertData.is_callback = resolvedIsCallback || false;
      if (officeCustomerRequest && cols.customer_request && cols.customer_request_source) {
        insertData.customer_request = officeCustomerRequest.text;
        insertData.customer_request_source = officeCustomerRequest.source;
      }
      if (cols.parent_service_id && parentServiceId) insertData.parent_service_id = parentServiceId;
      if (cols.source_estimate_id && insertLinkId) insertData.source_estimate_id = insertLinkId;
      if (cols.recurring_ongoing && isRecurring) insertData.recurring_ongoing = !!recurringOngoing;
      if (isRecurring) {
        if (cols.recurring_nth && monthAnchorOpts.nth != null && monthAnchorOpts.nth !== '' && !isNaN(parseInt(monthAnchorOpts.nth))) insertData.recurring_nth = parseInt(monthAnchorOpts.nth);
        if (cols.recurring_weekday && monthAnchorOpts.weekday != null && monthAnchorOpts.weekday !== '' && !isNaN(parseInt(monthAnchorOpts.weekday))) insertData.recurring_weekday = parseInt(monthAnchorOpts.weekday);
        if (cols.recurring_interval_days && recurringIntervalDays != null && recurringIntervalDays !== '' && !isNaN(parseInt(recurringIntervalDays))) insertData.recurring_interval_days = parseInt(recurringIntervalDays);
        if (cols.skip_weekends) insertData.skip_weekends = !!skipWeekends;
        if (cols.weekend_shift && skipWeekendsEffective) insertData.weekend_shift = weekendShift === 'back' ? 'back' : 'forward';
        if (cols.booster_months && Array.isArray(boosterMonths) && boosterMonths.length > 0) {
          const cleaned = Array.from(new Set(boosterMonths.map((m) => parseInt(m)).filter((m) => m >= 1 && m <= 12))).sort((a, b) => a - b);
          if (cleaned.length > 0) insertData.booster_months = JSON.stringify(cleaned);
        }
      }
      if (pricing.appointmentDiscount && cols.discount_id && pricing.appointmentDiscount.discountId) insertData.discount_id = pricing.appointmentDiscount.discountId;
      if (pricing.appointmentDiscount && cols.discount_name && pricing.appointmentDiscount.discountName) insertData.discount_name = String(pricing.appointmentDiscount.discountName).slice(0, 200);
      if (cols.discount_type && appointmentDiscountType) insertData.discount_type = appointmentDiscountType;
      if (cols.discount_amount && appointmentDiscountAmount != null) insertData.discount_amount = Number(appointmentDiscountAmount);
      if (pricing.appointmentDiscount && cols.discount_dollars && pricing.appointmentDiscount.discountDollars != null) insertData.discount_dollars = Number(pricing.appointmentDiscount.discountDollars);
      if (pricing.appointmentDiscount && cols.discount_service_key_filter) insertData.discount_service_key_filter = pricing.appointmentDiscount.serviceKeyFilter || null;
      if (pricing.appointmentDiscount && cols.discount_service_category_filter) insertData.discount_service_category_filter = pricing.appointmentDiscount.serviceCategoryFilter || null;
      if (pricing.appointmentDiscount && cols.discount_max_dollars) insertData.discount_max_dollars = pricing.appointmentDiscount.maxDiscountDollars ?? null;
      stampPrimaryLineDiscount(insertData, pricing, cols);
      // Pricing-regime provenance (GATE_DISCOUNT_STACKING) — lets a later
      // extension's own restack tell a null primary_line_price genuinely
      // means "no primary" apart from a legacy/unstructured row (see
      // restackStoredVisitFinancials's own comment).
      if (discountStackingLive()) stampPricingRegimeMarker(insertData, cols, capsSnapshotFromPricing(pricing));
      if (cols.create_invoice_on_complete) insertData.create_invoice_on_complete = createInvoiceStamp;

      // Global occupancy probe under rung 1 (the contract's second half):
      // tech-blind, counts live estimate holds, same predicate the customer
      // /book and rebooker commit gates run. A timed parent that overlaps
      // ANY existing visit books through with a warning naming the date
      // (owner ruling above — admin writes never block on conflicts).
      // Windowless rows carry no occupancy and skip the probe (the
      // predicate's NULL window_start is inert either way).
      if (insertData.window_start && insertData.window_end) {
        const adminCreateClash = await findConflictingVisits({
          db: trx,
          date: dateOnly(scheduledDate),
          windowStart: insertData.window_start,
          windowEnd: insertData.window_end,
          excludeStatuses: ADMIN_OCCUPANCY_EXCLUDE_STATUSES,
          // Second technician (GATE_MULTI_TECH_CONFIRM + capacity, dark):
          // the booked technician's route plus unassigned rows, as the
          // picker's strip and the edit save's route check score it. Gate
          // off or no technician = tech-blind, byte for byte.
          technicianId: insertData.technician_id || null,
        });
        if (adminCreateClash.length) {
          bookingWarnings.push(slotOverlapWarning(dateOnly(scheduledDate)));
        }
      }

      // Booking stamping contract (B-track adoption of the admin create
      // parent — the writer that was still creating unlinked recurring
      // parents from legacy labels). Gate OFF: attribution only, the
      // payload above inserts byte-identical. Gate ON: a MISSING catalog
      // identity (service_id / snapshots null because the request carried
      // no service_id) is resolved through the contract's bridge
      // (legacyCatalogName cadence map → serviceNameCandidates → unique
      // live row); a stamped identity is never overridden. Pricing, locks,
      // comms and children stay here.
      const adminCreateInsert = await completeScheduledServiceInsert(insertData, {
        trx, cols, source: { sourceAction: 'admin_manual' },
      });
      [svc] = await trx('scheduled_services').insert(adminCreateInsert).returning('*');
      if (separateProgram) {
        await trx('activity_log').insert({
          admin_user_id: actor.technicianId || null,
          customer_id: customerId,
          action: 'separate_recurring_program_created',
          description: `Series ${svc.id}; reviewed series ${separateProgram.existingSeriesIds.join(', ')}. Reason: ${separateProgram.reason.trim()}`,
        });
      }
      await insertScheduledServiceAddons(trx, svc.id, pricing.addonLines, addonCols);
      // Visit groups (visit-group-scope.md §2): stamp at scheduling —
      // gate-checked + best-effort + self-refusing inside maybeGroupRow.
      await require('../services/visit-groups').maybeGroupRow(svc.id, { database: trx, createdBy: 'dispatch' });
      // Two-treatment package (cockroach / flea): visit 2 books with visit 1
      // — gate-dark, savepoint-isolated, no-op for every other service
      // (package-followup-booking.js).
      await require('../services/package-followup-booking').ensurePackageFollowUpVisit({ trx, primary: svc, cols });
      createdAppointments.push({ id: svc.id, date: scheduledDate, confirmation: sendConfirmationSms === undefined ? true : !!sendConfirmationSms });
      // Inspection credit: durable in-transaction marker on the series
      // ANCHOR (Codex #3178 P1) — a recurring series is one booking, so
      // children must not each claim the promise. Dark behind the gate.
      await require('../services/inspection-credit').markBookingForInspectionCredit(trx, {
        customerId,
        scheduledServiceId: svc.id,
        source: 'admin_schedule',
      });

      // Consultation-outcomes reconciliation (round 10 fast path — see the
      // RECONCILIATION MODEL note atop consultation-outcomes.js; the hourly
      // sweep, reconcileOpenConsultationOutcomes, is the completeness
      // guarantee behind this and every other booking path). Same guarded
      // call admin-leads.js's schedule-appointment uses: isQualifyingSaleBooking
      // reads straight off `svc` (this INSERT's own RETURNING row) — no
      // extra query — and a Waves Assessment booked directly off this
      // calendar tool is excluded the same way admin-leads.js excludes one
      // (an assessment is never itself a win). Best-effort,
      // savepoint-isolated inside markWonForCustomer (waves-db §5b).
      if (!(await require('../services/assessment-booking').isAssessmentBooking(svc, trx))
        && require('../services/consultation-outcomes').isQualifyingSaleBooking(svc)) {
        // round 12 fix (codex P1 audit, post-push): this route is an
        // office/admin tool — never pass svc.technician_id as a
        // closeout-detection hint. That field is the visit's ASSIGNEE, not
        // who booked it; an office admin assigning a new visit to the
        // consultation's own technician is an ordinary office booking, not
        // a door-side close. No real "booked by" signal exists on
        // scheduled_services today (see WON_VIA PROVENANCE atop
        // consultation-outcomes.js).
        await require('../services/consultation-outcomes')
          .markWonForCustomer(customerId, { via: 'office_booking', trx });
      }

      // Create recurring instances from the dates precomputed (and locked)
      // above. Children resolve the CURRENT catalog identity from the
      // inserted parent (serviceId is optional on this endpoint — a legacy
      // or stale label must not seed a whole series with a retired name).
      // Only when something will actually be inserted: a one-off booking
      // takes no catalog read here, and a failed read inside `trx` must not
      // be able to poison an unrelated parent insert (codex #3604 r3 P2).
      const childIdentity = (plannedChildDates.length || plannedBoosterDates.length)
        ? await resolveSeriesChildIdentity(trx, svc)
        : null;
      for (const nextDateStr of plannedChildDates) {
        const childData = {
          customer_id: customerId, technician_id: resolvedTechId,
          scheduled_date: nextDateStr,
          window_start: windowStart, window_end: computedEnd,
          service_type: childIdentity.service_type, status: 'pending',
          time_window: timeWindow, zone, estimated_duration_minutes: duration,
          is_recurring: true, recurring_pattern: recurringPattern,
          recurring_parent_id: svc.id,
        };
        if (cols.recurring_ongoing) childData.recurring_ongoing = !!recurringOngoing;
        if (cols.appointment_type) childData.appointment_type = classifyAppointmentTag(childIdentity.service_type);
        if (cols.service_id && (childIdentity.service_id || serviceId)) childData.service_id = childIdentity.service_id || serviceId;
        if (cols.service_key_snapshot) childData.service_key_snapshot = childIdentity.service_key || pricing.primaryServiceKey || null;
        if (cols.service_category_snapshot) childData.service_category_snapshot = pricing.primaryServiceCategory || null;
        if (cols.recurring_nth && rOpts.nth != null && rOpts.nth !== '' && !isNaN(parseInt(rOpts.nth))) childData.recurring_nth = parseInt(rOpts.nth);
        if (cols.recurring_weekday && rOpts.weekday != null && rOpts.weekday !== '' && !isNaN(parseInt(rOpts.weekday))) childData.recurring_weekday = parseInt(rOpts.weekday);
        if (cols.recurring_interval_days && recurringIntervalDays != null && recurringIntervalDays !== '' && !isNaN(parseInt(recurringIntervalDays))) childData.recurring_interval_days = parseInt(recurringIntervalDays);
        if (cols.skip_weekends) childData.skip_weekends = !!skipWeekends;
        if (cols.weekend_shift && skipWeekendsEffective) childData.weekend_shift = shiftDir;
        if (cols.source_estimate_id && insertLinkId) childData.source_estimate_id = insertLinkId;
        // Property anchor rides the spawn (GH codex #3837 r1 P1): the parent
        // was anchored at insert, and a child without it is refused by the
        // maybeGroupRow call below forever.
        copyStampedServiceAddressFields(childData, svc, cols);
        if (!propertyOwnedByEstimateLinkage) await anchorSoleProperty(childData, cols, trx);
        const childAddonLines = filterAddonLinesForDate(pricing.addonLines, scheduledDate, nextDateStr, seriesBlackoutDates, skipWeekendsEffective);
        const childFinancials = calculateVisitFinancialsForAddons(pricing, childAddonLines);
        // Canonical restack (GATE_DISCOUNT_STACKING): this child's own due
        // add-ons can already differ from the anchor date's — restack fresh
        // against ITS OWN pool rather than copying the anchor's dollars (see
        // restackLiveVisitFinancials). null off, or when there's nothing to
        // restack — every read below then falls back to the values already
        // computed above, unchanged.
        const childRestack = restackLiveVisitFinancials(pricing, childAddonLines);
        // Carry callback status + suppression onto recurring children: if an
        // operator turns a re-service into a repeating cadence, every future
        // visit must stay free and report as a callback (not bill monthly dues).
        if (cols.is_callback) childData.is_callback = resolvedIsCallback || false;
        if (cols.estimated_price) {
          if (zeroCallbackPrice) childData.estimated_price = 0;
          else if (memberSeriesCovered) {
            // Codex pre-push audit P1: sum the RESTACKED add-on nets when
            // available, not the anchor-date prices addonOnlyTotal(childAddonLines)
            // would otherwise read — a $0 primary + a discounted recurring
            // add-on + a shared appointment credit nets differently for a
            // child whose own due add-ons differ from the anchor's (see
            // restackLiveVisitFinancials), and insertScheduledServiceAddons
            // below already writes each addon row's OWN restacked net —
            // this total must agree with what actually got stamped on them.
            const addonStamp = addonOnlyTotal(childRestack
              ? childAddonLines.map((line, i) => ({
                ...line,
                price: childRestack.addonDollars[i]?.netPrice ?? line.price,
                // Codex round 3 P1: threaded through so addonOnlyTotal can
                // subtract each line's own allocated appointment-credit share.
                appointmentCreditDollars: childRestack.addonDollars[i]?.appointmentCreditDollars ?? 0,
              }))
              : childAddonLines);
            if (addonStamp > 0) childData.estimated_price = addonStamp;
          } else if (childRestack) { if (childRestack.price != null) childData.estimated_price = childRestack.price; }
          else if (childFinancials.price != null) childData.estimated_price = childFinancials.price;
        }
        if (cols.primary_line_price && pricing.primaryBase != null) childData.primary_line_price = pricing.primaryBase;
        if (pricing.appointmentDiscount && cols.discount_id && pricing.appointmentDiscount.discountId) childData.discount_id = pricing.appointmentDiscount.discountId;
        if (pricing.appointmentDiscount && cols.discount_name && pricing.appointmentDiscount.discountName) childData.discount_name = String(pricing.appointmentDiscount.discountName).slice(0, 200);
        if (cols.discount_type && appointmentDiscountType) childData.discount_type = appointmentDiscountType;
        if (cols.discount_amount && appointmentDiscountAmount != null) childData.discount_amount = Number(appointmentDiscountAmount);
        if (pricing.appointmentDiscount && cols.discount_dollars) childData.discount_dollars = childRestack ? childRestack.appointmentDiscountDollars : childFinancials.appointmentDiscountDollars;
        if (pricing.appointmentDiscount && cols.discount_service_key_filter) childData.discount_service_key_filter = pricing.appointmentDiscount.serviceKeyFilter || null;
        if (pricing.appointmentDiscount && cols.discount_service_category_filter) childData.discount_service_category_filter = pricing.appointmentDiscount.serviceCategoryFilter || null;
        if (pricing.appointmentDiscount && cols.discount_max_dollars) childData.discount_max_dollars = pricing.appointmentDiscount.maxDiscountDollars ?? null;
        if (pricing.primaryDiscount && cols.line_discount_id && pricing.primaryDiscount.discountId) childData.line_discount_id = pricing.primaryDiscount.discountId;
        if (pricing.primaryDiscount && cols.line_discount_name && pricing.primaryDiscount.discountName) childData.line_discount_name = String(pricing.primaryDiscount.discountName).slice(0, 200);
        if (pricing.primaryDiscount && cols.line_discount_type && pricing.primaryDiscount.discountType) childData.line_discount_type = String(pricing.primaryDiscount.discountType).slice(0, 30);
        if (pricing.primaryDiscount && cols.line_discount_amount && pricing.primaryDiscount.discountAmount != null) childData.line_discount_amount = Number(pricing.primaryDiscount.discountAmount);
        if (pricing.primaryDiscount && cols.line_discount_dollars && pricing.primaryDiscount.discountDollars != null) {
          childData.line_discount_dollars = childRestack ? (childRestack.primaryDiscountDollars || 0) : Number(pricing.primaryDiscount.discountDollars);
        }
        // Pricing-regime provenance — see the parent insertData's identical stamp.
        if (discountStackingLive()) stampPricingRegimeMarker(childData, cols, capsSnapshotFromPricing(pricing));
        if (cols.create_invoice_on_complete) childData.create_invoice_on_complete = createInvoiceStamp;
        // Same global probe as the parent, under this child's own date lock.
        if (childData.window_start && childData.window_end) {
          const childClash = await findConflictingVisits({
            db: trx,
            date: nextDateStr,
            windowStart: childData.window_start,
            windowEnd: childData.window_end,
            excludeStatuses: ADMIN_OCCUPANCY_EXCLUDE_STATUSES,
            technicianId: childData.technician_id || null, // see the parent probe
          });
          if (childClash.length) {
            bookingWarnings.push(slotOverlapWarning(nextDateStr));
          }
        }
        const [childRow] = await trx('scheduled_services').insert(childData).returning('*');
        // Visit groups: stamp per inserted row (parity with the seeder,
        // which already stamps identical rows).
        if (childRow?.id) await require('../services/visit-groups').maybeGroupRow(childRow.id, { database: trx, createdBy: 'dispatch' });
        // Mirror only add-on lines due on this child date. Mixed-cadence
        // bundles stay one visit on overlap months, but slower lines do
        // not ride every faster-cadence child.
        if (childRow?.id) await insertScheduledServiceAddons(trx, childRow.id, childAddonLines, addonCols, childRestack ? childRestack.addonDollars : null);
        createdAppointments.push({ id: childRow.id, date: nextDateStr, confirmation: false });
      }

      // Booster months — dates precomputed (and locked) above; boosters
      // share recurring_parent_id but are themselves is_recurring=false so
      // the auto-extend path leaves them alone. A future cron can refresh
      // year-2 boosters from parent.booster_months.
      if (plannedBoosterDates.length > 0) {
        for (const boosterDate of plannedBoosterDates) {
          const boosterData = {
            customer_id: customerId, technician_id: resolvedTechId,
            scheduled_date: boosterDate,
            window_start: windowStart, window_end: computedEnd,
            service_type: childIdentity.service_type, status: 'pending',
            time_window: timeWindow, zone, estimated_duration_minutes: duration,
            is_recurring: false,
            recurring_parent_id: svc.id,
            notes: combinedNotes,
          };
          if (cols.appointment_type) boosterData.appointment_type = classifyAppointmentTag(childIdentity.service_type);
          if (cols.service_id && (childIdentity.service_id || serviceId)) boosterData.service_id = childIdentity.service_id || serviceId;
          if (cols.service_key_snapshot) boosterData.service_key_snapshot = childIdentity.service_key || pricing.primaryServiceKey || null;
          if (cols.service_category_snapshot) boosterData.service_category_snapshot = pricing.primaryServiceCategory || null;
          copyStampedServiceAddressFields(boosterData, svc, cols);
          if (!propertyOwnedByEstimateLinkage) await anchorSoleProperty(boosterData, cols, trx);
          const boosterAddonLines = filterAddonLinesForDate(pricing.addonLines, scheduledDate, boosterDate, seriesBlackoutDates, skipWeekendsEffective);
          const boosterFinancials = calculateVisitFinancialsForAddons(pricing, boosterAddonLines);
          // Canonical restack (GATE_DISCOUNT_STACKING) — see the child loop
          // above for the full rationale; null off, or nothing to restack.
          const boosterRestack = restackLiveVisitFinancials(pricing, boosterAddonLines);
          // Boosters off a re-service line inherit the same callback suppression.
          if (cols.is_callback) boosterData.is_callback = resolvedIsCallback || false;
          // Booster rows are is_recurring:false — completion treats them as
          // one-off visits that BILL their own price, never as dues-covered
          // plan visits, so the member-series stripping must not touch them:
          // stripping left base-only boosters unpriced, completing unbilled
          // (or falling back to the dues rate) instead of invoicing the
          // booster's real price (Codex r6).
          if (cols.estimated_price) {
            if (zeroCallbackPrice) boosterData.estimated_price = 0;
            else if (boosterRestack) { if (boosterRestack.price != null) boosterData.estimated_price = boosterRestack.price; }
            else if (boosterFinancials.price != null) boosterData.estimated_price = boosterFinancials.price;
          }
          if (cols.primary_line_price && pricing.primaryBase != null) boosterData.primary_line_price = pricing.primaryBase;
          if (cols.urgency) boosterData.urgency = urgency || 'routine';
          if (cols.internal_notes && internalNotes) boosterData.internal_notes = internalNotes;
          if (cols.skip_weekends) boosterData.skip_weekends = !!skipWeekends;
          if (cols.weekend_shift && skipWeekendsEffective) boosterData.weekend_shift = shiftDir;
          if (cols.source_estimate_id && insertLinkId) boosterData.source_estimate_id = insertLinkId;
          if (pricing.appointmentDiscount && cols.discount_id && pricing.appointmentDiscount.discountId) boosterData.discount_id = pricing.appointmentDiscount.discountId;
          if (pricing.appointmentDiscount && cols.discount_name && pricing.appointmentDiscount.discountName) boosterData.discount_name = String(pricing.appointmentDiscount.discountName).slice(0, 200);
          if (cols.discount_type && appointmentDiscountType) boosterData.discount_type = appointmentDiscountType;
          if (cols.discount_amount && appointmentDiscountAmount != null) boosterData.discount_amount = Number(appointmentDiscountAmount);
          if (pricing.appointmentDiscount && cols.discount_dollars) boosterData.discount_dollars = boosterRestack ? boosterRestack.appointmentDiscountDollars : boosterFinancials.appointmentDiscountDollars;
          if (pricing.appointmentDiscount && cols.discount_service_key_filter) boosterData.discount_service_key_filter = pricing.appointmentDiscount.serviceKeyFilter || null;
          if (pricing.appointmentDiscount && cols.discount_service_category_filter) boosterData.discount_service_category_filter = pricing.appointmentDiscount.serviceCategoryFilter || null;
          if (pricing.appointmentDiscount && cols.discount_max_dollars) boosterData.discount_max_dollars = pricing.appointmentDiscount.maxDiscountDollars ?? null;
          if (pricing.primaryDiscount && cols.line_discount_id && pricing.primaryDiscount.discountId) boosterData.line_discount_id = pricing.primaryDiscount.discountId;
          if (pricing.primaryDiscount && cols.line_discount_name && pricing.primaryDiscount.discountName) boosterData.line_discount_name = String(pricing.primaryDiscount.discountName).slice(0, 200);
          if (pricing.primaryDiscount && cols.line_discount_type && pricing.primaryDiscount.discountType) boosterData.line_discount_type = String(pricing.primaryDiscount.discountType).slice(0, 30);
          if (pricing.primaryDiscount && cols.line_discount_amount && pricing.primaryDiscount.discountAmount != null) boosterData.line_discount_amount = Number(pricing.primaryDiscount.discountAmount);
          if (pricing.primaryDiscount && cols.line_discount_dollars && pricing.primaryDiscount.discountDollars != null) {
            boosterData.line_discount_dollars = boosterRestack ? (boosterRestack.primaryDiscountDollars || 0) : Number(pricing.primaryDiscount.discountDollars);
          }
          // Pricing-regime provenance — see the parent insertData's identical stamp.
          if (discountStackingLive()) stampPricingRegimeMarker(boosterData, cols, capsSnapshotFromPricing(pricing));
          // Same reasoning: boosters keep the modal's invoice intent even on
          // a covered member series (identical to createInvoiceStamp for
          // every non-member booking).
          if (cols.create_invoice_on_complete) boosterData.create_invoice_on_complete = createInvoiceEffective;
          // Same global probe as the parent, under this booster's own date lock.
          if (boosterData.window_start && boosterData.window_end) {
            const boosterClash = await findConflictingVisits({
              db: trx,
              date: boosterDate,
              windowStart: boosterData.window_start,
              windowEnd: boosterData.window_end,
              excludeStatuses: ADMIN_OCCUPANCY_EXCLUDE_STATUSES,
              technicianId: boosterData.technician_id || null, // see the parent probe
            });
            if (boosterClash.length) {
              bookingWarnings.push(slotOverlapWarning(boosterDate));
            }
          }
          const [boosterRow] = await trx('scheduled_services').insert(boosterData).returning('*');
          // Visit groups: stamp per inserted row (seeder parity).
          if (boosterRow?.id) await require('../services/visit-groups').maybeGroupRow(boosterRow.id, { database: trx, createdBy: 'dispatch' });

          // Mirror only add-ons due on this booster date; one-time and
          // off-cadence recurring lines stay off future generated visits.
          if (boosterRow?.id) await insertScheduledServiceAddons(trx, boosterRow.id, boosterAddonLines, addonCols, boosterRestack ? boosterRestack.addonDollars : null);
          createdAppointments.push({ id: boosterRow.id, date: boosterDate, confirmation: false });
        }
      }

      // Prepaid stamping records financial state, so it belongs in the same
      // transaction as the appointment series. If it fails, no appointment rows
      // commit and the admin cannot retry into a duplicate unprepaid series.
      if (body.prepaid && isRecurring) {
        const { totalAmount, method, note } = body.prepaid;
        if (totalAmount > 0) {
          // GitHub round 4 P0 follow-up (Codex; the coordinator's own
          // framing: "the part that makes the P0 unfakeable"): totalAmount
          // above is CLIENT-COMPUTED and was stamped VERBATIM, with no
          // server-side recomputation against the actual per-visit price —
          // exactly the gap expected_discount_stacking's gate check (above)
          // does not cover, since a CATALOG value changing (not the gate)
          // produces the identical symptom: four $100 visits prepaid at a
          // stale $360 while pricing.finalPrice (this route's own,
          // authoritative, buildAppointmentPricing result) actually bills
          // $320/visit. Recomputed here from the SAME pricing this route
          // already produced (cent-exact, percentageDiscountDollars) and
          // the SAME planned-visit-count fallback the client's own
          // recurringGroupRequestFields mirrors (finiteCount ?? 4) — a
          // mismatch rejects with a retryable 409 BEFORE any write (this
          // stamp is the first write in the transaction that touches
          // prepaid money; the transaction that already inserted the
          // appointment rows above rolls back with it, so a mismatch here
          // leaves nothing committed at all, matching the sibling
          // DISCOUNT_STACKING_GATE_DIVERGED check's own "before any write"
          // contract for its own field).
          //
          // Validated against the cadence rows ACTUALLY PLACED (parent +
          // plannedChildDates), not the originally REQUESTED plannedCount
          // (ADMIN-BUG-R09 variant B): blackout/day-off exhaustion can place
          // fewer visits than requested (the route already warns about this
          // above, bookingWarnings), and the client's totalAmount is
          // computed from the requested count. Validating against the
          // stale requested count let a short-placed series pass this gate
          // and then fan the full amount across fewer rows than it prices
          // for, over-stamping every placed visit above its own price.
          const actualPlacedCadenceCount = 1 + plannedChildDates.length;
          assertPrepayTotalMatchesPricing({
            totalAmount, finalPrice: pricing.finalPrice, plannedCount: actualPlacedCadenceCount, requestedCount: plannedCount,
          });
          await stampSeriesPrepaid(trx, {
            anchorServiceId: svc.id,
            totalAmount,
            method: method || 'cash',
            note: note || null,
            useExistingTransaction: true,
          });
        }
      }

      // A direct rodent-bait series owes its setup AT CREATION (codex #3591
      // r58/r59 P1): stamp it in the SAME transaction as the series —
      // financial state never rides a post-response side effect. A resolver
      // failure rolls the booking back (retryable) rather than committing a
      // series whose first completion under-bills; the /secure page, if a
      // link is later sent, freezes/consumes this same stamp.
      // A booking linked to an ALREADY-ACCEPTED estimate never stamps here
      // (codex #3591 r61 P1): that acceptance already made and billed the
      // setup decision from the estimate's frozen disclosure — a stamp would
      // be collected AGAIN at a post-coverage completion. An ACCEPT-ON-BOOK
      // series, however, DOES stamp (codex #3591 r62 P1): the acceptance it
      // depends on runs post-commit and explicitly leaves the appointment
      // standing when the estimate attach loses a race or
      // markEstimateManuallyAccepted throws — without a stamp those paths
      // commit a series whose first completion permanently under-bills. The
      // stamp is retired below the moment acceptance succeeds (the accept
      // bills the setup itself), so the exemption is deferred until the
      // acceptance actually lands instead of assumed up front.
      if (isRecurring && (!linkedEstimateId || acceptEstimateOnBook)) {
        const plans = require('../services/secure-appointment-plans');
        const owedSetup = await plans.resolveDirectRodentSetupObligation(trx, { id: svc.id });
        if (owedSetup > 0) {
          // A Customer 360 coverage-only prepay already billed this setup
          // before any series existed (codex #3591 r73 P1): its claim sits
          // anchor-less on the live prepay invoice. This booking IS the
          // covered series — anchor the claim to it (so a later refund
          // restores here) instead of stamping a second collectible setup.
          // The mint takes the same customer-row lock this transaction
          // holds, so the claim is either committed and visible here or the
          // mint waits and sees this root.
          const coverageClaim = await plans.liveAnchorlessCoverageSetupClaim(trx, { customerId, rootId: svc.id });
          if (coverageClaim) {
            await plans.anchorSetupFeeClaim(trx, { claimId: coverageClaim.id, anchorId: svc.id });
            logger.info(`[schedule] rodent bait setup already billed on prepay invoice ${coverageClaim.invoice_id} — claim anchored to booking ${svc.id}, no stamp`);
          } else {
            await trx('scheduled_services')
              .where({ id: svc.id })
              .whereNull('pending_setup_fee')
              .update({ pending_setup_fee: owedSetup, updated_at: new Date() });
            directRodentSetupStamp = owedSetup;
            logger.info(`[schedule] rodent bait setup ($${owedSetup}) stamped on booking ${svc.id} — billed at first completion unless estimate acceptance bills it`);
          }
        }
      } else if (isRecurring && linkedEstimateId) {
        // A PREVIOUSLY accepted estimate booked afterward (codex #3591 r66
        // P1): the standard Mark Won already ran with skipSetupInvoice, so
        // nothing recorded the DISCLOSED setup — without a stamp the first
        // completion bills only the application. Stamp the estimate's
        // frozen figure unless an acceptance settled it (prepay claim via
        // the term), the estimate disclosed none, or another series booked
        // from it already carries/collected it.
        const plans = require('../services/secure-appointment-plans');
        if (plans.isRodentBaitProgramKey(await plans.authoritativeServiceKey(trx, svc))) {
          const { frozenRodentBaitSetupAmount } = require('../services/estimate-converter');
          const disclosed = frozenRodentBaitSetupAmount(linkedEstimate?.estimate_data || {});
          if (disclosed > 0) {
            const settledClaim = await plans.settledSetupClaimForEstimate(trx, linkedEstimateId);
            // Serialized with a concurrent void/refund (codex #3591 r75 P1):
            // the settled read above is unlocked, so a reversal can turn the
            // claim's invoice terminal between it and the anchor — leaving
            // this series with neither a stamp nor a collectible invoice.
            // Lock the claim's INVOICE row (the reversal transaction updates
            // it, so the loser waits), then re-verify liveness under the
            // lock; a claim whose invoice went terminal is an open
            // obligation and the booking stamps the disclosed figure below.
            let liveClaim = null;
            if (settledClaim) {
              await trx('invoices').where({ id: settledClaim.invoice_id }).forUpdate().first('id');
              liveClaim = await plans.settledSetupClaimForInvoice(trx, settledClaim.invoice_id);
            }
            if (liveClaim) {
              // The invoice-mode/standard accept billed the setup before
              // this series existed — anchor its claim to the root being
              // booked (codex #3591 r72 P1) so a later void/refund of that
              // invoice restores onto THIS series instead of paging.
              if (!liveClaim.scheduled_service_id) {
                await plans.anchorSetupFeeClaim(trx, { claimId: liveClaim.id, anchorId: svc.id });
              }
            } else if (!(await plans.estimateSetupCarriedElsewhere(trx, linkedEstimateId, svc.id))) {
              await trx('scheduled_services')
                .where({ id: svc.id })
                .whereNull('pending_setup_fee')
                .update({ pending_setup_fee: disclosed, updated_at: new Date() });
              logger.info(`[schedule] rodent bait setup ($${disclosed}, disclosed on accepted estimate ${linkedEstimateId}) stamped on booking ${svc.id} — billed at first completion`);
            }
          }
        }
      }

      // Re-align the customer's WaveGuard tier from the just-created recurring rows
      // INSIDE the transaction, so a sync failure rolls back the appointment series
      // rather than committing recurring rows with a stale tier/monthly_rate/member_since
      // — the exact split state this is meant to prevent.
      if (isRecurring) {
        waveguardPlanSync = await syncCustomerWaveGuardPlanFromScheduledServices({
          database: trx,
          customerId,
        });
      }
    });

    // A lead / standalone quote (customer_id was NULL at booking) gets attached
    // to the customer we just booked — only now that the appointment series is
    // committed — so it shows under them afterward and the acceptance/conversion
    // below runs against the right customer. Guarded to customer_id IS NULL so a
    // concurrent attach can't re-home it. Covers both the accept-on-book and the
    // already-accepted link path.
    let estimateAttachRaceLost = false;
    if (estimateNeedsAttach) {
      try {
        const attached = await db('estimates')
          .where({ id: linkedEstimateId })
          .whereNull('customer_id')
          .update({ customer_id: customerId, updated_at: new Date() });
        if (attached) {
          linkedEstimate.customer_id = customerId;
        } else {
          // 0 rows: the quote was attached to another customer between our
          // up-front contact check and here. Don't accept it for THIS customer.
          estimateAttachRaceLost = true;
          bookingWarnings.push('Appointment booked, but the quote was just linked to another customer — it was not marked accepted here. Re-link it from the Estimates page if needed.');
        }
      } catch (e) {
        estimateAttachRaceLost = true;
        logger.warn(`[schedule] could not attach estimate ${linkedEstimateId} to customer ${customerId}: ${e.message}`);
        bookingWarnings.push('Appointment booked, but linking the quote to this customer failed. Open the estimate and re-link it from the Estimates page.');
      }
    }

    // The property linkage the acceptance ran (markEstimateManuallyAccepted →
    // linkAcceptedEstimateProperty) scopes its visit stamp by
    // source_estimate_id, which the rows above did not carry yet — so it
    // stamped none of them (GH codex #3837 r2 P1). Now that they are
    // linked (accept-on-book below, or the attach-only path further down),
    // run it again for exactly these rows: an estimate for a NEW
    // address stamps them with that property; the sole-property anchor
    // deliberately left them alone (propertyOwnedByEstimateLinkage).
    // Best-effort — never throws.
    const stampCreatedRowsFromEstimateProperty = async () => {
      if (!createdAppointments.length) return;
      await require('../services/estimate-property-linkage').linkAcceptedEstimateProperty({
        estimateId: linkedEstimateId,
        customerId,
        onlyServiceIds: createdAppointments.map((a) => a.id),
      });
    };
    // Record the win for a phone-accepted quote — only now that the appointment
    // series is committed, so a booking failure can never strand an accepted
    // estimate with no visit. Reuse the canonical manual-accept flow so funnel
    // reporting, the linked-lead conversion, and (for recurring quotes) customer
    // conversion run exactly as a desk "Mark Won" would, with scheduling left to
    // this booking. Best-effort: estimate shapes that flow intentionally guards
    // (a one-time/recurring choice, invoice-mode, expired, pending manager
    // approval) keep the booked appointment but stay unlinked and surface a
    // warning, rather than failing the request. Skipped if the attach above lost
    // a race — accepting would convert the quote against the wrong customer.
    if (acceptEstimateOnBook && !estimateAttachRaceLost) {
      // Link the just-created rows to the estimate once it's a recorded win —
      // shared by the prepay path and the overlap-race standard fallback.
      // Returns whether the source-estimate link is DURABLY written (retried
      // once) — the stamp retire below keys on it (codex #3591 r88 P1): the
      // link is the acceptance provenance the setup resolver reads, so
      // retiring the stamp without it leaves the series with no estimate, no
      // claim, and no stamp, and a later family lapse re-derives a setup the
      // accepted quote already decided.
      const linkCreatedRowsToEstimate = async () => {
        if (!(cols.source_estimate_id && createdAppointments.length)) return true;
        const writeLink = () => db('scheduled_services')
          .whereIn('id', createdAppointments.map((a) => a.id))
          .update({ source_estimate_id: linkedEstimateId });
        try {
          await writeLink();
          return true;
        } catch (e) {
          try {
            await writeLink();
            return true;
          } catch (e2) {
            logger.warn(`[schedule] estimate ${linkedEstimateId} accepted but linking the appointment failed (retried): ${e2.message}`);
            return false;
          }
        }
      };
      // Acceptance landed → the accept path billed (or deliberately waived)
      // the setup from the estimate's frozen disclosure, so the booking-time
      // stamp must not ALSO bill at first completion (codex #3591 r62 P1 —
      // the stamp exists precisely for the failure paths below, where the
      // appointment stands but no acceptance ever bills the setup).
      // Best-effort: booking and acceptance stand either way, but a retire
      // failure is a live double-bill hazard, so it warns the operator
      // instead of failing silently. CAS on the exact stamped amount so a
      // concurrently frozen/consumed stamp is never clobbered.
      // A zero-row CAS is NOT success (codex #3591 r63 P1): Knex returns 0
      // when the stamp was already consumed/frozen (a completion charged it,
      // or the secure-plan flow froze a different figure) while the
      // acceptance was billing its own setup invoice — that is the
      // double-charge case, so it is reported like a thrown retire.
      // Only an acceptance that actually SETTLED the setup retires the stamp
      // (codex #3591 r64 P1): a standard verbal win converts with
      // skipSetupInvoice (estimate-manual-acceptance) — no invoice carries
      // the setup — so the stamp must stay for the first completion to
      // collect. Settlement evidence is the immutable setup_fee_claims row
      // the prepay mint ledgered against the acceptance's invoice, or the
      // estimate's explicit rodent-setup waiver (the quote disclosed no
      // setup, so a live stamp would charge one the customer never saw).
      // An acceptance WON BY ANOTHER SESSION (alreadyAccepted, no conversion)
      // resolves the winner's prepay claim through the estimate's term (codex
      // #3591 r65 P1). The waiver is the estimate's DISCLOSED setup figure
      // (frozenRodentBaitSetupAmount — engine result + persisted zero
      // decision), not the wizard-only setupFeeQuote: an admin estimate
      // with rodent bait beside another qualifying family omits the setup
      // line and persists no quote object (codex #3591 r65 P1).
      const rodentSetupSettledByAcceptance = async (acceptResult) => {
        const { settledSetupClaimForInvoice, settledSetupClaimForEstimate } = require('../services/secure-appointment-plans');
        const claim = acceptResult?.alreadyAccepted
          ? await settledSetupClaimForEstimate(db, linkedEstimateId)
          : await settledSetupClaimForInvoice(db, acceptResult?.conversion?.draftInvoiceId || null);
        if (claim) return { claim };
        const { frozenRodentBaitSetupAmount } = require('../services/estimate-converter');
        const disclosed = frozenRodentBaitSetupAmount(linkedEstimate?.estimate_data || {});
        return disclosed > 0 ? { disclosed } : { waived: 'estimate_disclosed_no_setup' };
      };
      const retireRodentSetupStampAfterAcceptance = async (acceptResult) => {
        if (!(directRodentSetupStamp > 0)) return;
        try {
          const settled = await rodentSetupSettledByAcceptance(acceptResult);
          if (settled.disclosed) {
            // Standard verbal win: nothing billed the setup, so the stamp
            // stays for the first completion — at the figure the estimate
            // DISCLOSED, never the live constant the booking priced.
            if (Math.round(settled.disclosed * 100) !== Math.round(directRodentSetupStamp * 100)) {
              const aligned = await db('scheduled_services')
                .where({ id: svc.id, pending_setup_fee: directRodentSetupStamp })
                .update({ pending_setup_fee: settled.disclosed, updated_at: new Date() });
              if (Number(aligned) === 1) {
                logger.info(`[schedule] rodent setup stamp on ${svc.id} aligned to the estimate's disclosed $${settled.disclosed} (booking priced $${directRodentSetupStamp})`);
                directRodentSetupStamp = settled.disclosed;
              } else {
                logger.error(`[schedule] FIX: rodent setup stamp on ${svc.id} could not be aligned to the estimate's disclosed $${settled.disclosed} (stamp changed under us) — reconcile before the first completion bills it`);
                bookingWarnings.push('The estimate disclosed a different bait-station setup than the booking stamped — check the pending setup fee on the new series before its first completion.');
              }
            } else {
              logger.info(`[schedule] rodent setup stamp ($${directRodentSetupStamp}) kept on ${svc.id}: the estimate acceptance billed no setup — first completion collects it`);
            }
            return;
          }
          // ONE transaction for the retire + anchor (codex #3591 r76 P1):
          // the settlement read above is unlocked, and the old path cleared
          // the stamp and anchored the claim in separate autocommitted
          // statements — a void/refund of the acceptance's setup invoice in
          // that gap would clear the stamp beside a now-terminal claim,
          // leaving the series with no carrier at all. Lock the claim's
          // INVOICE row (the reversal transaction updates it, so the loser
          // waits), re-verify liveness under the lock, and KEEP the stamp
          // when the reversal won — the first completion collects it.
          await db.transaction(async (trx) => {
            let liveClaim = null;
            if (settled.claim) {
              const { settledSetupClaimForInvoice } = require('../services/secure-appointment-plans');
              await trx('invoices').where({ id: settled.claim.invoice_id }).forUpdate().first('id');
              liveClaim = await settledSetupClaimForInvoice(trx, settled.claim.invoice_id);
              if (!liveClaim) {
                logger.info(`[schedule] rodent setup stamp ($${directRodentSetupStamp}) kept on ${svc.id}: the acceptance's setup invoice was reversed before the retire — first completion collects it`);
                return;
              }
            }
            const retired = await trx('scheduled_services')
              .where({ id: svc.id, pending_setup_fee: directRodentSetupStamp })
              .update({ pending_setup_fee: null, updated_at: new Date() });
            if (Number(retired) !== 1) {
              const live = await trx('scheduled_services').where({ id: svc.id }).first('pending_setup_fee');
              logger.error(`[schedule] FIX: rodent setup stamp on ${svc.id} was ${live?.pending_setup_fee ?? 'null'} (expected ${directRodentSetupStamp}) when estimate acceptance tried to retire it — the stamp was consumed or refrozen while the acceptance billed the setup; reconcile the two setup charges`);
              bookingWarnings.push('The estimate acceptance covered the bait-station setup, but the booking-time setup stamp had already been consumed or changed — check the customer for a second setup charge and clear or refund it.');
              return;
            }
            directRodentSetupStamp = 0;
            // The prepay mint ledgered its claim before this series existed
            // (anchor-less); anchor it now — in the SAME transaction as the
            // retire — so a later refund of that prepay restores the stamp
            // onto THIS series instead of paging.
            if (liveClaim && !liveClaim.scheduled_service_id) {
              const { anchorSetupFeeClaim } = require('../services/secure-appointment-plans');
              await anchorSetupFeeClaim(trx, { claimId: liveClaim.id, anchorId: svc.id });
            }
          });
        } catch (e) {
          logger.error(`[schedule] FIX: could not retire the rodent setup stamp on ${svc.id} after estimate acceptance — first completion would bill a setup the acceptance already covered: ${e.message}`);
          bookingWarnings.push('The estimate acceptance covered the bait-station setup, but the booking-time setup stamp could not be cleared — clear the pending setup fee on the new series to avoid double-billing.');
        }
      };
      try {
        const { markEstimateManuallyAccepted } = require('../services/estimate-manual-acceptance');
        const acceptResult = await markEstimateManuallyAccepted({
          estimateId: linkedEstimateId,
          bookedAppointmentIds: createdAppointments.map((appointment) => appointment.id),
          adminUserId: actor.technicianId || null,
          source: bookingBillingTermEffective === 'prepay_annual' ? 'verbal_annual_prepay_booking' : 'verbal_yes_booking',
          billingTerm: bookingBillingTermEffective,
          // Anchor the prepay renewal term to the visit we just booked — the
          // converter can't see the row (it's linked after acceptance) and
          // would otherwise start the term today, letting a future-dated
          // booking renew before its first service.
          annualPrepayTermStart: bookingBillingTermEffective === 'prepay_annual' ? dateOnly(scheduledDate) : null,
          // Coverage from the BOOKED series (service_type / operator's visit
          // count / booked cadence) so on payment the term attaches + stamps
          // the rows this request just created instead of seeding duplicates.
          annualPrepayCoverage: bookingBillingTermEffective === 'prepay_annual' ? annualPrepayCoverage : null,
          // Program-agreement start date: only when the booked series IS the
          // termite service (a pest/lawn booking on a multi-service estimate
          // must not become the termite program start).
          agreementStartDate: /termite/i.test(String(serviceType || '')) ? dateOnly(scheduledDate) : null,
        });
        estimateAutoAccepted = true;
        if (bookingBillingTermEffective === 'prepay_annual') {
          if (acceptResult?.alreadyAccepted) {
            // Another session accepted this estimate between our preflight and
            // the accept — the short-circuit records no conversion, so NO
            // prepay invoice/term was created here. Never report prepay as
            // applied when it wasn't.
            bookingWarnings.push('Appointment booked, but annual prepay was not applied — the estimate was already accepted by another session. Manage prepay from Customer 360.');
          } else {
            annualPrepayResult = {
              applied: true,
              invoiceId: acceptResult?.conversion?.draftInvoiceId || null,
            };
          }
        }
        // A recurring conversion sends its own new-recurring welcome SMS
        // post-commit; suppress this handler's duplicate so the customer isn't
        // double-texted.
        if (acceptResult?.conversion?.welcomeSms) shouldSendNewRecurringWelcome = false;
        // Link the just-created rows now that the estimate is a recorded win.
        // The stamp retires ONLY once the link is durable (codex #3591 r88
        // P1) — an unlinked series keeps the stamp as its provenance, and
        // the operator is paged to relink before the double-bill hazard the
        // stamp now carries can fire at first completion.
        if (await linkCreatedRowsToEstimate()) {
          await retireRodentSetupStampAfterAcceptance(acceptResult);
          await stampCreatedRowsFromEstimateProperty();
        } else {
          logger.error(`[schedule] FIX: estimate ${linkedEstimateId} accepted but the appointment link could not be written — setup stamp KEPT as provenance; relink the series and retire the stamp (or it double-bills at first completion)`);
        }
      } catch (err) {
        logger.warn(`[schedule] could not auto-accept estimate ${linkedEstimateId} on booking: ${err.message}`);
        // An overlap that RACED in between the preflight check and the atomic
        // lock must not strand the phone-accepted quote unaccepted/unlinked
        // (the appointment rows are already committed) — mirror the preflight
        // overlap branch: record the win as a STANDARD accept (no invoice/
        // term) and link, then warn. The prepay attempt rolled back whole, so
        // the estimate is still open for this retry.
        let downgradedAfterOverlapRace = false;
        if (bookingBillingTermEffective === 'prepay_annual' && err.annualPrepayOverlap) {
          try {
            const { markEstimateManuallyAccepted } = require('../services/estimate-manual-acceptance');
            const retryResult = await markEstimateManuallyAccepted({
              estimateId: linkedEstimateId,
              bookedAppointmentIds: createdAppointments.map((appointment) => appointment.id),
              adminUserId: actor.technicianId || null,
              source: 'verbal_yes_booking',
              billingTerm: 'standard',
              agreementStartDate: /termite/i.test(String(serviceType || '')) ? dateOnly(scheduledDate) : null,
            });
            estimateAutoAccepted = true;
            downgradedAfterOverlapRace = true;
            if (retryResult?.conversion?.welcomeSms) shouldSendNewRecurringWelcome = false;
            if (await linkCreatedRowsToEstimate()) {
              await retireRodentSetupStampAfterAcceptance(retryResult);
              await stampCreatedRowsFromEstimateProperty();
            } else {
              logger.error(`[schedule] FIX: estimate ${linkedEstimateId} accepted (overlap fallback) but the appointment link could not be written — setup stamp KEPT as provenance; relink the series and retire the stamp (or it double-bills at first completion)`);
            }
            bookingWarnings.push('Appointment booked and the estimate was marked accepted as standard — an annual prepay term covering this date already exists (it landed during booking), so no new prepay invoice/term was created. Manage prepay from Customer 360.');
          } catch (retryErr) {
            logger.warn(`[schedule] standard-accept fallback after prepay overlap failed for estimate ${linkedEstimateId}: ${retryErr.message}`);
          }
        }
        if (!downgradedAfterOverlapRace) {
          if (bookingBillingTermEffective === 'prepay_annual') {
            // The accept + prepay invoice/term are one transaction, so a failure
            // (e.g. an overlap raced in between the preflight and the lock) leaves
            // the estimate un-accepted and NO invoice/term behind — the booking
            // stands, nothing is half-applied.
            bookingWarnings.push(`Appointment booked, but the annual-prepay acceptance failed (${err.message}). The estimate was NOT marked accepted and no prepay invoice/term was created — use the estimate’s Annual Prepay action or Mark Won.`);
          } else {
            bookingWarnings.push(`Appointment booked, but the estimate could not be marked accepted automatically (${err.message}). Mark it accepted from the Estimates page to record the win.`);
          }
        }
      }
    }

    // An already-accepted but unowned estimate skips the accept-on-book block, so
    // its source_estimate_id was deferred out of the booking txn (insertLinkId
    // null). Link the rows now that the customer_id attach has won — never before,
    // so a lost race can't point the appointment at another customer's quote.
    if (estimateNeedsAttach && !acceptEstimateOnBook && !estimateAttachRaceLost
        && cols.source_estimate_id && createdAppointments.length) {
      try {
        await db('scheduled_services')
          .whereIn('id', createdAppointments.map((a) => a.id))
          .update({ source_estimate_id: linkedEstimateId });
        await stampCreatedRowsFromEstimateProperty();
      } catch (e) {
        logger.warn(`[schedule] could not link appointment to attached estimate ${linkedEstimateId}: ${e.message}`);
      }
    }

    // Register appointment-reminder rows synchronously, BEFORE the response, with
    // deferConfirmation so the slow Twilio confirmation SMS does NOT run here.
    //  - Honors the "Send confirmation SMS" checkbox: admin_manual defaults to true,
    //    but sendConfirmationSms === false skips the confirmation SMS (the reminder
    //    row is still inserted so 72h/24h reminders fire).
    //  - The row insert is a fast local DB write; doing it on the save path keeps
    //    every reminder row durable before the client can act on the response, so
    //    a same-second cancel/reschedule (which only UPDATE existing rows) can't
    //    race a not-yet-inserted child row into firing reminders for a cancelled
    //    or moved visit. Only the Twilio send is deferred below.
    try {
      const AppointmentReminders = require('../services/appointment-reminders');
      for (const appt of createdAppointments) {
        try {
          // fromCommittedRow: the time is read from the committed row inside
          // the registration transaction (UPDATE-only sync trigger — a
          // reminder born at the wrong time never heals). Windowless →
          // non-delivering placeholder, never an armed 08:00 nobody chose.
          await AppointmentReminders.registerAppointment(
            appt.id, customerId,
            `${appt.date}T${windowStart || '08:00'}`,
            serviceType, 'admin_manual',
            { sendConfirmation: !!appt.confirmation, deferConfirmation: true, closeReminderWindows: !windowStart, fromCommittedRow: true }
          );
        } catch (e) {
          logger.error(`Appointment reminder registration failed for ${appt.id}: ${e.message}`);
        }
      }
    } catch (e) { logger.error(`Appointment reminder registration failed: ${e.message}`); }

    // Inspection credit (dark behind GATE_INSPECTION_CREDIT). The durable
    // marker is written in-transaction with the appointment inserts; this
    // is the fast path that mints immediately when it can. Runs on the
    // FIRST created appointment only — a recurring series is one booking,
    // not one redemption per visit. Best-effort: a booking must never fail
    // because crediting failed, and the service never throws.
    if (createdAppointments.length) {
      try {
        const InspectionCredit = require('../services/inspection-credit');
        const first = createdAppointments[0];
        await InspectionCredit.redeemInspectionCreditForBooking({
          customerId,
          scheduledServiceId: first.id,
          createdBy: `admin:${actor.technicianName || actor.technicianId || 'unknown'}`,
        });
      } catch (e) {
        logger.error(`[schedule] inspection credit redemption failed: ${e.message}`);
      }
    }

    // The appointment(s), any prepayment, and all reminder rows are committed at
    // this point — respond immediately so the admin UI isn't held on "Saving…"
    // while the remaining best-effort side-effects run. Everything in the
    // setImmediate block below was already non-blocking/logged-only; the only
    // change is that it now runs *after* the response. That deferred work is what
    // was costing ~15-20s: the confirmation SMS + Twilio landline lookup, plus the
    // recurring welcome SMS, tech notification, tagging, prepay-terms refresh, and
    // dispatch broadcast — none of which affect the response payload, financial
    // state, or reminder-row durability.
    const response = reply(201, {
      id: svc.id,
      // The ACTUAL number of committed appointments (parent + children +
      // boosters) — blackout exhaustion can place fewer than requested, and
      // reporting the requested count made callers record a complete plan
      // with visits missing. The shortfall itself is named in `warnings`.
      recurringCreated: createdAppointments.length,
      appointments: createdAppointments,
      waveguardPlanSync,
      estimateAccepted: estimateAutoAccepted,
      annualPrepay: annualPrepayResult,
      warnings: bookingWarnings,
    });

    // ── Post-commit side-effects (fire-and-forget; never fail the request) ──
    setImmediate(async () => {
      try {
        // FIRST: a visit created straight onto a tech's route is a "new visit"
        // to them (tech-visit-notifications.js: gate-dark, silent when the
        // creator IS the tech). Queued before the slow Twilio/lead steps
        // below so a reassignment seconds after creation cannot overtake it
        // in the visit's notice queue. With the gate on it replaces the
        // legacy opt-in `new_appointment` row further down.
        const techNotices = require('../services/tech-visit-notifications');
        const visitNoticeLive = !!resolvedTechId && techNotices.isEnabled();
        if (visitNoticeLive) {
          void techNotices.notifyTechVisitChange({
            visitId: svc.id, kind: 'assigned', technicianId: resolvedTechId, actorId: actor.technicianId || null,
            snapshot: { date: scheduledDate, windowStart: windowStart || null, windowEnd: windowEnd || null },
          });
        }
        // Fire the deferred confirmation SMS for any appointment that wants one
        // (the reminder rows were already inserted durably above). This is the
        // slow, Twilio-bound step: landline lookup + send.
        try {
          const AppointmentReminders = require('../services/appointment-reminders');
          for (const appt of createdAppointments) {
            if (!appt.confirmation) continue;
            try {
              await AppointmentReminders.sendConfirmation(appt.id);
            } catch (e) {
              logger.error(`Appointment confirmation SMS failed for ${appt.id}: ${e.message}`);
            }
          }
        } catch (e) { logger.error(`Appointment confirmation SMS failed: ${e.message}`); }

        // Office opted in to the secure-card / Auto Pay setup text (the
        // "Text card-on-file link" checkbox, OFF by default). Parent visit
        // only — a recurring series must never fan the link out per
        // occurrence; every policy check (payer exemption, saved-card
        // auto-secure, one-text-ever claim, gate + template levers) lives
        // in requestCardForAppointment, which never throws.
        if (sendCardOnFileLink === true) {
          try {
            const { requestCardForAppointment } = require('../services/appointment-card-request');
            const cardResult = await requestCardForAppointment({ scheduledServiceId: svc.id, trigger: 'admin' });
            logger.info(`[schedule] admin card-link request for ${svc.id}: ${cardResult.action} (${cardResult.reason})`);
          } catch (e) {
            logger.error(`[schedule] admin card-link request failed for ${svc.id}: ${e.message}`);
          }
        }

        if (shouldSendNewRecurringWelcome) {
          try {
            await sendNewRecurringWelcome({
              customer,
              scheduledServiceId: svc.id,
              recurringPattern,
              entryPoint: 'admin_recurring_appointment_created',
              adminUserId: actor.technicianId,
            });
          } catch (e) {
            logger.error(`[schedule] new recurring welcome SMS failed (non-blocking): ${e.message}`);
          }
        }

        // Booking a service is the deal closing — convert the originating lead
        // to won now rather than waiting for the first visit to complete.
        // Recurring bookings keep their dedicated trigger source; one-time
        // bookings use appointment_booked (previously they didn't convert
        // until completion/invoice, stranding phone-sold one-time jobs as
        // open leads whenever the completion trigger's matching tiers missed).
        // enforceOriginating keeps the fuzzy contact fallback from winning a
        // LATER unlinked add-on lead that happens to share the customer's
        // phone/email (e.g. an established customer booking an add-on): only
        // a lead first contacted on/before the customer signed up converts.
        // Single unambiguous open lead only, idempotent. Best-effort; never
        // blocks the booking.
        //
        // Gated on the quote's fate: when the booking came from a sent/viewed
        // estimate whose auto-accept was REFUSED (manager approval,
        // invoice-mode, converter guards — the warning path above), the deal
        // did not close, so recording the lead as won here would contradict
        // the quote we deliberately left unaccepted. No linked estimate or an
        // already-/newly-accepted one converts as before.
        const estimateRefusedAcceptance = !!(linkedEstimate
          && linkedEstimate.status !== 'accepted'
          && !estimateAutoAccepted);
        // A Waves Assessment is not a closed deal either (owner ruling
        // 2026-09-08): the converter judges that from the booked row itself
        // (`booking: svc` below — name or catalog FK, never the client's
        // label alone) and reports converted:false, so the promotion below
        // stays off too. The lead stays open and the customer row keeps its
        // lead stage until the quote is accepted.
        if (!estimateRefusedAcceptance) {
          try {
            const { convertLeadFromEvent } = require('../services/lead-estimate-link');
            const conversion = await convertLeadFromEvent({
              source: isRecurring ? 'recurring_service_booked' : 'appointment_booked',
              booking: svc,
              // The estimate this booking rode in on: passing it lets the
              // authoritative estimate-link tier (leads.estimate_id) resolve
              // the exact FK-linked lead before the customer/contact
              // fallback — so an add-on lead linked to the source estimate
              // of an established customer converts even though
              // enforceOriginating would reject it by timing. Never after a
              // lost attach race: the quote (and its linked lead) belongs to
              // another customer.
              estimateId: (linkedEstimate && !estimateAttachRaceLost) ? linkedEstimateId : null,
              customerId,
              enforceOriginating: true,
            });
            // A closed deal owes the customer row the same promotion every
            // other booking path applies (stage → won, member_since,
            // reactivation); markConverted only touches the leads row.
            // Promote when THIS trigger converted — or when the deal closed
            // through the estimate path: markEstimateManuallyAccepted (or the
            // earlier acceptance of an already-accepted quote) converts the
            // linked lead itself, so convertLeadFromEvent finds no open lead
            // and reports converted:false, yet a one-time acceptance never
            // promotes the customer row (only the recurring converter does).
            const estimateClosedDeal = !!(linkedEstimate && !estimateAttachRaceLost
              && (estimateAutoAccepted || linkedEstimate.status === 'accepted'));
            if (conversion?.converted || estimateClosedDeal) {
              const { promoteCustomerOnBooking } = require('../services/customer-stages');
              await promoteCustomerOnBooking(db, customerId);
            }
          } catch (e) {
            logger.warn(`[lead-trigger] booking conversion failed for customer=${customerId}: ${e.message}`);
          }
        }

        // Optional: push an in-app notification to the assigned tech's PWA queue
        // (honors the "Notify technician" checkbox — unchecked by default).
        // Legacy opt-in `new_appointment` row (the tech feed never rendered
        // it) — only while the visit-notice gate is off; on, the assigned
        // card queued at the top of this block replaces it.
        if (sendTechNotification && resolvedTechId && !visitNoticeLive) {
          try {
            const { sendTechNotification: pushTechNote } = require('../services/geofence-handler');
            const custName = customer ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim() : 'Customer';
            const when = `${scheduledDate}${windowStart ? ' @ ' + windowStart : ''}`;
            await pushTechNote(resolvedTechId, {
              type: 'new_appointment',
              message: `New appointment: ${custName} — ${serviceType} on ${when}`,
              payload: { scheduled_service_id: svc.id, customer_id: customerId, scheduled_date: scheduledDate, window_start: windowStart },
            });
          } catch (e) { logger.error(`[schedule] tech notification failed (non-blocking): ${e.message}`); }
        }

        // Trigger appointment type automations
        try {
          const AppointmentTagger = require('../services/appointment-tagger');
          await AppointmentTagger.onServiceScheduled(svc.id);
        } catch (e) { logger.error(`Appointment tagger failed: ${e.message}`); }

        try {
          await refreshAnnualPrepayTermsForCustomer(customerId);
        } catch (e) { logger.error(`[schedule] annual prepay terms refresh failed (non-blocking): ${e.message}`); }

        // Keep the live dispatch board in sync when a same-day job is created
        // while dispatchers already have the Board tab open.
        try {
          await emitDispatchJobUpdate({ jobId: svc.id, actorId: actor.technicianId });
        } catch (e) {
          logger.error(`[schedule] dispatch board create broadcast failed: ${e.message}`);
        }
      } catch (e) {
        logger.error(`[schedule] post-commit side-effects failed (non-blocking): ${e.message}`);
      }
    });
    return response;
  } catch (err) {
    // The in-transaction duplicate-series backstop rolled the create back —
    // present the SAME 409 the preflight would have returned.
    if (Array.isArray(err.duplicateRecurringSeries)) {
      return reply(409, duplicateSeriesConflictBody(err.duplicateRecurringSeries));
    }
    // The phone-agent double-booking guard (preflight or locked re-check).
    if (err.callBookingConflict) return reply(409, err.callBookingConflict);
    if (err.isOperational && err.status) {
      return reply(err.status, { error: err.message, code: err.code, ...(err.conflicts ? { conflicts: err.conflicts } : {}) });
    }
    throw err;
  }
}

module.exports = { createScheduleBooking };
