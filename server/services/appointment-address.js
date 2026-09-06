const { stopBaseKey, lockStop, frozenVisitVerdict } = require('./visit-groups');
const { recordAuditEvent } = require('./audit-log');
const { dateOnly } = require('./visit-groups');

const { recurringServiceAddress } = require('./booking/visit-financial-stamps');

const { JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');
const retry = () => Object.assign(new Error('Appointments changed while saving. Reload and choose the address again.'), { statusCode: 409, isOperational: true });

// The template remains the address source for future recurrence generation.
// Completed history stays intact except the explicitly edited row. Future
// defaults live in template overrides. A grouped stop stays at one property.
async function planAppointmentAddress(conn, serviceId, propertyId, scope = 'series') {
  const anchor = await conn('scheduled_services').where({ id: serviceId }).first();
  if (!anchor) throw Object.assign(new Error('Appointment not found'), { statusCode: 404, isOperational: true });
  // A stale editor must not relocate the placeholder left by a reschedule.
  if (anchor.status === 'rescheduled') throw retry();
  const parentId = scope === 'visit' ? null : (anchor.recurring_parent_id || (anchor.is_recurring ? anchor.id : null));
  let rows = await conn('scheduled_services').where({ customer_id: anchor.customer_id })
    .where((q) => {
      q.where('id', anchor.id);
      if (parentId) q.orWhere('id', parentId).orWhere((children) => children
        .where('recurring_parent_id', parentId).whereNotIn('status', JOIN_INELIGIBLE_STATUSES));
    }).orderBy('id');
  const visitIds = [...new Set(rows.filter((row) => row.id === anchor.id || !JOIN_INELIGIBLE_STATUSES.includes(row.status))
    .map((row) => row.visit_id).filter(Boolean))];
  if (visitIds.length) {
    const members = await conn('scheduled_services').whereIn('visit_id', visitIds).whereNotIn('status', JOIN_INELIGIBLE_STATUSES);
    if (members.some((row) => row.customer_id !== anchor.customer_id)) throw retry();
    rows = [...new Map([...rows, ...members].map((row) => [row.id, row])).values()]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  const visits = visitIds.length ? await conn('service_visits').whereIn('id', visitIds).orderBy('id') : [];
  const stopKeys = [...new Set(rows.flatMap((row) => [row.property_id, propertyId].map((id) => stopBaseKey({
    propertyId: id, customerId: row.customer_id, scheduledDate: row.scheduled_date,
  }))).concat(visits.map((visit) => visit.stop_base_key)))].sort();
  return { anchor, parentId, propertyId, scope, rows, visits, stopKeys };
}

// Called after occupancy, tech-day, maintenance and comms locks, before stop/appointment rows.
async function lockAppointmentAddress(trx, plan, updates = {}) {
  // Match createOrJoinVisit: customer row before every stop lock.
  await trx('customers').where({ id: plan.anchor.customer_id }).forNoKeyUpdate().first('id');
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
  const fresh = await planAppointmentAddress(trx, plan.anchor.id, plan.propertyId, plan.scope);
  const fingerprint = (p) => JSON.stringify(p.rows.map((row) => [row.id, row.customer_id, row.recurring_parent_id,
    row.property_id, dateOnly(row.scheduled_date), row.technician_id, row.visit_id, row.status]));
  if (fingerprint(fresh) !== fingerprint(plan) || JSON.stringify(fresh.stopKeys) !== JSON.stringify(plan.stopKeys)) throw retry();
  const property = await trx('customer_properties').where({
    id: plan.propertyId, customer_id: plan.anchor.customer_id, active: true,
  }).forShare().first();
  if (!property || !['address_line1', 'city', 'state', 'zip'].every((field) =>
    typeof property[field] === 'string' && property[field].trim())) {
    throw Object.assign(new Error('Choose an active customer address with a street, city, state and ZIP code.'), { statusCode: 422, isOperational: true });
  }
  const locked = await trx('scheduled_services').whereIn('id', plan.rows.map((row) => row.id)).orderBy('id').forUpdate();
  if (fingerprint({ rows: locked }) !== fingerprint(plan)) throw retry();
  const addressRows = locked.filter((row) => row.id === plan.anchor.id || !JOIN_INELIGIBLE_STATUSES.includes(row.status));
  for (const visit of fresh.visits) {
    const verdict = await frozenVisitVerdict(trx, visit.id);
    // A retained historical member must never be left at a different property
    // from its visit parent, even if that visit has no surviving artifact.
    const omittedMember = await trx('scheduled_services').where({ visit_id: visit.id })
      .whereNotIn('id', addressRows.map((row) => row.id)).first('id');
    if (verdict.frozen || omittedMember) {
      throw Object.assign(new Error('This plan includes a visit with completed services, issued links or completion work. Its address cannot be moved here.'), {
        statusCode: 409, isOperational: true, code: 'VISIT_FROZEN_MOVE_UNSUPPORTED',
        reason: verdict.reason || 'historical_member',
      });
    }
  }
  const stamp = {
    property_id: property.id,
    service_address_line1: property.address_line1,
    service_address_line2: property.address_line2 || '',
    service_address_city: property.city,
    service_address_state: property.state,
    service_address_zip: property.zip,
    zone: null,
    route_order: null,
    lat: property.latitude ?? null,
    lng: property.longitude ?? null,
    pre_service_brief: null,
    pre_service_brief_type: null,
    pre_service_brief_generated_at: null,
    updated_at: trx.fn.now(),
  };
  await trx('scheduled_services').whereIn('id', addressRows.map((row) => row.id)).update(stamp);
  if (plan.parentId) {
    await trx('scheduled_services').where({ id: plan.parentId, customer_id: plan.anchor.customer_id }).update({
      recurring_template_overrides: trx.raw(
        "COALESCE(recurring_template_overrides, '{}'::jsonb) || ?::jsonb",
        [JSON.stringify({ appointment_address: recurringServiceAddress(stamp) })],
      ),
    });
  }
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

// Rebuild only WDO research; replaying booking automations could send prep.
async function refreshAppointmentAddressBriefs(conn, ids) {
  if (!ids.length) return;
  const tagger = require('./appointment-tagger');
  const rows = await conn('scheduled_services as ss')
    .leftJoin('customers as c', 'ss.customer_id', 'c.id')
    .whereIn('ss.id', ids).whereNotIn('ss.status', JOIN_INELIGIBLE_STATUSES)
    .select('ss.*', 'c.first_name', 'c.last_name', 'c.address_line1', 'c.city', 'c.zip');
  for (const row of rows) {
    if (tagger.classifyAppointmentType(row.service_type).tag === 'wdo_inspection') {
      await tagger.triggerWDOPrep(row);
    }
  }
}

module.exports = { planAppointmentAddress, lockAppointmentAddress, applyAppointmentAddress, refreshAppointmentAddressBriefs };
