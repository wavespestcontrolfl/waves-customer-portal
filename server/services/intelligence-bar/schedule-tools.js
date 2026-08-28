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
const { scheduledServiceTrackTokenExpiry } = require('../track-token-expiry');
const { etDateString, addETDays, validScheduleDate, sameDayWindowElapsed } = require('../../utils/datetime-et');
const { dayStopsQuery, guardedCoordSelects } = require('../scheduling/day-stops');
const { probeSlotOverlap, slotOverlapWarning } = require('../scheduling/window-rules');

const SCHEDULE_TOOLS = [
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
        technician_name: { type: 'string', description: 'Tech name (Adam, Jose, Jacob)' },
      },
      required: ['date', 'technician_name'],
    },
  },
  {
    name: 'assign_technician',
    description: `Assign a technician to one or more unassigned services. Useful when the operator says "give those to Adam" or "assign the Parrish stops to Jose." Your call returns a PREVIEW; the operator approves or rejects it on the confirmation card in the portal. Call ONCE per intended action — never retry, never claim completion.`,
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
    description: `Swap all stops between two technicians for a date. Use when "give Adam's route to Jose and Jose's to Adam." Your call returns a PREVIEW; the operator approves or rejects it on the confirmation card in the portal. Call ONCE per intended action — never retry, never claim completion. This touches every stop for both techs on the date — preview is essential.`,
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
        technician_name: { type: 'string', description: 'Optional: restrict to one tech (Adam, Jose, Jacob)' },
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

async function executeScheduleTool(toolName, input) {
  try {
    switch (toolName) {
      case 'optimize_all_routes': return await optimizeAllRoutes(input);
      case 'optimize_tech_route': return await optimizeTechRoute(input);
      case 'assign_technician': return await assignTechnician(input);
      case 'move_stops_to_day': return await moveStopsToDay(input);
      case 'swap_tech_assignments': return await swapTechAssignments(input);
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


async function assignTechnician(input) {
  const { service_ids: serviceIds, technician_name: techName, confirmed } = input;
  const tech = await db('technicians').whereILike('name', `%${techName}%`).first();
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
      'scheduled_services.technician_id as current_tech_id',
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
  }));

  if (confirmed !== true) {
    return {
      proposal: true,
      would_assign_to: tech.name,
      stop_count: stops.length,
      stops,
      note: `Would reassign ${stops.length} stop(s) to ${tech.name}. Re-call with confirmed:true to apply.`,
    };
  }

  // Reassignment edits tech-day MEMBERSHIP on both sides (the day the stop
  // leaves and the day it joins), so it must hold the same tech-day fence the
  // nightly reorder and the booking/reschedule writers hold — an unfenced
  // reassign landing mid-reorder leaves the committed route_order not
  // covering the day.
  const { lockTechDays } = require('../scheduling/tech-day-lock');
  const count = await db.transaction(async trx => {
    await lockTechDays(trx, services.flatMap(s => [
      { techId: s.current_tech_id, date: s.scheduled_date_str },
      { techId: tech.id, date: s.scheduled_date_str },
    ]));
    // route_order: null ONLY for rows whose technician actually CHANGES —
    // the old sequence number is meaningless in the day the stop joins
    // (NULL appends after the ordered run; every consumer sorts
    // COALESCE(route_order, 999)) until an optimizer places it. Rows
    // already on tech.id are a no-op reassignment: clearing them would
    // erase a valid manual/optimized position (uncapped audit r25 P1) —
    // the predicate is on the row value the UPDATE itself observes.
    const [{ count: alreadyOn }] = await trx('scheduled_services')
      .whereIn('id', serviceIds)
      .where('technician_id', tech.id)
      .count('id as count');
    const changed = await trx('scheduled_services')
      .whereIn('id', serviceIds)
      .whereRaw('technician_id IS DISTINCT FROM ?', [tech.id])
      .update({ technician_id: tech.id, route_order: null, updated_at: new Date() });
    return changed + Number(alreadyOn);
  });

  logger.info(`[intelligence-bar:schedule] Assigned ${count} services to ${tech.name}`);

  return {
    success: true,
    assigned_count: count,
    technician: tech.name,
    stops,
  };
}


// Terminal scheduled_services statuses — one-way; never movable. Live
// (en_route/on_site) rows ARE movable, but the move must rewind the tracker
// lifecycle (rebooker LIVE_LIFECYCLE_RESET) so stale arrival timestamps
// don't survive onto the new date.
const TERMINAL_MOVE_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show']);
const LIVE_MOVE_STATUSES = new Set(['en_route', 'on_site']);

async function moveStopsToDay(input) {
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
  const movable = movableAnyDate.filter((s) => stopDateOnly(s.scheduled_date) !== dateStr);
  const skippedUnchanged = movableAnyDate
    .filter((s) => stopDateOnly(s.scheduled_date) === dateStr)
    .map((s) => ({ id: s.id }));
  if (!movable.length) {
    return {
      error: skippedUnchanged.length && !skippedElapsed.length
        ? 'Every selected stop is already on that date — nothing to move'
        : 'Every movable stop\'s window has already passed today — pick a later window or a future date',
      ...(skippedUnchanged.length ? { skipped_unchanged: skippedUnchanged } : {}),
      ...(skippedElapsed.length ? { skipped_elapsed: skippedElapsed } : {}),
      ...(skippedTerminal.length ? { skipped_terminal: skippedTerminal } : {}),
    };
  }

  const stops = movable.map(s => ({
    id: s.id,
    customer: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
    city: s.city,
    service_type: s.service_type,
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
      ...(skippedUnchanged.length ? { skipped_unchanged: skippedUnchanged } : {}),
      ...(skippedElapsed.length ? { skipped_elapsed: skippedElapsed } : {}),
      ...(skippedTerminal.length ? { skipped_terminal: skippedTerminal } : {}),
      note: `Would move ${stops.length} stop(s) to ${dateStr}${notifyCustomers ? ' and TEXT each customer the new arrival window' : ' silently (no customer texts)'}. Re-call with confirmed:true to apply.`,
    };
  }

  // Lazy require: rebooker is heavy (sockets, comms) — only needed on commit.
  const {
    LIVE_LIFECYCLE_RESET, applyLiveMoveSideEffects, applyLiveMovePostCommitEffects,
    needsLifecycleRewind, applyTrackLifecycleCas, collectiveMoveGateOn, dateExceptionStamp,
  } = require('../rebooker');
  const movedIds = new Set();
  // Committed stops whose landing block overlaps another appointment on the
  // target date (advisory — the moves stand; the result warns).
  const overlapMovedIds = [];
  const skippedConflict = [];
  // Moved rows whose requested customer text did NOT go out — reported so
  // the operator learns the move committed but someone wasn't notified.
  const notificationFailures = [];
  let textedCount = 0;
  for (const s of movable) {
    const oldDate = s.scheduled_date;
    // A live (en_route/on_site) stop being moved rewinds its tracker
    // lifecycle exactly like the rebooker's live override does.
    const wasLive = LIVE_MOVE_STATUSES.has(String(s.status));
    // Rewind on stale evidence too, not just live status — see
    // needsLifecycleRewind in rebooker.js. The status flip and the history
    // append stay keyed on wasLive; an evidence-only rewind still gets the
    // post-commit tracker cleanup below without recording a status
    // transition that never happened.
    const trackRewound = !wasLive && needsLifecycleRewind(s);
    const liveReset = wasLive || trackRewound ? LIVE_LIFECYCLE_RESET : {};
    // Compare-and-swap on the OBSERVED status + schedule fields: everything
    // below (the wasLive classification, the lifecycle rewind, the
    // 'confirmed' restamp) was derived from the initial read — if the stop
    // completed, got cancelled, or went live between that read and this
    // write, applying the stale branch by id alone would rewrite a terminal
    // row back to 'confirmed' (or leave a now-live row unrewound). Status
    // alone also let two ORDINARY moves of the same confirmed stop both
    // match — the later write silently clobbered the newer date and logged
    // from a stale snapshot. Matching the observed scheduled_date +
    // window_start makes the later writer miss instead (knex renders a null
    // value in the object form as IS NULL — the same contract auto-dispatch's
    // rebooker `expect` relies on). window_end is in the predicate too: this
    // mover never writes the window columns themselves, but it DOES stamp
    // track_token_expires_at derived from the observed end (and classified
    // movability + logs the window pair off the same read) — a concurrent
    // end-resize would otherwise still match and get a token expiry computed
    // from the stale end. Field-level CAS is the repo's established
    // pattern for exactly this (rebooker options.expect); still deliberately
    // NOT SELECT..FOR UPDATE. The short transaction below exists solely to
    // hold the tech-day advisory fence (a date-move edits tech-day MEMBERSHIP
    // on both the leaving and joining day, and the nightly reorder's
    // membership read is only fenced against writers holding the same lock —
    // see tech-day-lock.js); the CAS predicate remains the conflict
    // detector. updated_at stays out of the
    // predicate: knex never auto-touches it and not every mover stamps it
    // (the bulk route's UPDATE doesn't), so it isn't a reliable change
    // marker. Zero rows matched = the stop changed under us; skip it and
    // report the conflict.
    const observedDate = s.scheduled_date instanceof Date
      ? s.scheduled_date.toISOString().slice(0, 10)
      : (s.scheduled_date ? String(s.scheduled_date).slice(0, 10) : null);
    // Collective series moves (GATE_ADMIN_COLLECTIVE_MOVE): this batch mover
    // writes ONE row per stop and cannot shift a cadence visit's sister
    // visits, so with the gate on a recurring stop is refused (reported as
    // skipped) rather than silently moved per-visit — refuse-don't-drop,
    // same as reschedule_appointment. Gate off: the move is a this-visit-only
    // date exception (rebooker.dateExceptionStamp).
    if (collectiveMoveGateOn() && s.is_recurring === true && observedDate !== dateStr) {
      skippedConflict.push({ id: s.id, status: s.status, reason: 'collective_move_required' });
      continue;
    }
    const { lockTechDays } = require('../scheduling/tech-day-lock');
    // Advisory overlap note for THIS stop, set inside the trx but reported
    // only after the CAS commits (a missed CAS rolls back and must not warn).
    let stopOverlapped = false;
    const updatedRows = await db.transaction(async trx => {
      // Rung 1 + tech-blind probe FIRST (occupancy.js ORDERING CONTRACT:
      // the date-wide lock precedes the tech-day fence below). A hit never
      // blocks the move (owner ruling 2026-08-25 — staff saves warn, not
      // block): the stop still moves and the result carries a warning.
      // Windowless stops carry no occupancy and skip the probe; an end-less
      // stop probes its duration-derived block (default 60), mirroring the
      // shared predicate.
      {
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
          if (overlap.length) stopOverlapped = true;
        }
      }
      await lockTechDays(trx, [
        { techId: s.technician_id, date: observedDate },
        { techId: s.technician_id, date: dateStr },
      ]);
      return applyTrackLifecycleCas(
        trx('scheduled_services')
          .where('id', s.id)
          .where('status', String(s.status))
          .where({
            scheduled_date: observedDate,
            window_start: s.window_start ?? null,
            window_end: s.window_end ?? null,
          }),
        // Full observed tracker/lifecycle snapshot in the CAS — any
        // concurrent lifecycle or SMS-guard write must make this miss.
        // See reschedule_appointment in tools.js.
        s,
      )
        .update({
        scheduled_date: dateStr,
        ...(observedDate !== dateStr ? dateExceptionStamp(s, 'admin_ib') : {}),
        // Old day's sequence number is meaningless on the new date — NULL
        // appends the stop after the target day's ordered run.
        route_order: null,
        notes: reason ? `${s.notes || ''}\nMoved from ${oldDate}: ${reason}`.trim() : s.notes,
        track_token_expires_at: scheduledServiceTrackTokenExpiry(db, dateStr, s.window_end),
        // LIVE_LIFECYCLE_RESET clears the tracker fields but not status — land a
        // moved en_route/on_site stop back on 'confirmed' so it isn't left live
        // on a future date, matching the rebooker's own path.
          ...(wasLive ? { status: 'confirmed' } : {}),
          ...liveReset,
          updated_at: new Date(),
        });
    });
    if (updatedRows === 0) {
      // Best-effort re-read so the operator sees the status that blocked the
      // move (falls back to the stale one if the row vanished).
      let nowStatus = s.status;
      try {
        const row = await db('scheduled_services').where('id', s.id).first('status');
        if (row) nowStatus = row.status;
      } catch { /* reporting only */ }
      skippedConflict.push({ id: s.id, status: nowStatus });
      continue;
    }
    movedIds.add(s.id);
    if (stopOverlapped) overlapMovedIds.push(s.id);
    // Rebooker-parity side effects of the live → confirmed flip above:
    // job_status_history audit row, tech_status release, customer tracker
    // refresh. Best-effort: the move is committed — a side-effect failure
    // must not report the whole batch as failed.
    if (wasLive) {
      try {
        await applyLiveMoveSideEffects(db, s);
      } catch (err) {
        logger.error(`[intelligence-bar:schedule] live-move side effects failed for ${s.id}: ${err.message}`);
      }
    } else if (trackRewound) {
      // Tracker rewind without a status transition: cleanup only, no
      // history row, refresh with the stop's unchanged status.
      try {
        await applyLiveMovePostCommitEffects(s, { toStatus: s.status });
      } catch (err) {
        logger.error(`[intelligence-bar:schedule] track-rewind side effects failed for ${s.id}: ${err.message}`);
      }
    }
    // Audit row matching the rebooker's reschedule_log conventions.
    // Best-effort: the move is committed — a log failure must not report
    // the whole batch as failed.
    try {
      await db('reschedule_log').insert({
        scheduled_service_id: s.id,
        customer_id: s.customer_id,
        original_date: oldDate,
        new_date: dateStr,
        reason_code: 'admin',
        initiated_by: 'admin_ib',
        original_window: s.window_start ? `${s.window_start}-${s.window_end}` : null,
        new_window: s.window_start ? `${s.window_start}-${s.window_end}` : null,
        notes: reason || null,
      });
    } catch (err) {
      logger.error(`[intelligence-bar:schedule] reschedule_log insert failed for ${s.id}: ${err.message}`);
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
              const notice = await sendRescheduleNoticeForVisit(s.id, dateStr, start);
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

  if (!movedStops.length) {
    return {
      error: 'No stops were moved — every selected stop changed concurrently (status, date, or window) while the move was pending; re-check and retry',
      ...(skippedConflict.length ? { skipped_conflict: skippedConflict } : {}),
      ...(skippedElapsed.length ? { skipped_elapsed: skippedElapsed } : {}),
      ...(skippedTerminal.length ? { skipped_terminal: skippedTerminal } : {}),
    };
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
  const combinedWarning = [overlapNote, notifyNote].filter(Boolean).join(' ');

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
    ...(skippedConflict.length ? { skipped_conflict: skippedConflict } : {}),
  };
}


async function swapTechAssignments(input) {
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
      note: `Would swap ${aServices.length} stop(s) from ${techA.name} with ${bServices.length} stop(s) from ${techB.name}. Re-call with confirmed:true to apply.`,
    };
  }

  // Swap assignments atomically. Park A's services on NULL (allowed — the FK
  // is nullable for unassigned stops), then redirect B's to A and the parked
  // A-set to B. Earlier code parked on a hard-coded UUID, which violated the
  // technician_id FK if the swap ever ran.
  const aIds = aServices.map(s => s.id);
  const bIds = bServices.map(s => s.id);
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
    // route_order: null on both real reassignments — each stop's sequence
    // number belonged to its OLD tech's run; carrying it into the new tech's
    // day would interleave stale numbers (consumers append NULLs last).
    if (aIds.length) await trx('scheduled_services').whereIn('id', aIds).update({ technician_id: null, updated_at: new Date() });
    if (bIds.length) await trx('scheduled_services').whereIn('id', bIds).update({ technician_id: techA.id, route_order: null, updated_at: new Date() });
    if (aIds.length) await trx('scheduled_services').whereIn('id', aIds).update({ technician_id: techB.id, route_order: null, updated_at: new Date() });
  });

  return {
    success: true,
    date,
    swapped: {
      [techA.name]: { was: aServices.length, now: bServices.length },
      [techB.name]: { was: bServices.length, now: aServices.length },
    },
  };
}


async function findScheduleGaps(input) {
  const { date, date_from, date_to, service_type } = input;
  const MAX_STOPS_PER_DAY = 10;

  const from = date || date_from || etDateString();
  const to = date || date_to || etDateString(addETDays(new Date(), 6));

  const techs = await db('technicians').where({ active: true }).select('id', 'name');

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
