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
const { etDateString, addETDays } = require('../../utils/datetime-et');

const SCHEDULE_TOOLS = [
  {
    name: 'optimize_all_routes',
    description: `Run full route optimization for a date using Google Routes API. Reorders all technician stops to minimize total drive time and distance. Two-step pattern: call WITHOUT \`confirmed\` first to preview the new ordering and miles saved, then re-call WITH \`confirmed: true\` after the operator approves to actually write the new route_order. Always preview first.`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD to optimize' },
        confirmed: { type: 'boolean', description: 'Set true ONLY after the operator has approved the proposed reorder. Defaults to false (preview only).' },
      },
      required: ['date'],
    },
  },
  {
    name: 'optimize_tech_route',
    description: `Optimize route for a single technician on a given date. Reorders just their stops. Two-step pattern: call WITHOUT \`confirmed\` first to preview, then re-call WITH \`confirmed: true\` after the operator approves.`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        technician_name: { type: 'string', description: 'Tech name (Adam, Jose, Jacob)' },
        confirmed: { type: 'boolean', description: 'Set true ONLY after the operator has approved the proposed reorder. Defaults to false (preview only).' },
      },
      required: ['date', 'technician_name'],
    },
  },
  {
    name: 'assign_technician',
    description: `Assign a technician to one or more unassigned services. Useful when the operator says "give those to Adam" or "assign the Parrish stops to Jose." Two-step pattern: call WITHOUT \`confirmed\` first to show which stops would be reassigned, then re-call WITH \`confirmed: true\` after the operator approves.`,
    input_schema: {
      type: 'object',
      properties: {
        service_ids: { type: 'array', items: { type: 'string' }, description: 'Scheduled service IDs to assign' },
        technician_name: { type: 'string' },
        confirmed: { type: 'boolean', description: 'Set true ONLY after the operator has approved the assignment. Defaults to false (preview only).' },
      },
      required: ['service_ids', 'technician_name'],
    },
  },
  {
    name: 'move_stops_to_day',
    description: `Move one or more scheduled services to a different date. Use when operator says "move the Lakewood stops to Thursday" or "push these to next week." Two-step pattern: call WITHOUT \`confirmed\` first to preview the moves, then re-call WITH \`confirmed: true\` after the operator approves.`,
    input_schema: {
      type: 'object',
      properties: {
        service_ids: { type: 'array', items: { type: 'string' }, description: 'Scheduled service IDs to move' },
        new_date: { type: 'string', description: 'YYYY-MM-DD target date' },
        reason: { type: 'string' },
        confirmed: { type: 'boolean', description: 'Set true ONLY after the operator has approved the moves. Defaults to false (preview only).' },
      },
      required: ['service_ids', 'new_date'],
    },
  },
  {
    name: 'swap_tech_assignments',
    description: `Swap all stops between two technicians for a date. Use when "give Adam's route to Jose and Jose's to Adam." Two-step pattern: call WITHOUT \`confirmed\` first to preview the swap counts, then re-call WITH \`confirmed: true\` after the operator approves. This touches every stop for both techs on the date — preview is essential.`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        tech_a_name: { type: 'string' },
        tech_b_name: { type: 'string' },
        confirmed: { type: 'boolean', description: 'Set true ONLY after the operator has approved the swap. Defaults to false (preview only).' },
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

  const services = await db('scheduled_services')
    .where({ scheduled_date: date })
    .whereNotIn('status', ['cancelled', 'completed', 'rescheduled'])
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.*',
      'customers.first_name', 'customers.last_name',
      'customers.address_line1', 'customers.city', 'customers.state', 'customers.zip',
      'customers.lat', 'customers.lng',
    );

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

  if (!confirmed) {
    return {
      proposal: true,
      ...summary,
      note: `Would reorder ${stopsWithCoords.length} stops, saving ~${savedMiles} miles. Re-call with confirmed:true to apply.`,
    };
  }

  if (result.orderedStops) {
    for (let i = 0; i < result.orderedStops.length; i++) {
      await db('scheduled_services').where('id', result.orderedStops[i].id).update({ route_order: i + 1, updated_at: new Date() });
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

  const services = await db('scheduled_services')
    .where({ scheduled_date: date, technician_id: tech.id })
    .whereNotIn('status', ['cancelled', 'completed', 'rescheduled'])
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.*',
      'customers.first_name', 'customers.last_name',
      'customers.city', 'customers.lat', 'customers.lng',
    );

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

  if (!confirmed) {
    return {
      proposal: true,
      ...summary,
      note: `Would reorder ${tech.name}'s ${stopsWithCoords.length} stops, saving ~${savedMiles} miles. Re-call with confirmed:true to apply.`,
    };
  }

  if (result.orderedStops) {
    for (let i = 0; i < result.orderedStops.length; i++) {
      await db('scheduled_services').where('id', result.orderedStops[i].id).update({ route_order: i + 1, updated_at: new Date() });
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

  if (!confirmed) {
    return {
      proposal: true,
      would_assign_to: tech.name,
      stop_count: stops.length,
      stops,
      note: `Would reassign ${stops.length} stop(s) to ${tech.name}. Re-call with confirmed:true to apply.`,
    };
  }

  const count = await db('scheduled_services')
    .whereIn('id', serviceIds)
    .update({ technician_id: tech.id, updated_at: new Date() });

  logger.info(`[intelligence-bar:schedule] Assigned ${count} services to ${tech.name}`);

  return {
    success: true,
    assigned_count: count,
    technician: tech.name,
    stops,
  };
}


async function moveStopsToDay(input) {
  const { service_ids: serviceIds, new_date: newDate, reason, confirmed } = input;
  const services = await db('scheduled_services')
    .whereIn('id', serviceIds)
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.*',
      'customers.first_name', 'customers.last_name', 'customers.city',
    );

  if (!services.length) return { error: 'No services found for the given IDs' };

  const stops = services.map(s => ({
    id: s.id,
    customer: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
    city: s.city,
    service_type: s.service_type,
    old_date: s.scheduled_date,
    new_date: newDate,
  }));

  if (!confirmed) {
    return {
      proposal: true,
      would_move_to: newDate,
      stop_count: stops.length,
      reason: reason || null,
      stops,
      note: `Would move ${stops.length} stop(s) to ${newDate}. Re-call with confirmed:true to apply.`,
    };
  }

  for (const s of services) {
    const oldDate = s.scheduled_date;
    await db('scheduled_services').where('id', s.id).update({
      scheduled_date: newDate,
      notes: reason ? `${s.notes || ''}\nMoved from ${oldDate}: ${reason}`.trim() : s.notes,
      updated_at: new Date(),
    });
  }

  logger.info(`[intelligence-bar:schedule] Moved ${stops.length} stops to ${newDate}`);

  return {
    success: true,
    moved_count: stops.length,
    new_date: newDate,
    stops,
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

  if (!confirmed) {
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
    if (aIds.length) await trx('scheduled_services').whereIn('id', aIds).update({ technician_id: null, updated_at: new Date() });
    if (bIds.length) await trx('scheduled_services').whereIn('id', bIds).update({ technician_id: techA.id, updated_at: new Date() });
    if (aIds.length) await trx('scheduled_services').whereIn('id', aIds).update({ technician_id: techB.id, updated_at: new Date() });
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
    const dow = d.getDay();
    if (dow !== 0) { // skip Sundays
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
    }
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
    const c = await db('customers').where('id', customer_id).select('lat', 'lng', 'address_line1', 'city', 'state', 'zip').first();
    if (c?.lat && c?.lng) { lat = parseFloat(c.lat); lng = parseFloat(c.lng); }
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
