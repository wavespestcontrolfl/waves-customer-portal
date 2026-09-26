const { inheritReferenceUnit, premiseStampConflicts } = require('./stamped-address');
const { lockTechDays } = require('./scheduling/tech-day-lock');
const { etDateString } = require('../utils/datetime-et');
const { toDateStr } = require('./auto-dispatch/dates');
const { recurringServiceAddress } = require('./booking/visit-financial-stamps');
const {
  planAppointmentAddress,
  lockAppointmentAddress,
  applyAppointmentAddress,
} = require('./appointment-address');
const { roundDecimal } = require('../../shared/proposal-bid.cjs');

const VISIT_FIELDS = [
  'id', 'property_id', 'technician_id', 'scheduled_date', 'status', 'lat', 'lng', 'visit_id',
  'auto_dispatch_locked', 'auto_dispatch_excluded',
  'is_recurring', 'recurring_parent_id',
  'service_address_line1', 'service_address_line2', 'service_address_city',
  'service_address_state', 'service_address_zip',
];

const pinAtScale = (value, places) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? roundDecimal(numeric, places) : NaN;
};
const isProtected = row => Boolean(row.auto_dispatch_locked || row.auto_dispatch_excluded);

function retry(message = 'Appointments changed while saving. Reload and review them.') {
  return Object.assign(new Error(message), {
    statusCode: 409, status: 409, code: 'visit_changed', isOperational: true,
  });
}

function visitStamp(row) {
  return {
    service_address_line1: row.service_address_line1,
    service_address_line2: row.service_address_line2,
    service_address_city: row.service_address_city,
    service_address_state: row.service_address_state,
    service_address_zip: row.service_address_zip,
  };
}

function visitMatchesPrimary(row, customer, primary) {
  if (row.property_id != null && String(row.property_id) !== String(primary.id)) return false;
  const reference = {
    service_address_line1: customer.address_line1,
    service_address_line2: customer.address_line2,
    service_address_city: customer.city,
    service_address_state: customer.state,
    service_address_zip: customer.zip,
  };
  const original = visitStamp(row);
  const stamped = inheritReferenceUnit({
    ...original,
    service_address_line1: original.service_address_line1 || reference.service_address_line1,
  }, reference);
  if (premiseStampConflicts(stamped, reference)) return false;
  const stampedState = String(original.service_address_state || '').trim().toLowerCase();
  return !stampedState || stampedState === String(customer.state || '').trim().toLowerCase();
}

function visitPinIsSafeToReplace(row, customer) {
  if (row.lat == null || row.lng == null) return true;
  const priorLat = Number(customer.latitude);
  const priorLng = Number(customer.longitude);
  const rowLat = Number(row.lat);
  const rowLng = Number(row.lng);
  const rowHasPair = Number.isFinite(rowLat) && Number.isFinite(rowLng) && rowLat !== 0 && rowLng !== 0;
  const customerHasPair = customer.latitude != null && customer.longitude != null
    && Number.isFinite(priorLat) && Number.isFinite(priorLng) && priorLat !== 0 && priorLng !== 0;
  return !rowHasPair || (customerHasPair
    && pinAtScale(rowLat, 6) === pinAtScale(priorLat, 6)
    && pinAtScale(rowLng, 6) === pinAtScale(priorLng, 6));
}

function candidateVisits(conn, customerId, { lock = false } = {}) {
  let query = conn('scheduled_services')
    .where({ customer_id: customerId })
    .whereIn('status', ['pending', 'confirmed'])
    .where('scheduled_date', '>=', etDateString())
    .orderBy('id')
    .select(VISIT_FIELDS);
  if (lock) query = query.forUpdate();
  return query;
}

function recurringRoots(conn, customerId, { lock = false } = {}) {
  let query = conn('scheduled_services')
    .where({ customer_id: customerId, is_recurring: true, recurring_ongoing: true })
    .whereNull('recurring_parent_id')
    .orderBy('id')
    .select('*');
  if (lock) query = query.forUpdate();
  return query;
}

function seriesParentId(row) {
  return row.recurring_parent_id || (row.is_recurring ? row.id : null);
}

async function prelockVisitContext(trx, customerId) {
  const visits = await candidateVisits(trx, customerId);
  const roots = await recurringRoots(trx, customerId);
  await lockTechDays(trx, visits.map(row => ({
    techId: row.technician_id,
    date: toDateStr(row.scheduled_date),
  })));
  const seriesIds = [...new Set([
    ...visits.map(seriesParentId), ...roots.map(row => row.id),
  ].filter(Boolean))].map(String).sort();
  for (const parentId of seriesIds) {
    const result = await trx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS locked',
      ['recurring-series-maintenance', parentId]);
    if (result.rows[0]?.locked !== true) {
      throw retry('This recurring plan changed while saving. Reload and review it.');
    }
  }
  return { visits, rootIds: roots.map(row => String(row.id)), seriesIds };
}

function sameVisitFence(before, after) {
  return String(before.id) === String(after.id)
    && String(before.technician_id || '') === String(after.technician_id || '')
    && toDateStr(before.scheduled_date) === toDateStr(after.scheduled_date)
    && String(before.visit_id || '') === String(after.visit_id || '')
    && String(seriesParentId(before) || '') === String(seriesParentId(after) || '');
}

function rowIsEligible(row, customer, primary, verifyPin) {
  return visitMatchesPrimary(row, customer, primary)
    && (!verifyPin || visitPinIsSafeToReplace(row, customer));
}

async function groupedPlans(trx, prelocked, { customer, primary, verifyPin }) {
  if (!verifyPin) return [];
  const candidates = new Map(prelocked.visits.map(row => [String(row.id), row]));
  const anchors = new Map();
  for (const row of prelocked.visits) {
    if (row.visit_id && rowIsEligible(row, customer, primary, true)
      && !anchors.has(String(row.visit_id))) anchors.set(String(row.visit_id), row);
  }
  const groups = [];
  for (const [visitId, anchor] of [...anchors].sort(([a], [b]) => a.localeCompare(b))) {
    const plan = await planAppointmentAddress(trx, anchor.id, primary.id, 'visit');
    const memberIds = plan.rows.map(row => String(row.id));
    if (memberIds.some(id => !candidates.has(id))
      || plan.rows.some(row => isProtected(row) || !rowIsEligible(row, customer, primary, true))) {
      throw retry('A grouped visit is no longer eligible for this location update. Reload and review it.');
    }
    groups.push({ visitId, memberIds, plan });
  }
  return groups;
}

async function lockVisitContext(trx, customerId, prelocked, {
  includeProtected = false, customer, primary, verifyPin = false,
} = {}) {
  const groups = await groupedPlans(trx, prelocked, { customer, primary, verifyPin });
  for (const group of groups) await lockAppointmentAddress(trx, group.plan);

  const visits = await candidateVisits(trx, customerId, { lock: true });
  const roots = await recurringRoots(trx, customerId, { lock: true });
  const changed = visits.length !== prelocked.visits.length
    || visits.some((row, index) => !sameVisitFence(prelocked.visits[index], row))
    || roots.length !== prelocked.rootIds.length
    || roots.some((row, index) => String(row.id) !== prelocked.rootIds[index]);
  if (changed) throw retry();

  if (groups.length) {
    const lockedById = new Map(visits.map(row => [String(row.id), row]));
    if (groups.some(group => group.memberIds.some(id => isProtected(lockedById.get(id))
      || !rowIsEligible(lockedById.get(id), customer, primary, true)))) {
      throw retry('A grouped visit is no longer eligible for this location update. Reload and review it.');
    }
  }
  if (verifyPin) {
    const plannedIds = new Set(groups.flatMap(group => group.memberIds));
    const newlyEligibleGroup = visits.some(row => row.visit_id
      && !plannedIds.has(String(row.id)) && rowIsEligible(row, customer, primary, true));
    if (newlyEligibleGroup) throw retry();
  }

  const rootsById = new Map(roots.map(row => [String(row.id), row]));
  const missingIds = prelocked.seriesIds.filter(id => !rootsById.has(id));
  if (missingIds.length) {
    const parents = await trx('scheduled_services')
      .where({ customer_id: customerId })
      .whereIn('id', missingIds)
      .orderBy('id')
      .forUpdate()
      .select('*');
    if (parents.length !== missingIds.length
      || parents.some((row, index) => String(row.id) !== missingIds[index])) {
      throw retry('Recurring plans changed while saving. Reload and review them.');
    }
    for (const row of parents) rootsById.set(String(row.id), row);
  }
  return {
    visits: includeProtected ? visits : visits.filter(row => !isProtected(row)),
    parents: prelocked.seriesIds.map(id => rootsById.get(id)), groups,
  };
}

async function updatePrimaryVisits(trx, customer, primary, after, latitude, longitude, visitContext, actorId) {
  const ids = visitContext.visits
    .filter(row => !row.visit_id)
    .filter(row => rowIsEligible(row, customer, primary, true))
    .map(row => row.id);
  if (ids.length) {
    await trx('scheduled_services')
      .whereIn('id', ids)
      .whereIn('status', ['pending', 'confirmed'])
      .where('scheduled_date', '>=', etDateString())
      .update({
        property_id: primary.id,
        service_address_line1: after.address_line1,
        service_address_line2: after.address_line2 || null,
        service_address_city: after.city,
        service_address_state: after.state,
        service_address_zip: after.zip,
        lat: latitude,
        lng: longitude,
        zone: null,
        route_order: null,
        pre_service_brief: null,
        pre_service_brief_type: null,
        pre_service_brief_generated_at: null,
        updated_at: new Date(),
      });
  }
  const groupedUpdated = [];
  for (const group of visitContext.groups) {
    groupedUpdated.push(...await applyAppointmentAddress(trx, group.plan, actorId));
  }
  if (visitContext.parents.length) {
    const appointmentAddress = {
      property_id: primary.id,
      service_address_line1: after.address_line1,
      service_address_line2: after.address_line2 || null,
      service_address_city: after.city,
      service_address_state: after.state,
      service_address_zip: after.zip,
      lat: latitude,
      lng: longitude,
      zone: null,
    };
    const matchingParentIds = visitContext.parents.filter(parent => {
      const effective = { ...parent, ...recurringServiceAddress(parent) };
      return rowIsEligible(effective, customer, primary, true);
    }).map(parent => parent.id);
    if (matchingParentIds.length) {
      await trx('scheduled_services')
        .where({ customer_id: customer.id })
        .whereIn('id', matchingParentIds)
        .update({
          recurring_template_overrides: trx.raw(
            "COALESCE(recurring_template_overrides, '{}'::jsonb) || ?::jsonb",
            [JSON.stringify({ appointment_address: appointmentAddress })],
          ),
        });
    }
  }
  return [...ids, ...groupedUpdated];
}

async function clearMatchingPins(trx, customer, primary, storedReview, visitContext) {
  if (storedReview?.latitude == null || storedReview?.longitude == null) {
    return { customer: 0, property: 0, visits: 0, templates: 0 };
  }
  const latitude = Number(storedReview.latitude);
  const longitude = Number(storedReview.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { customer: 0, property: 0, visits: 0, templates: 0 };
  }
  const customerCount = await trx('customers')
    .where({ id: customer.id, latitude, longitude })
    .update({ latitude: null, longitude: null, updated_at: new Date() });
  const propertyCount = await trx('customer_properties')
    .where({ id: primary.id, customer_id: customer.id, active: true, is_primary: true, latitude, longitude })
    .update({ latitude: null, longitude: null, updated_at: new Date() });
  const visitLatitude = pinAtScale(latitude, 6);
  const visitLongitude = pinAtScale(longitude, 6);
  const visitIds = visitContext.visits
    .filter(row => visitMatchesPrimary(row, customer, primary))
    .filter(row => pinAtScale(row.lat, 6) === visitLatitude && pinAtScale(row.lng, 6) === visitLongitude)
    .map(row => row.id);
  const visits = visitIds.length ? await trx('scheduled_services')
    .whereIn('id', visitIds)
    .where({ customer_id: customer.id, lat: visitLatitude, lng: visitLongitude })
    .whereIn('status', ['pending', 'confirmed'])
    .where('scheduled_date', '>=', etDateString())
    .update({ lat: null, lng: null, route_order: null, updated_at: new Date() }) : 0;
  let templates = 0;
  for (const parent of visitContext.parents) {
    const effective = { ...parent, ...recurringServiceAddress(parent) };
    if (!visitMatchesPrimary(effective, customer, primary)
      || pinAtScale(effective.lat, 6) !== visitLatitude
      || pinAtScale(effective.lng, 6) !== visitLongitude) continue;
    templates += await trx('scheduled_services')
      .where({ id: parent.id, customer_id: customer.id })
      .update({
        recurring_template_overrides: trx.raw(
          "COALESCE(recurring_template_overrides, '{}'::jsonb) || ?::jsonb",
          [JSON.stringify({ appointment_address: {
            ...recurringServiceAddress(parent), lat: null, lng: null,
          } })],
        ),
      });
  }
  return { customer: customerCount, property: propertyCount, visits, templates };
}

module.exports = {
  prelockVisitContext,
  lockVisitContext,
  updatePrimaryVisits,
  clearMatchingPins,
  pinAtScale,
};
