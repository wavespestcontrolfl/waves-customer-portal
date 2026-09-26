const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');
const { isInServiceAreaBox } = require('./service-area');
const { ensurePrimaryProperty, syncPrimaryAddress, syncPrimaryCoordsFromCustomer } = require('./customer-properties');
const { inheritReferenceUnit, premiseStampConflicts } = require('./stamped-address');
const { lockTechDays } = require('./scheduling/tech-day-lock');
const { etDateString } = require('../utils/datetime-et');
const { toDateStr } = require('./auto-dispatch/dates');
const { recurringServiceAddress } = require('./booking/visit-financial-stamps');
const reviewStore = require('./customer-geocode-review');

const REVIEW_SOURCES = new Set(['county_records', 'customer_confirmation', 'site_visit']);
const PROPERTY_ADDRESS_CONSTRAINT = 'customer_properties_customer_address_uniq';
const ADDRESS_FIELDS = ['address_line1', 'address_line2', 'city', 'state', 'zip'];
const VISIT_FIELDS = [
  'id', 'property_id', 'technician_id', 'scheduled_date', 'status', 'lat', 'lng',
  'auto_dispatch_locked', 'auto_dispatch_excluded',
  'is_recurring', 'recurring_parent_id',
  'service_address_line1', 'service_address_line2', 'service_address_city',
  'service_address_state', 'service_address_zip',
];
const pinAtScale = (value, places) => Number(Number(value).toFixed(places));

function actionError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, status: statusCode, code, isOperational: true });
}

function completeAddress(row) {
  return ['address_line1', 'city', 'state', 'zip']
    .every(field => typeof row?.[field] === 'string' && row[field].trim())
    && /^\d+[A-Za-z-]*\s+\S/.test(row.address_line1.trim());
}

function sameAddress(a, b) {
  return ADDRESS_FIELDS.every(field => String(a?.[field] || '') === String(b?.[field] || ''));
}

function hasUsablePin(row) {
  return row?.latitude != null && row?.longitude != null
    && Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude))
    && Number(row.latitude) !== 0 && Number(row.longitude) !== 0;
}

function reviewPinMatchesCustomer(customer, review) {
  return hasUsablePin(customer) && hasUsablePin(review)
    && pinAtScale(customer.latitude, 7) === pinAtScale(review.latitude, 7)
    && pinAtScale(customer.longitude, 7) === pinAtScale(review.longitude, 7);
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

function candidateVisits(conn, customerId, ids = null, { lock = false, includeProtected = false } = {}) {
  let query = conn('scheduled_services')
    .where({ customer_id: customerId })
    .whereIn('status', ['pending', 'confirmed'])
    .where('scheduled_date', '>=', etDateString())
    .select(VISIT_FIELDS);
  if (!includeProtected) {
    query = query.whereRaw('NOT COALESCE(auto_dispatch_locked, false) AND NOT COALESCE(auto_dispatch_excluded, false)');
  }
  if (ids) query = query.whereIn('id', ids);
  if (lock) query = query.forUpdate();
  return query;
}

function seriesParentId(row) {
  return row.recurring_parent_id || (row.is_recurring ? row.id : null);
}

async function prelockVisitDays(trx, customerId, { includeProtected = false, lockSeries = false } = {}) {
  const rows = await candidateVisits(trx, customerId, null, { includeProtected });
  await lockTechDays(trx, rows.map(row => ({
    techId: row.technician_id,
    date: toDateStr(row.scheduled_date),
  })));
  if (lockSeries) {
    const parentIds = [...new Set(rows.map(seriesParentId).filter(Boolean))].map(String).sort();
    for (const parentId of parentIds) {
      const result = await trx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS locked',
        ['recurring-series-maintenance', parentId]);
      if (result.rows[0]?.locked !== true) {
        throw actionError('This recurring plan changed while saving. Reload and review it.', 409, 'visit_changed');
      }
    }
  }
  return rows;
}

function stayedOnLockedTechDay(row, prelockedById) {
  const before = prelockedById.get(String(row.id));
  return before
    && String(before.technician_id || '') === String(row.technician_id || '')
    && toDateStr(before.scheduled_date) === toDateStr(row.scheduled_date)
    && String(seriesParentId(before) || '') === String(seriesParentId(row) || '');
}

async function updatePrimaryVisits(trx, customer, primary, after, latitude, longitude, prelockedVisits) {
  if (!prelockedVisits.length) return 0;
  const prelockedById = new Map(prelockedVisits.map(row => [String(row.id), row]));
  const rows = await candidateVisits(trx, customer.id, [...prelockedById.keys()], { lock: true });
  const eligible = rows
    .filter(row => stayedOnLockedTechDay(row, prelockedById))
    .filter(row => visitMatchesPrimary(row, customer, primary))
    .filter(row => visitPinIsSafeToReplace(row, customer));
  const ids = eligible.map(row => row.id);
  if (!ids.length) return 0;
  const updated = await trx('scheduled_services')
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
  const parentIds = [...new Set(eligible
    .map(seriesParentId)
    .filter(Boolean))];
  if (parentIds.length) {
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
    const parents = await trx('scheduled_services')
      .where({ customer_id: customer.id })
      .whereIn('id', parentIds)
      .orderBy('id')
      .forUpdate()
      .select('*');
    const matchingParentIds = parents.filter(parent => {
      const effective = { ...parent, ...recurringServiceAddress(parent) };
      return visitMatchesPrimary(effective, customer, primary)
        && visitPinIsSafeToReplace(effective, customer);
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
  return updated;
}

async function clearMatchingPins(trx, customer, primary, storedReview, prelockedVisits) {
  if (storedReview?.latitude == null || storedReview?.longitude == null) {
    return { customer: 0, property: 0, visits: 0 };
  }
  const latitude = Number(storedReview?.latitude);
  const longitude = Number(storedReview?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { customer: 0, property: 0, visits: 0 };
  const customerCount = await trx('customers')
    .where({ id: customer.id, latitude, longitude })
    .update({ latitude: null, longitude: null, updated_at: new Date() });
  const propertyCount = await trx('customer_properties')
    .where({ id: primary.id, customer_id: customer.id, active: true, is_primary: true, latitude, longitude })
    .update({ latitude: null, longitude: null, updated_at: new Date() });
  let visits = 0;
  if (prelockedVisits.length) {
    const visitLatitude = pinAtScale(latitude, 6);
    const visitLongitude = pinAtScale(longitude, 6);
    const prelockedById = new Map(prelockedVisits.map(row => [String(row.id), row]));
    const rows = await candidateVisits(trx, customer.id, [...prelockedById.keys()], {
      lock: true, includeProtected: true,
    });
    const visitIds = rows.filter(row => stayedOnLockedTechDay(row, prelockedById))
      .filter(row => visitMatchesPrimary(row, customer, primary))
      .filter(row => pinAtScale(row.lat, 6) === visitLatitude && pinAtScale(row.lng, 6) === visitLongitude)
      .map(row => row.id);
    if (!visitIds.length) return { customer: customerCount, property: propertyCount, visits };
    visits = await trx('scheduled_services')
      .whereIn('id', visitIds)
      .where({ customer_id: customer.id, lat: visitLatitude, lng: visitLongitude })
      .whereIn('status', ['pending', 'confirmed'])
      .where('scheduled_date', '>=', etDateString())
      .update({ lat: null, lng: null, updated_at: new Date() });
  }
  return { customer: customerCount, property: propertyCount, visits };
}

async function lockedContext(trx, customerId) {
  const customer = await trx('customers').where({ id: customerId }).forUpdate().first();
  if (!customer || customer.deleted_at) throw actionError('Customer not found', 404, 'customer_not_found');
  let primaries = await trx('customer_properties')
    .where({ customer_id: customerId, active: true, is_primary: true })
    .forUpdate()
    .select('*');
  if (!primaries.length) {
    await ensurePrimaryProperty(customer, { conn: trx });
    primaries = await trx('customer_properties')
      .where({ customer_id: customerId, active: true, is_primary: true })
      .forUpdate()
      .select('*');
  }
  if (primaries.length !== 1) {
    throw actionError('The active primary service location changed. Reload and review it.', 409, 'primary_location_changed');
  }
  const primary = primaries[0];
  if (!sameAddress(customer, primary)) {
    throw actionError('The customer and primary service location do not match. Resolve that conflict first.', 409, 'primary_location_mismatch');
  }
  const storedReview = await trx('customer_geocode_reviews').where({ customer_id: customerId }).forUpdate().first();
  return { customer, primary, storedReview };
}

function assertRevision(customer, storedReview, expected) {
  if (reviewStore.reviewRevision(customer, storedReview) !== expected) {
    throw actionError('Customer location data changed. Reload and review the latest values.', 409, 'review_changed');
  }
}

async function auditResolution(trx, customerId, actorId, action, metadata) {
  await recordAuditEvent({
    actor_type: 'technician',
    actor_id: actorId,
    action: `customer_geocode_review.${action}`,
    resource_type: 'customer',
    resource_id: customerId,
    metadata,
    critical: true,
    trx,
  });
}

async function verifyPin({ trx, customerId, input, actorId, customer, primary, storedReview, prelockedVisits }) {
  if (input.confirmed !== true) {
    throw actionError('Confirm the primary service location before verifying it.', 400, 'confirmation_required');
  }
  if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)
    || !isInServiceAreaBox(input.latitude, input.longitude)) {
    throw actionError('Verified coordinates must be inside the service area.', 400, 'invalid_verified_pin');
  }
  if (!REVIEW_SOURCES.has(input.source) || !String(input.evidence || '').trim()) {
    throw actionError('A reviewed source and evidence are required.', 400, 'review_evidence_required');
  }
  const latitude = pinAtScale(input.latitude, 7);
  const longitude = pinAtScale(input.longitude, 7);
  const addressPatch = input.address ? Object.fromEntries(ADDRESS_FIELDS
    .filter(field => Object.prototype.hasOwnProperty.call(input.address, field))
    .map(field => [field, field === 'address_line2' ? (input.address[field] || null) : input.address[field]])) : null;
  const address = addressPatch && Object.keys(addressPatch).length ? addressPatch : null;
  const after = address ? { ...customer, ...address } : { ...customer };
  if (!completeAddress(after)) {
    throw actionError('A complete confirmed service address is required.', 400, 'incomplete_service_address');
  }
  if (storedReview?.status === 'verified') {
    await reviewStore.saveReview(trx, customer, {
      status: 'pending', reason: 'manual_verification_in_progress', source: storedReview.source,
      evidence: storedReview.evidence, latitude: storedReview.latitude, longitude: storedReview.longitude,
    });
  }
  after.latitude = latitude;
  after.longitude = longitude;
  await trx('customers').where({ id: customerId }).update({
    ...(address || {}), latitude, longitude, updated_at: new Date(),
  });
  await syncPrimaryAddress(after, trx, {
    explicitLine2: !!address && Object.prototype.hasOwnProperty.call(address, 'address_line2'),
  });
  await syncPrimaryCoordsFromCustomer(customerId, trx);
  if (address) {
    await require('./customer-address-fanout').propagateCustomerAddressChange({ before: customer, after }, trx);
  }
  const visitsUpdated = await updatePrimaryVisits(
    trx, customer, primary, after, latitude, longitude, prelockedVisits,
  );
  await reviewStore.saveReview(trx, after, {
    status: 'verified', reason: 'staff_verified', source: input.source, evidence: input.evidence,
    reviewed_by: actorId, latitude, longitude,
  });
  await auditResolution(trx, customerId, actorId, input.action, {
    address_changed: !!address,
    visits_updated: visitsUpdated,
    source: input.source,
  });
}

async function markOutside({ trx, customerId, input, actorId, customer, primary, storedReview, prelockedVisits }) {
  if (input.confirmed !== true || !String(input.evidence || '').trim()) {
    throw actionError('Confirmation and evidence are required.', 400, 'confirmation_required');
  }
  const source = input.source || storedReview?.source;
  if (!REVIEW_SOURCES.has(source)) {
    throw actionError('A reviewed source is required.', 400, 'review_evidence_required');
  }
  const pin = hasUsablePin(customer)
    ? { ...storedReview, latitude: customer.latitude, longitude: customer.longitude }
    : storedReview;
  await reviewStore.saveReview(trx, customer, {
    status: 'outside_area', reason: 'staff_confirmed_outside_area',
    source, evidence: input.evidence,
    reviewed_by: actorId, latitude: pin?.latitude, longitude: pin?.longitude,
  });
  const cleared = await clearMatchingPins(trx, customer, primary, pin, prelockedVisits);
  await auditResolution(trx, customerId, actorId, input.action, { cleared });
}

async function revokePin({ trx, customerId, input, actorId, customer, primary, storedReview, prelockedVisits }) {
  if (!reviewPinMatchesCustomer(customer, storedReview)) {
    throw actionError('The current pin has no matching review provenance.', 409, 'review_pin_missing');
  }
  await reviewStore.saveReview(trx, customer, {
    status: 'needs_pin', reason: 'verification_revoked', source: storedReview.source || null,
    evidence: storedReview.evidence || null, latitude: storedReview.latitude, longitude: storedReview.longitude,
  });
  const cleared = await clearMatchingPins(trx, customer, primary, storedReview, prelockedVisits);
  await auditResolution(trx, customerId, actorId, input.action, { cleared });
}

async function requestRetry({ trx, customerId, input, actorId, customer, storedReview }) {
  if (hasUsablePin(customer)) {
    throw actionError('Revoke the current pin before retrying the lookup.', 409, 'pin_present');
  }
  await reviewStore.saveReview(trx, customer, {
    status: 'pending', reason: 'retry_requested', source: storedReview?.source || null,
    evidence: storedReview?.evidence || null, latitude: storedReview?.latitude, longitude: storedReview?.longitude,
  });
  await auditResolution(trx, customerId, actorId, input.action, {});
  return require('./geocoder').buildAddress(customer);
}

const ACTION_HANDLERS = {
  verify_pin: verifyPin,
  outside_service_area: markOutside,
  revoke: revokePin,
  retry: requestRetry,
};

async function resolveCustomerGeocodeReview(customerId, input, actorId, conn = db) {
  let retryAddress = null;
  await conn.transaction(async trx => {
    const needsVisitFence = ['verify_pin', 'outside_service_area', 'revoke'].includes(input.action);
    const includeProtected = ['outside_service_area', 'revoke'].includes(input.action);
    const prelockedVisits = needsVisitFence ? await prelockVisitDays(trx, customerId, {
      includeProtected, lockSeries: input.action === 'verify_pin',
    }) : [];
    const { customer, primary, storedReview } = await lockedContext(trx, customerId);
    if (!reviewStore.reviewEnabled()) throw actionError('Geocode review is disabled.', 404, 'review_disabled');
    assertRevision(customer, storedReview, input.revision);
    retryAddress = await ACTION_HANDLERS[input.action]({
      trx, customerId, input, actorId, customer, primary, storedReview, prelockedVisits,
    }) || null;
    if (!reviewStore.reviewEnabled()) throw actionError('Geocode review is disabled.', 404, 'review_disabled');
  }).catch(err => {
    if (err?.code === '23505' && err?.constraint === PROPERTY_ADDRESS_CONSTRAINT) {
      throw actionError(
        'That address already exists as another property on this customer.',
        409,
        'address_matches_existing_property',
      );
    }
    throw err;
  });

  if (input.action === 'retry') {
    const geocoder = require('./geocoder');
    geocoder.clearGeocodeMemo(retryAddress);
    await geocoder.ensureCustomerGeocoded(customerId);
  }
  await require('./scheduling/quality-after-change')
    .refreshScheduleQualityAfterChange({ customerIds: [customerId] }, conn)
    .catch(() => {});
  return reviewStore.getReviewDetail(customerId, conn);
}

module.exports = {
  clearMatchingPins,
  resolveCustomerGeocodeReview,
  updatePrimaryVisits,
  visitMatchesPrimary,
  visitPinIsSafeToReplace,
};
