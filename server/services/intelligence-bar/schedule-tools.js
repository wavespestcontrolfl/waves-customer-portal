const { recurringDispatchDuePatch } = require('../scheduling/recurring-dispatch-due');
/**
 * Intelligence Bar — Schedule & Dispatch Tools
 * server/services/intelligence-bar/schedule-tools.js
 *
 * Extended tools for schedule/dispatch context.
 * These are loaded alongside the base tools when the Intelligence Bar
 * is used from the Schedule page.
 */

const db = require('../../models/db');
const { ibTargetRulesV2Live, secondTechLowsLive } = require('../../config/feature-gates');
const logger = require('../logger');
const { assertAssignableTechnician, applyAssignable } = require('../technician-eligibility');
const { scheduledServiceTrackTokenExpiry } = require('../track-token-expiry');
const { etDateString, addETDays, validScheduleDate, sameDayWindowElapsed } = require('../../utils/datetime-et');
const { dayStopsQuery, guardedCoordSelects } = require('../scheduling/day-stops');
const { resolveWindowSafeOrderByTechDay, windowSafeFigures, inProgressStartMin, loadTechDayOrigins,
  assertTechDayOriginsFresh,
  ROUTE_WRITE_GUARD_COLUMNS, CUSTOMER_PREMISE_ALIASES, routeWriteGuardSignature } = require('../route-reorder');
const { probeSlotOverlap, slotOverlapWarning } = require('../scheduling/window-rules');
const { TRANSIENT_FROZEN_REASONS } = require('./outcomes');
const { techStartPoint, homeFromMap, assertStartPointUnchanged } = require('../scheduling/tech-start-point');

// Whether overlap probes are technician-scoped (occupancy.js techScopedConfirmActive). Looked
// up at call time and guarded: suites mock the occupancy module down to a few functions, and a
// missing reader reads as off (tech-blind), today's behavior.
function techScopedProbes() {
  const occupancy = require('../scheduling/occupancy');
  return typeof occupancy.techScopedConfirmActive === 'function' && occupancy.techScopedConfirmActive();
}

const SCHEDULE_TOOLS = [
  {
    name: 'switch_appointment_property',
    description: 'Change only this scheduled visit (including its grouped service lines) to an active saved property on the same customer. Use get_customer_detail to resolve the property ID first. Preserves the primary customer address and future recurring visits. En-route visits are allowed; external navigation may need manual refresh. Call once to prepare the confirmation card; never ask permission to prepare it. The bar can\'t change recurrence templates from here yet.',
    _sideEffects: true,
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', format: 'uuid' },
        property_id: { type: 'string', format: 'uuid' },
      },
      required: ['appointment_id', 'property_id'],
    },
  },
  {
    name: 'optimize_all_routes',
    description: `Run full route optimization for a date using Google Routes API. Reorders all technician stops to minimize total drive time and distance. Your call returns a PREVIEW; the operator approves or rejects it on the confirmation card in the portal. Call ONCE per intended action — never retry, never claim completion.`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD to optimize' },
      },
      required: ['date'],
    },
  },
  {
    name: 'optimize_tech_route',
    description: `Optimize route for a single technician on a given date. Reorders just their stops. Your call returns a PREVIEW; the operator approves or rejects it on the confirmation card in the portal. Call ONCE per intended action — never retry, never claim completion.`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        technician_name: { type: 'string', description: 'Technician name as shown on the schedule' },
      },
      required: ['date', 'technician_name'],
    },
  },
  {
    name: 'assign_technician',
    description: `Assign a technician to one or more unassigned services. Useful when the operator says "give those to <technician>" or "assign the Parrish stops to <technician>." Your call returns a PREVIEW; the operator approves or rejects it on the confirmation card in the portal. Call ONCE per intended action — never retry, never claim completion.`,
    input_schema: {
      type: 'object',
      properties: {
        service_ids: { type: 'array', items: { type: 'string' }, description: 'Scheduled service IDs to assign' },
        technician_name: { type: 'string' },
      },
      required: ['service_ids', 'technician_name'],
    },
  },
  {
    name: 'move_stops_to_day',
    description: `Move one or more scheduled services to a different date. Use when operator says "move the Lakewood stops to Thursday" or "push these to next week." Your call returns a PREVIEW; the operator approves or rejects it on the confirmation card in the portal. Call ONCE per intended action — never retry, never claim completion. Moves are SILENT by default; set notify_customers true ONLY when the operator explicitly asks to text the customers.`,
    input_schema: {
      type: 'object',
      properties: {
        service_ids: { type: 'array', items: { type: 'string' }, description: 'Scheduled service IDs to move' },
        new_date: { type: 'string', description: 'YYYY-MM-DD target date' },
        reason: { type: 'string' },
        notify_customers: { type: 'boolean', description: 'Text each customer the new date and arrival window. Default false (silent move) — only set true when the operator explicitly asks to notify customers.' },
      },
      required: ['service_ids', 'new_date'],
    },
  },
  {
    name: 'swap_tech_assignments',
    description: `Swap all stops between two technicians for a date. Use when "swap those two techs' routes for today." Your call returns a PREVIEW; the operator approves or rejects it on the confirmation card in the portal. Call ONCE per intended action — never retry, never claim completion. This touches every stop for both techs on the date — preview is essential.`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        tech_a_name: { type: 'string' },
        tech_b_name: { type: 'string' },
      },
      required: ['date', 'tech_a_name', 'tech_b_name'],
    },
  },
  {
    name: 'find_schedule_gaps',
    description: `Inspect schedule gaps for a date or date range. When schedule-quality measurements are enabled, reports stored service minutes, modeled driving/waiting, overlaps and unknown capacity; gross gaps or minute budgets never prove an extra visit fits. candidate_service_id tests a specific existing visit against the saved route and known constraints; suggested times still require staff review of commitments/access and a locked save recheck. Supply the operator's workday/break allowance if known; never invent it. Otherwise returns legacy stop-count estimates, which are not bookable capacity.`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD single day' },
        date_from: { type: 'string', description: 'Start of range' },
        date_to: { type: 'string', description: 'End of range' },
        service_type: { type: 'string', description: 'Requested service; all existing work still counts toward the route workload.' },
        candidate_service_id: { type: 'string', format: 'uuid', description: 'Existing appointment to test in the gaps. Loads its stored location/duration; does not move it or assume customer permission.' },
        departure_time: { type: 'string', description: 'Known departure time, HH:MM; otherwise the route model uses 08:00.' },
        target_return_time: { type: 'string', description: 'Operator-provided target return to base, HH:MM. Omit if unknown.' },
        break_minutes: { type: 'number', minimum: 0, description: 'Operator-provided daily lunch/restock allowance. Omit if unknown.' },
      },
    },
  },
  {
    name: 'get_day_summary',
    description: `Get a complete summary of a schedule day: services by tech, completion status, zones, estimated times, unassigned stops, weather. Use for "what does today look like?" or "give me a briefing for Friday."`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['date'],
    },
  },
  {
    name: 'get_zone_density',
    description: `Analyze geographic density of stops for a date. Shows which zones have the most stops and which techs are covering them. Use for route consolidation analysis like "can we consolidate Friday's Venice stops?"`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string' },
      },
      required: ['date'],
    },
  },
  {
    name: 'find_available_slots',
    description: `Find the best time slots to insert a new job based on tech calendars and drive-time detour cost. Returns a ranked list — the top slot adds the LEAST extra driving. Use when the operator says "when can we fit in the Smith job?" or "find me a time for a Bradenton pest control next week" or "what's the best slot for a customer at 123 Oak St?".
Use for: "find time for", "when can we schedule", "best slot for", "fit in a new job".
Each slot carries day_label (e.g. "Wed Oct 28"): quote it as given, never work out a weekday yourself. The result's "searched" block is the dates, visit length and technicians the search really used. "days" lists every searched day with its booked stops and, when that day has no slot, a no_slot_reason — when no slot fits, give the operator each day's no_slot_reason and booked stops as stated (never a cause the result does not give) and the nearest slots from a wider range instead of only asking a question back.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Existing customer UUID (preferred when available)' },
        address: { type: 'string', description: 'Full street address to geocode (e.g. "123 Oak St, Bradenton FL 34202")' },
        lat: { type: 'number', description: 'Latitude if already known' },
        lng: { type: 'number', description: 'Longitude if already known' },
        service_name: { type: 'string', description: 'The service being booked, as the operator said it (e.g. "rodent trapping", "pest control"). The visit length then comes from the service catalog. Pass it whenever the operator names a service.' },
        duration_minutes: { type: 'number', description: 'Visit length in minutes. Pass ONLY when the operator states a length; never guess one. Ignored when service_name matches a catalog service. Default 60.' },
        date_from: { type: 'string', description: 'YYYY-MM-DD start of search range (default: today)' },
        date_to: { type: 'string', description: 'YYYY-MM-DD end of search range (default: today + 7 days)' },
        technician_name: { type: 'string', description: 'Optional: restrict to one technician (name as shown on the schedule)' },
        top_n: { type: 'number', description: 'How many slots to return (default 10)' },
      },
    },
  },
  {
    name: 'cancel_and_reschedule_far_out',
    description: `Find appointments scheduled more than N days from now and propose rescheduling them sooner. Use when operator says "cancel anything more than 30 days out and move them up."`,
    input_schema: {
      type: 'object',
      properties: {
        days_threshold: { type: 'number', description: 'Cancel appointments scheduled more than this many days from today (default 30)' },
        service_type: { type: 'string', description: 'Optional: only affect this service type' },
        reschedule_to_range: { type: 'string', description: 'Optional: target week like "next_week" or "this_week" or specific YYYY-MM-DD' },
      },
    },
  },
];


// ─── EXECUTION ──────────────────────────────────────────────────

async function executeScheduleTool(toolName, input, actionContext = {}) {
  try {
    switch (toolName) {
      case 'switch_appointment_property': return await switchAppointmentProperty(input, actionContext);
      case 'optimize_all_routes': return await optimizeAllRoutes(input);
      case 'optimize_tech_route': return await optimizeTechRoute(input);
      case 'assign_technician': return await assignTechnician(input, actionContext);
      case 'move_stops_to_day': return await moveStopsToDay(input, actionContext);
      case 'swap_tech_assignments': return await swapTechAssignments(input, actionContext);
      case 'find_schedule_gaps': return await findScheduleGaps(input);
      case 'find_available_slots': return await findAvailableSlotsTool(input, actionContext);
      case 'get_day_summary': return await getDaySummary(input.date);
      case 'get_zone_density': return await getZoneDensity(input.date);
      case 'cancel_and_reschedule_far_out': return await cancelAndRescheduleFarOut(input);
      default: return { error: `Unknown schedule tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:schedule] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}


// Both proposal and locked commit use this exact effect description.
async function appointmentPropertyPreview(conn, plan) {
  const { formatAddress } = require('../../utils/address-normalizer');
  const { effectiveServiceAddress } = require('../stamped-address');
  const { TERMINAL_APPOINTMENT_STATUSES } = require('./proposal-pins');
  if (plan.rows.some(row => TERMINAL_APPOINTMENT_STATUSES.includes(row.status))) {
    throw new Error('This visit contains a completed or cancelled service. Review it in Dispatch.');
  }
  if (plan.rows.some(row => row.is_recurring && !row.recurring_parent_id)) {
    // A coded refusal, not a throw: executeScheduleTool turns a throw into an uncoded fault that never reaches the gap list (Codex #6371 r12).
    return {
      error: 'The bar can\'t change the address of a recurring template appointment from here yet: this appointment is also the recurring plan template, so a change would reach the plan\'s later visits. Nothing was changed.',
      code: 'recurring_template_property_unsupported',
    };
  }
  const property = await conn('customer_properties').where({ id: plan.propertyId, customer_id: plan.anchor.customer_id, active: true }).first();
  if (!property || !['address_line1', 'city', 'state', 'zip'].every(field => typeof property[field] === 'string' && property[field].trim())) {
    throw new Error('Choose an active saved customer property with a street, city, state and ZIP code.');
  }
  const customer = await conn('customers').where({ id: plan.anchor.customer_id }).whereNull('deleted_at').first();
  if (!customer) throw new Error('Customer not found');
  // Research is rebuilt after commit for WDO visits only (refreshAppointmentAddressBriefs).
  const wdo = plan.rows.some(row => require('../appointment-tagger').classifyAppointmentType(row.service_type).tag === 'wdo_inspection');
  return {
    proposal: true,
    customer_id: customer.id,
    destination: formatAddress({ line1: property.address_line1, line2: property.address_line2, city: property.city, state: property.state, zip: property.zip }),
    destination_coordinates: { latitude: property.latitude ?? null, longitude: property.longitude ?? null },
    property_id: property.id,
    stops: plan.rows.map(row => ({
      id: row.id, customer_id: row.customer_id, property_id: row.property_id,
      visit_id: row.visit_id, date: require('../visit-groups').dateOnly(row.scheduled_date), technician_id: row.technician_id,
      status: row.status, service_type: row.service_type,
      current_address: formatAddress(effectiveServiceAddress(row, customer)),
    })),
    effects: `Changes the destination and map coordinates for these service lines and clears the route position and cached pre-service brief${wdo ? ', then rebuilds WDO research for the new address' : ''}. The visit keeps its current grouping and is not combined with other stops at the destination; regroup from Dispatch if needed. Preserves the primary customer address, future visits, schedule times, status, and billing. Sends no messages.`,
    navigation: 'An already-open navigation app may need its destination refreshed separately.',
  };
}

async function switchAppointmentProperty(input, actionContext) {
  if (!require('../../config/feature-gates').isEnabled('editApptAddress')) return { error: 'Appointment address changes are not enabled.' };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(input.appointment_id) || !uuid.test(input.property_id)) return { error: 'Resolve the appointment and saved property IDs first.' };
  const { planAppointmentAddress, lockAppointmentAddress, applyAppointmentAddress, refreshAppointmentAddressBriefs } = require('../appointment-address');
  const { previewFingerprint } = require('./authorization-contract');
  const plan = await planAppointmentAddress(db, input.appointment_id, input.property_id, 'visit');
  // A package visit 1 carries its address to visit 2, which this card does
  // not show: change it from the Schedule screen.
  if ((plan.packageChildIds || []).length) return { error: 'This visit has a linked second treatment (package visit 2) that would move to the new address too. The bar can\'t change the address of a package visit 1 from here yet. Nothing was changed.', code: 'package_visit_two_linked' };
  if (input.confirmed !== true) return appointmentPropertyPreview(db, plan);
  if (!actionContext.confirmed || !input._verified_address_fingerprint) return { error: 'Use the confirmation card to approve this change.' };
  const result = await db.transaction(async trx => {
    await require('../scheduling/occupancy').acquireOccupancyLocks(trx, plan.rows.map(row => require('../visit-groups').dateOnly(row.scheduled_date)));
    await require('../scheduling/tech-day-lock').lockTechDays(trx, plan.rows.map(row => ({ techId: row.technician_id, date: require('../visit-groups').dateOnly(row.scheduled_date) })));
    await require('../../utils/customer-comms-lock').lockCustomerComms(trx, plan.anchor.customer_id);
    await lockAppointmentAddress(trx, plan);
    await trx('customers').where({ id: plan.anchor.customer_id }).forShare().first();
    await trx('customer_properties').where({ id: input.property_id }).forShare().first();
    await trx('scheduled_services').whereIn('id', plan.rows.map(row => row.id)).orderBy('id').forUpdate();
    const fresh = await planAppointmentAddress(trx, input.appointment_id, input.property_id, 'visit');
    const preview = await appointmentPropertyPreview(trx, fresh);
    if (preview.error) return preview;
    if (previewFingerprint(preview) !== input._verified_address_fingerprint) return { error: 'The visit or property changed. Request a fresh confirmation card.', preview_changed: true };
    // Apply against the original lock plan: a moved stop cannot silently use
    // advisory locks acquired for an old property/date.
    const ids = await applyAppointmentAddress(trx, plan, actionContext.technicianId);
    return { success: true, updated_service_ids: ids, destination: preview.destination, messages_sent: false };
  });
  if (result.success) {
    // Research must see committed address stamps; the helper rebuilds WDO
    // briefs only and never replays booking prep sends (parity with the
    // Dispatch update-details path).
    void refreshAppointmentAddressBriefs(db, result.updated_service_ids).catch(err => {
      logger.error(`[intelligence-bar] address brief refresh failed: ${err.message}`);
    });
    const { emitDispatchJobUpdate, flushDispatchQualityDates } = require('../dispatch-assignment');
    // A property switch restamps every future appointment at once. Each one
    // changes where its route goes, so the dates need remeasuring — but as a
    // single pass, not one concurrent route scan per row (codex #4295 r1 P2).
    const qualityDates = new Set();
    const broadcasts = await Promise.allSettled(result.updated_service_ids.map(jobId =>
      emitDispatchJobUpdate({ jobId, actorId: actionContext.technicianId, qualityDates })));
    try {
      await flushDispatchQualityDates(qualityDates);
    } catch (err) {
      logger.error(`[intelligence-bar] route quality refresh failed: ${err.message}`);
    }
    if (broadcasts.some(item => item.status === 'rejected')) {
      logger.warn('[intelligence-bar] address saved but dispatch refresh broadcast failed');
      result.warning = 'Address saved. Live refresh failed; refresh the technician schedule to see the new destination.';
    }
  }
  return result;
}

// ─── IMPLEMENTATIONS ────────────────────────────────────────────

function getZone(city) {
  const c = (city || '').toLowerCase();
  if (['parrish', 'ellenton'].includes(c)) return 'Parrish';
  if (c === 'palmetto') return 'Palmetto';
  if (c.includes('lakewood')) return 'Lakewood Ranch';
  if (c.includes('bradenton')) return 'Bradenton';
  if (c === 'sarasota') return 'Sarasota';
  if (['venice', 'nokomis', 'north port'].includes(c)) return 'Venice/N.Port';
  return city || 'Unknown';
}


// Applies a card-approved route_order sequence under the tech-day fence —
// shared by both optimizers' confirmed paths (GH r14 P1). Per-row CAS: each
// write is constrained to the date and the technician the stop was READ on;
// any miss (row moved or reassigned since) aborts the whole rewrite
// untouched, and an approved id missing from the fresh day set refuses with
// preview_changed.
async function applyApprovedRouteOrder({ date, approvedIds, services, lockKeys, expectTechFor, loadEligibleIds, RouteOptimizer, technicianId = null, techHomes = null }) {
  const byId = new Map(services.map((s) => [String(s.id), s]));
  if (approvedIds.some((id) => !byId.has(id))) {
    return { error: "The day's stops changed after the card was shown — nothing was reordered. Ask again for a fresh card.", preview_changed: true };
  }
  // The approved plan must still be window-safe against the rows as they are
  // NOW, not only as they were when the card was drawn: a window, duration,
  // pin or live status changed since then can make the approved sequence
  // illegal, and this path applies it verbatim (codex #4430 r3 P1). The guard
  // is asked to validate the APPROVED order — if it would rather write a
  // different one, the card is stale.
  // Kept for the write transaction below: a completed visit's time or pin can
  // change while confirmation waits for locks, and completed rows are outside
  // loadEligibleIds' own freshness check (codex #4430 r5 P1).
  let techDayOrigins = null;
  const preLockNow = new Date();
  if (RouteOptimizer) {
    const approvedOrder = approvedIds.map((id) => byId.get(id));
    // From the truck's real position, exactly as the preview did — the day
    // has moved on since the card was drawn.
    techDayOrigins = await loadTechDayOrigins(db, date, { technicianId, now: preLockNow });
    const revalidated = resolveWindowSafeOrderByTechDay({
      RouteOptimizer, orderedStops: approvedOrder, sourceStops: services,
      googleSource: 'approved_card', startMin: inProgressStartMin(date, preLockNow),
      techDayOrigins, techHomes,
    });
    if (revalidated.refusal) {
      return { error: routeGuardMessage(revalidated.refusal.reason), reason: revalidated.refusal.reason, preview_changed: true };
    }
    if (revalidated.orderedIds.join(',') !== approvedIds.join(',')) {
      return { error: "The day's promised windows changed after the card was shown — nothing was reordered. Ask again for a fresh card.", preview_changed: true };
    }
  }
  // Guard inputs as the card saw them; compared again under the lock below.
  const guardSnapshot = new Map(services.map((s) => [String(s.id), routeWriteGuardSignature(s)]));
  const { lockTechDays } = require('../scheduling/tech-day-lock');
  try {
    await db.transaction(async (trx) => {
      await lockTechDays(trx, lockKeys);
      // The start point the approved order was certified against (one tech
      // only; a changed address means the card is stale).
      await assertStartPointUnchanged(trx, technicianId, homeFromMap(techHomes, technicianId),
        () => Object.assign(new Error('technician start point changed'), { code: 'STALE_OPTIMIZE_SET' }));
      // Newly ADDED stops refuse too (pre-push r15 P1): the approved plan
      // covers the complete eligible set the card showed — a geocoded stop
      // added since the confirm preflight would sit ungoverned beside (or
      // collide with) the approved 1..N sequence, so the eligible set must
      // match the approved set exactly under the locks.
      // The WHOLE day under the lock, ungeocoded rows included: an
      // appointment without a pin added in the gap is exactly what the
      // COORDLESS_STOPS guard refuses, and filtering it out here would hide
      // it while the ids and signatures still matched (codex #4430 r3 P1).
      const dayRows = await loadEligibleIds(trx);
      const approvedSet = new Set(approvedIds);
      const geocodedIds = dayRows.filter((row) => row.lat && row.lng).map((row) => String(row.id));
      if (geocodedIds.length !== approvedIds.length || geocodedIds.some((id) => !approvedSet.has(id))) {
        throw Object.assign(new Error('stop set changed'), { code: 'STALE_OPTIMIZE_SET' });
      }
      // Membership over the full day, then the guard inputs themselves — the
      // same fence the admin endpoints apply.
      if (dayRows.length !== guardSnapshot.size
        || dayRows.some((row) => routeWriteGuardSignature(row) !== guardSnapshot.get(String(row.id)))) {
        throw Object.assign(new Error('guard inputs changed'), { code: 'STALE_OPTIMIZE_SET' });
      }
      // The completed rows the origin came from are outside that set.
      // Scoped to the technician this card covers: an unrelated tech
      // finishing a stop must not reject it, and their completed rows have no
      // business being locked here (codex round 5 P2).
      const freshOrigins = await assertTechDayOriginsFresh(trx, date, techDayOrigins, {
        technicianId,
        stale: () => Object.assign(new Error('completed-stop origin changed'), { code: 'STALE_OPTIMIZE_SET' }),
      });
      // And time has passed while this waited for locks: re-run today's
      // decision at the CURRENT minute and refuse if the approved order is no
      // longer the one it yields (codex #4430 r5 P1, as both admin endpoints
      // already do).
      const recheckStart = RouteOptimizer ? inProgressStartMin(date) : null;
      if (recheckStart != null) {
        const again = resolveWindowSafeOrderByTechDay({
          RouteOptimizer, orderedStops: approvedIds.map((id) => byId.get(id)), sourceStops: services,
          googleSource: 'approved_card', startMin: recheckStart,
          // Clock advances, elapsed cutoff does not — see the admin recheck.
          elapsedCutoffMin: inProgressStartMin(date, preLockNow), techDayOrigins: freshOrigins, techHomes,
        });
        if (again.refusal || again.orderedIds.map(String).join(',') !== approvedIds.join(',')) {
          throw Object.assign(new Error('route no longer reachable'), { code: 'STALE_OPTIMIZE_SET' });
        }
      }
      for (let i = 0; i < approvedIds.length; i++) {
        const expectTech = expectTechFor(byId.get(approvedIds[i])) || null;
        const updated = await trx('scheduled_services')
          .where('id', approvedIds[i])
          .where('scheduled_date', date)
          .modify((q) => (expectTech ? q.where('technician_id', expectTech) : q.whereNull('technician_id')))
          .update({ route_order: i + 1, updated_at: new Date() });
        if (updated !== 1) {
          throw Object.assign(new Error('schedule changed while optimizing'), { code: 'STALE_OPTIMIZE' });
        }
      }
    });
  } catch (e) {
    if (e.code === 'STALE_OPTIMIZE_SET') {
      return { error: "The day's stops changed after the card was shown — nothing was reordered. Ask again for a fresh card.", preview_changed: true };
    }
    if (e.code === 'STALE_OPTIMIZE') return { error: 'Schedule changed while optimizing — please retry' };
    throw e;
  }
  // A manual reorder writes route_order directly, outside the batched
  // dispatch/rebooker paths — without this the day's card stays stale
  // after an operator applies the approved plan (codex #4295 r2 P2).
  try {
    await require('../scheduling/quality-after-change').refreshScheduleQualityAfterChange({ dates: [date] });
  } catch (e) {
    logger.error(`[intelligence-bar:schedule] route quality refresh failed for ${date}: ${e.message}`);
  }
  logger.info(`[intelligence-bar:schedule] Applied approved route order for ${date}: ${approvedIds.length} stops`);
  return {
    success: true,
    date,
    total_stops: approvedIds.length,
    source: 'approved_plan',
    note: 'Applied the stop order approved on the card (not re-optimized at commit).',
  };
}


/** Operator-facing copy for each refusal the shared window guard returns. */
function routeGuardMessage(reason) {
  if (reason === 'WINDOW_FIT_GATE_OFF') return 'The shortest route breaks a promised arrival window and the window-fit repair is off — nothing was changed.';
  if (reason === 'LIVE_STOP_IN_PROGRESS') return 'A stop on this route is already in progress — reorder it once that visit is complete.';
  if (reason === 'COORDLESS_STOPS') return 'A stop on this route has no map location, so its arrival window cannot be verified — nothing was changed.';
  if (reason === 'MODEL_UNCALIBRATED') return 'Drive-time calibration is off, so this route\'s arrival windows cannot be verified without live traffic data — nothing was changed.';
  if (reason === 'PROGRESS_ORIGIN_UNKNOWN') return 'This route is already under way and the last completed stop has no map location, so the remaining drive cannot be verified — nothing was changed.';
  return 'No legal stop order keeps every promised arrival window — nothing was changed.';
}

async function optimizeAllRoutes(input) {
  const { date, confirmed } = input;
  let RouteOptimizer;
  try { RouteOptimizer = require('../route-optimizer'); } catch {
    return { error: 'Route optimizer not available' };
  }

  // Shared day-stops scaffold (services/scheduling/day-stops) — same rows as
  // the inline query it replaced, including the stamped-address divergence
  // guard on the coordinate fallback (codex round-9 P1).
  const services = await dayStopsQuery(db, {
    dateStr: date,
    excludeStatuses: ['cancelled', 'completed', 'rescheduled'],
    select: [
      'scheduled_services.*',
      'customers.first_name', 'customers.last_name',
      'customers.address_line1', 'customers.city', 'customers.state', 'customers.zip',
      // The co-visit merge resolves an unstamped row's premise through these.
      ...CUSTOMER_PREMISE_ALIASES,
      ...guardedCoordSelects(db),
    ],
  });

  if (!services.length) return { blocked: true, message: 'No services found for this date', date };

  const stopsWithCoords = services.filter(s => s.lat && s.lng);
  if (stopsWithCoords.length < 2) return { blocked: true, message: 'Need at least 2 geocoded stops to optimize', geocoded: stopsWithCoords.length, total: services.length };

  // The card's approved sequence IS the plan (GH r14 P1): a confirmed run
  // with the fingerprint-verified order applies exactly that order under
  // the tech-day locks — never a fresh optimizer answer, which traffic, a
  // transient API fallback, or a coordinate edit can change between the
  // confirm preflight and here.
  if (confirmed === true && Array.isArray(input._verified_ordered_stops) && input._verified_ordered_stops.length) {
    return applyApprovedRouteOrder({
      date,
      approvedIds: input._verified_ordered_stops.map(String),
      services,
      lockKeys: services.map((s) => ({ techId: s.technician_id, date })),
      expectTechFor: (s) => s.technician_id || null,
      RouteOptimizer,
      loadEligibleIds: async (trx) => (await dayStopsQuery(trx, {
        dateStr: date,
        excludeStatuses: ['cancelled', 'completed', 'rescheduled'],
        select: ['scheduled_services.id',
          ...ROUTE_WRITE_GUARD_COLUMNS.map((c) => `scheduled_services.${c}`),
          ...CUSTOMER_PREMISE_ALIASES, ...guardedCoordSelects(trx)],
      // FOR UPDATE: a status transition can otherwise commit en_route/on_site
      // between this check and the writes, which constrain only id/date/tech
      // (codex #4430 r5 P1) — the same fence the admin endpoints take.
      }).forUpdate('scheduled_services')),
    });
  }

  const result = await RouteOptimizer.optimizeRoute(
    stopsWithCoords.map(s => ({
      id: s.id, lat: parseFloat(s.lat), lng: parseFloat(s.lng),
      customerName: `${s.first_name} ${s.last_name}`, serviceType: s.service_type,
      techId: s.technician_id,
    })),
    { startLat: RouteOptimizer.HQ.lat, startLng: RouteOptimizer.HQ.lng, endAtStart: true },
  );

  // Window safety BEFORE anything is proposed — the approved card is applied
  // verbatim later, so an illegal order must never reach it.
  // Window safety BEFORE anything is proposed — the approved card is applied
  // verbatim later, so an illegal order must never reach it. Same shared
  // per-tech-day resolver the admin optimize buttons and the nightly pass use
  // (codex #4430 r3 P1: these two tools were the third writer still applying
  // Google's raw order).
  // sourceStops is the FULL day, not just the geocoded rows: an ungeocoded
  // appointment is exactly what COORDLESS_STOPS and LIVE_STOP_IN_PROGRESS
  // exist to catch, and filtering it out first would hide it (codex #4430 r3
  // P1). Ungeocoded rows are not in the optimizer's order, so a day that
  // passes leaves their route_order untouched.
  const guarded = resolveWindowSafeOrderByTechDay({
    RouteOptimizer, orderedStops: result.orderedStops, sourceStops: services,
    googleSource: result.source,
    // No live-leg shortcut here: the confirmation re-validates the APPROVED
    // order, which has no legs of its own, so a preview certified on Google's
    // legs would produce a card that could never be applied (codex round 5
    // P2). Judge it the way it will be judged.
    legs: null, startMin: inProgressStartMin(date),
    techDayOrigins: await loadTechDayOrigins(db, date),
  });
  if (guarded.refusal) {
    return { blocked: true, date, reason: guarded.refusal.reason, conflict: guarded.refusal.conflict,
      technician_id: guarded.refusal.technicianId,
      message: routeGuardMessage(guarded.refusal.reason) };
  }
  const optimizedById = new Map(result.orderedStops.map((s) => [s.id, s]));
  result.orderedStops = guarded.orderedIds.map((id) => optimizedById.get(id));

  // A repaired order is NOT the one Google scored, so the card must not
  // advertise Google's savings for a sequence it will never apply — the same
  // per-tech-day figures the admin endpoint reports (codex #4430 r3 P1).
  const figures = windowSafeFigures(result, guarded.resolvedByTech,
    guarded.anyWindowConstrained || guarded.scoredRouteChanged, guarded.unassigned);
  result.totalDistanceMeters = figures.totalDistanceMeters;
  result.unoptimizedDistanceMeters = figures.unoptimizedDistanceMeters;
  result.totalDurationSeconds = figures.totalDurationMinutes * 60;
  if (guarded.anyWindowConstrained) result.source = 'window_constrained';
  const savedMiles = Math.round(figures.savedDistanceMeters / 1609.34);
  const addedMiles = Math.round(figures.addedDistanceMeters / 1609.34);
  // A repair that adds less than half a mile still ADDS mileage; rounding it
  // to 0 and taking the savings branch would tell the operator the opposite
  // (codex round 5 P2).
  const addedMilesCopy = addedMiles > 0 ? `~${addedMiles} miles` : 'under a mile';
  const savedPct = figures.savedPercent;

  const summary = {
    date,
    total_stops: stopsWithCoords.length,
    total_miles_before: Math.round(result.unoptimizedDistanceMeters / 1609.34),
    total_miles_after: Math.round(result.totalDistanceMeters / 1609.34),
    miles_saved: savedMiles,
    miles_added: addedMiles,
    percent_saved: savedPct,
    total_drive_minutes: Math.round((result.totalDurationSeconds || 0) / 60),
    source: result.source, // 'google_routes' or 'nearest_neighbor'
    ordered_stops: (result.orderedStops || []).map((s, i) => ({
      position: i + 1,
      // Immutable row id: the confirm fingerprint must bind WHICH visits get
      // a new route_order, not just a name/service that another visit for
      // the same customer could reproduce (W0B).
      id: s.id,
      customer: s.customerName,
      service: s.serviceType,
    })),
  };

  if (confirmed !== true) {
    return {
      proposal: true,
      ...summary,
      note: figures.addedDistanceMeters > 0
        ? `Would reorder ${stopsWithCoords.length} stops to keep every promised arrival window — this ADDS ${addedMilesCopy}. Re-call with confirmed:true to apply.`
        : `Would reorder ${stopsWithCoords.length} stops, saving ~${savedMiles} miles. Re-call with confirmed:true to apply.`,
    };
  }

  if (result.orderedStops) {
    // Fenced + transactional rewrite — same 'slot-reserve' tech-day lock as
    // every other route_order writer (scheduling/tech-day-lock.js); an
    // unfenced per-row loop racing the nightly reorder leaves a mixed
    // sequence. Locks every tech-day this board-wide rewrite touches.
    const { lockTechDays } = require('../scheduling/tech-day-lock');
    try {
      await db.transaction(async (trx) => {
        await lockTechDays(trx, services.map((s) => ({ techId: s.technician_id, date })));
        // Stale-snapshot guard (uncapped audit r21 P1): the optimizer ran
        // BEFORE the fence — a move that committed while we waited must not
        // receive the stale sequence on its new tech-day. Constrain each
        // write to the tech-day the stop was optimized FOR; a miss aborts
        // the whole rewrite untouched.
        const techById = new Map(services.map((s) => [s.id, s.technician_id || null]));
        for (let i = 0; i < result.orderedStops.length; i++) {
          const stopId = result.orderedStops[i].id;
          const expectTech = techById.get(stopId) || null;
          const updated = await trx('scheduled_services')
            .where('id', stopId)
            .where('scheduled_date', date)
            .modify((q) => (expectTech ? q.where('technician_id', expectTech) : q.whereNull('technician_id')))
            .update({ route_order: i + 1, updated_at: new Date() });
          if (updated !== 1) {
            throw Object.assign(new Error('schedule changed while optimizing'), { code: 'STALE_OPTIMIZE' });
          }
        }
      });
    } catch (e) {
      if (e.code === 'STALE_OPTIMIZE') return { error: 'Schedule changed while optimizing — please retry' };
      throw e;
    }
  }

  logger.info(`[intelligence-bar:schedule] Optimized routes for ${date}: saved ${savedMiles} miles (${savedPct}%)`);

  return { success: true, ...summary };
}


// Technician picked by name text. GATE_SECOND_TECH_LOWS (census L3) off: the
// old unordered first() substring match. On: resolveTechnicianByName
// (tools.js) - assignable technicians only, and a name that fits two of them
// comes back as { error, ambiguous, candidates } so the caller refuses
// instead of guessing. Returns a row, null (no match) or that ambiguity object.
// These tools take a name, not technician_id, so the retry asks for the full name.
async function technicianByName(name) {
  if (!(typeof secondTechLowsLive === 'function' && secondTechLowsLive())) {
    return db('technicians').whereILike('name', `%${name}%`).first();
  }
  const found = await require('./tools').resolveTechnicianByName(name);
  if (found && found.ambiguous) {
    return { ...found, error: 'Multiple technicians match that name. Ask the operator which one, then retry with their full name.' };
  }
  return found;
}

async function optimizeTechRoute(input) {
  const { date, technician_name: techName, confirmed } = input;
  const tech = await technicianByName(techName);
  if (!tech) return { error: `Technician "${techName}" not found` };
  if (tech.ambiguous) return tech;

  let RouteOptimizer;
  try { RouteOptimizer = require('../route-optimizer'); } catch {
    return { error: 'Route optimizer not available' };
  }

  // Shared day-stops scaffold — same rows/divergence guard as before (codex round-9 P1).
  const services = await dayStopsQuery(db, {
    dateStr: date,
    technicianId: tech.id,
    excludeStatuses: ['cancelled', 'completed', 'rescheduled'],
    select: [
      'scheduled_services.*',
      'customers.first_name', 'customers.last_name',
      'customers.city',
      ...CUSTOMER_PREMISE_ALIASES,
      ...guardedCoordSelects(db),
    ],
  });

  if (services.length < 2) return { blocked: true, message: `${tech.name} has ${services.length} stop(s) — nothing to optimize`, tech: tech.name };

  const stopsWithCoords = services.filter(s => s.lat && s.lng);
  if (stopsWithCoords.length < 2) return { blocked: true, message: 'Need at least 2 geocoded stops', geocoded: stopsWithCoords.length };

  // This tech's day starts and ends at their start point (GATE_TECH_START_POINTS;
  // the office when unset or the gate is off). The tech row is `select *`, so
  // the coordinates ride along with no extra query. Staff-only: never put them
  // in the card, the summary or a log line.
  const startPoint = techStartPoint(tech);
  const techHomes = new Map([[String(tech.id).toLowerCase(), startPoint]]);

  // Approved-plan application — same contract as optimize_all_routes above
  // (GH r14 P1).
  if (confirmed === true && Array.isArray(input._verified_ordered_stops) && input._verified_ordered_stops.length) {
    const applied = await applyApprovedRouteOrder({
      date,
      approvedIds: input._verified_ordered_stops.map(String),
      services,
      lockKeys: [{ techId: tech.id, date }],
      expectTechFor: () => tech.id,
      RouteOptimizer,
      technicianId: tech.id,
      techHomes,
      loadEligibleIds: async (trx) => (await dayStopsQuery(trx, {
        dateStr: date,
        technicianId: tech.id,
        excludeStatuses: ['cancelled', 'completed', 'rescheduled'],
        select: ['scheduled_services.id',
          ...ROUTE_WRITE_GUARD_COLUMNS.map((c) => `scheduled_services.${c}`),
          ...CUSTOMER_PREMISE_ALIASES, ...guardedCoordSelects(trx)],
      // FOR UPDATE: a status transition can otherwise commit en_route/on_site
      // between this check and the writes, which constrain only id/date/tech
      // (codex #4430 r5 P1) — the same fence the admin endpoints take.
      }).forUpdate('scheduled_services')),
    });
    return applied.success ? { ...applied, tech: tech.name } : applied;
  }

  const result = await RouteOptimizer.optimizeRoute(
    stopsWithCoords.map(s => ({
      id: s.id, lat: parseFloat(s.lat), lng: parseFloat(s.lng),
      customerName: `${s.first_name} ${s.last_name}`, serviceType: s.service_type,
    })),
    { startLat: startPoint.lat, startLng: startPoint.lng, endAtStart: true },
  );

  // Full day as sourceStops, repaired figures on the card — see the notes in
  // optimize_all_routes above.
  const guarded = resolveWindowSafeOrderByTechDay({
    RouteOptimizer, orderedStops: result.orderedStops, sourceStops: services,
    googleSource: result.source,
    // Judged as the confirmation will judge it — see optimize_all_routes.
    legs: null, startMin: inProgressStartMin(date),
    techDayOrigins: await loadTechDayOrigins(db, date, { technicianId: tech.id }),
    techHomes,
  });
  if (guarded.refusal) {
    return { blocked: true, date, tech: tech.name, reason: guarded.refusal.reason,
      conflict: guarded.refusal.conflict, message: routeGuardMessage(guarded.refusal.reason) };
  }
  const optimizedById = new Map(result.orderedStops.map((s) => [s.id, s]));
  result.orderedStops = guarded.orderedIds.map((id) => optimizedById.get(id));

  const figures = windowSafeFigures(result, guarded.resolvedByTech,
    guarded.anyWindowConstrained || guarded.scoredRouteChanged, guarded.unassigned);
  result.totalDistanceMeters = figures.totalDistanceMeters;
  result.unoptimizedDistanceMeters = figures.unoptimizedDistanceMeters;
  result.totalDurationSeconds = figures.totalDurationMinutes * 60;
  if (guarded.anyWindowConstrained) result.source = 'window_constrained';
  const savedMiles = Math.round(figures.savedDistanceMeters / 1609.34);
  const addedMiles = Math.round(figures.addedDistanceMeters / 1609.34);
  // A repair that adds less than half a mile still ADDS mileage; rounding it
  // to 0 and taking the savings branch would tell the operator the opposite
  // (codex round 5 P2).
  const addedMilesCopy = addedMiles > 0 ? `~${addedMiles} miles` : 'under a mile';

  const summary = {
    tech: tech.name,
    date,
    stops: stopsWithCoords.length,
    miles_before: Math.round(result.unoptimizedDistanceMeters / 1609.34),
    miles_after: Math.round(result.totalDistanceMeters / 1609.34),
    miles_saved: savedMiles,
    miles_added: addedMiles,
    drive_minutes: Math.round((result.totalDurationSeconds || 0) / 60),
    ordered_stops: (result.orderedStops || []).map((s, i) => ({
      position: i + 1,
      // Immutable row id: the confirm fingerprint must bind WHICH visits get
      // a new route_order, not just a name/service that another visit for
      // the same customer could reproduce (W0B).
      id: s.id,
      customer: s.customerName,
      service: s.serviceType,
    })),
  };

  if (confirmed !== true) {
    return {
      proposal: true,
      ...summary,
      note: figures.addedDistanceMeters > 0
        ? `Would reorder ${tech.name}'s ${stopsWithCoords.length} stops to keep every promised arrival window — this ADDS ${addedMilesCopy}. Re-call with confirmed:true to apply.`
        : `Would reorder ${tech.name}'s ${stopsWithCoords.length} stops, saving ~${savedMiles} miles. Re-call with confirmed:true to apply.`,
    };
  }

  if (result.orderedStops) {
    // Fenced + transactional — single tech-day; same contract as
    // optimize_all_routes above.
    const { lockTechDays } = require('../scheduling/tech-day-lock');
    try {
      await db.transaction(async (trx) => {
        await lockTechDays(trx, [{ techId: tech.id, date }]);
        // Stale-snapshot guard — same contract as optimize_all_routes above.
        for (let i = 0; i < result.orderedStops.length; i++) {
          const updated = await trx('scheduled_services')
            .where('id', result.orderedStops[i].id)
            .where('scheduled_date', date)
            .where('technician_id', tech.id)
            .update({ route_order: i + 1, updated_at: new Date() });
          if (updated !== 1) {
            throw Object.assign(new Error('schedule changed while optimizing'), { code: 'STALE_OPTIMIZE' });
          }
        }
      });
    } catch (e) {
      if (e.code === 'STALE_OPTIMIZE') return { error: 'Schedule changed while optimizing — please retry' };
      throw e;
    }
  }

  logger.info(`[intelligence-bar:schedule] Optimized ${tech.name}'s route for ${date}: saved ${savedMiles} miles`);

  return { success: true, ...summary };
}


// Approved-snapshot drift checks for assign_technician (the pre-lock compare and the
// locked re-read), kept as named predicates. Each compares one stop against what the
// operator approved.
//
// The owner binds too when the approved snapshot carries it (GATE_IB_TARGET_RULES_V2
// puts customer_id on each previewed stop): a stop re-pointed to another customer
// between preview and commit is drift (Codex #6369 r16).
const stopOwnerChanged = (approved, customerId) => approved?.customer_id !== undefined
  && String(approved.customer_id) !== String(customerId || '');

const approvedStopMap = (stops) => new Map((stops || []).map((s) => [String(s.id), s]));

const approvedDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ? String(v).slice(0, 10) : null));

// Pre-lock compare. Date binds too (GH r9 P1): a stop moved to another day after the
// confirm re-preview would otherwise pass the tech compare, and the transaction would
// lock/validate the NEW day rather than the approved one. Grouped membership binds
// (GH r14 P1): a stop that joined, left, or switched grouped visits after the card was
// shown gets seam effects (visit adoption/detach) the card never disclosed.
function assignStopDrifted(approved, stop) {
  return !approved
    || String(approved.current_tech || 'Unassigned') !== String(stop.current_tech_name || 'Unassigned')
    || approvedDateStr(approved.scheduled_date) !== stop.scheduled_date_str
    || String(approved.grouped_visit_id || '') !== String(stop.visit_id || '')
    || stopOwnerChanged(approved, stop.customer_id);
}

// Compare on the locked rows the UPDATE itself will touch: the pre-lock read chose the
// lock keys, so any drift between it and the locked rows means the fence may not cover
// the real source day.
function assignLockedRowDrifted(approved, locked, stop) {
  return !locked
    || String(locked.technician_id || '') !== String(stop.current_tech_id || '')
    || locked.scheduled_date_str !== stop.scheduled_date_str
    || String(locked.visit_id || '') !== String(stop.visit_id || '')
    || stopOwnerChanged(approved, locked.customer_id);
}

async function assignTechnician(input, actionContext = {}) {
  const { service_ids: rawServiceIds, technician_name: techName, confirmed } = input;
  let serviceIds = rawServiceIds;
  let tech = await technicianByName(techName);
  if (!tech) return { error: `Technician "${techName}" not found` };
  if (tech.ambiguous) return tech;

  const allServices = await db('scheduled_services')
    .whereIn('scheduled_services.id', serviceIds)
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .leftJoin('technicians as cur_tech', 'scheduled_services.technician_id', 'cur_tech.id')
    .select(
      'scheduled_services.id',
      'scheduled_services.status',
      'customers.first_name', 'customers.last_name',
      'scheduled_services.customer_id',
      'scheduled_services.service_type',
      'scheduled_services.scheduled_date',
      // The window rides the assignment notice's snapshot (Codex r4 P2): a
      // reschedule landing while the notice waits on its recipient lookup
      // must not make the "new visit" card describe the LATER window.
      'scheduled_services.window_start', 'scheduled_services.window_end',
      'scheduled_services.technician_id as current_tech_id',
      // Grouped-visit membership rides the preview (GH r14 P1): the
      // post-commit seam can adopt the new technician for the whole visit
      // or detach the child — effects the card must disclose, and a
      // membership change during the pending window must drift.
      'scheduled_services.visit_id',
      // Canonical YYYY-MM-DD for the tech-day fence key — a JS Date
      // stringified any other way builds a key that never collides with the
      // other lock holders' keys (see tech-day-lock.js).
      db.raw("to_char(scheduled_services.scheduled_date, 'YYYY-MM-DD') as scheduled_date_str"),
      'cur_tech.name as current_tech_name',
    );

  if (!allServices.length) return { error: 'No services found for the given IDs' };

  // Terminal rows are one-way — reassigning a completed/no_show/skipped
  // visit silently rewrites who performed it (pay validation, tech stats,
  // visit history all read scheduled_services.technician_id), while the
  // REST reassign path (assignDispatchJob) already refuses the same rows
  // with a 409. Fence here the same way moveStopsToDay fences a terminal
  // move: drop them from the preview/commit set and disclose what was left
  // behind, refusing outright when nothing remains.
  const { TERMINAL_APPOINTMENT_STATUSES } = require('./proposal-pins');
  const services = allServices.filter((s) => !TERMINAL_APPOINTMENT_STATUSES.includes(String(s.status)));
  // Each excluded stop is named (customer + id + status) so the card can
  // list exactly WHICH stops the operator is approving to leave behind, not
  // just how many (Codex round 3 P1); the list rides the fingerprinted
  // preview like `stops` does.
  const skippedTerminal = allServices
    .filter((s) => TERMINAL_APPOINTMENT_STATUSES.includes(String(s.status)))
    .map((s) => ({ id: s.id, status: s.status, customer: `${s.first_name || ''} ${s.last_name || ''}`.trim() }));
  if (!services.length) {
    return { error: 'All matching stops are in a terminal status (completed/cancelled/skipped/no_show) — nothing to reassign' };
  }
  serviceIds = services.map((s) => s.id);

  const stops = services.map(s => ({
    id: s.id,
    customer: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
    service_type: s.service_type,
    scheduled_date: s.scheduled_date,
    current_tech: s.current_tech_name || 'Unassigned',
    ...(s.visit_id ? { grouped_visit_id: String(s.visit_id) } : {}),
    // GATE_IB_TARGET_RULES_V2: the stop's owner by id, so owner-direct can tell a named
    // customer from a same-name one. Only while the gate is on (off = preview unchanged);
    // the executor's drift check reads id, tech, date and visit only.
    ...(ibTargetRulesV2Live() && s.customer_id ? { customer_id: String(s.customer_id) } : {}),
  }));

  if (confirmed !== true) {
    return {
      proposal: true,
      would_assign_to: tech.name,
      // The resolved ROW id binds the fingerprint (GH r21 P2): technician
      // names are not unique, and the executor's own name resolution is an
      // unordered first() — the card must pin WHICH technician row gets
      // the stops, and the executor enforces that id.
      would_assign_to_id: String(tech.id),
      stop_count: stops.length,
      stops,
      ...(skippedTerminal.length ? { skipped_terminal: skippedTerminal } : {}),
      note: `Would reassign ${stops.length} stop(s) to ${tech.name}.`
        + (skippedTerminal.length ? ` ${skippedTerminal.length} stop(s) are in a terminal status (completed/cancelled/skipped/no_show) and will NOT be reassigned.` : '')
        + ' Re-call with confirmed:true to apply.',
    };
  }

  // Card-approved runs enforce the pinned technician IDENTITY (GH r21
  // P2): the name re-resolution above is an unordered match, so the
  // approved row id is authoritative — a different row (same display
  // name, or a replacement) refuses instead of receiving every stop.
  if (input._verified_tech_id && String(tech.id) !== String(input._verified_tech_id)) {
    const pinned = await db('technicians').where('id', String(input._verified_tech_id)).first();
    if (!pinned) {
      return { error: 'The approved technician no longer exists — nothing was reassigned. Ask again for a fresh card.', preview_changed: true };
    }
    tech = pinned;
  }

  // The stop/current-tech set the operator approved (`_verified_stops`, the
  // route's fingerprint-verified re-preview) must match what this run reads
  // — otherwise a reassignment made during the pending window is silently
  // overwritten by a card that named the OLD assignments (GH r8 P1).
  const approvedStops = Array.isArray(input._verified_stops) ? input._verified_stops : null;
  const approvedById = approvedStopMap(approvedStops);
  if (approvedStops) {
    const drifted = approvedStops.length !== services.length
      || services.some((s) => assignStopDrifted(approvedById.get(String(s.id)), s));
    if (drifted) {
      return { error: 'The assignments on these stops changed after the card was shown — nothing was reassigned. Ask again for a fresh card.', preview_changed: true };
    }
  }

  // Reassignment edits tech-day MEMBERSHIP on both sides (the day the stop
  // leaves and the day it joins), so it must hold the same tech-day fence the
  // nightly reorder and the booking/reschedule writers hold — an unfenced
  // reassign landing mid-reorder leaves the committed route_order not
  // covering the day.
  const { lockTechDays } = require('../scheduling/tech-day-lock');
  let count;
  let committedAssignRows = [];
  try {
    count = await db.transaction(async trx => {
    await lockTechDays(trx, services.flatMap(s => [
      { techId: s.current_tech_id, date: s.scheduled_date_str },
      { techId: tech.id, date: s.scheduled_date_str },
    ]));
    // Save-time eligibility on the writing trx (422 TECH_NOT_ASSIGNABLE),
    // checked once per distinct destination day the selected stops land on
    // — a tech marked out for even one of several dates in this bulk assign
    // must refuse the whole call, not silently accept the days it's clear
    // for (the absence read per date is cheap; see swapTechAssignments for
    // the same date-threaded pattern). Runs BEFORE the row locks below: a
    // refused tech never takes FOR UPDATE locks on the stops.
    const destDates = [...new Set(services.map((s) => s.scheduled_date_str))];
    for (const d of destDates) {
      await assertAssignableTechnician(tech.id, { conn: trx, date: d });
    }
    // Re-read the approved set UNDER the tech-day locks — one live read
    // serves both checks below. Re-assert the approved snapshot (same
    // contract as swap_tech_assignments): the pre-lock read above chose the
    // lock keys, so any drift between it and the locked rows means the
    // fence may not cover the real source day — refuse rather than commit
    // an unapproved overwrite.
    const live = await trx('scheduled_services')
      .whereIn('id', serviceIds)
      .forUpdate()
      .select('id', 'status', 'technician_id', 'visit_id', 'customer_id', db.raw("to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date_str"));
    const liveById = new Map(live.map((r) => [String(r.id), r]));
    if (approvedStops) {
      const changed = live.length !== services.length
        || services.some((s) => assignLockedRowDrifted(approvedById.get(String(s.id)), liveById.get(String(s.id)), s));
      if (changed) {
        const err = new Error('assign_set_changed');
        err.previewChanged = true;
        throw err;
      }
    }
    // Terminal-status re-check UNCONDITIONAL (Codex round 1 P1): the
    // in-trx UPDATE's whereNotIn fence below silently drops a row that
    // turned completed/cancelled/skipped/no_show between the preview read
    // and this lock — without this check the batch still reports
    // success:true for the ORIGINAL approved count and the grouped-visit
    // repair loop still runs against every original id, including the one
    // that was never touched. Abort the whole batch instead: the card
    // shows exactly which stop(s) drifted and the operator re-asks.
    const nowTerminal = live.filter((l) => TERMINAL_APPOINTMENT_STATUSES.includes(String(l.status)));
    if (nowTerminal.length) {
      const err = new Error('assign_now_terminal');
      err.previewChanged = true;
      err.nowTerminal = nowTerminal.map((l) => ({ id: l.id, status: l.status }));
      throw err;
    }
    // route_order: null ONLY for rows whose technician actually CHANGES —
    // the old sequence number is meaningless in the day the stop joins
    // (NULL appends after the ordered run; every consumer sorts
    // COALESCE(route_order, 999)) until an optimizer places it. Rows
    // already on tech.id are a no-op reassignment: clearing them would
    // erase a valid manual/optimized position (uncapped audit r25 P1) —
    // the predicate is on the row value the UPDATE itself observes.
    // No-op split from the LOCKED live rows (not a separate count query):
    // the commit-count guard below compares the UPDATE's touched rows
    // against exactly this set.
    const nonNoOpIds = live.filter((l) => String(l.technician_id || '') !== String(tech.id)).map((l) => l.id);
    const alreadyOn = live.length - nonNoOpIds.length;
    // The COMMITTED schedule of every reassigned row rides back for the
    // notices (pre-push audit P1): a same-day window edit landing between
    // the card's read and this lock must not make the "new visit" card
    // describe the old window.
    committedAssignRows = await trx('scheduled_services')
      .whereIn('id', serviceIds)
      // Belt-and-braces (ADMIN-BUG-R56): serviceIds is already narrowed to
      // non-terminal rows above and re-verified live just above, but the
      // in-trx UPDATE — the decisive write — must never depend on either of
      // those alone.
      // NULL-safe (Codex round 3 P2): scheduled_services.status is nullable
      // and `NULL NOT IN (...)` is never true, so a bare whereNotIn would
      // drop a legacy null-status row the preview and the live re-read both
      // treated as open — the UPDATE would touch zero rows and the count
      // guard below would report preview_changed on every retry.
      .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_APPOINTMENT_STATUSES))
      .whereRaw('technician_id IS DISTINCT FROM ?', [tech.id])
      .update({ technician_id: tech.id, route_order: null, updated_at: new Date() })
      .returning(['id', 'scheduled_date', 'window_start', 'window_end']);
    // Contract-drift guard, not a silent partial success (Codex round 1
    // P1): every row the live re-read found still needing reassignment
    // must be a row the UPDATE actually touched — any mismatch means the
    // two reads disagree in a way the operator must see, never a quiet
    // undercount reported as success:true.
    if (committedAssignRows.length !== nonNoOpIds.length) {
      const err = new Error('assign_commit_count_mismatch');
      err.previewChanged = true;
      throw err;
    }
    return committedAssignRows.length + alreadyOn;
    });
  } catch (err) {
    if (err && err.previewChanged) {
      if (err.nowTerminal && err.nowTerminal.length) {
        return {
          error: `${err.nowTerminal.length} of these stop(s) turned completed/cancelled/skipped/no_show just before this was applied — nothing was reassigned. Ask again for a fresh card.`,
          preview_changed: true,
          skipped_terminal: err.nowTerminal,
        };
      }
      return { error: 'The assignments on these stops changed after the card was shown — nothing was reassigned. Ask again for a fresh card.', preview_changed: true };
    }
    throw err;
  }

  // Tech-facing notices (tech-visit-notifications.js): this writer bypasses
  // assignDispatchJob, so it tells both techs itself. Post-commit,
  // best-effort and NOT awaited — a bulk reassign must not serialize push
  // delivery into the tool's response; the operator's own moves stay silent.
  {
    const { notifyAssignmentChange } = require('../tech-visit-notifications');
    // Recipients and snapshots come from the rows the UPDATE actually
    // reassigned (a row already on tech.id was a no-op and stays silent).
    const preById = new Map(services.map((s) => [String(s.id), s]));
    for (const row of committedAssignRows) {
      const pre = preById.get(String(row.id));
      void notifyAssignmentChange({
        visitId: row.id, fromTechId: pre?.current_tech_id || null, toTechId: tech.id, actorId: actionContext.technicianId || null,
        snapshot: { date: row.scheduled_date, windowStart: row.window_start || null, windowEnd: row.window_end || null },
      });
    }
  }

  // Visit-group seam (visit-group-scope.md §2; codex #3590 r9): this
  // writer bypasses assignDispatchJob, so it repairs grouped membership
  // itself — a reassigned child whose tech now conflicts with its visit
  // detaches (or the visit adopts, per the helper's rules). Post-commit,
  // best-effort, no-op for ungrouped rows.
  let groupWarning = null;
  try {
    const { handleChildStopChanged } = require('../visit-groups');
    for (const sid of serviceIds) await handleChildStopChanged(sid);
  } catch (vgErr) {
    logger.warn(`[intelligence-bar:schedule] visit-group seam failed after assign: ${vgErr.message}`);
    // The card disclosed the grouped-visit adoption/detach for grouped
    // stops — a failed repair leaves stale group state and must surface,
    // never a bare Done (GH r14).
    if (services.some((s) => s.visit_id)) {
      groupWarning = 'Assigned, but repairing grouped-visit membership failed — one or more grouped stops may still show the old visit assignment; re-check the affected visits on the schedule.';
    }
  }

  logger.info(`[intelligence-bar:schedule] Assigned ${count} services to ${tech.name}`);

  return {
    success: true,
    assigned_count: count,
    technician: tech.name,
    stops,
    ...(skippedTerminal.length ? { skipped_terminal: skippedTerminal } : {}),
    ...(groupWarning ? { warning: groupWarning } : {}),
  };
}


// Terminal scheduled_services statuses — one-way; never movable. Live
// (en_route/on_site) rows ARE movable, but the move must rewind the tracker
// lifecycle (rebooker LIVE_LIFECYCLE_RESET) so stale arrival timestamps
// don't survive onto the new date.
const TERMINAL_MOVE_STATUSES = new Set(require('./proposal-pins').TERMINAL_APPOINTMENT_STATUSES);
const LIVE_MOVE_STATUSES = new Set(['en_route', 'on_site']);

// A frozen verdict's skip kind: a wait ('busy') or a structural freeze ('frozen').
const frozenStopKind = (reason) => (TRANSIENT_FROZEN_REASONS.has(reason) ? 'busy' : 'frozen');

// A batch move that goes ahead without some of its stops is a success, so the
// gap collector cannot see the refusals; it reads this note instead (Codex #6371 r12, r13).
// One code per kind of skipped stop: grouped, frozen, and collective (series) moves.
function skippedMoveGaps(skippedGrouped, skippedCollective, outage = false) {
  if (outage) return {};
  const codes = [
    skippedGrouped.some((entry) => entry.kind === 'grouped') && 'grouped_visit_move_unsupported',
    skippedGrouped.some((entry) => entry.kind === 'frozen') && 'frozen_visit_move_unsupported',
    skippedCollective.length > 0 && 'collective_move_unsupported',
  ].filter(Boolean);
  return codes.length ? { capability_gaps: codes.map((code) => ({ code })) } : {};
}

// Why a stop with a visit cannot ride a batch move, or null when it can: one
// classification per stop, read-only (no locks; the commit's per-stop assert
// stays authoritative). Fails CLOSED on a group state that cannot be read
// (GH r8 P1). Each entry keeps its kind: grouped, frozen (structural), busy
// (a wait) or unreadable (an outage).
async function groupStateSkip(s) {
  if (!s.visit_id) return null;
  const status = (detail) => `${s.status} (${detail})`;
  try {
    const { openMembers, frozenVisitVerdict } = require('../visit-groups');
    const members = await openMembers(db, s.visit_id);
    if (members.length >= 2) return { id: s.id, kind: 'grouped', status: status("grouped visit, which moves as a whole; the bar can't move it from here yet") };
    const verdict = await frozenVisitVerdict(db, s.visit_id);
    if (!verdict.frozen) return null;
    if (verdict.reason === 'unreadable') return { id: s.id, kind: 'unreadable', status: status('group state unverifiable'), unreadable: true };
    return { id: s.id, kind: frozenStopKind(verdict.reason), reason: verdict.reason, status: status(`frozen visit: ${verdict.reason}`) };
  } catch (err) {
    logger.warn(`[intelligence-bar:schedule] group-state preview check failed for ${s.id}: ${err.message}`);
    return { id: s.id, kind: 'unreadable', status: status('group state unverifiable'), unreadable: true };
  }
}

// Every kind of skipped stop, in the order a refusal names them. `structural`
// kinds are missing capabilities and carry their own code; `busy` is a wait.
const SKIP_KINDS = {
  grouped: {
    code: 'grouped_visit_move_unsupported',
    sentence: () => 'part of a grouped visit, which moves as a whole',
  },
  frozen: {
    code: 'frozen_visit_move_unsupported',
    sentence: (stops) => {
      const reasons = [...new Set(stops.map((g) => g.reason).filter(Boolean))].join(', ');
      return `a visit that has an issued link, records or a payment in progress${reasons ? ` (${reasons})` : ''}`;
    },
  },
  busy: {
    code: null,
    sentence: () => 'a visit that is busy right now (being finalized, completed, or sending a reminder)',
  },
  collective: {
    code: 'collective_move_unsupported',
    sentence: () => 'a recurring-plan visit, whose later visits move with it under collective moves',
  },
};

// The refusal for a batch where every selected stop was skipped for a group,
// freeze, wait or series reason: one sentence per kind present, the retry
// hint when any is a wait, and the code of the first structural kind (the
// wait code only when ALL are waits). Table-driven over SKIP_KINDS.
function skippedKindsRefusal(byKind) {
  const kinds = Object.keys(SKIP_KINDS).filter((kind) => byKind[kind].length);
  const structural = kinds.find((kind) => SKIP_KINDS[kind].code);
  const intro = `Every selected stop is ${kinds.map((kind) => SKIP_KINDS[kind].sentence(byKind[kind])).join(', or ')}`;
  const retry = byKind.busy.length ? ' Try again in a moment for the busy ones.' : '';
  return structural
    ? { error: `${intro}, and the bar can't move ${kinds.length > 1 ? 'those' : 'it'} from here yet.${retry}`, code: SKIP_KINDS[structural].code }
    : { error: `${intro}, so nothing was moved. Try again in a moment.`, code: 'visit_busy_move' };
}

// The refusal when no stop is left to move, plus every kind of capability gap
// among the skips (Codex #6371 r15, r21). An unreadable group check anywhere
// keeps the whole refusal an uncoded fault (Tool Health), never a gap (r7).
function allSkippedRefusal({ skippedGrouped, skippedCollective, skippedUnchanged, skippedElapsed }) {
  if (skippedGrouped.some((entry) => entry.unreadable)) {
    return { error: 'The bar could not check whether some selected stops belong to a grouped or frozen visit, so nothing was moved. Try again.' };
  }
  const byKind = {
    grouped: skippedGrouped.filter((g) => g.kind === 'grouped'),
    frozen: skippedGrouped.filter((g) => g.kind === 'frozen'),
    busy: skippedGrouped.filter((g) => g.kind === 'busy'),
    collective: skippedCollective,
  };
  const anyKind = Object.values(byKind).some((stops) => stops.length);
  const plain = skippedUnchanged.length && !skippedElapsed.length
    ? { error: 'Every selected stop is already on that date — nothing to move' }
    : { error: 'Every movable stop\'s window has already passed today — pick a later window or a future date' };
  const refusal = anyKind && !skippedUnchanged.length && !skippedElapsed.length ? skippedKindsRefusal(byKind) : plain;
  return { ...refusal, ...skippedMoveGaps(skippedGrouped, skippedCollective) };
}



const stopDateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ? String(v).slice(0, 10) : null));

// Stage 1: the date and the rows. A refusal here ends the move: a bad date,
// no such stops, or every stop already in a terminal status (one-way — they
// stay behind and are reported).
async function selectMoveCandidates({ service_ids: serviceIds, new_date: newDate }) {
  // scheduled_date is a plain DATE column holding ET calendar dates — a
  // garbage, impossible (2099-02-31), or past target moves stops where no
  // upcoming query finds them, or throws a raw PG cast error.
  const dateStr = validScheduleDate(newDate);
  if (!dateStr) return { refusal: { error: `new_date must be a valid YYYY-MM-DD date that is not in the past (got "${newDate}")` } };
  const services = await db('scheduled_services')
    .whereIn('scheduled_services.id', serviceIds)
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select('scheduled_services.*', 'customers.first_name', 'customers.last_name', 'customers.city');
  if (!services.length) return { refusal: { error: 'No services found for the given IDs' } };
  const isTerminal = (s) => TERMINAL_MOVE_STATUSES.has(String(s.status));
  const nonTerminal = services.filter((s) => !isTerminal(s));
  if (!nonTerminal.length) {
    return { refusal: { error: 'All matching stops are in a terminal status (completed/cancelled/skipped/no_show) — nothing to move' } };
  }
  return { dateStr, nonTerminal, skippedTerminal: services.filter(isTerminal).map((s) => ({ id: s.id, status: s.status })) };
}

// Stage 2: what the date itself rules out. A move TO today whose stop window
// already elapsed in ET would land in a past window no route can serve; a
// stop already on the target date has nothing to move (neither the preview
// nor the commit rewrites it or texts its customer). With collective series
// moves on (GATE_ADMIN_COLLECTIVE_MOVE) a recurring stop is refused on BOTH
// passes — this batch mover writes one row per stop and cannot shift a
// cadence visit's sister visits (hook r17 P1). Each skip is reported.
function splitMoveByDate(nonTerminal, dateStr) {
  const elapsed = (s) => sameDayWindowElapsed(dateStr, s.window_end || s.window_start);
  const onTarget = (s) => stopDateOnly(s.scheduled_date) === dateStr;
  const movableAnyDate = nonTerminal.filter((s) => !elapsed(s));
  const movableByDate = movableAnyDate.filter((s) => !onTarget(s));
  // The gate read is the rebooker's own (lazy — only when a recurring stop is in the set).
  const collectiveGateOn = movableByDate.some((s) => s.is_recurring === true) && require('../rebooker').collectiveMoveGateOn();
  const isSeries = (s) => collectiveGateOn && s.is_recurring === true;
  return {
    skippedElapsed: nonTerminal.filter(elapsed).map((s) => ({ id: s.id, status: s.status })),
    skippedUnchanged: movableAnyDate.filter(onTarget).map((s) => ({ id: s.id })),
    skippedCollective: movableByDate.filter(isSeries).map((s) => ({ id: s.id, status: s.status, reason: 'collective_move_required' })),
    movableUngated: movableByDate.filter((s) => !isSeries(s)),
  };
}

// Stage 3: grouped/frozen eligibility at PROPOSAL time too (GH r8 P1): a stop
// already known unmovable must never ride the card's approved set only to be
// skipped silently after Confirm.
async function classifyMoveStops(stops) {
  const skippedGrouped = [];
  const movable = [];
  for (const s of stops) {
    const skip = await groupStateSkip(s);
    (skip ? skippedGrouped : movable).push(skip || s);
  }
  return { movable, skippedGrouped };
}

// Pinned SMS recipients (GH r18 P1): with notify_customers the commit texts
// each stop's resolved service-contact recipient, re-resolved from a fresh
// customer load at send time — so the phone the operator approves must ride
// the preview (full number binds the fingerprint, last4 renders on the card)
// and be enforced at the sender's final recipient read.
async function loadNotifyPhones(movable, notifyCustomers) {
  const phones = new Map();
  if (!notifyCustomers) return phones;
  const contactApi = require('../customer-contact');
  for (const s of movable) {
    if (!s.customer_id || phones.has(String(s.customer_id))) continue;
    const customerRow = await db('customers').where('id', s.customer_id).first();
    phones.set(String(s.customer_id), customerRow ? (contactApi.getServiceContactSmsRecipient(customerRow).phone || null) : null);
  }
  return phones;
}

// One stop as the card shows it (and the confirmed pass re-derives it).
function previewStop(s, { dateStr, notifyCustomers, notifyPhoneByCustomer }) {
  // Evidence-only tracker rewinds ride the preview too (GH r8 P1): the card
  // discloses them and the two-step fingerprint binds them.
  const { needsLifecycleRewind } = require('../rebooker');
  const phone = notifyPhoneByCustomer.get(String(s.customer_id)) || null;
  return {
    id: s.id,
    customer: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
    city: s.city,
    service_type: s.service_type,
    // Lifecycle state rides in the preview (codex r7 on #3648): a live
    // (en_route/on_site) stop is more than a date move — the commit resets
    // it to confirmed and releases tech/tracker state — so the card must
    // disclose it, and the two-step fingerprint must bind it.
    status: s.status,
    ...(!LIVE_MOVE_STATUSES.has(String(s.status)) && needsLifecycleRewind(s) ? { track_rewind: true } : {}),
    // Grouped-visit membership (GH r18 P1): a sole-open-member grouped stop
    // is detached and its empty group dissolved after commit — the card
    // must disclose that, and a membership change must drift.
    ...(s.visit_id ? { grouped_visit_id: String(s.visit_id) } : {}),
    ...(notifyCustomers ? { notify_phone: phone, notify_phone_last4: String(phone || '').replace(/\D/g, '').slice(-4) || null } : {}),
    old_date: s.scheduled_date,
    new_date: dateStr,
  };
}

// Stages 1-3 plus the preview stops: a refusal, or everything a card or a
// commit needs. `skipped` holds the skip lists and the capability-gap note,
// the same on the proposal and the committed result.
async function planMove(input) {
  const picked = await selectMoveCandidates(input);
  if (picked.refusal) return picked;
  const { dateStr, nonTerminal, skippedTerminal } = picked;
  const split = splitMoveByDate(nonTerminal, dateStr);
  const { movable, skippedGrouped } = await classifyMoveStops(split.movableUngated);
  const { skippedCollective, skippedUnchanged, skippedElapsed } = split;
  const lists = {
    skipped_grouped: skippedGrouped, skipped_collective: skippedCollective, skipped_unchanged: skippedUnchanged,
    skipped_elapsed: skippedElapsed, skipped_terminal: skippedTerminal,
  };
  if (!movable.length) {
    return { refusal: { ...allSkippedRefusal({ skippedGrouped, skippedCollective, skippedUnchanged, skippedElapsed }), ...nonEmptySkipLists(lists) } };
  }
  const notifyCustomers = input.notify_customers === true;
  const notifyPhoneByCustomer = await loadNotifyPhones(movable, notifyCustomers);
  const context = { dateStr, notifyCustomers, notifyPhoneByCustomer };
  return {
    ...context,
    reason: input.reason,
    movable,
    stops: movable.map((s) => previewStop(s, context)),
    skipped: { ...nonEmptySkipLists(lists), ...skippedMoveGaps(skippedGrouped, skippedCollective) },
  };
}

function moveProposal(plan) {
  const { stops, dateStr, notifyCustomers } = plan;
  return {
    proposal: true,
    would_move_to: dateStr,
    stop_count: stops.length,
    reason: plan.reason || null,
    // Surfaced on the confirmation card — the operator must see whether
    // committing will text the customers.
    will_text_customers: notifyCustomers,
    stops,
    ...plan.skipped,
    note: `Would move ${stops.length} stop(s) to ${dateStr}${notifyCustomers ? ' and TEXT each customer the new arrival window' : ' silently (no customer texts)'}. Re-call with confirmed:true to apply.`,
  };
}

// Whether one approved stop differs from this pass's re-derived stop (status,
// tracker evidence, date, and — GH r18 P1 — grouped membership and the pinned
// SMS recipient, which bind too: a stop that joined/left/switched groups, or
// whose resolved phone changed, gets effects the card never showed).
function stopDrifted(approved, s, notifyCustomers) {
  return !approved
    || String(approved.status) !== String(s.status)
    || (approved.track_rewind === true) !== (s.track_rewind === true)
    || stopDateOnly(approved.old_date) !== stopDateOnly(s.old_date)
    || String(approved.grouped_visit_id || '') !== String(s.grouped_visit_id || '')
    || (notifyCustomers && String(approved.notify_phone || '') !== String(s.notify_phone || ''));
}

// The stop set + lifecycle states the operator approved (`_verified_stops`,
// the route's fingerprint-verified re-preview) must match what this confirmed
// pass just re-read (pre-push r11 P1): a stop that went en_route, gained
// rewind evidence, or moved during the pending window would otherwise get a
// workflow reset or tracker release the card never disclosed.
function approvedStopsDrift(input, plan) {
  if (!Array.isArray(input._verified_stops)) return null;
  const byId = new Map(input._verified_stops.map((a) => [String(a.id), a]));
  const drifted = input._verified_stops.length !== plan.stops.length
    || plan.stops.some((s) => stopDrifted(byId.get(String(s.id)), s, plan.notifyCustomers));
  return drifted
    ? { error: 'The stops changed after the card was shown (status, tracker evidence, or date) — nothing was moved. Ask again for a fresh confirmation card.', preview_changed: true }
    : null;
}

// Per-stop lifecycle classification, derived from the same read the CAS pins.
function classifyForCommit(movable) {
  const { LIVE_LIFECYCLE_RESET, needsLifecycleRewind } = require('../rebooker');
  return movable.map((s) => {
    const wasLive = LIVE_MOVE_STATUSES.has(String(s.status));
    const trackRewound = !wasLive && needsLifecycleRewind(s);
    return {
      s,
      oldDate: s.scheduled_date,
      wasLive,
      trackRewound,
      liveReset: wasLive || trackRewound ? LIVE_LIFECYCLE_RESET : {},
      observedDate: stopDateOnly(s.scheduled_date),
    };
  });
}

// The advisory overlap probe window of a stop: its own window, or its start
// plus the visit's duration when the end is missing or not after the start.
function probeWindowOf(s) {
  const start = s.window_start ? String(s.window_start).slice(0, 5) : null;
  let end = s.window_end ? String(s.window_end).slice(0, 5) : null;
  if (start && (!end || end <= start)) {
    const [h, m] = start.split(':').map(Number);
    const endMin = Math.min(h * 60 + m + (parseInt(s.estimated_duration_minutes, 10) || 60), 23 * 60 + 59);
    end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
  }
  return { start, end };
}

// Rung 1 + tech-blind probes FIRST (occupancy.js ORDERING CONTRACT: the
// date-wide lock precedes the tech-day fence). Advisory only — a hit warns,
// never blocks (owner ruling 2026-08-25). Returns the overlapping stop ids.
async function probeMoveOverlaps(trx, classified, dateStr) {
  const overlappedIds = [];
  for (const { s } of classified) {
    const { start, end } = probeWindowOf(s);
    if (!start || !end) continue;
    // A move keeps the stop's technician (it never reassigns): the probe
    // passes the technician the row is saved with; null stays tech-blind.
    const overlap = await probeSlotOverlap({
      trx, date: dateStr, windowStart: start, windowEnd: end, excludeServiceIds: [String(s.id)],
      technicianId: s.technician_id || null,
    });
    if (overlap.length) overlappedIds.push(s.id);
  }
  return overlappedIds;
}

// One stop's write inside the batch transaction: the grouped/frozen refusal
// under the stop lock (AFTER the tech-day fence — lock order; codex #3609 r29
// P1), the package visit 2 recheck, the area add-on limit, then the CAS
// update (status + observed schedule fields + visit_id + tracker snapshot, no
// FOR UPDATE; a miss aborts the batch).
async function writeMovedStop(trx, c, dateStr, reason) {
  const { applyTrackLifecycleCas, dateExceptionStamp } = require('../rebooker');
  const s = c.s;
  await require('../visit-groups').assertRowMovableAlone(trx, s.id, s.visit_id);
  // Package visit 2 recheck, atomic with this stop's write; aborts the batch.
  await require('../package-followup-booking').assertNoLivePackageChildLocked(trx, [s.id],
    'One of these stops has a linked second treatment (a two-treatment package visit 2) that this card does not show. The bar can\'t move that stop from here yet. Nothing was moved.');
  // A stop carrying a limited area add-on is judged for the new day at its place; a limit reached aborts the batch, nothing moves.
  await require('../area-addon-limits').assertMovedVisitLimitsOpen(trx, { visitId: s.id, visit: s, scheduledDate: dateStr, staff: true });
  const committedRows = await applyTrackLifecycleCas(
    trx('scheduled_services')
      .where('id', s.id)
      .where('status', String(s.status))
      .where({
        scheduled_date: c.observedDate,
        window_start: s.window_start ?? null,
        window_end: s.window_end ?? null,
        // Observed membership joins the CAS (codex r29): grouped-since ⇒ miss.
        visit_id: s.visit_id ?? null,
      }),
    // Full observed tracker/lifecycle snapshot in the CAS — any concurrent
    // lifecycle or SMS-guard write must make this miss.
    s,
  )
    .update({
      scheduled_date: dateStr,
      ...recurringDispatchDuePatch(s, { scheduled_date: dateStr }),
      ...(c.observedDate !== dateStr ? dateExceptionStamp(s, 'admin_ib') : {}),
      // Old day's sequence number is meaningless on the new date — NULL
      // appends the stop after the target day's ordered run.
      route_order: null,
      notes: reason ? `${s.notes || ''}\nMoved from ${c.oldDate}: ${reason}`.trim() : s.notes,
      track_token_expires_at: scheduledServiceTrackTokenExpiry(db, dateStr, s.window_end),
      // LIVE_LIFECYCLE_RESET clears the tracker fields but not status — land a
      // moved live stop back on 'confirmed', matching the rebooker's own path.
      ...(c.wasLive ? { status: 'confirmed' } : {}),
      ...c.liveReset,
      updated_at: new Date(),
    })
    // The technician on the COMMITTED row: the CAS does not pin technician_id,
    // so the move notice goes to whoever holds the stop now (Codex r4 P1).
    .returning(['id', 'technician_id']);
  if (committedRows.length === 0) throw Object.assign(new Error('move_set_changed'), { code: 'MOVE_SET_CHANGED', stopId: s.id });
  c.committedTechId = committedRows[0]?.technician_id || null;
}

// Phase A: the COMPLETE approved set moves in ONE transaction (pre-push r21
// P1): a CAS miss, a grouped/frozen refusal, or any target drift aborts EVERY
// move (all-or-none, like bulk_update_leads).
async function moveBatchTrx(trx, classified, dateStr, reason) {
  const overlappedIds = await probeMoveOverlaps(trx, classified, dateStr);
  // ONE tech-day fence over every day this batch touches (each stop's leaving day + the joining day).
  await require('../scheduling/tech-day-lock').lockTechDays(trx, classified.flatMap((c) => [
    { techId: c.s.technician_id, date: c.observedDate },
    { techId: c.s.technician_id, date: dateStr },
  ]));
  for (const c of classified) await writeMovedStop(trx, c, dateStr, reason);
  // The probe ran on the technician each stop was read with. The CAS does not
  // pin technician_id (the notice follows the stop), so a concurrent
  // reassignment can commit a stop onto another route: when scoping is on
  // (techScopedConfirmActive), check that stop on its committed route, with
  // the batch's other stops excluded as in the first probe (they were not on
  // this date then). Tech-blind probes need no second look.
  if (techScopedProbes()) {
    const batchIds = classified.map((c) => String(c.s.id));
    for (const c of classified) {
      if (String(c.committedTechId || '') === String(c.s.technician_id || '')) continue;
      const { start, end } = probeWindowOf(c.s);
      if (!start || !end) continue;
      const again = await probeSlotOverlap({
        trx, date: dateStr, windowStart: start, windowEnd: end, excludeServiceIds: batchIds, technicianId: c.committedTechId,
      });
      const at = overlappedIds.indexOf(c.s.id);
      if (again.length && at === -1) overlappedIds.push(c.s.id);
      if (!again.length && at !== -1) overlappedIds.splice(at, 1);
    }
  }
  // Route check (GATE_ROUTE_CHECK_STAFF_SAVES, owner 2026-10-29; a no-op when
  // off): once every stop sits in its new place, each moved stop gets the
  // arrival-window check Edit's save runs, on the road times the pickers
  // already bought. ADVISORY ONLY: the warnings ride on the stops
  // (`routeWarnings`) into the result's warning; a route result never refuses
  // or rolls back the batch, and the overlap probes above are unchanged.
  for (const c of classified) {
    const { start, end } = probeWindowOf(c.s);
    c.routeWarnings = await require('../scheduling/staff-save-route-check').staffSaveRouteWarnings(trx, {
      serviceId: c.s.id, date: dateStr, windowStart: start, windowEnd: end, technicianId: c.committedTechId,
    });
  }
  return overlappedIds;
}

// Deadlock retry (codex #3609 r31 P2) around the WHOLE batch — locks
// re-acquired fresh on 40P01.
async function runMoveBatch(classified, dateStr, reason) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction((trx) => moveBatchTrx(trx, classified, dateStr, reason));
    } catch (err) {
      if (!(err && err.code === '40P01' && attempt < 2)) throw err;
    }
  }
}

// The result for a batch the transaction aborted, or a rethrow of a real fault.
function moveBatchFailure(err) {
  if (err && err.code === 'PACKAGE_CHILD_PRESENT') return { error: err.message, code: 'package_visit_two_linked' };
  if (err && err.code === 'VISIT_FROZEN_MOVE_UNSUPPORTED' && err.reason === 'unreadable') throw err; // an outage stays a fault
  if (err && ['MOVE_SET_CHANGED', 'VISIT_EDIT_SCHEDULE_UNSUPPORTED', 'VISIT_FROZEN_MOVE_UNSUPPORTED'].includes(err.code)) {
    return {
      error: 'One of the approved stops changed (status, schedule, or grouped-visit state) while the move was pending — NOTHING was moved. Ask again for a fresh confirmation card.',
      preview_changed: true,
      code: 'preview_changed',
    };
  }
  throw err;
}

// Tech-facing notices (tech-visit-notifications.js): this writer changes
// scheduled_date itself, so it tells the holder itself. Post-commit,
// best-effort, NOT awaited; the operator's own move stays silent.
function notifyTechsOfMove(classified, dateStr, actionContext) {
  const { notifyVisitRescheduled } = require('../tech-visit-notifications');
  for (const c of classified.filter((item) => item.committedTechId)) {
    void notifyVisitRescheduled({
      visitId: c.s.id,
      technicianId: c.committedTechId,
      actorId: actionContext.technicianId || null,
      previous: { date: c.oldDate, windowStart: c.s.window_start, windowEnd: c.s.window_end },
      snapshot: { date: dateStr, windowStart: c.s.window_start, windowEnd: c.s.window_end },
    });
  }
}

// Rebooker-parity release of a moved live stop (job_status_history audit,
// tech_status release, tracker refresh) or, for a tracker rewind without a
// status change, cleanup only. Best-effort; true when it failed.
async function releaseMovedStop(c) {
  if (!c.wasLive && !c.trackRewound) return false;
  const { applyLiveMoveSideEffects, applyLiveMovePostCommitEffects } = require('../rebooker');
  try {
    if (c.wasLive) await applyLiveMoveSideEffects(db, c.s);
    else await applyLiveMovePostCommitEffects(c.s, { toStatus: c.s.status });
    return false;
  } catch (err) {
    logger.error(`[intelligence-bar:schedule] ${c.wasLive ? 'live-move' : 'track-rewind'} side effects failed for ${c.s.id}: ${err.message}`);
    return true;
  }
}

// The reschedule_log audit row, matching the rebooker's conventions. True
// when the append failed (the card discloses it — GH r19 P2).
async function auditMovedStop(c, dateStr, reason) {
  const s = c.s;
  const window = s.window_start ? `${s.window_start}-${s.window_end}` : null;
  try {
    await db('reschedule_log').insert({
      scheduled_service_id: s.id,
      customer_id: s.customer_id,
      original_date: c.oldDate,
      new_date: dateStr,
      reason_code: 'admin',
      initiated_by: 'admin_ib',
      original_window: window,
      new_window: window,
      notes: reason || null,
    });
    return false;
  } catch (err) {
    logger.error(`[intelligence-bar:schedule] reschedule_log insert failed for ${s.id}: ${err.message}`);
    return true;
  }
}

// Phase B: post-commit side effects per moved stop — best-effort; the batch
// is committed, so failures surface as warnings, never unwind it.
async function applyPostCommit(classified, dateStr, reason) {
  const lifecycleCleanupFailures = [];
  const auditFailures = [];
  for (const c of classified) {
    if (await releaseMovedStop(c)) lifecycleCleanupFailures.push(c.s.id);
    if (await auditMovedStop(c, dateStr, reason)) auditFailures.push(c.s.id);
  }
  return { lifecycleCleanupFailures, auditFailures };
}

// The opt-in reschedule text for one moved stop: { sent: true } or { reason }.
// Same shared path as update-details and the bulk reschedule (arrival-window
// copy, recipient routing, terminal/slot recheck, guarded reminder close/re-arm).
async function sendMoveNotice(s, { dateStr, notifyPhoneByCustomer }) {
  const start = s.window_start ? String(s.window_start).slice(0, 5) : null;
  if (!start) return { reason: 'No arrival time is set for this visit, so no reschedule text was sent' };
  const reminderRow = await db('appointment_reminders')
    .where({ scheduled_service_id: s.id })
    .first('suppressed_by_sibling')
    .catch(() => null);
  if (!reminderRow) return { reason: 'No reminder record for this visit — not texted' };
  // The destination slot's reminder owner carries this customer's messaging
  // and may not be part of this move — report it rather than let the operator
  // assume the customer was told (codex #3102 r3).
  if (reminderRow.suppressed_by_sibling) return { reason: 'Another visit that day carries this customer\'s reminders — no reschedule text was sent for this stop' };
  // Cover any already-due reminder window before our text so the 15-min cron
  // can't double-text in the send gap (sendRescheduleNoticeForVisit's contract).
  const sync = await require('../appointment-reminders').handleReschedule(s.id, `${dateStr}T${start}`, {
    sendNotification: false,
    coverDueWindows: true,
    // Stale-move guard (atomic in the service): the reminder rewrite misses if
    // a newer reschedule already landed a different slot on the row.
    expectSchedule: { date: dateStr, windowStart: start },
  });
  if (!sync || sync.skippedStale) {
    // skippedStale: a newer move won and owns the customer messaging. Falsy:
    // the guarded sync itself failed — a still-pending deferred confirmation
    // would follow our text as a duplicate. Either way: report, don't send.
    return {
      reason: sync && sync.skippedStale
        ? 'Appointment changed again before the text could be sent'
        : 'Reminder sync failed — not texted (automated reminders still cover the new time)',
    };
  }
  // The card-approved recipient phone rides to the sender's final recipient
  // read (GH r18 P1), even when null (GH r19 P1): a card that showed "no SMS
  // recipient" pins ABSENCE — a phone added after the confirm re-preview must
  // refuse at the sender, never text a number the operator did not see.
  const notice = await require('../../routes/admin-schedule').sendRescheduleNoticeForVisit(s.id, dateStr, start, {
    expectedPhone: notifyPhoneByCustomer.get(String(s.customer_id)) ?? null,
  });
  return notice.sent ? { sent: true } : { reason: notice.error || 'reschedule text was not sent' };
}

// Best-effort per stop: a send failure is reported, never unwinds the committed move.
async function textMovedStop(s, plan) {
  try {
    return await sendMoveNotice(s, plan);
  } catch (err) {
    logger.error(`[intelligence-bar:schedule] move notice failed for ${s.id}: ${err.message}`);
    return { reason: err.message };
  }
}

// Notification phase — runs only after EVERY approved stop has been moved,
// released, and audited, so one slow SMS provider can never delay or strand
// the rest of the confirmed batch. Activates a moved LEGACY outbound-review
// row regardless of the notify flag (Codex #3361 r3 P0), then, when asked,
// texts the customer LAST.
async function notifyMovedCustomers(plan, movedIds) {
  let textedCount = 0;
  const notificationFailures = [];
  for (const s of plan.movable.filter((stop) => movedIds.has(stop.id))) {
    try {
      await require('../outbound-review-confirm').activateLegacyOutboundReviewRowIfNeeded(db, s.id, 'ib-bulk-move');
    } catch { /* helper is internally best-effort; never strand the batch */ }
    if (!plan.notifyCustomers) continue;
    const outcome = await textMovedStop(s, plan);
    if (outcome.sent) textedCount++;
    else notificationFailures.push({ id: s.id, reason: outcome.reason });
  }
  return { textedCount, notificationFailures };
}

// Visit-group seam (codex #3590 r9): this writer moves dates directly (not via
// the rebooker), so it repairs grouped membership itself — a moved child
// leaves a visit that stays on the old date. Runs LAST (best-effort). A failed
// repair of a grouped moved stop surfaces as a warning (GH r18 P1).
async function repairMovedGroups(movedIds, movable) {
  let warning = null;
  for (const movedId of movedIds) {
    try {
      await require('../visit-groups').handleChildStopChanged(movedId);
    } catch (vgErr) {
      logger.warn(`[intelligence-bar:schedule] visit-group seam failed for moved ${movedId}: ${vgErr.message}`);
      if (movable.some((s) => movedIds.has(s.id) && s.visit_id)) {
        warning = 'Moved, but repairing grouped-visit membership failed — one or more grouped stops may still show the old visit; re-check the affected visits on the schedule.';
      }
    }
  }
  return warning;
}

// ONE `warning` key: the card renders body.result.warning only, so the
// overlap note, the texts-failed note and the rest must COMBINE.
function moveWarning(plan, run, movedCount) {
  const n = run.overlapMovedIds.length;
  const overlapNote = n
    ? `${slotOverlapWarning(plan.dateStr)} (${n} moved stop${n === 1 ? '' : 's'} overlap${n === 1 ? 's' : ''} an existing appointment)`
    : null;
  // Top-level partial-failure signal: /confirm-action reports success (the
  // moves DID commit), so a bare "Done" would imply every customer was texted.
  const failures = run.notificationFailures;
  const notifyNote = plan.notifyCustomers && failures.length
    ? `Moved ${movedCount} stop(s), but ${failures.length} customer(s) were not texted: ${failures.map((f) => f.reason).slice(0, 3).join('; ')}${failures.length > 3 ? '…' : ''}`
    : null;
  const lifecycleNote = run.lifecycleCleanupFailures.length
    ? `${run.lifecycleCleanupFailures.length} moved stop(s) committed but their technician/tracker release failed — check the tech pointer for those visits.`
    : null;
  const auditNote = run.auditFailures.length
    ? `${run.auditFailures.length} moved stop(s) are missing their reschedule audit entry (the moves stand; the history append failed).`
    : null;
  return [overlapNote, ...(run.routeWarnings || []), notifyNote, lifecycleNote, run.moveGroupWarning, auditNote].filter(Boolean).join(' ');
}

function moveResult(plan, run) {
  const movedStops = plan.stops.filter((st) => run.movedIds.has(st.id));
  logger.info(`[intelligence-bar:schedule] Moved ${movedStops.length} stops to ${plan.dateStr}`);
  const warning = moveWarning(plan, run, movedStops.length);
  return {
    success: true,
    moved_count: movedStops.length,
    new_date: plan.dateStr,
    stops: movedStops,
    ...(warning ? { warning } : {}),
    ...(run.overlapMovedIds.length ? { overlap_ids: run.overlapMovedIds } : {}),
    ...(plan.notifyCustomers ? { texted_count: run.textedCount, notification_failures: run.notificationFailures } : {}),
    ...plan.skipped,
  };
}

// The confirmed pass: classify, refuse a package visit 1 the card does not
// show, run the one transaction, then the post-commit phases in order.
async function commitMove(plan, actionContext) {
  const classified = classifyForCommit(plan.movable);
  // A package visit 1 with a live visit 2: the card lists only the stops, so
  // the bar does not move it (same rule as the single reschedule).
  if (await require('../package-followup-booking').hasLivePackageChild(db, classified.map((c) => c.s.id))) {
    return { error: 'One of these stops has a linked second treatment (a two-treatment package visit 2) that this card does not show. The bar can\'t move that stop from here yet. Nothing was moved.', code: 'package_visit_two_linked' };
  }
  let overlapMovedIds;
  try {
    overlapMovedIds = await runMoveBatch(classified, plan.dateStr, plan.reason);
  } catch (err) {
    return moveBatchFailure(err);
  }
  const movedIds = new Set(classified.map((c) => c.s.id));
  const routeWarnings = [...new Set(classified.flatMap((c) => c.routeWarnings || []))];
  notifyTechsOfMove(classified, plan.dateStr, actionContext);
  const post = await applyPostCommit(classified, plan.dateStr, plan.reason);
  const notices = await notifyMovedCustomers(plan, movedIds);
  const moveGroupWarning = await repairMovedGroups(movedIds, plan.movable);
  return moveResult(plan, { movedIds, overlapMovedIds, routeWarnings, moveGroupWarning, ...post, ...notices });
}

// The skipped lists that hold a stop, named as the card and the result show
// them: exactly what stays behind.
const nonEmptySkipLists = (lists) => Object.fromEntries(Object.entries(lists).filter(([, stops]) => stops.length));

// Move stops to another day: validate and plan (select, split by date, classify
// group state), answer the card, check the approved stops, then commit.
async function moveStopsToDay(input, actionContext = {}) {
  const plan = await planMove(input);
  if (plan.refusal) return plan.refusal;
  if (input.confirmed !== true) return moveProposal(plan);
  return approvedStopsDrift(input, plan) || commitMove(plan, actionContext);
}


async function swapTechAssignments(input, actionContext = {}) {
  const { date, tech_a_name: techAName, tech_b_name: techBName, confirmed } = input;
  const techA = await technicianByName(techAName);
  const techB = await technicianByName(techBName);
  if (techA && techA.ambiguous) return techA;
  if (techB && techB.ambiguous) return techB;
  if (!techA) return { error: `Tech "${techAName}" not found` };
  if (!techB) return { error: `Tech "${techBName}" not found` };

  // ADMIN-BUG-R56: the old exclusion list ['cancelled','completed','rescheduled']
  // omitted 'skipped' and 'no_show' — both terminal (proposal-pins.js
  // TERMINAL_APPOINTMENT_STATUSES) — so a no-show or skipped visit was
  // parked and re-pointed to the other tech, rewriting who performed it.
  const { TERMINAL_APPOINTMENT_STATUSES } = require('./proposal-pins');
  const NON_SWAPPABLE_STATUSES = [...TERMINAL_APPOINTMENT_STATUSES, 'rescheduled'];

  // Get both sets of services — read everything scheduled for each tech that
  // day, then split into swappable vs. terminal, so the terminal ones can be
  // disclosed on the card (Codex round 1 P1) instead of silently vanishing
  // from the swap set with no indication anything was left out.
  const [aAllRows, bAllRows] = await Promise.all([
    db('scheduled_services').where({ scheduled_date: date, technician_id: techA.id }),
    db('scheduled_services').where({ scheduled_date: date, technician_id: techB.id }),
  ]);
  const aServices = aAllRows.filter((s) => !NON_SWAPPABLE_STATUSES.includes(String(s.status)));
  const bServices = bAllRows.filter((s) => !NON_SWAPPABLE_STATUSES.includes(String(s.status)));
  const skippedTerminalRows = [...aAllRows, ...bAllRows]
    .filter((s) => TERMINAL_APPOINTMENT_STATUSES.includes(String(s.status)));
  // Named like assign_technician's exclusions (Codex round 3 P1): the card
  // lists WHICH stops stay behind (customer + id + status), not just how
  // many. The raw tech-day rows carry no customer name, so look the few
  // skipped ones up by id — only when there is something to disclose.
  const skippedCustomerName = new Map();
  if (skippedTerminalRows.length) {
    const custIds = [...new Set(skippedTerminalRows.map((s) => s.customer_id).filter(Boolean))];
    const custRows = custIds.length
      ? await db('customers').whereIn('id', custIds).select('id', 'first_name', 'last_name')
      : [];
    for (const c of custRows || []) {
      skippedCustomerName.set(String(c.id), `${c.first_name || ''} ${c.last_name || ''}`.trim());
    }
  }
  const skippedTerminal = skippedTerminalRows
    .map((s) => ({ id: s.id, status: s.status, customer: skippedCustomerName.get(String(s.customer_id)) || '' }));

  if (confirmed !== true) {
    return {
      proposal: true,
      date,
      swap: {
        [techA.name]: { current_count: aServices.length, after_swap: bServices.length },
        [techB.name]: { current_count: bServices.length, after_swap: aServices.length },
      },
      // The exact stop sets being exchanged — counts alone can't pin the
      // effect (one stop leaving and another joining each side keeps the
      // counts equal). Ids + service/window let the confirm card and its
      // fingerprint bind the actual targets (W0B).
      stops: {
        // grouped_visit_id rides too (GH r16 P1): the post-commit seam can
        // adopt the new tech for a grouped visit or detach the child —
        // membership must bind the fingerprint and the card's disclosure.
        [techA.name]: aServices.map((s) => ({ id: s.id, service_type: s.service_type, time_window: s.time_window || null, ...(s.visit_id ? { grouped_visit_id: String(s.visit_id) } : {}) })),
        [techB.name]: bServices.map((s) => ({ id: s.id, service_type: s.service_type, time_window: s.time_window || null, ...(s.visit_id ? { grouped_visit_id: String(s.visit_id) } : {}) })),
      },
      ...(skippedTerminal.length ? { skipped_terminal: skippedTerminal } : {}),
      note: `Would swap ${aServices.length} stop(s) from ${techA.name} with ${bServices.length} stop(s) from ${techB.name}.`
        + (skippedTerminal.length ? ` ${skippedTerminal.length} stop(s) are in a terminal status (completed/cancelled/skipped/no_show) and will NOT be swapped.` : '')
        + ' Re-call with confirmed:true to apply.',
    };
  }

  // Swap assignments atomically. Park A's services on NULL (allowed — the FK
  // is nullable for unassigned stops), then redirect B's to A and the parked
  // A-set to B. Earlier code parked on a hard-coded UUID, which violated the
  // technician_id FK if the swap ever ran.
  // The stop sets the operator approved: the route's verified re-preview
  // (`_verified_stops`, W0B) when this is a card confirm, else this call's
  // own pre-lock read. Reloaded and compared UNDER the tech-day locks so a
  // concurrent move between read and lock can't swap an unseen set.
  const sameSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  // Membership key = id + grouped-visit id (GH r16 P1): a stop that joined,
  // left, or switched grouped visits during the pending window must refuse —
  // the seam's adopt/detach on it was never disclosed. Handles both shapes:
  // verified preview stops carry grouped_visit_id, fresh rows carry visit_id.
  const memberKey = (s) => `${s.id}:${s.grouped_visit_id ? String(s.grouped_visit_id) : (s.visit_id ? String(s.visit_id) : '')}`;
  const expectedA = (input._verified_stops?.[techA.name] || aServices).map(memberKey);
  const expectedB = (input._verified_stops?.[techB.name] || bServices).map(memberKey);
  let aIds = [];
  let bIds = [];
  const liveStops = async (trx, techId) => trx('scheduled_services')
    .where({ scheduled_date: date, technician_id: techId })
    // NULL-safe, like assign_technician's UPDATE fence (Codex round 3 P2):
    // status is nullable and `NULL NOT IN (...)` is never true, so a bare
    // whereNotIn would drop a legacy null-status row the client-side split
    // above kept as swappable — the membership check would then read
    // preview_changed on every retry.
    .where((q) => q.whereNull('status').orWhereNotIn('status', NON_SWAPPABLE_STATUSES))
    .forUpdate()
    .select('id', 'visit_id');
  let committedSwapRows = [];
  try {
    await db.transaction(async trx => {
      // Tech-day fence before any membership write — both real tech-days plus
      // the transient 'unassigned' day the A-set parks on (see
      // tech-day-lock.js; keys must match the other holders').
      const { lockTechDays } = require('../scheduling/tech-day-lock');
      await lockTechDays(trx, [
        { techId: techA.id, date },
        { techId: techB.id, date },
        { techId: null, date },
      ]);
      const [liveA, liveB] = [await liveStops(trx, techA.id), await liveStops(trx, techB.id)];
      if (!sameSet(liveA.map(memberKey), expectedA) || !sameSet(liveB.map(memberKey), expectedB)) {
        const err = new Error('swap_set_changed');
        err.previewChanged = true;
        throw err;
      }
      aIds = liveA.map((r) => r.id);
      bIds = liveB.map((r) => r.id);
    // route_order: null on both real reassignments — each stop's sequence
    // number belonged to its OLD tech's run; carrying it into the new tech's
    // day would interleave stale numbers (consumers append NULLs last).
      // Only a tech RECEIVING stops must be assignable: swapping an offboarded
      // tech's remaining route onto an eligible one is exactly how their
      // retained future work gets reassigned.
      if (bIds.length) await assertAssignableTechnician(techA.id, { conn: trx, date });
      if (aIds.length) await assertAssignableTechnician(techB.id, { conn: trx, date });
      if (aIds.length) await trx('scheduled_services').whereIn('id', aIds).update({ technician_id: null, updated_at: new Date() });
      // The COMMITTED schedule of every swapped row rides back for the
      // notices (pre-push audit P1): a same-day window edit landing between
      // the card's read and these locks must not put the old window on the
      // receiving tech's card.
      const swapReturning = ['id', 'scheduled_date', 'window_start', 'window_end'];
      if (bIds.length) committedSwapRows.push(...await trx('scheduled_services').whereIn('id', bIds).update({ technician_id: techA.id, route_order: null, updated_at: new Date() }).returning(swapReturning));
      if (aIds.length) committedSwapRows.push(...await trx('scheduled_services').whereIn('id', aIds).update({ technician_id: techB.id, route_order: null, updated_at: new Date() }).returning(swapReturning));
    });
  } catch (err) {
    if (err && err.previewChanged) {
      return { error: 'The stops on one of these days changed after the card was shown — nothing was swapped. Ask again for a fresh card.', preview_changed: true };
    }
    throw err;
  }

  // Tech-facing notices (tech-visit-notifications.js): a swap is two
  // reassignments per stop; both techs hear each one. Post-commit,
  // best-effort and NOT awaited (push delivery stays off the response
  // path); the operator's own swap stays silent for them.
  {
    const { notifyAssignmentChange } = require('../tech-visit-notifications');
    const swapActor = actionContext.technicianId || null;
    const swapRows = new Map(committedSwapRows.map((r) => [String(r.id), r]));
    const swapSnapshot = (sid) => {
      const r = swapRows.get(String(sid));
      return r ? { date: r.scheduled_date, windowStart: r.window_start || null, windowEnd: r.window_end || null } : null;
    };
    for (const sid of aIds) void notifyAssignmentChange({ visitId: sid, fromTechId: techA.id, toTechId: techB.id, actorId: swapActor, snapshot: swapSnapshot(sid) });
    for (const sid of bIds) void notifyAssignmentChange({ visitId: sid, fromTechId: techB.id, toTechId: techA.id, actorId: swapActor, snapshot: swapSnapshot(sid) });
  }

  // Visit-group seam (codex #3590 r9): a whole-day swap moves every child
  // but not service_visits.technician_id — run the repair per row so each
  // grouped visit either adopts the new tech (all members moved together)
  // or detaches the divergent child. Post-commit, best-effort.
  let swapGroupWarning = null;
  try {
    const { handleChildStopChanged } = require('../visit-groups');
    for (const sid of [...aIds, ...bIds]) await handleChildStopChanged(sid);
  } catch (vgErr) {
    logger.warn(`[intelligence-bar:schedule] visit-group seam failed after swap: ${vgErr.message}`);
    // The card disclosed the grouped-visit adoption/detach for grouped
    // stops — a failed repair must surface, never a bare Done (GH r16 P1).
    if ([...aServices, ...bServices].some((s) => s.visit_id)) {
      swapGroupWarning = 'Swapped, but repairing grouped-visit membership failed — one or more grouped stops may still show the old visit assignment; re-check the affected visits on the schedule.';
    }
  }

  return {
    success: true,
    date,
    swapped: {
      [techA.name]: { was: aServices.length, now: bServices.length },
      [techB.name]: { was: bServices.length, now: aServices.length },
    },
    ...(skippedTerminal.length ? { skipped_terminal: skippedTerminal } : {}),
    ...(swapGroupWarning ? { warning: swapGroupWarning } : {}),
  };
}


// The measurement result is shared with the route-performance ledger, which
// needs every planned stop's id. The Intelligence Bar does not: inside a
// task about one customer the other stops on the route are other customers'
// appointments, so their ids and arrival windows are reduced to counts, the
// diagnostic id lists (missing coordinates, default durations) become
// counts, and the late-visit rows lose their ids before the model sees them.
function withoutStopIdentifiers(result) {
  if (!Array.isArray(result?.days)) return result;
  const count = list => (Array.isArray(list) ? list.length : null);
  return { ...result, days: result.days.map(day => ({ ...day, byTech: (day.byTech || []).map(({ plannedStops, modeledLateVisits, missingCoordinates, defaultDurations, doubleBookedVisits, ...tech }) => ({
    ...tech,
    plannedStopCount: count(plannedStops),
    // Each pair lists other customers' appointment ids: keep only how many
    // collisions there are (the count the alert card shows).
    doubleBookingCount: Array.isArray(doubleBookedVisits) ? doubleBookedVisits.length : null,
    missingCoordinateCount: count(missingCoordinates),
    defaultDurationCount: count(defaultDurations),
    modeledLateVisits: Array.isArray(modeledLateVisits) ? modeledLateVisits.map(({ id, visitId, ...late }) => late) : modeledLateVisits,
  })) })) };
}

async function findScheduleGaps(input) {
  if (require('../../config/feature-gates').gateEnvValue('GATE_SCHEDULE_QUALITY_MEASUREMENTS')) {
    return withoutStopIdentifiers(await require('../scheduling/day-quality').getScheduleQualityMeasurements(input, db));
  }
  const { date, date_from, date_to, service_type } = input;
  const MAX_STOPS_PER_DAY = 10;

  const from = date || date_from || etDateString();
  const to = date || date_to || etDateString(addETDays(new Date(), 6));

  // Capacity = assignable staff only (technician-eligibility.js); an
  // office-only admin has no route to have gaps in.
  const techs = await applyAssignable(db('technicians')).select('technicians.id', 'technicians.name');

  const services = await db('scheduled_services')
    .whereBetween('scheduled_date', [from, to])
    .whereNotIn('status', ['cancelled', 'rescheduled'])
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select('scheduled_services.scheduled_date', 'scheduled_services.technician_id', 'scheduled_services.service_type', 'customers.city');

  // Build day-by-tech matrix
  const days = [];
  let d = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  while (d <= end) {
    // Every day of week — Waves works weekends. Which days are actually
    // offered to customers is governed by the owner-editable weekly days-off
    // setting (scheduling/blackout-dates.js), not a hardcoded skip here.
    const dateStr = d.toISOString().split('T')[0];
    const dayName = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    const dayServices = services.filter(s => s.scheduled_date === dateStr || (s.scheduled_date && s.scheduled_date.toISOString && s.scheduled_date.toISOString().split('T')[0] === dateStr));

    const techSlots = techs.map(t => {
      const techServices = dayServices.filter(s => s.technician_id === t.id);
      const zones = {};
      techServices.forEach(s => { const z = getZone(s.city); zones[z] = (zones[z] || 0) + 1; });
      return {
        tech: t.name,
        scheduled: techServices.length,
        capacity: MAX_STOPS_PER_DAY,
        available: Math.max(0, MAX_STOPS_PER_DAY - techServices.length),
        zones,
      };
    });

    const unassignedCount = dayServices.filter(s => !s.technician_id).length;

    days.push({
      date: dateStr,
      day: dayName,
      total_scheduled: dayServices.length,
      total_available: techSlots.reduce((s, t) => s + t.available, 0),
      unassigned: unassignedCount,
      by_tech: techSlots,
    });
    d.setDate(d.getDate() + 1);
  }

  return {
    range: { from, to },
    max_per_tech_per_day: MAX_STOPS_PER_DAY,
    days,
    best_day: days.reduce((best, d) => d.total_available > (best?.total_available || 0) ? d : best, null),
  };
}


async function getDaySummary(date) {
  const services = await db('scheduled_services')
    .where({ 'scheduled_services.scheduled_date': date })
    .whereNotIn('scheduled_services.status', ['cancelled', 'rescheduled'])
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
    .select(
      'scheduled_services.*',
      'customers.first_name', 'customers.last_name', 'customers.city',
      'customers.waveguard_tier', 'customers.phone',
      'technicians.name as tech_name',
    );

  const byTech = {};
  const unassigned = [];
  const byZone = {};
  let completed = 0;
  let estRevenue = 0;

  services.forEach(s => {
    const zone = getZone(s.city);
    byZone[zone] = (byZone[zone] || 0) + 1;

    if (s.status === 'completed') completed++;
    estRevenue += (parseFloat(s.estimated_price) || 125);

    if (!s.tech_name) {
      unassigned.push({
        id: s.id,
        customer: `${s.first_name} ${s.last_name}`,
        city: s.city,
        service_type: s.service_type,
      });
      return;
    }

    if (!byTech[s.tech_name]) byTech[s.tech_name] = { services: [], completed: 0, zones: {} };
    byTech[s.tech_name].services.push({
      id: s.id,
      customer: `${s.first_name} ${s.last_name}`,
      city: s.city,
      service_type: s.service_type,
      status: s.status,
      tier: s.waveguard_tier,
      time_window: s.window_start || null,
      route_order: s.route_order,
    });
    if (s.status === 'completed') byTech[s.tech_name].completed++;
    byTech[s.tech_name].zones[zone] = (byTech[s.tech_name].zones[zone] || 0) + 1;
  });

  const techSummaries = Object.entries(byTech).map(([name, data]) => ({
    name,
    total: data.services.length,
    completed: data.completed,
    remaining: data.services.length - data.completed,
    zones: data.zones,
    services: data.services.sort((a, b) => (a.route_order || 999) - (b.route_order || 999)),
  }));

  // Check for new customers (no prior service)
  const newCustomerChecks = await Promise.all(
    services.map(async s => {
      const prior = await db('service_records').where({ customer_id: s.customer_id, status: 'completed' }).count('* as count').first();
      return { id: s.id, isNew: parseInt(prior.count) === 0 };
    })
  );
  const newCustomerIds = new Set(newCustomerChecks.filter(c => c.isNew).map(c => c.id));

  return {
    date,
    total_services: services.length,
    completed,
    remaining: services.length - completed,
    estimated_revenue: estRevenue,
    unassigned,
    unassigned_count: unassigned.length,
    new_customer_count: newCustomerIds.size,
    by_zone: byZone,
    by_tech: techSummaries,
  };
}


async function getZoneDensity(date) {
  const services = await db('scheduled_services')
    .where({ 'scheduled_services.scheduled_date': date })
    .whereNotIn('scheduled_services.status', ['cancelled', 'rescheduled'])
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
    .select(
      'scheduled_services.id', 'scheduled_services.service_type',
      'customers.first_name', 'customers.last_name', 'customers.city',
      'technicians.name as tech_name',
    );

  const zones = {};
  services.forEach(s => {
    const zone = getZone(s.city);
    if (!zones[zone]) zones[zone] = { stops: [], techs: new Set() };
    zones[zone].stops.push({
      id: s.id,
      customer: `${s.first_name} ${s.last_name}`,
      service_type: s.service_type,
      tech: s.tech_name || 'Unassigned',
    });
    if (s.tech_name) zones[zone].techs.add(s.tech_name);
  });

  const analysis = Object.entries(zones).map(([zone, data]) => ({
    zone,
    stop_count: data.stops.length,
    techs_assigned: [...data.techs],
    tech_count: data.techs.size,
    stops: data.stops,
    consolidation_opportunity: data.techs.size > 1 && data.stops.length >= 3,
  })).sort((a, b) => b.stop_count - a.stop_count);

  return {
    date,
    zones: analysis,
    consolidation_candidates: analysis.filter(z => z.consolidation_opportunity),
  };
}


async function findAvailableSlotsTool(input, actionContext) {
  const { findAvailableSlots } = require('../scheduling/find-time');
  let { customer_id, address, lat, lng, service_name, duration_minutes, date_from, date_to, technician_name, top_n } = input;

  // Resolve customer → lat/lng if provided. An explicit address is the
  // destination: it is geocoded below rather than replaced by the customer's
  // primary coordinates, so a search for a customer's other property is
  // run around that property.
  if (customer_id && !address && (!lat || !lng)) {
    const c = await db('customers').where('id', customer_id).select('latitude', 'longitude', 'address_line1', 'city', 'state', 'zip').first();
    if (c?.latitude && c?.longitude) { lat = parseFloat(c.latitude); lng = parseFloat(c.longitude); }
    else if (c) address = [c.address_line1, c.city, c.state, c.zip].filter(Boolean).join(', ');
  }

  // Geocode if still needed
  if ((!lat || !lng) && address) {
    const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
    if (!key) return { error: 'No Google Maps API key configured for geocoding' };
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== 'OK' || !data.results?.length) return { error: `Geocode failed: ${data.status}` };
    lat = data.results[0].geometry.location.lat;
    lng = data.results[0].geometry.location.lng;
  }

  if (!lat || !lng) return { error: 'Need a customer_id, address, or lat/lng to find slots' };

  let technician_id;
  if (technician_name) {
    const tech = await technicianByName(technician_name);
    if (!tech) return { error: `Technician "${technician_name}" not found` };
    if (tech.ambiguous) return tech;
    technician_id = tech.id;
  }

  // The visit length comes from the catalog when the operator named a
  // service: a model-guessed length on a packed day silently hides slots.
  const length = await resolveVisitLength(service_name, duration_minutes);
  if (length.error) return length;
  const { service, serviceType, durationMinutes, durationSource } = length;

  const today = etDateString();
  const weekOut = etDateString(addETDays(new Date(), 7));
  const dateFrom = date_from || today;
  const dateTo = date_to || weekOut;

  // GATE_ROUTE_CHECK_STAFF_LISTS (owner 2026-10-29): the new stop is checked
  // by the dispatcher's arrival-window route check instead of the gap search.
  // Only an admin caller's search may buy Google road times (the acting
  // user's technician id is the spender); anyone else stays on the estimate.
  // Needs the stop's coordinates; without them the old search runs.
  const rankedDays = require('../scheduling/route-ranked-days');
  const routeCheck = rankedDays.newStopRouteOptions({ lat, lng, durationMinutes, caller: actionContext });

  let result = await findAvailableSlots({
    // Staff tool: tech start points apply (GATE_TECH_START_POINTS).
    techStartPoints: true,
    lat, lng,
    durationMinutes,
    serviceType,
    dateFrom,
    dateTo,
    technicianId: technician_id,
    ...routeCheck,
    // Every feasible slot comes back, so each day's count is real; the
    // operator's top N is cut in describeSlotSearch.
    topN: SLOT_SEARCH_ALL,
    // Waves works weekends — without this, find-time's legacy default
    // silently dropped every Sunday from staff slot suggestions. Day-off
    // policy lives in the weekly days-off setting, and staff surfaces are
    // deliberately unblocked anyway (matching admin-schedule-find-time.js),
    // so blackout/weekly-days-off dates stay visible here too.
    includeWeekends: true,
    includeBlackoutDates: true,
  });
  if (result.error) return result;
  result = rankedDays.withSearchedDays(result, routeCheck, dateFrom, dateTo);
  return describeSlotSearch(result, {
    dateFrom, dateTo, today, durationMinutes, durationSource, service, technicianId: technician_id,
    topN: top_n || 10,
  });
}

// Large enough to return every feasible slot in a staff search window.
const SLOT_SEARCH_ALL = 5000;

// Weekday + month label for a YYYY-MM-DD calendar date ("Wed Oct 28"). The
// date is a calendar day, so it is read at UTC noon and never shifts.
function slotDayLabel(date) {
  const d = new Date(`${String(date).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
}

// Visit length for a slot search. A named service takes its catalog
// length: exact name / short name / key, else a single partial match; several
// matches (a shared short name included) refuse with the choices so the
// model picks one. With no service, a stated length, else 60 minutes.
async function resolveVisitLength(serviceName, statedMinutes) {
  const wanted = String(serviceName || '').trim().toLowerCase();
  if (!wanted) {
    const stated = Math.round(Number(statedMinutes)) || 0;
    return { service: null, serviceType: undefined, durationMinutes: stated > 0 ? stated : 60, durationSource: stated > 0 ? 'operator' : 'default' };
  }
  const { serviceDurationMinutes } = require('../service-library');
  const rows = await db('services').where({ is_active: true })
    .select('id', 'service_key', 'name', 'short_name', 'default_duration_minutes', 'scheduling_duration_policy');
  const namesOf = (row) => [row.name, row.short_name, row.service_key].map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
  const exact = rows.filter((row) => namesOf(row).includes(wanted));
  const matches = exact.length ? exact : rows.filter((row) => namesOf(row).some((v) => v.includes(wanted) || wanted.includes(v)));
  const choice = (row) => ({ name: row.name, duration_minutes: serviceDurationMinutes(row, 60) });
  if (matches.length === 1) {
    const { name, duration_minutes } = choice(matches[0]);
    return { service: { name, service_key: matches[0].service_key }, serviceType: name, durationMinutes: duration_minutes, durationSource: 'catalog' };
  }
  if (!matches.length) {
    return { error: `No active catalog service matches "${serviceName}". Ask the operator which service, or pass duration_minutes they state.`, code: 'service_not_found' };
  }
  return {
    error: `"${serviceName}" matches several catalog services. Call again with one exact service_name.`,
    code: 'service_ambiguous',
    choices: matches.slice(0, 8).map(choice),
  };
}

// What the search really used, a weekday label on every slot, and one row
// per searched day — stop count and, when that day has no slot, why — so a
// thin answer explains itself instead of reading as "nothing feasible".
async function describeSlotSearch(result, { dateFrom, dateTo, today, durationMinutes, durationSource, service, technicianId, topN }) {
  const allSlots = result.slots || [];
  const slotCount = new Map();
  for (const slot of allSlots) slotCount.set(slot.date, (slotCount.get(slot.date) || 0) + 1);
  const slots = allSlots.slice(0, topN).map((slot, i) => ({ ...slot, rank: i + 1, day_label: slotDayLabel(slot.date) }));
  const searchedDates = result.searched_dates || [];
  const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
  const { dateOnlyString } = require('../../utils/datetime-et');
  // The technician names and per-day stop counts only explain the answer: a
  // failed read keeps the slots and leaves them unknown (null), never zero.
  let techs = [];
  let byDay = null;
  try {
    let techQuery = applyAssignable(db('technicians'));
    if (technicianId) techQuery = techQuery.where('technicians.id', technicianId);
    techs = await techQuery.select('technicians.id', 'technicians.name');
    // Same occupancy rule as the engine: an expired slot hold is not a stop.
    const dayRows = await db('scheduled_services')
      .whereBetween('scheduled_date', [dateFrom, dateTo])
      // Unassigned bookings and holds block every technician's route in the
      // engine (arrival-route fixed blockers), so they count here too.
      .where((q) => q.whereIn('technician_id', techs.map((tech) => tech.id)).orWhereNull('technician_id'))
      .whereNotIn('status', NOT_A_ROUTE_STOP_STATUSES)
      .where((q) => q.whereNull('reservation_expires_at').orWhereRaw('reservation_expires_at > NOW()'))
      .groupBy('scheduled_date')
      .select('scheduled_date', db.raw('count(*)::int as stops'), db.raw('count(*) filter (where technician_id is null)::int as unassigned'),
        db.raw('left(min(window_start)::text, 5) as first_start'), db.raw('left(max(window_end)::text, 5) as last_end'));
    byDay = new Map(dayRows.map((row) => [dateOnlyString(row.scheduled_date), row]));
  } catch (err) {
    logger.warn(`[intelligence-bar:schedule] slot-search day counts failed: ${err.message}`);
  }
  const rejectionsByDate = result.rejections_by_date || {};
  const days = searchedDates.map((date) => {
    const day = byDay?.get(date);
    const feasible = slotCount.get(date) || 0;
    const row = { date, day_label: slotDayLabel(date), stops_booked: byDay ? Number(day?.stops || 0) : null,
      unassigned_stops: byDay ? Number(day?.unassigned || 0) : null,
      first_start: day?.first_start || null, last_end: day?.last_end || null, feasible_slots: feasible };
    if (feasible) return row;
    // Only the engine's own rejection counts are a reason; without them (the
    // legacy path keeps none) the row says so instead of inventing one.
    const rejections = Object.entries(rejectionsByDate[date] || {});
    row.no_slot_reason = rejections.length
      ? `No ${durationMinutes}-minute visit fits: ${rejections.map(([why, n]) => `${why} x${n}`).join(', ')}`
      : `No ${durationMinutes}-minute visit fits; the search gave no rejection reason for this day. Report the booked stops above as facts, not as the proven cause.`;
    return row;
  });
  return {
    ...result,
    slots,
    today: { date: today, day_label: slotDayLabel(today) },
    searched: {
      date_from: dateFrom, date_to: dateTo,
      date_from_label: slotDayLabel(dateFrom), date_to_label: slotDayLabel(dateTo),
      duration_minutes: durationMinutes, duration_source: durationSource,
      service: service ? service.name : null,
      technicians: techs.map((tech) => tech.name),
    },
    days,
  };
}


async function cancelAndRescheduleFarOut(input) {
  const { days_threshold = 30, service_type, reschedule_to_range } = input;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days_threshold);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  let query = db('scheduled_services')
    .where('scheduled_date', '>', cutoffStr)
    .whereNotIn('status', ['cancelled', 'completed', 'rescheduled'])
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.id', 'scheduled_services.scheduled_date',
      'scheduled_services.service_type', 'scheduled_services.customer_id',
      'customers.first_name', 'customers.last_name', 'customers.city',
    );

  if (service_type) {
    query = query.whereILike('scheduled_services.service_type', `%${service_type}%`);
  }

  const farOut = await query.orderBy('scheduled_services.scheduled_date', 'asc');

  // Don't execute — return proposal for confirmation
  return {
    proposal: true,
    message: `Found ${farOut.length} appointments scheduled more than ${days_threshold} days from today. These would be cancelled and rescheduled sooner.`,
    threshold_date: cutoffStr,
    appointments: farOut.map(a => ({
      id: a.id,
      customer_id: a.customer_id,
      customer: `${a.first_name} ${a.last_name}`,
      city: a.city,
      service_type: a.service_type,
      current_date: a.scheduled_date,
    })),
    total: farOut.length,
    note: 'Say "yes, do it" to execute or specify which ones to move.',
  };
}


module.exports = { SCHEDULE_TOOLS, executeScheduleTool, _private: { allSkippedRefusal } };
