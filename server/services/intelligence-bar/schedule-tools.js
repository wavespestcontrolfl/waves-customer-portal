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
const logger = require('../logger');
const { assertAssignableTechnician, applyAssignable } = require('../technician-eligibility');
const { scheduledServiceTrackTokenExpiry } = require('../track-token-expiry');
const { etDateString, addETDays, validScheduleDate, sameDayWindowElapsed } = require('../../utils/datetime-et');
const { dayStopsQuery, guardedCoordSelects } = require('../scheduling/day-stops');
const { probeSlotOverlap, slotOverlapWarning } = require('../scheduling/window-rules');

const SCHEDULE_TOOLS = [
  {
    name: 'switch_appointment_property',
    description: 'Change only this scheduled visit (including its grouped service lines) to an active saved property on the same customer. Use get_customer_detail to resolve the property ID first. Preserves the primary customer address and future recurring visits. En-route visits are allowed; external navigation may need manual refresh. Call once to prepare the confirmation card; never ask permission to prepare it. Recurrence templates require the Dispatch editor.',
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
    description: `Find open capacity/gaps in the schedule for a date or date range. Shows which techs have room for more stops, and which zones are underserved. Useful for "any room on Tuesday?" or "where can I fit 3 more pest stops this week?"`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD single day' },
        date_from: { type: 'string', description: 'Start of range' },
        date_to: { type: 'string', description: 'End of range' },
        service_type: { type: 'string', description: 'Optional: filter capacity for a specific service type' },
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
Use for: "find time for", "when can we schedule", "best slot for", "fit in a new job".`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Existing customer UUID (preferred when available)' },
        address: { type: 'string', description: 'Full street address to geocode (e.g. "123 Oak St, Bradenton FL 34202")' },
        lat: { type: 'number', description: 'Latitude if already known' },
        lng: { type: 'number', description: 'Longitude if already known' },
        duration_minutes: { type: 'number', description: 'How long the service takes (default 60)' },
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
      case 'find_available_slots': return await findAvailableSlotsTool(input);
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
    throw new Error('This appointment is also the recurring plan template. Use the Dispatch address editor to review the recurring-plan effects.');
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
    const { emitDispatchJobUpdate } = require('../dispatch-assignment');
    const broadcasts = await Promise.allSettled(result.updated_service_ids.map(jobId =>
      emitDispatchJobUpdate({ jobId, actorId: actionContext.technicianId })));
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
async function applyApprovedRouteOrder({ date, approvedIds, services, lockKeys, expectTechFor, loadEligibleIds }) {
  const byId = new Map(services.map((s) => [String(s.id), s]));
  if (approvedIds.some((id) => !byId.has(id))) {
    return { error: "The day's stops changed after the card was shown — nothing was reordered. Ask again for a fresh card.", preview_changed: true };
  }
  const { lockTechDays } = require('../scheduling/tech-day-lock');
  try {
    await db.transaction(async (trx) => {
      await lockTechDays(trx, lockKeys);
      // Newly ADDED stops refuse too (pre-push r15 P1): the approved plan
      // covers the complete eligible set the card showed — a geocoded stop
      // added since the confirm preflight would sit ungoverned beside (or
      // collide with) the approved 1..N sequence, so the eligible set must
      // match the approved set exactly under the locks.
      const eligible = (await loadEligibleIds(trx)).map(String);
      const approvedSet = new Set(approvedIds);
      if (eligible.length !== approvedIds.length || eligible.some((id) => !approvedSet.has(id))) {
        throw Object.assign(new Error('stop set changed'), { code: 'STALE_OPTIMIZE_SET' });
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
  logger.info(`[intelligence-bar:schedule] Applied approved route order for ${date}: ${approvedIds.length} stops`);
  return {
    success: true,
    date,
    total_stops: approvedIds.length,
    source: 'approved_plan',
    note: 'Applied the stop order approved on the card (not re-optimized at commit).',
  };
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
      ...guardedCoordSelects(db),
    ],
  });

  if (!services.length) return { message: 'No services found for this date', date };

  const stopsWithCoords = services.filter(s => s.lat && s.lng);
  if (stopsWithCoords.length < 2) return { message: 'Need at least 2 geocoded stops to optimize', geocoded: stopsWithCoords.length, total: services.length };

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
      loadEligibleIds: async (trx) => (await dayStopsQuery(trx, {
        dateStr: date,
        excludeStatuses: ['cancelled', 'completed', 'rescheduled'],
        select: ['scheduled_services.id', ...guardedCoordSelects(trx)],
      })).filter((s) => s.lat && s.lng).map((s) => s.id),
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

  const savedMiles = Math.max(0, Math.round((result.unoptimizedDistanceMeters - result.totalDistanceMeters) / 1609.34));
  const savedPct = result.unoptimizedDistanceMeters > 0
    ? Math.round(((result.unoptimizedDistanceMeters - result.totalDistanceMeters) / result.unoptimizedDistanceMeters) * 100)
    : 0;

  const summary = {
    date,
    total_stops: stopsWithCoords.length,
    total_miles_before: Math.round(result.unoptimizedDistanceMeters / 1609.34),
    total_miles_after: Math.round(result.totalDistanceMeters / 1609.34),
    miles_saved: savedMiles,
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
      note: `Would reorder ${stopsWithCoords.length} stops, saving ~${savedMiles} miles. Re-call with confirmed:true to apply.`,
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


async function optimizeTechRoute(input) {
  const { date, technician_name: techName, confirmed } = input;
  const tech = await db('technicians').whereILike('name', `%${techName}%`).first();
  if (!tech) return { error: `Technician "${techName}" not found` };

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
      ...guardedCoordSelects(db),
    ],
  });

  if (services.length < 2) return { message: `${tech.name} has ${services.length} stop(s) — nothing to optimize`, tech: tech.name };

  const stopsWithCoords = services.filter(s => s.lat && s.lng);
  if (stopsWithCoords.length < 2) return { message: 'Need at least 2 geocoded stops', geocoded: stopsWithCoords.length };

  // Approved-plan application — same contract as optimize_all_routes above
  // (GH r14 P1).
  if (confirmed === true && Array.isArray(input._verified_ordered_stops) && input._verified_ordered_stops.length) {
    const applied = await applyApprovedRouteOrder({
      date,
      approvedIds: input._verified_ordered_stops.map(String),
      services,
      lockKeys: [{ techId: tech.id, date }],
      expectTechFor: () => tech.id,
      loadEligibleIds: async (trx) => (await dayStopsQuery(trx, {
        dateStr: date,
        technicianId: tech.id,
        excludeStatuses: ['cancelled', 'completed', 'rescheduled'],
        select: ['scheduled_services.id', ...guardedCoordSelects(trx)],
      })).filter((s) => s.lat && s.lng).map((s) => s.id),
    });
    return applied.success ? { ...applied, tech: tech.name } : applied;
  }

  const result = await RouteOptimizer.optimizeRoute(
    stopsWithCoords.map(s => ({
      id: s.id, lat: parseFloat(s.lat), lng: parseFloat(s.lng),
      customerName: `${s.first_name} ${s.last_name}`, serviceType: s.service_type,
    })),
    { startLat: RouteOptimizer.HQ.lat, startLng: RouteOptimizer.HQ.lng, endAtStart: true },
  );

  const savedMiles = Math.max(0, Math.round((result.unoptimizedDistanceMeters - result.totalDistanceMeters) / 1609.34));

  const summary = {
    tech: tech.name,
    date,
    stops: stopsWithCoords.length,
    miles_before: Math.round(result.unoptimizedDistanceMeters / 1609.34),
    miles_after: Math.round(result.totalDistanceMeters / 1609.34),
    miles_saved: savedMiles,
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
      note: `Would reorder ${tech.name}'s ${stopsWithCoords.length} stops, saving ~${savedMiles} miles. Re-call with confirmed:true to apply.`,
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


async function assignTechnician(input, actionContext = {}) {
  const { service_ids: serviceIds, technician_name: techName, confirmed } = input;
  let tech = await db('technicians').whereILike('name', `%${techName}%`).first();
  if (!tech) return { error: `Technician "${techName}" not found` };

  const services = await db('scheduled_services')
    .whereIn('scheduled_services.id', serviceIds)
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .leftJoin('technicians as cur_tech', 'scheduled_services.technician_id', 'cur_tech.id')
    .select(
      'scheduled_services.id',
      'customers.first_name', 'customers.last_name',
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

  if (!services.length) return { error: 'No services found for the given IDs' };

  const stops = services.map(s => ({
    id: s.id,
    customer: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
    service_type: s.service_type,
    scheduled_date: s.scheduled_date,
    current_tech: s.current_tech_name || 'Unassigned',
    ...(s.visit_id ? { grouped_visit_id: String(s.visit_id) } : {}),
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
      note: `Would reassign ${stops.length} stop(s) to ${tech.name}. Re-call with confirmed:true to apply.`,
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
  const approvedDateStr = (v) => (v instanceof Date
    ? v.toISOString().slice(0, 10)
    : (v ? String(v).slice(0, 10) : null));
  if (approvedStops) {
    const approvedById = new Map(approvedStops.map((s) => [String(s.id), s]));
    const drifted = approvedStops.length !== services.length
      || services.some((s) => {
        const a = approvedById.get(String(s.id));
        // Date binds too (GH r9 P1): a stop moved to another day after the
        // confirm re-preview would otherwise pass the tech compare, and the
        // transaction would lock/validate the NEW day rather than the
        // approved one.
        return !a
          || String(a.current_tech || 'Unassigned') !== String(s.current_tech_name || 'Unassigned')
          || approvedDateStr(a.scheduled_date) !== s.scheduled_date_str
          // Grouped membership binds too (GH r14 P1): a stop that joined,
          // left, or switched grouped visits after the card was shown gets
          // seam effects (visit adoption/detach) the card never disclosed.
          || String(a.grouped_visit_id || '') !== String(s.visit_id || '');
      });
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
    // Re-assert the approved snapshot UNDER the tech-day locks (same
    // contract as swap_tech_assignments): the pre-lock read above chose the
    // lock keys, so any drift between it and the locked rows means the
    // fence may not cover the real source day — refuse rather than commit
    // an unapproved overwrite.
    if (approvedStops) {
      const live = await trx('scheduled_services')
        .whereIn('id', serviceIds)
        .forUpdate()
        .select('id', 'technician_id', 'visit_id', db.raw("to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date_str"));
      const liveById = new Map(live.map((r) => [String(r.id), r]));
      const changed = live.length !== services.length
        || services.some((s) => {
          const l = liveById.get(String(s.id));
          return !l
            || String(l.technician_id || '') !== String(s.current_tech_id || '')
            || l.scheduled_date_str !== s.scheduled_date_str
            // Same grouped-membership bind as the pre-lock compare (GH r14
            // P1) — asserted on the rows the UPDATE itself will touch.
            || String(l.visit_id || '') !== String(s.visit_id || '');
        });
      if (changed) {
        const err = new Error('assign_set_changed');
        err.previewChanged = true;
        throw err;
      }
    }
    // route_order: null ONLY for rows whose technician actually CHANGES —
    // the old sequence number is meaningless in the day the stop joins
    // (NULL appends after the ordered run; every consumer sorts
    // COALESCE(route_order, 999)) until an optimizer places it. Rows
    // already on tech.id are a no-op reassignment: clearing them would
    // erase a valid manual/optimized position (uncapped audit r25 P1) —
    // the predicate is on the row value the UPDATE itself observes.
    // Save-time eligibility on the writing trx (422 TECH_NOT_ASSIGNABLE).
    await assertAssignableTechnician(tech.id, { conn: trx });
    const [{ count: alreadyOn }] = await trx('scheduled_services')
      .whereIn('id', serviceIds)
      .where('technician_id', tech.id)
      .count('id as count');
    // The COMMITTED schedule of every reassigned row rides back for the
    // notices (pre-push audit P1): a same-day window edit landing between
    // the card's read and this lock must not make the "new visit" card
    // describe the old window.
    committedAssignRows = await trx('scheduled_services')
      .whereIn('id', serviceIds)
      .whereRaw('technician_id IS DISTINCT FROM ?', [tech.id])
      .update({ technician_id: tech.id, route_order: null, updated_at: new Date() })
      .returning(['id', 'scheduled_date', 'window_start', 'window_end']);
    return committedAssignRows.length + Number(alreadyOn);
    });
  } catch (err) {
    if (err && err.previewChanged) {
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
    ...(groupWarning ? { warning: groupWarning } : {}),
  };
}


// Terminal scheduled_services statuses — one-way; never movable. Live
// (en_route/on_site) rows ARE movable, but the move must rewind the tracker
// lifecycle (rebooker LIVE_LIFECYCLE_RESET) so stale arrival timestamps
// don't survive onto the new date.
const TERMINAL_MOVE_STATUSES = new Set(require('./proposal-pins').TERMINAL_APPOINTMENT_STATUSES);
const LIVE_MOVE_STATUSES = new Set(['en_route', 'on_site']);

async function moveStopsToDay(input, actionContext = {}) {
  const { service_ids: serviceIds, new_date: newDate, reason, confirmed } = input;
  const notifyCustomers = input.notify_customers === true;

  // scheduled_date is a plain DATE column holding ET calendar dates — a
  // garbage, impossible (2099-02-31), or past target moves stops where no
  // upcoming query finds them, or throws a raw PG cast error. Shared strict
  // validator: a shape-only regex let impossible dates reach the DATE update.
  const dateStr = validScheduleDate(newDate);
  if (!dateStr) {
    return { error: `new_date must be a valid YYYY-MM-DD date that is not in the past (got "${newDate}")` };
  }

  const services = await db('scheduled_services')
    .whereIn('id', serviceIds)
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.*',
      'customers.first_name', 'customers.last_name', 'customers.city',
    );

  if (!services.length) return { error: 'No services found for the given IDs' };

  // Terminal rows are one-way — refuse to move them, and report them so the
  // operator sees exactly what stays behind.
  const nonTerminal = services.filter((s) => !TERMINAL_MOVE_STATUSES.has(String(s.status)));
  const skippedTerminal = services
    .filter((s) => TERMINAL_MOVE_STATUSES.has(String(s.status)))
    .map((s) => ({ id: s.id, status: s.status }));
  if (!nonTerminal.length) {
    return { error: 'All matching stops are in a terminal status (completed/cancelled/skipped/no_show) — nothing to move' };
  }

  // A move TO today whose stop window already elapsed in ET would land the
  // stop in a past window no route can serve — reject those per-stop with the
  // rebooker's shared cutoff logic (window_end preferred, else window_start),
  // and report them so the operator sees what stayed behind. A stop with a
  // still-future window today, or any move to a future date, is unaffected.
  const movableAnyDate = nonTerminal.filter((s) => !sameDayWindowElapsed(dateStr, s.window_end || s.window_start));
  const skippedElapsed = nonTerminal
    .filter((s) => sameDayWindowElapsed(dateStr, s.window_end || s.window_start))
    .map((s) => ({ id: s.id, status: s.status }));
  // A stop already on the target date has nothing to move — drop it here so
  // neither the preview nor the commit rewrites it or texts its customer
  // about an "unchanged" appointment (and never closes its reminder windows
  // as if a real reschedule notice replaced them).
  const stopDateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ? String(v).slice(0, 10) : null));
  const movableByDate = movableAnyDate.filter((s) => stopDateOnly(s.scheduled_date) !== dateStr);
  const skippedUnchanged = movableAnyDate
    .filter((s) => stopDateOnly(s.scheduled_date) === dateStr)
    .map((s) => ({ id: s.id }));
  // Collective series moves (GATE_ADMIN_COLLECTIVE_MOVE): this batch mover
  // writes ONE row per stop and cannot shift a cadence visit's sister
  // visits, so with the gate on a recurring stop moving to another date is
  // refused — reported as skipped_collective — on BOTH passes, so the
  // proposal promises exactly the set the confirmed pass moves (hook r17
  // P1: the refusal used to live only in the commit loop, and an operator
  // could confirm a proposal that then moved nothing). Refuse-don't-drop,
  // same as reschedule_appointment. Gate off: the move is a this-visit-only
  // date exception (rebooker.dateExceptionStamp). The gate read is the
  // rebooker's own (lazy — only when a recurring stop is in the set).
  const collectiveGateOn = movableByDate.some((s) => s.is_recurring === true)
    && require('../rebooker').collectiveMoveGateOn();
  const skippedCollective = collectiveGateOn
    ? movableByDate.filter((s) => s.is_recurring === true).map((s) => ({ id: s.id, status: s.status, reason: 'collective_move_required' }))
    : [];
  const movableUngated = collectiveGateOn ? movableByDate.filter((s) => s.is_recurring !== true) : movableByDate;
  // Grouped/frozen eligibility at PROPOSAL time too (GH r8 P1): the commit's
  // per-stop assert (under locks) stays authoritative, but a stop already
  // known unmovable must never ride the card's approved set only to be
  // skipped silently after Confirm. Read-only check (no locks — the CAS pins
  // visit_id, so a stop grouped AFTER this read drifts/misses instead);
  // fail CLOSED per stop on an unverifiable group state.
  const skippedGrouped = [];
  const movable = [];
  for (const s of movableUngated) {
    if (!s.visit_id) { movable.push(s); continue; }
    try {
      const { openMembers, frozenVisitVerdict } = require('../visit-groups');
      const members = await openMembers(db, s.visit_id);
      if (members.length >= 2) {
        skippedGrouped.push({ id: s.id, status: `${s.status} (grouped visit — move the stop from the schedule so the whole visit moves together)` });
        continue;
      }
      const verdict = await frozenVisitVerdict(db, s.visit_id);
      if (verdict.frozen) {
        skippedGrouped.push({ id: s.id, status: `${s.status} (frozen grouped visit)` });
        continue;
      }
      movable.push(s);
    } catch (err) {
      logger.warn(`[intelligence-bar:schedule] group-state preview check failed for ${s.id}: ${err.message}`);
      skippedGrouped.push({ id: s.id, status: `${s.status} (group state unverifiable)` });
    }
  }
  if (!movable.length) {
    let error = 'Every movable stop\'s window has already passed today — pick a later window or a future date';
    if (skippedGrouped.length && !skippedCollective.length && !skippedUnchanged.length && !skippedElapsed.length) {
      error = 'Every selected stop is part of a grouped (or frozen) visit — move the stop from the schedule so the whole visit moves together';
    } else if (skippedCollective.length && !skippedUnchanged.length && !skippedElapsed.length) {
      error = 'Every selected stop is a recurring-plan visit — with collective moves on, move it from dispatch or Edit appointment so its later visits move with it';
    } else if (skippedUnchanged.length && !skippedElapsed.length) {
      error = 'Every selected stop is already on that date — nothing to move';
    }
    return {
      error,
      ...(skippedGrouped.length ? { skipped_grouped: skippedGrouped } : {}),
      ...(skippedCollective.length ? { skipped_collective: skippedCollective } : {}),
      ...(skippedUnchanged.length ? { skipped_unchanged: skippedUnchanged } : {}),
      ...(skippedElapsed.length ? { skipped_elapsed: skippedElapsed } : {}),
      ...(skippedTerminal.length ? { skipped_terminal: skippedTerminal } : {}),
    };
  }

  // Evidence-only tracker rewinds ride the preview too (GH r8 P1): a
  // non-live stop with stale tracker evidence gets its tracker fields
  // cleared + post-commit cleanup on move (needsLifecycleRewind) — derived
  // here so the card can disclose it and the two-step fingerprint binds it
  // (evidence appearing during the pending window is drift, not a silent
  // tracker release).
  const { needsLifecycleRewind: previewNeedsRewind } = require('../rebooker');
  // Pinned SMS recipients (GH r18 P1): with notify_customers the commit
  // texts each stop's resolved service-contact recipient, re-resolved from
  // a fresh customer load at send time — so the phone the operator
  // approves must ride the preview (full number binds the fingerprint,
  // last4 renders on the card) and be enforced at the sender's final
  // recipient read (sendRescheduleNoticeForVisit expectedPhone).
  const notifyPhoneByCustomer = new Map();
  if (notifyCustomers) {
    const contactApi = require('../customer-contact');
    for (const s of movable) {
      if (!s.customer_id || notifyPhoneByCustomer.has(String(s.customer_id))) continue;
      const customerRow = await db('customers').where('id', s.customer_id).first();
      notifyPhoneByCustomer.set(String(s.customer_id),
        customerRow ? (contactApi.getServiceContactSmsRecipient(customerRow).phone || null) : null);
    }
  }
  const stops = movable.map(s => ({
    id: s.id,
    customer: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
    city: s.city,
    service_type: s.service_type,
    // Lifecycle state rides in the preview (codex r7 on #3648): a live
    // (en_route/on_site) stop is more than a date move — the commit resets
    // it to confirmed and releases tech/tracker state — so the card must
    // disclose it, and the two-step fingerprint must bind it (a stop going
    // live during the pending window is drift, not a silent workflow kill).
    status: s.status,
    ...(!LIVE_MOVE_STATUSES.has(String(s.status)) && previewNeedsRewind(s) ? { track_rewind: true } : {}),
    // Grouped-visit membership (GH r18 P1): a sole-open-member grouped
    // stop passes eligibility, and the post-commit seam then detaches it
    // and dissolves the empty group — the card must disclose that, and a
    // membership change during the pending window must drift.
    ...(s.visit_id ? { grouped_visit_id: String(s.visit_id) } : {}),
    ...(notifyCustomers ? {
      notify_phone: notifyPhoneByCustomer.get(String(s.customer_id)) || null,
      notify_phone_last4: String(notifyPhoneByCustomer.get(String(s.customer_id)) || '').replace(/\D/g, '').slice(-4) || null,
    } : {}),
    old_date: s.scheduled_date,
    new_date: dateStr,
  }));

  if (confirmed !== true) {
    return {
      proposal: true,
      would_move_to: dateStr,
      stop_count: stops.length,
      reason: reason || null,
      // Surfaced on the confirmation card — the operator must see whether
      // committing will text the customers.
      will_text_customers: notifyCustomers,
      stops,
      ...(skippedGrouped.length ? { skipped_grouped: skippedGrouped } : {}),
      ...(skippedCollective.length ? { skipped_collective: skippedCollective } : {}),
      ...(skippedUnchanged.length ? { skipped_unchanged: skippedUnchanged } : {}),
      ...(skippedElapsed.length ? { skipped_elapsed: skippedElapsed } : {}),
      ...(skippedTerminal.length ? { skipped_terminal: skippedTerminal } : {}),
      note: `Would move ${stops.length} stop(s) to ${dateStr}${notifyCustomers ? ' and TEXT each customer the new arrival window' : ' silently (no customer texts)'}. Re-call with confirmed:true to apply.`,
    };
  }

  // The stop set + lifecycle states the operator approved
  // (`_verified_stops`, the route's fingerprint-verified re-preview) must
  // match what this confirmed pass just re-read (pre-push r11 P1): the
  // fingerprint bound the CARD, but this run's movable/status/rewind
  // classification comes from its own fresh unlocked read — a stop that
  // went en_route, gained rewind evidence, or moved during the pending
  // window would otherwise get a workflow reset or tracker release the
  // card never disclosed. Same consume-the-pin contract as
  // assign_technician / swap_tech_assignments; the per-stop CAS below
  // stays the read→write authority.
  const approvedMoveStops = Array.isArray(input._verified_stops) ? input._verified_stops : null;
  if (approvedMoveStops) {
    const approvedById = new Map(approvedMoveStops.map((a) => [String(a.id), a]));
    const drifted = approvedMoveStops.length !== stops.length
      || stops.some((s) => {
        const a = approvedById.get(String(s.id));
        return !a
          || String(a.status) !== String(s.status)
          || (a.track_rewind === true) !== (s.track_rewind === true)
          || stopDateOnly(a.old_date) !== stopDateOnly(s.old_date)
          // Grouped membership + pinned SMS recipient bind too (GH r18
          // P1): a stop that joined/left/switched groups, or whose
          // resolved recipient phone changed, gets effects the card never
          // showed. `s` here is THIS confirmed pass's re-derived stop
          // (same builder), so both sides carry the fields.
          || String(a.grouped_visit_id || '') !== String(s.grouped_visit_id || '')
          || (notifyCustomers && String(a.notify_phone || '') !== String(s.notify_phone || ''));
      });
    if (drifted) {
      return {
        error: 'The stops changed after the card was shown (status, tracker evidence, or date) — nothing was moved. Ask again for a fresh confirmation card.',
        preview_changed: true,
      };
    }
  }

  // Lazy require: rebooker is heavy (sockets, comms) — only needed on commit.
  const {
    LIVE_LIFECYCLE_RESET, applyLiveMoveSideEffects, applyLiveMovePostCommitEffects,
    needsLifecycleRewind, applyTrackLifecycleCas, dateExceptionStamp,
  } = require('../rebooker');
  const movedIds = new Set();
  // Committed stops whose landing block overlaps another appointment on the
  // target date (advisory — the moves stand; the result warns).
  const overlapMovedIds = [];
  // Moved rows whose requested customer text did NOT go out — reported so
  // the operator learns the move committed but someone wasn't notified.
  const notificationFailures = [];
  // Moved rows whose promised tech/tracker release or cleanup failed
  // post-commit (GH r9 P1) — the card disclosed that release, so a failure
  // surfaces as a warning, never a bare Done.
  const lifecycleCleanupFailures = [];
  // Moved rows whose reschedule_log audit append failed (GH r19 P2).
  const auditFailures = [];
  let textedCount = 0;
  // ── Phase A: the COMPLETE approved set moves in ONE transaction
  // (pre-push r21 P1): the exact-effects card promised one frozen effect
  // set, so a CAS miss, a grouped/frozen refusal, or any target drift
  // aborts EVERY move (same all-or-none contract as bulk_update_leads)
  // instead of leaving a partially applied batch behind a Done. Per-stop
  // lifecycle classification derives from the same read the CAS pins; the
  // CAS rationale (status + observed schedule fields + visit_id + tracker
  // snapshot, no FOR UPDATE) is unchanged from the per-stop version.
  const classified = movable.map((s) => {
    const wasLive = LIVE_MOVE_STATUSES.has(String(s.status));
    const trackRewound = !wasLive && needsLifecycleRewind(s);
    return {
      s,
      oldDate: s.scheduled_date,
      wasLive,
      trackRewound,
      liveReset: wasLive || trackRewound ? LIVE_LIFECYCLE_RESET : {},
      observedDate: s.scheduled_date instanceof Date
        ? s.scheduled_date.toISOString().slice(0, 10)
        : (s.scheduled_date ? String(s.scheduled_date).slice(0, 10) : null),
    };
  });
  const { lockTechDays } = require('../scheduling/tech-day-lock');
  const runBatchTrx = async () => db.transaction(async (trx) => {
    const overlappedIds = [];
    // Rung 1 + tech-blind probes FIRST (occupancy.js ORDERING CONTRACT: the
    // date-wide lock precedes the tech-day fence). Advisory only — a hit
    // warns, never blocks (owner ruling 2026-08-25).
    for (const c of classified) {
      const s = c.s;
      const probeStart = s.window_start ? String(s.window_start).slice(0, 5) : null;
      let probeEnd = s.window_end ? String(s.window_end).slice(0, 5) : null;
      if (probeStart && (!probeEnd || probeEnd <= probeStart)) {
        const [h, m] = probeStart.split(':').map(Number);
        const endMin = Math.min(h * 60 + m + (parseInt(s.estimated_duration_minutes, 10) || 60), 23 * 60 + 59);
        probeEnd = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
      }
      if (probeStart && probeEnd) {
        const overlap = await probeSlotOverlap({
          trx, date: dateStr, windowStart: probeStart, windowEnd: probeEnd, excludeServiceIds: [String(s.id)],
        });
        if (overlap.length) overlappedIds.push(s.id);
      }
    }
    // ONE tech-day fence over every day this batch touches (each stop's
    // leaving day + the joining day).
    await lockTechDays(trx, classified.flatMap((c) => [
      { techId: c.s.technician_id, date: c.observedDate },
      { techId: c.s.technician_id, date: dateStr },
    ]));
    for (const c of classified) {
      const s = c.s;
      // Grouped/frozen refusal under the stop lock, AFTER the tech-day
      // fence (lock order; codex #3609 r29 P1) — here it ABORTS the batch.
      await require('../visit-groups').assertRowMovableAlone(trx, s.id, s.visit_id);
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
        // Full observed tracker/lifecycle snapshot in the CAS — any
        // concurrent lifecycle or SMS-guard write must make this miss.
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
          // LIVE_LIFECYCLE_RESET clears the tracker fields but not status —
          // land a moved live stop back on 'confirmed', matching the
          // rebooker's own path.
          ...(c.wasLive ? { status: 'confirmed' } : {}),
          ...c.liveReset,
          updated_at: new Date(),
        })
        // The technician on the COMMITTED row: the CAS does not pin
        // technician_id, so the move notice goes to whoever holds the stop
        // now, not the unlocked pre-read (Codex r4 P1).
        .returning(['id', 'technician_id']);
      if (committedRows.length === 0) {
        throw Object.assign(new Error('move_set_changed'), { code: 'MOVE_SET_CHANGED', stopId: s.id });
      }
      c.committedTechId = committedRows[0]?.technician_id || null;
    }
    return overlappedIds;
  });
  try {
    // Deadlock retry (codex #3609 r31 P2) around the WHOLE batch — locks
    // re-acquired fresh on 40P01.
    for (let attempt = 0; ; attempt++) {
      try {
        overlapMovedIds.push(...await runBatchTrx());
        break;
      } catch (err) {
        if (err && err.code === '40P01' && attempt < 2) {
          overlapMovedIds.length = 0;
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (err && (err.code === 'MOVE_SET_CHANGED' || err.code === 'VISIT_EDIT_SCHEDULE_UNSUPPORTED' || err.code === 'VISIT_FROZEN_MOVE_UNSUPPORTED')) {
      return {
        error: 'One of the approved stops changed (status, schedule, or grouped-visit state) while the move was pending — NOTHING was moved. Ask again for a fresh confirmation card.',
        preview_changed: true,
      };
    }
    throw err;
  }
  for (const c of classified) movedIds.add(c.s.id);

  // Tech-facing notices (tech-visit-notifications.js): this writer changes
  // scheduled_date itself, so it tells the holder itself. Post-commit,
  // best-effort, NOT awaited; the operator's own move stays silent.
  {
    const { notifyVisitRescheduled } = require('../tech-visit-notifications');
    for (const c of classified) {
      if (!c.committedTechId) continue;
      void notifyVisitRescheduled({
        visitId: c.s.id,
        technicianId: c.committedTechId,
        actorId: actionContext.technicianId || null,
        previous: { date: c.oldDate, windowStart: c.s.window_start, windowEnd: c.s.window_end },
        snapshot: { date: dateStr, windowStart: c.s.window_start, windowEnd: c.s.window_end },
      });
    }
  }

  // ── Phase B: post-commit side effects per moved stop — best-effort; the
  // batch is committed, so failures surface as warnings, never unwind it.
  for (const c of classified) {
    const s = c.s;
    if (c.wasLive) {
      // Rebooker-parity effects of the live → confirmed flip:
      // job_status_history audit, tech_status release, tracker refresh.
      try {
        await applyLiveMoveSideEffects(db, s);
      } catch (err) {
        logger.error(`[intelligence-bar:schedule] live-move side effects failed for ${s.id}: ${err.message}`);
        lifecycleCleanupFailures.push(s.id);
      }
    } else if (c.trackRewound) {
      // Tracker rewind without a status transition: cleanup only, no
      // history row, refresh with the stop's unchanged status.
      try {
        await applyLiveMovePostCommitEffects(s, { toStatus: s.status });
      } catch (err) {
        logger.error(`[intelligence-bar:schedule] track-rewind side effects failed for ${s.id}: ${err.message}`);
        lifecycleCleanupFailures.push(s.id);
      }
    }
    // Audit row matching the rebooker's reschedule_log conventions.
    try {
      await db('reschedule_log').insert({
        scheduled_service_id: s.id,
        customer_id: s.customer_id,
        original_date: c.oldDate,
        new_date: dateStr,
        reason_code: 'admin',
        initiated_by: 'admin_ib',
        original_window: s.window_start ? `${s.window_start}-${s.window_end}` : null,
        new_window: s.window_start ? `${s.window_start}-${s.window_end}` : null,
        notes: reason || null,
      });
    } catch (err) {
      logger.error(`[intelligence-bar:schedule] reschedule_log insert failed for ${s.id}: ${err.message}`);
      // The card discloses the audit append (GH r19 P2) — a failed insert
      // surfaces in the combined warning, never a bare Done.
      auditFailures.push(s.id);
    }
  }

  // Notification phase — runs only after EVERY approved stop has been
  // moved, released, and audited above, so one slow SMS provider can
  // never delay or strand the rest of the confirmed batch. Best-effort
  // per stop; failures land in notification_failures.
  for (const s of movable) {
    if (!movedIds.has(s.id)) continue;
    // Activate a moved LEGACY outbound-review row regardless of the notify
    // flag (Codex #3361 r3 P0 — same gap as the admin bulk path): this
    // writer moves rows directly, and a legacy row has no reminder row, so
    // the notify branch below would report "no reminder record" without
    // ever reaching the notice sender's activation belt. No-op for every
    // other row; best-effort by the helper's contract.
    try {
      await require('../outbound-review-confirm')
        .activateLegacyOutboundReviewRowIfNeeded(db, s.id, 'ib-bulk-move');
    } catch { /* helper is internally best-effort; never strand the batch */ }
    // Opt-in customer text — LAST: after the live-job release and the
    // reschedule_log audit, so a slow
    // SMS provider can never hold tech_status/tracker on the moved job.
    // Same shared path as update-details and the bulk
    // reschedule (arrival-window copy, recipient routing, terminal/slot
    // recheck, guarded reminder close/re-arm). Best-effort per stop: a send
    // failure is reported, never unwinds the committed move.
    if (notifyCustomers) {
      try {
        const start = s.window_start ? String(s.window_start).slice(0, 5) : null;
        if (!start) {
          notificationFailures.push({ id: s.id, reason: 'No arrival time is set for this visit, so no reschedule text was sent' });
        } else {
          const reminderRow = await db('appointment_reminders')
            .where({ scheduled_service_id: s.id })
            .first('suppressed_by_sibling')
            .catch(() => null);
          if (!reminderRow) {
            notificationFailures.push({ id: s.id, reason: 'No reminder record for this visit — not texted' });
          } else if (reminderRow.suppressed_by_sibling) {
            // The destination slot's reminder owner carries this customer's
            // messaging, and that owner may not be part of this move — so
            // no reschedule text goes out here. Report it rather than let
            // the operator assume the customer was told (codex #3102 r3).
            notificationFailures.push({ id: s.id, reason: 'Another visit that day carries this customer\'s reminders — no reschedule text was sent for this stop' });
          } else {
            const AppointmentReminders = require('../appointment-reminders');
            // Cover any already-due reminder window before our text so the
            // 15-min cron can't double-text in the send gap (the caller-side
            // contract of sendRescheduleNoticeForVisit).
            const sync = await AppointmentReminders.handleReschedule(s.id, `${dateStr}T${start}`, {
              sendNotification: false,
              coverDueWindows: true,
              // Stale-move guard (atomic in the service): the reminder
              // rewrite misses if a newer reschedule already landed a
              // different slot on the row.
              expectSchedule: { date: dateStr, windowStart: start },
            });
            if (!sync || sync.skippedStale) {
              // skippedStale: a newer move won and owns the customer
              // messaging. Falsy: the guarded sync itself failed — a
              // still-pending deferred confirmation would then follow our
              // text as a duplicate. Either way: report, don't send (the
              // cron's fallback reminders remain armed).
              notificationFailures.push({
                id: s.id,
                reason: sync && sync.skippedStale
                  ? 'Appointment changed again before the text could be sent'
                  : 'Reminder sync failed — not texted (automated reminders still cover the new time)',
              });
            } else {
              const { sendRescheduleNoticeForVisit } = require('../../routes/admin-schedule');
              // The card-approved recipient phone rides to the sender's
              // final recipient read (GH r18 P1) — a number changed after
              // the card refuses there instead of texting an unapproved
              // phone.
              // The pinned value is passed even when it is null (GH r19
              // P1): a card that showed "no SMS recipient" pins ABSENCE —
              // a phone added after the confirm re-preview must refuse at
              // the sender, never text a number the operator did not see.
              const notice = await sendRescheduleNoticeForVisit(s.id, dateStr, start, {
                expectedPhone: notifyPhoneByCustomer.get(String(s.customer_id)) ?? null,
              });
              if (notice.sent) textedCount++;
              else notificationFailures.push({ id: s.id, reason: notice.error || 'reschedule text was not sent' });
            }
          }
        }
      } catch (err) {
        notificationFailures.push({ id: s.id, reason: err.message });
        logger.error(`[intelligence-bar:schedule] move notice failed for ${s.id}: ${err.message}`);
      }
    }
  }

  const movedStops = stops.filter((st) => movedIds.has(st.id));

  // Visit-group seam (codex #3590 r9): this writer moves dates directly
  // (not via the rebooker), so it repairs grouped membership itself — a
  // moved child leaves a visit that stays on the old date. Runs LAST,
  // after every query this tool issues for its own result (the helper is
  // best-effort and self-contained). No-op for ungrouped rows.
  let moveGroupWarning = null;
  for (const movedId of movedIds) {
    try {
      await require('../visit-groups').handleChildStopChanged(movedId);
    } catch (vgErr) {
      logger.warn(`[intelligence-bar:schedule] visit-group seam failed for moved ${movedId}: ${vgErr.message}`);
      // The card disclosed the detach/dissolve for grouped moved stops —
      // a failed repair must surface, never a bare Done (GH r18 P1).
      if (movable.some((s) => movedIds.has(s.id) && s.visit_id)) {
        moveGroupWarning = 'Moved, but repairing grouped-visit membership failed — one or more grouped stops may still show the old visit; re-check the affected visits on the schedule.';
      }
    }
  }


  logger.info(`[intelligence-bar:schedule] Moved ${movedStops.length} stops to ${dateStr}`);

  // ONE `warning` key: the card renders body.result.warning only, so the
  // overlap note and the texts-failed note must COMBINE, never overwrite
  // each other (a later spread writing `warning` clobbered the overlap).
  const overlapNote = overlapMovedIds.length
    ? `${slotOverlapWarning(dateStr)} (${overlapMovedIds.length} moved stop${overlapMovedIds.length === 1 ? '' : 's'} overlap${overlapMovedIds.length === 1 ? 's' : ''} an existing appointment)`
    : null;
  // Top-level partial-failure signal: /confirm-action reports success (the
  // moves DID commit), so without this the card shows a bare "Done" and
  // the operator assumes every customer was texted.
  const notifyNote = notifyCustomers && notificationFailures.length
    ? `Moved ${movedStops.length} stop(s), but ${notificationFailures.length} customer(s) were not texted: ${notificationFailures.map((f) => f.reason).slice(0, 3).join('; ')}${notificationFailures.length > 3 ? '…' : ''}`
    : null;
  const lifecycleNote = lifecycleCleanupFailures.length
    ? `${lifecycleCleanupFailures.length} moved stop(s) committed but their technician/tracker release failed — check the tech pointer for those visits.`
    : null;
  const auditNote = auditFailures.length
    ? `${auditFailures.length} moved stop(s) are missing their reschedule audit entry (the moves stand; the history append failed).`
    : null;
  const combinedWarning = [overlapNote, notifyNote, lifecycleNote, moveGroupWarning, auditNote].filter(Boolean).join(' ');

  return {
    success: true,
    moved_count: movedStops.length,
    new_date: dateStr,
    stops: movedStops,
    ...(combinedWarning ? { warning: combinedWarning } : {}),
    ...(overlapMovedIds.length ? { overlap_ids: overlapMovedIds } : {}),
    ...(notifyCustomers ? { texted_count: textedCount, notification_failures: notificationFailures } : {}),
    ...(skippedUnchanged.length ? { skipped_unchanged: skippedUnchanged } : {}),
    ...(skippedTerminal.length ? { skipped_terminal: skippedTerminal } : {}),
    ...(skippedElapsed.length ? { skipped_elapsed: skippedElapsed } : {}),
    ...(skippedGrouped.length ? { skipped_grouped: skippedGrouped } : {}),
    ...(skippedCollective.length ? { skipped_collective: skippedCollective } : {}),
  };
}


async function swapTechAssignments(input, actionContext = {}) {
  const { date, tech_a_name: techAName, tech_b_name: techBName, confirmed } = input;
  const techA = await db('technicians').whereILike('name', `%${techAName}%`).first();
  const techB = await db('technicians').whereILike('name', `%${techBName}%`).first();
  if (!techA) return { error: `Tech "${techAName}" not found` };
  if (!techB) return { error: `Tech "${techBName}" not found` };

  // Get both sets of services
  const aServices = await db('scheduled_services').where({ scheduled_date: date, technician_id: techA.id }).whereNotIn('status', ['cancelled', 'completed', 'rescheduled']);
  const bServices = await db('scheduled_services').where({ scheduled_date: date, technician_id: techB.id }).whereNotIn('status', ['cancelled', 'completed', 'rescheduled']);

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
      note: `Would swap ${aServices.length} stop(s) from ${techA.name} with ${bServices.length} stop(s) from ${techB.name}. Re-call with confirmed:true to apply.`,
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
    .whereNotIn('status', ['cancelled', 'completed', 'rescheduled'])
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
      if (bIds.length) await assertAssignableTechnician(techA.id, { conn: trx });
      if (aIds.length) await assertAssignableTechnician(techB.id, { conn: trx });
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
    ...(swapGroupWarning ? { warning: swapGroupWarning } : {}),
  };
}


async function findScheduleGaps(input) {
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


async function findAvailableSlotsTool(input) {
  const { findAvailableSlots } = require('../scheduling/find-time');
  let { customer_id, address, lat, lng, duration_minutes, date_from, date_to, technician_name, top_n } = input;

  // Resolve customer → lat/lng if provided
  if (customer_id && (!lat || !lng)) {
    const c = await db('customers').where('id', customer_id).select('latitude', 'longitude', 'address_line1', 'city', 'state', 'zip').first();
    if (c?.latitude && c?.longitude) { lat = parseFloat(c.latitude); lng = parseFloat(c.longitude); }
    else if (c && !address) address = [c.address_line1, c.city, c.state, c.zip].filter(Boolean).join(', ');
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
    const tech = await db('technicians').whereILike('name', `%${technician_name}%`).first();
    if (!tech) return { error: `Technician "${technician_name}" not found` };
    technician_id = tech.id;
  }

  const today = etDateString();
  const weekOut = etDateString(addETDays(new Date(), 7));

  return await findAvailableSlots({
    lat, lng,
    durationMinutes: duration_minutes || 60,
    dateFrom: date_from || today,
    dateTo: date_to || weekOut,
    technicianId: technician_id,
    topN: top_n || 10,
    // Waves works weekends — without this, find-time's legacy default
    // silently dropped every Sunday from staff slot suggestions. Day-off
    // policy lives in the weekly days-off setting, and staff surfaces are
    // deliberately unblocked anyway (matching admin-schedule-find-time.js),
    // so blackout/weekly-days-off dates stay visible here too.
    includeWeekends: true,
    includeBlackoutDates: true,
  });
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


module.exports = { SCHEDULE_TOOLS, executeScheduleTool };
