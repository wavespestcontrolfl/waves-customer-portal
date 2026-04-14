// server/services/dispatch/schedule-bridge.js
// Bridges the original portal tables (scheduled_services, customers, technicians)
// into the dispatch AI tables (dispatch_jobs, dispatch_technicians).

let db;
function getDb() {
  if (!db) db = require('../../models/db');
  return db;
}

const logger = require('../logger');

/**
 * Sync today's (or a given date's) scheduled_services into dispatch_jobs.
 *
 * Column mapping:
 *   scheduled_services.id           → dispatch_jobs.sheet_row_id
 *   customers.first_name + last_name → dispatch_jobs.customer_name
 *   customers.address_line1          → dispatch_jobs.address
 *   customers.city                   → dispatch_jobs.city
 *   customers.zip                    → dispatch_jobs.zip
 *   scheduled_services.lat/lng       → dispatch_jobs.lat/lng (from migration 028)
 *   scheduled_services.service_type  → dispatch_jobs.service_type
 *   customers.waveguard_tier         → dispatch_jobs.waveguard_tier
 *   customers.monthly_rate           → dispatch_jobs.estimated_revenue (fallback)
 *   scheduled_services.technician_id → dispatch_jobs.assigned_tech_id (via tech slug lookup)
 *   scheduled_services.window_start  → dispatch_jobs.scheduled_time
 *   scheduled_services.notes         → dispatch_jobs.notes
 */
async function syncJobsFromSchedule(date) {
  const d = date || new Date().toISOString().split('T')[0];
  const knex = getDb();

  const services = await knex('scheduled_services')
    .where('scheduled_services.scheduled_date', d)
    .whereNotIn('scheduled_services.status', ['cancelled'])
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
    .select(
      'scheduled_services.id as svc_id',
      'scheduled_services.service_type',
      'scheduled_services.status',
      'scheduled_services.window_start',
      'scheduled_services.notes',
      'scheduled_services.route_order',
      'scheduled_services.lat',
      'scheduled_services.lng',
      'scheduled_services.is_recurring',
      'scheduled_services.estimated_duration_minutes',
      'customers.first_name',
      'customers.last_name',
      'customers.address_line1',
      'customers.city',
      'customers.zip',
      'customers.waveguard_tier',
      'customers.monthly_rate',
      'customers.phone as customer_phone',
      'customers.id as cust_id',
      'technicians.name as tech_name',
      'technicians.id as tech_id',
    );

  let synced = 0;

  for (const svc of services) {
    // Resolve the tech in dispatch_technicians by name-slug
    let dispatchTechId = null;
    if (svc.tech_name) {
      const slug = svc.tech_name.toLowerCase().replace(/\s+/g, '-');
      const dispatchTech = await knex('dispatch_technicians').where('slug', slug).first();
      dispatchTechId = dispatchTech?.id || null;
    }

    // Estimate revenue: use monthly_rate as a proxy, or fall back to service-type map
    const revenueMap = {
      'lawn care': 75, 'quarterly pest': 120, 'pest control': 110, 'mosquito': 89,
      'tree & shrub': 130, 'termite': 200, 'rodent': 95, 'one-time pest': 149,
    };
    const svcType = (svc.service_type || '').toLowerCase();
    const estimatedRevenue = parseFloat(svc.monthly_rate || 0) > 0
      ? parseFloat(svc.monthly_rate)
      : revenueMap[svcType] || Object.entries(revenueMap).find(([k]) => svcType.includes(k))?.[1] || 95;

    // Determine job category
    let jobCategory = 'recurring';
    if (svc.is_recurring === false) jobCategory = 'one_time';
    if (svcType.includes('estimate') || svcType.includes('inspection')) jobCategory = 'estimate';
    if (svcType.includes('callback') || svcType.includes('retreat')) jobCategory = 'callback';

    const jobData = {
      sheet_row_id: svc.svc_id, // link back to scheduled_services.id
      customer_name: `${svc.first_name || ''} ${svc.last_name || ''}`.trim() || 'Unknown',
      address: svc.address_line1 || '',
      city: svc.city || '',
      zip: svc.zip || '',
      lat: svc.lat ? parseFloat(svc.lat) : null,
      lng: svc.lng ? parseFloat(svc.lng) : null,
      service_type: svc.service_type?.toLowerCase().replace(/[\s-]+/g, '_') || 'general_pest',
      job_category: jobCategory,
      waveguard_tier: svc.waveguard_tier ? svc.waveguard_tier.toLowerCase() : null,
      assigned_tech_id: dispatchTechId,
      scheduled_date: d,
      scheduled_time: svc.window_start || '09:00',
      estimated_duration: parseInt(svc.estimated_duration_minutes) || 45,
      estimated_revenue: estimatedRevenue,
      route_position: svc.route_order || null,
      status: svc.status === 'completed' ? 'complete' : 'scheduled',
      notes: svc.notes || null,
      updated_at: new Date(),
    };

    // Upsert by sheet_row_id (atomic ON CONFLICT to avoid race conditions)
    await knex.raw(`
      INSERT INTO dispatch_jobs (sheet_row_id, customer_name, address, city, zip, lat, lng, service_type, job_category, waveguard_tier, assigned_tech_id, scheduled_date, scheduled_time, estimated_duration, estimated_revenue, route_position, status, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (sheet_row_id) DO UPDATE SET
        customer_name = EXCLUDED.customer_name, address = EXCLUDED.address, city = EXCLUDED.city,
        zip = EXCLUDED.zip, lat = EXCLUDED.lat, lng = EXCLUDED.lng, service_type = EXCLUDED.service_type,
        job_category = EXCLUDED.job_category, waveguard_tier = EXCLUDED.waveguard_tier,
        assigned_tech_id = EXCLUDED.assigned_tech_id, scheduled_date = EXCLUDED.scheduled_date,
        scheduled_time = EXCLUDED.scheduled_time, estimated_duration = EXCLUDED.estimated_duration,
        estimated_revenue = EXCLUDED.estimated_revenue, route_position = EXCLUDED.route_position,
        status = EXCLUDED.status, notes = EXCLUDED.notes, updated_at = EXCLUDED.updated_at
    `, [
      svc.svc_id, jobData.customer_name, jobData.address, jobData.city, jobData.zip,
      jobData.lat, jobData.lng, jobData.service_type, jobData.job_category, jobData.waveguard_tier,
      jobData.assigned_tech_id, jobData.scheduled_date, jobData.scheduled_time, jobData.estimated_duration,
      jobData.estimated_revenue, jobData.route_position, jobData.status, jobData.notes, jobData.updated_at,
    ]);
    synced++;
  }

  logger.info(`Schedule bridge: synced ${synced} jobs for ${d}`);
  return { synced, date: d };
}

/**
 * Sync technicians from the portal's technicians table into dispatch_technicians.
 * Only updates name, active — preserves licenses/service_lines/territory enrichment.
 */
async function syncTechnicians() {
  const knex = getDb();
  const portalTechs = await knex('technicians').select('*');

  let synced = 0;
  for (const tech of portalTechs) {
    const slug = (tech.name || '').toLowerCase().replace(/\s+/g, '-');
    if (!slug) continue;

    const existing = await knex('dispatch_technicians').where('slug', slug).first();
    if (existing) {
      // Only update name and active status — preserve enriched fields
      await knex('dispatch_technicians').where('id', existing.id).update({
        name: tech.name,
        active: tech.active !== false,
        updated_at: new Date(),
      });
    } else {
      // Create new dispatch_technician with defaults
      await knex('dispatch_technicians').insert({
        name: tech.name,
        slug,
        active: tech.active !== false,
        licenses: JSON.stringify([]),
        service_lines: JSON.stringify(['general_pest']),
        territory_zips: JSON.stringify([]),
        territory_label: '',
      });
    }
    synced++;
  }

  logger.info(`Schedule bridge: synced ${synced} technicians`);
  return { synced };
}

module.exports = { syncJobsFromSchedule, syncTechnicians };
