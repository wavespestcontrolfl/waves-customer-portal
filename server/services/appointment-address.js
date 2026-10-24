const { stopBaseKey, lockStop, frozenVisitVerdict } = require('./visit-groups');
const { recordAuditEvent } = require('./audit-log');
const { dateOnly } = require('./visit-groups');

const { recurringServiceAddress } = require('./booking/visit-financial-stamps');

const { JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');
// The address future generated visits copy (recurringServiceAddress reads the
// template row unless an override names one). A series move points it at the
// destination. A one-visit move of the template row itself keeps the pre-move
// address, so only this visit moves (ops 2026-10-21: a Saturday move on a
// quarterly template would have sent January there too).
function futureTemplateDefault(plan, locked, addressRows, stamp) {
  if (plan.parentId) return { id: plan.parentId, address: recurringServiceAddress(stamp) };
  const anchor = locked.find((row) => row.id === plan.anchor.id);
  if (plan.scope !== 'visit' || !anchor || !anchor.is_recurring || anchor.recurring_parent_id) return null;
  if (!addressRows.some((row) => row.id === anchor.id) || String(anchor.property_id ?? '') === String(stamp.property_id)) return null;
  let overrides = anchor.recurring_template_overrides;
  if (typeof overrides === 'string') {
    try { overrides = JSON.parse(overrides); } catch { overrides = null; }
  }
  return overrides?.appointment_address ? null : { id: anchor.id, address: recurringServiceAddress(anchor) };
}

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
  // A package visit 2 is the same treatment at the same property: an address
  // correction on visit 1 carries to it in every scope (it is neither
  // recurring nor grouped), including one parked 'rescheduled' by a customer
  // request, which is rebooked later from this row.
  const kids = await conn('scheduled_services').where({ customer_id: anchor.customer_id, parent_service_id: anchor.id,
    source_action: 'package_followup_auto' }).whereIn('status', ['pending', 'confirmed', 'rescheduled']);
  const packageChildIds = kids.filter((row) => row.source_action === 'package_followup_auto').map((row) => row.id);
  if (packageChildIds.length) rows = [...new Map([...rows, ...kids.filter((row) => packageChildIds.includes(row.id))].map((row) => [row.id, row])).values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
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
  return { anchor, parentId, propertyId, scope, rows, visits, stopKeys, packageChildIds };
}

// Called after occupancy, tech-day, maintenance and comms locks, before stop/appointment rows.
async function lockAppointmentAddress(trx, plan, updates = {}, { noWait = false } = {}) {
  // Customer row before every stop lock (the visit writers' order).
  await trx('customers').where({ id: plan.anchor.customer_id }).forNoKeyUpdate().first('id');
  const keys = new Set(plan.stopKeys);
  if (updates.scheduled_date) {
    for (const row of plan.rows) {
      for (const propertyId of [row.property_id, plan.propertyId]) keys.add(stopBaseKey({
        propertyId, customerId: row.customer_id, scheduledDate: updates.scheduled_date,
      }));
    }
  }
  for (const key of [...keys].sort()) await lockStop(trx, key, { noWait });
}

// Every visit the plan moves to another property and that carries a limited area add-on (its own service or an add-on row) is
// judged at the DESTINATION property (area-addon-limits assertMovedVisitLimitsOpen), inside the caller's transaction on the
// locked rows: the anchor, grouped siblings and series rows alike, for every caller (Update Details, the Intelligence Bar, the
// geocode review). One batched row read; a plan with no area add-on reads nothing more.
// `edited` ({ id, ownKey, rowKeys }): the visit the SAME save edits. Its add-on rows are replaced later in that save, so what it
// will carry (the posted own service and rows, where the save posts them) is judged, never the rows it is about to drop.
async function assertAreaAddOnLimitsAtDestination(trx, lockedRows, propertyId, edited = null) {
  const moving = lockedRows.filter((row) => String(row.property_id || '') !== String(propertyId || ''));
  if (!moving.length) return;
  const { areaAddOnKeysByVisit } = require('./area-addon-visit-rows');
  const rowKeys = await areaAddOnKeysByVisit(trx, moving.map((row) => row.id));
  // The rows are judged as ONE batch: each row that passes counts, on its day, for the rows judged after it (in the tables it
  // is still at its old property), so two visits moved together cannot each take the destination's last allowed application.
  const alsoMoving = {};
  for (const row of moving) {
    const isEdited = edited && String(edited.id) === String(row.id);
    const ownKey = isEdited && edited.ownKey !== undefined ? edited.ownKey : row.service_key_snapshot;
    const carried = isEdited && Array.isArray(edited.rowKeys) ? edited.rowKeys : (rowKeys.get(String(row.id)) || []);
    const serviceKeys = [ownKey, ...carried].filter((key) => String(key || '').startsWith('area_addon_'));
    if (!serviceKeys.length) continue;
    // The edited visit lands on the day the same save sets (a combined address and date edit is judged on its final day).
    const scheduledDate = isEdited && edited.scheduledDate ? edited.scheduledDate : undefined;
    const judged = await require('./area-addon-limits').assertMovedVisitLimitsOpen(trx, { visitId: row.id, visit: row, propertyId, scheduledDate, serviceKeys, staff: true, alsoMoving });
    for (const key of (judged && judged.keys) || []) alsoMoving[key] = [...(alsoMoving[key] || []), judged.day];
  }
}

// A misting refill is priced for the house its accepted estimate names, so a visit that carries one cannot be moved to another
// property (misting PR 2c; behind GATE_MOSQUITO_MISTING). Judged here, the one mechanism every address mover shares (Update Details,
// the Intelligence Bar, the geocode review), on the locked rows the plan moves to a property they are not already at. The visit the
// SAME save edits is judged by what the save leaves on it (`edited.rowKeys`, its add-ons are replaced later in that save); every
// other moved visit by the rows it stores. Remove the refill, move the address, add the refill again.
async function assertNoMistingRefillMoves(trx, lockedRows, propertyId, edited = null) {
  const gates = require('../config/feature-gates');
  if (typeof gates.mosquitoMistingLive !== 'function' || !gates.mosquitoMistingLive()) return;
  const { MISTING_REFILL_CATALOG_KEY: REFILL_KEY } = require('../utils/mosquito-misting-system');
  const moving = lockedRows.filter((row) => String(row.property_id || '') !== String(propertyId || ''));
  if (!moving.length) return;
  const isEdited = (row) => edited && String(edited.id) === String(row.id);
  const stillStored = moving.filter((row) => !(isEdited(row) && Array.isArray(edited.rowKeys))).map((row) => row.id);
  const postedRefill = moving.some((row) => isEdited(row) && Array.isArray(edited.rowKeys) && edited.rowKeys.includes(REFILL_KEY));
  const storedRefill = stillStored.length > 0
    && !!(await trx('scheduled_service_addons').whereIn('scheduled_service_id', stillStored).where({ service_key_snapshot: REFILL_KEY }).first('id'));
  if (postedRefill || storedRefill) {
    throw Object.assign(new Error('A misting refill is priced for the house it was set up for. Remove the refill (Edit visit, Add-ons), change the address, then add the refill again.'), {
      statusCode: 409, isOperational: true, code: 'MISTING_REFILL_ADDRESS_MOVE',
    });
  }
}

// Which locked rows the move re-addresses: the anchor, its package children, and every member not in a historical status.
function rowsTheMoveUpdates(locked, { anchorId, packageChildIds }) {
  return locked.filter((row) => row.id === anchorId || (packageChildIds || []).includes(row.id)
    || !JOIN_INELIGIBLE_STATUSES.includes(row.status));
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
  const addressRows = rowsTheMoveUpdates(locked, { anchorId: plan.anchor.id, packageChildIds: fresh.packageChildIds });
  await assertAreaAddOnLimitsAtDestination(trx, locked, plan.propertyId, plan.editedVisit || null);
  // Only the rows this move actually re-addresses are judged (Codex #6559 r1 P2): a completed series parent the plan carries for its
  // fingerprint stays where it is, so a refill on it never blocks moving the future occurrences.
  await assertNoMistingRefillMoves(trx, addressRows, plan.propertyId, plan.editedVisit || null);
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
  const futureDefault = futureTemplateDefault(plan, locked, addressRows, stamp);
  await trx('scheduled_services').whereIn('id', addressRows.map((row) => row.id)).update(stamp);
  // A trace is drawn on the satellite photo of the property it was traced
  // at, and the report shows it beside the visit's live address: a visit
  // that moves to another property drops it (Codex #5538). Its images stay
  // in S3 unreferenced, as when a visit is deleted.
  const movedIds = addressRows.filter((row) => String(row.property_id ?? '') !== String(property.id)).map((row) => row.id);
  if (movedIds.length) await trx('treatment_zone_maps').whereIn('scheduled_service_id', movedIds).del();
  if (futureDefault) {
    await trx('scheduled_services').where({ id: futureDefault.id, customer_id: plan.anchor.customer_id }).update({
      recurring_template_overrides: trx.raw(
        "COALESCE(recurring_template_overrides, '{}'::jsonb) || ?::jsonb",
        [JSON.stringify({ appointment_address: futureDefault.address })],
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

module.exports = { planAppointmentAddress, lockAppointmentAddress, applyAppointmentAddress, refreshAppointmentAddressBriefs, assertNoMistingRefillMoves };
module.exports._test = { assertAreaAddOnLimitsAtDestination, rowsTheMoveUpdates };
