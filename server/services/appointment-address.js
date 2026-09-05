const { stopBaseKey, lockStop } = require('./visit-groups');
const { lockTechDays } = require('./scheduling/tech-day-lock');
const { recordAuditEvent } = require('./audit-log');
const { dateOnly } = require('./visit-groups');

const terminal = ['completed', 'cancelled', 'skipped', 'no_show'];
const retry = () => Object.assign(new Error('Appointments changed while saving. Reload and choose the address again.'), { statusCode: 409, isOperational: true });

// The template remains the address source for future recurrence generation.
// Existing completed history stays intact except the explicitly edited row
// and that template. A grouped stop keeps all its services at one property.
async function planAppointmentAddress(conn, serviceId, propertyId) {
  const anchor = await conn('scheduled_services').where({ id: serviceId }).first();
  if (!anchor) throw Object.assign(new Error('Appointment not found'), { statusCode: 404 });
  const parentId = anchor.recurring_parent_id || (anchor.is_recurring ? anchor.id : null);
  let rows = await conn('scheduled_services').where({ customer_id: anchor.customer_id })
    .where((q) => {
      q.where('id', anchor.id);
      if (parentId) q.orWhere('id', parentId).orWhere((children) => children
        .where('recurring_parent_id', parentId).whereNotIn('status', terminal));
    }).orderBy('id');
  const visitIds = [...new Set(rows.map((row) => row.visit_id).filter(Boolean))];
  if (visitIds.length) {
    const members = await conn('scheduled_services').whereIn('visit_id', visitIds);
    if (members.some((row) => row.customer_id !== anchor.customer_id)) throw retry();
    rows = [...new Map([...rows, ...members].map((row) => [row.id, row])).values()]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  const visits = visitIds.length ? await conn('service_visits').whereIn('id', visitIds).orderBy('id') : [];
  const stopKeys = [...new Set(rows.flatMap((row) => [row.property_id, propertyId].map((id) => stopBaseKey({
    propertyId: id, customerId: row.customer_id, scheduledDate: row.scheduled_date,
  }))).concat(visits.map((visit) => visit.stop_base_key)))].sort();
  return { anchor, parentId, propertyId, rows, visits, stopKeys };
}

// Called after the date-wide occupancy locks, before maintenance/comms/rows.
async function lockAppointmentAddress(trx, plan, updates = {}) {
  const fences = plan.rows.flatMap((row) => [row.technician_id, updates.technician_id].flatMap((techId) =>
    [row.scheduled_date, updates.scheduled_date].filter(Boolean).map((date) => ({ techId, date: dateOnly(date) }))));
  await lockTechDays(trx, fences);
  const keys = new Set(plan.stopKeys);
  if (updates.scheduled_date) {
    for (const row of plan.rows) {
      for (const propertyId of [row.property_id, plan.propertyId]) keys.add(stopBaseKey({
        propertyId, customerId: row.customer_id, scheduledDate: updates.scheduled_date,
      }));
    }
  }
  for (const key of [...keys].sort()) await lockStop(trx, key);
}

async function applyAppointmentAddress(trx, plan, actorId) {
  const fresh = await planAppointmentAddress(trx, plan.anchor.id, plan.propertyId);
  const fingerprint = (p) => JSON.stringify(p.rows.map((row) => [row.id, row.customer_id, row.recurring_parent_id,
    row.property_id, dateOnly(row.scheduled_date), row.technician_id, row.visit_id, row.status]));
  if (fingerprint(fresh) !== fingerprint(plan) || JSON.stringify(fresh.stopKeys) !== JSON.stringify(plan.stopKeys)) throw retry();
  const locked = await trx('scheduled_services').whereIn('id', plan.rows.map((row) => row.id)).orderBy('id').forUpdate();
  if (fingerprint({ rows: locked }) !== fingerprint(plan)) throw retry();
  const property = await trx('customer_properties').where({
    id: plan.propertyId, customer_id: plan.anchor.customer_id, active: true,
  }).forShare().first();
  if (!property || !property.address_line1) {
    throw Object.assign(new Error('Choose an active address belonging to this customer.'), { statusCode: 422, isOperational: true });
  }
  const stamp = {
    property_id: property.id,
    service_address_line1: property.address_line1,
    service_address_line2: property.address_line2 || '',
    service_address_city: property.city || '',
    service_address_state: property.state || '',
    service_address_zip: property.zip || '',
    lat: property.latitude ?? null,
    lng: property.longitude ?? null,
    pre_service_brief: null,
    pre_service_brief_type: null,
    pre_service_brief_generated_at: null,
    updated_at: trx.fn.now(),
  };
  await trx('scheduled_services').whereIn('id', locked.map((row) => row.id)).update(stamp);
  for (const visit of fresh.visits) {
    const key = stopBaseKey({ propertyId: property.id, customerId: visit.customer_id, scheduledDate: visit.scheduled_date });
    if (key === visit.stop_base_key) continue;
    const maximum = await trx('service_visits').where({ stop_base_key: key }).max('stop_seq as max').first();
    await trx('service_visits').where({ id: visit.id }).update({
      property_id: property.id, stop_base_key: key, stop_seq: Number(maximum?.max || 0) + 1,
    });
  }
  await recordAuditEvent({
    actor_type: 'admin', actor_id: actorId, action: 'appointment_address_changed',
    resource_type: 'scheduled_service', resource_id: plan.anchor.id,
    metadata: { property_id: property.id, scheduled_service_ids: locked.map((row) => row.id), parent_id: plan.parentId },
    critical: true, trx,
  });
  return locked.map((row) => row.id);
}

module.exports = { planAppointmentAddress, lockAppointmentAddress, applyAppointmentAddress };
