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

const SCHEDULE_TOOLS = [
  {
    name: 'optimize_all_routes',
    description: `Run full route optimization for a date using Google Routes API. Reorders all technician stops to minimize total drive time and distance. Returns before/after comparison with miles saved.`,
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
    description: `Optimize route for a single technician on a given date. Reorders just their stops.`,
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
    description: `Assign a technician to one or more unassigned services. Useful when the operator says "give those to Adam" or "assign the Parrish stops to Jose."`,
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
    description: `Move one or more scheduled services to a different date. Use when operator says "move the Lakewood stops to Thursday" or "push these to next week."`,
    input_schema: {
      type: 'object',
      properties: {
        service_ids: { type: 'array', items: { type: 'string' }, description: 'Scheduled service IDs to move' },
        new_date: { type: 'string', description: 'YYYY-MM-DD target date' },
        reason: { type: 'string' },
      },
      required: ['service_ids', 'new_date'],
    },
  },
  {
    name: 'swap_tech_assignments',
    description: `Swap all stops between two technicians for a date. Use when "give Adam's route to Jose and Jose's to Adam."`,
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
      case 'optimize_all_routes': return await optimizeAllRoutes(input.date);
      case 'optimize_tech_route': return await optimizeTechRoute(input.date, input.technician_name);
      case 'assign_technician': return await assignTechnician(input.service_ids, input.technician_name);
      case 'move_stops_to_day': return await moveStopsToDay(input.service_ids, input.new_date, input.reason);
      case 'swap_tech_assignments': return await swapTechAssignments(input.date, input.tech_a_name, input.tech_b_name);
      case 'find_schedule_gaps': return await findScheduleGaps(input);
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


async function optimizeAllRoutes(date) {
  let RouteOptimizer;
  try { RouteOptimizer = require('../route-optimizer'); } catch {
    return { error: 'Route optimizer not available' };
  }

  const services = await db('scheduled_services')
    .where({ scheduled_date: date })
    .whereNotIn('status', ['cancelled', 'completed'])
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

  // Apply the new order
  if (result.orderedStops) {
    for (let i = 0; i < result.orderedStops.length; i++) {
      await db('scheduled_services').where('id', result.orderedStops[i].id).update({ route_order: i + 1, updated_at: new Date() });
    }
  }

  const savedMiles = Math.max(0, Math.round((result.unoptimizedDistanceMeters - result.totalDistanceMeters) / 1609.34));
  const savedPct = result.unoptimizedDistanceMeters > 0
    ? Math.round(((result.unoptimizedDistanceMeters - result.totalDistanceMeters) / result.unoptimizedDistanceMeters) * 100)
    : 0;

  logger.info(`[intelligence-bar:schedule] Optimized routes for ${date}: saved ${savedMiles} miles (${savedPct}%)`);

  return {
    success: true,
    date,
    total_stops: stopsWithCoords.length,
    total_miles_before: Math.round(result.unoptimizedDistanceMeters / 1609.34),
    total_miles_after: Math.round(result.totalDistanceMeters / 1609.34),
    miles_saved: savedMiles,
    percent_saved: savedPct,
    total_drive_minutes: Math.round((result.totalDurationSeconds || 0) / 60),
    source: result.source, // 'google_routes' or 'nearest_neighbor'
  };
}


async function optimizeTechRoute(date, techName) {
  const tech = await db('technicians').whereILike('name', `%${techName}%`).first();
  if (!tech) return { error: `Technician "${techName}" not found` };

  let RouteOptimizer;
  try { RouteOptimizer = require('../route-optimizer'); } catch {
    return { error: 'Route optimizer not available' };
  }

  const services = await db('scheduled_services')
    .where({ scheduled_date: date, technician_id: tech.id })
    .whereNotIn('status', ['cancelled', 'completed'])
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

  if (result.orderedStops) {
    for (let i = 0; i < result.orderedStops.length; i++) {
      await db('scheduled_services').where('id', result.orderedStops[i].id).update({ route_order: i + 1, updated_at: new Date() });
    }
  }

  const savedMiles = Math.max(0, Math.round((result.unoptimizedDistanceMeters - result.totalDistanceMeters) / 1609.34));

  return {
    success: true,
    tech: tech.name,
    date,
    stops: stopsWithCoords.length,
    miles_before: Math.round(result.unoptimizedDistanceMeters / 1609.34),
    miles_after: Math.round(result.totalDistanceMeters / 1609.34),
    miles_saved: savedMiles,
    drive_minutes: Math.round((result.totalDurationSeconds || 0) / 60),
    ordered_stops: (result.orderedStops || []).map(s => ({
      customer: s.customerName,
      service: s.serviceType,
    })),
  };
}


async function assignTechnician(serviceIds, techName) {
  const tech = await db('technicians').whereILike('name', `%${techName}%`).first();
  if (!tech) return { error: `Technician "${techName}" not found` };

  const count = await db('scheduled_services')
    .whereIn('id', serviceIds)
    .update({ technician_id: tech.id, updated_at: new Date() });

  const services = await db('scheduled_services')
    .whereIn('id', serviceIds)
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select('scheduled_services.id', 'customers.first_name', 'customers.last_name', 'scheduled_services.service_type');

  logger.info(`[intelligence-bar:schedule] Assigned ${count} services to ${tech.name}`);

  return {
    success: true,
    assigned_count: count,
    technician: tech.name,
    services: services.map(s => ({
      id: s.id,
      customer: `${s.first_name} ${s.last_name}`,
      service_type: s.service_type,
    })),
  };
}


async function moveStopsToDay(serviceIds, newDate, reason) {
  const services = await db('scheduled_services')
    .whereIn('id', serviceIds)
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.*',
      'customers.first_name', 'customers.last_name', 'customers.city',
    );

  const moved = [];
  for (const s of services) {
    const oldDate = s.scheduled_date;
    await db('scheduled_services').where('id', s.id).update({
      scheduled_date: newDate,
      notes: reason ? `${s.notes || ''}\nMoved from ${oldDate}: ${reason}`.trim() : s.notes,
      updated_at: new Date(),
    });
    moved.push({
      id: s.id,
      customer: `${s.first_name} ${s.last_name}`,
      city: s.city,
      service_type: s.service_type,
      old_date: oldDate,
      new_date: newDate,
    });
  }

  logger.info(`[intelligence-bar:schedule] Moved ${moved.length} stops to ${newDate}`);

  return {
    success: true,
    moved_count: moved.length,
    new_date: newDate,
    stops: moved,
  };
}


async function swapTechAssignments(date, techAName, techBName) {
  const techA = await db('technicians').whereILike('name', `%${techAName}%`).first();
  const techB = await db('technicians').whereILike('name', `%${techBName}%`).first();
  if (!techA) return { error: `Tech "${techAName}" not found` };
  if (!techB) return { error: `Tech "${techBName}" not found` };

  // Get both sets of services
  const aServices = await db('scheduled_services').where({ scheduled_date: date, technician_id: techA.id }).whereNotIn('status', ['cancelled', 'completed']);
  const bServices = await db('scheduled_services').where({ scheduled_date: date, technician_id: techB.id }).whereNotIn('status', ['cancelled', 'completed']);

  // Use a temp ID to avoid conflicts
  const tempId = '00000000-0000-0000-0000-000000000000';
  await db('scheduled_services').whereIn('id', aServices.map(s => s.id)).update({ technician_id: tempId });
  await db('scheduled_services').whereIn('id', bServices.map(s => s.id)).update({ technician_id: techA.id });
  await db('scheduled_services').where({ technician_id: tempId }).update({ technician_id: techB.id });

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

  const from = date || date_from || new Date().toISOString().split('T')[0];
  const to = date || date_to || (() => { const d = new Date(); d.setDate(d.getDate() + 6); return d.toISOString().split('T')[0]; })();

  const techs = await db('technicians').where({ active: true }).select('id', 'name');

  const services = await db('scheduled_services')
    .whereBetween('scheduled_date', [from, to])
    .whereNotIn('status', ['cancelled'])
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
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
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
    .whereNotIn('scheduled_services.status', ['cancelled'])
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
    estRevenue += (s.price || 125);

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
    .whereNotIn('scheduled_services.status', ['cancelled'])
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


async function cancelAndRescheduleFarOut(input) {
  const { days_threshold = 30, service_type, reschedule_to_range } = input;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days_threshold);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  let query = db('scheduled_services')
    .where('scheduled_date', '>', cutoffStr)
    .whereNotIn('status', ['cancelled', 'completed'])
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
