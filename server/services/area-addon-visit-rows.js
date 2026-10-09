'use strict';

/**
 * Area add-ons on the booked visit (GATE_AREA_ADDONS, owner ruling 2026-10-08):
 * several add-ons on one estimate are ONE visit. The appointment stamps one
 * catalog service (the profile's primary, see primaryProfileService); every
 * OTHER sold area add-on becomes a structured `scheduled_service_addons` row on
 * that same appointment, written in the transaction that books it, so the job
 * card, the completion invoice, closeout and the visit's trace readers all see
 * every add-on the customer bought and not only the one in the visit's notes.
 *
 * Money contract (the admin schedule's own, services/invoice.js
 * buildScheduledServiceInvoiceLines): `scheduled_services.estimated_price`
 * stays the WHOLE visit total (the estimate's one-time total); each add-on row
 * carries only its own price, and the invoice's primary line is the total less
 * the add-on rows. Nothing here touches the parent price, so the invoice equals
 * the estimate's one-time total and no add-on is counted twice.
 *
 * Exactly once: rows are written only when a hold graduates (or a booked
 * appointment is adopted), never on the hold, so a released or expired hold
 * leaves nothing to clean up; and a row whose add-on is already on the visit
 * (a replayed accept, a second adoption) is skipped.
 */
const logger = require('./logger');

const AREA_ADDON_ENGINE_KEY = 'area_addon';

// The profile service the appointment itself is stamped with: the pest control
// row when there is one, else the first. ONE rule for the catalog stamp
// (slot-reservation catalogLinkForProfile) and for "everything else is an
// add-on row" below.
function primaryProfileService(serviceProfile = {}) {
  const services = Array.isArray(serviceProfile?.services) ? serviceProfile.services : [];
  return services.find((svc) => svc?.service === 'pest_control') || services[0] || null;
}

function areaAddOnProfileRows(serviceProfile = {}) {
  const services = Array.isArray(serviceProfile?.services) ? serviceProfile.services : [];
  return services.filter((svc) => svc?.engineKey === AREA_ADDON_ENGINE_KEY);
}

// The add-ons that need their own row: every sold area add-on except the one
// that already IS the visit's own service (`ownServiceKey`, a catalog key).
function secondaryAreaAddOns(serviceProfile, ownServiceKey = null) {
  return areaAddOnProfileRows(serviceProfile).filter((row) => !(ownServiceKey && row.catalogServiceKey === ownServiceKey));
}

function unresolvedError(row) {
  const err = new Error(`Area add-on "${row.label || 'unknown'}" cannot be booked as a visit line: its catalog key or price is missing. Rebuild the estimate.`);
  err.status = 409;
  err.statusCode = 409;
  err.code = 'AREA_ADDON_ROW_UNRESOLVED';
  err.isOperational = true;
  return err;
}

function addOnRowData(row, catalog, cols, scheduledServiceId, trx) {
  const price = Math.round(Number(row.addOnPrice) * 100) / 100;
  const data = {
    scheduled_service_id: scheduledServiceId,
    service_id: catalog?.id || null,
    service_name: String(catalog?.name || row.label).slice(0, 200),
    estimated_price: price,
    // clock_timestamp, not the transaction's now(): rows keep the profile's order.
    created_at: trx.raw('clock_timestamp()'),
  };
  if (cols.base_price) data.base_price = price;
  // An explicit one-time line: a NULL pattern rides the parent visit's cadence
  // (admin-schedule lineDueOnRecurringDate), and a sold add-on is one application.
  if (cols.recurring_pattern) data.recurring_pattern = 'one_time';
  if (cols.service_key_snapshot) data.service_key_snapshot = row.catalogServiceKey;
  if (cols.service_category_snapshot) data.service_category_snapshot = catalog?.category || null;
  if (cols.estimated_duration_minutes && Number(row.durationMinutes) > 0) data.estimated_duration_minutes = Math.ceil(Number(row.durationMinutes));
  return data;
}

/**
 * Write one add-on row per sold area add-on that the appointment does not
 * already carry. `trx` is the booking transaction. Returns the number written.
 * A priced add-on with no catalog key (or no price) cannot be a structured row:
 * it throws, rolling the booking back, rather than dropping a sold add-on.
 */
async function writeAreaAddOnVisitRows(trx, { scheduledServiceId, serviceProfile, ownServiceKey = null }) {
  const wanted = secondaryAreaAddOns(serviceProfile, ownServiceKey);
  if (!scheduledServiceId || wanted.length === 0) return 0;
  for (const row of wanted) {
    if (!row.catalogServiceKey || !(Number(row.addOnPrice) > 0)) throw unresolvedError(row);
  }
  const present = await trx('scheduled_service_addons').where({ scheduled_service_id: scheduledServiceId })
    .select('service_key_snapshot');
  const have = new Set(present.map((r) => r.service_key_snapshot).filter(Boolean));
  const todo = wanted.filter((row) => !have.has(row.catalogServiceKey));
  if (todo.length === 0) return 0;
  const catalogRows = await trx('services').whereIn('service_key', todo.map((row) => row.catalogServiceKey))
    .select('id', 'service_key', 'name', 'category');
  const byKey = new Map(catalogRows.map((c) => [c.service_key, c]));
  const cols = await trx('scheduled_service_addons').columnInfo();
  for (const row of todo) {
    if (!byKey.has(row.catalogServiceKey)) {
      logger.error(`[area-addon-visit-rows] catalog row ${row.catalogServiceKey} missing - add-on row written from its key snapshot only (visit ${scheduledServiceId})`);
    }
    await trx('scheduled_service_addons').insert(addOnRowData(row, byKey.get(row.catalogServiceKey), cols, scheduledServiceId, trx));
  }
  return todo.length;
}

/**
 * The same rows for an EXISTING appointment that the accept adopts (a booked
 * visit linked to the estimate; no hold graduates). The appointment's own
 * identity (`ownServiceKey`) is whatever it already is; every sold area add-on
 * it does not carry becomes an add-on row on it.
 */
async function writeAdoptedAreaAddOns(trx, { scheduledServiceId, estimate, ownServiceKey = null }) {
  // Lazy: estimate-slot-availability loads slot-reservation, which loads this module.
  const profile = require('./estimate-slot-availability').resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
  return writeAreaAddOnVisitRows(trx, { scheduledServiceId, serviceProfile: profile, ownServiceKey });
}

module.exports = {
  writeAdoptedAreaAddOns,
  AREA_ADDON_ENGINE_KEY,
  primaryProfileService,
  areaAddOnProfileRows,
  secondaryAreaAddOns,
  writeAreaAddOnVisitRows,
};
