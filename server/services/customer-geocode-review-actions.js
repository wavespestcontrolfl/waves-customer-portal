const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');
const { isInServiceAreaBox } = require('./service-area');
const { addressKey, ensurePrimaryProperty, syncPrimaryAddress, syncPrimaryCoordsFromCustomer } = require('./customer-properties');
const logger = require('./logger');
const { prelockVisitContext, lockVisitContext, updatePrimaryVisits, clearMatchingPins, pinAtScale } = require('./customer-geocode-review-visits');
const reviewStore = require('./customer-geocode-review');

const REVIEW_SOURCES = new Set(['county_records', 'customer_confirmation', 'site_visit']);
const PROPERTY_ADDRESS_CONSTRAINT = 'customer_properties_customer_address_uniq';
const ADDRESS_FIELDS = ['address_line1', 'address_line2', 'city', 'state', 'zip'];

function actionError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, status: statusCode, code, isOperational: true });
}

function completeAddress(row) {
  return ['address_line1', 'city', 'state', 'zip']
    .every(field => typeof row?.[field] === 'string' && row[field].trim())
    && /^\d+[A-Za-z-]*\s+\S/.test(row.address_line1.trim());
}

function normalizedAddressValue(value) {
  return String(value || '');
}

function sameAddress(a, b) {
  return ADDRESS_FIELDS.every(field => normalizedAddressValue(a?.[field]) === normalizedAddressValue(b?.[field]));
}

function reviewAddressPatch(input) {
  if (!input || typeof input !== 'object') return null;
  const patch = Object.fromEntries(ADDRESS_FIELDS
    .filter(field => Object.prototype.hasOwnProperty.call(input, field))
    .map(field => [field, field === 'address_line2' ? (input[field] || null) : input[field]]));
  return Object.keys(patch).length ? patch : null;
}

function hasUsablePin(row) {
  return row?.latitude != null && row?.longitude != null
    && Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude))
    && Number(row.latitude) !== 0 && Number(row.longitude) !== 0;
}

function pinsMatch(left, right) {
  return hasUsablePin(left) && hasUsablePin(right)
    && pinAtScale(left.latitude, 7) === pinAtScale(right.latitude, 7)
    && pinAtScale(left.longitude, 7) === pinAtScale(right.longitude, 7);
}

function reviewAddressMatchesCustomer(customer, review) {
  return Array.isArray(review?.address_snapshot)
    && ADDRESS_FIELDS.every((field, index) => normalizedAddressValue(customer?.[field]) === normalizedAddressValue(review.address_snapshot[index]));
}

function rejectedPrimaryPin(customer, primary, storedReview) {
  if (hasUsablePin(primary) && !pinsMatch(customer, primary)) return primary;
  if (hasUsablePin(customer)) return customer;
  if (hasUsablePin(primary)) return primary;
  return reviewAddressMatchesCustomer(customer, storedReview) ? storedReview : null;
}

async function lockedContext(trx, customerId, proposedAddress = null) {
  const customer = await trx('customers').where({ id: customerId }).forUpdate().first();
  if (!customer || customer.deleted_at) throw actionError('Customer not found', 404, 'customer_not_found');
  let primaryReference = customer;
  let visitReference = customer;
  let primaries = await trx('customer_properties')
    .where({ customer_id: customerId, active: true, is_primary: true })
    .forUpdate()
    .select('*');
  if (!primaries.length) {
    primaryReference = proposedAddress ? { ...customer, ...proposedAddress } : customer;
    if (!String(customer.address_line1 || '').trim()) visitReference = primaryReference;
    await ensurePrimaryProperty(primaryReference, { conn: trx });
    primaries = await trx('customer_properties')
      .where({ customer_id: customerId, active: true, is_primary: true })
      .forUpdate()
      .select('*');
  }
  if (!primaries.length && await trx('customer_properties').where({
    customer_id: customerId, active: true, address_key: addressKey(primaryReference),
  }).first('id')) {
    throw actionError('That address already exists as another property on this customer.',
      409, 'address_matches_existing_property');
  }
  if (primaries.length !== 1) {
    throw actionError('The active primary service location changed. Reload and review it.', 409, 'primary_location_changed');
  }
  const primary = primaries[0];
  if (!sameAddress(primaryReference, primary)) {
    throw actionError('The customer and primary service location do not match. Resolve that conflict first.', 409, 'primary_location_mismatch');
  }
  const storedReview = await trx('customer_geocode_reviews').where({ customer_id: customerId }).forUpdate().first();
  return { customer, primary, visitReference, storedReview };
}

function assertRevision(customer, primary, storedReview, expected) {
  if (reviewStore.reviewRevision(customer, storedReview, primary) !== expected) {
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

async function verifyPin({
  trx, customerId, input, actorId, customer, primary, visitReference, storedReview, visitContext,
}) {
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
  const address = reviewAddressPatch(input.address);
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
  const updatedVisitIds = await updatePrimaryVisits(
    trx, visitReference, primary, after, latitude, longitude, visitContext, actorId,
  );
  await reviewStore.saveReview(trx, after, {
    status: 'verified', reason: 'staff_verified', source: input.source, evidence: input.evidence,
    reviewed_by: actorId, latitude, longitude,
  });
  await auditResolution(trx, customerId, actorId, input.action, {
    address_changed: !!address,
    visits_updated: updatedVisitIds.length,
    source: input.source,
  });
  return { addressBriefIds: updatedVisitIds };
}

async function markOutside({ trx, customerId, input, actorId, customer, primary, storedReview, visitContext }) {
  if (input.confirmed !== true || !String(input.evidence || '').trim()) {
    throw actionError('Confirmation and evidence are required.', 400, 'confirmation_required');
  }
  const source = input.source || storedReview?.source;
  if (!REVIEW_SOURCES.has(source)) {
    throw actionError('A reviewed source is required.', 400, 'review_evidence_required');
  }
  const rejected = rejectedPrimaryPin(customer, primary, storedReview);
  const pin = rejected ? {
    ...storedReview, latitude: rejected.latitude, longitude: rejected.longitude,
  } : null;
  await reviewStore.saveReview(trx, customer, {
    status: 'outside_area', reason: 'staff_confirmed_outside_area',
    source, evidence: input.evidence,
    reviewed_by: actorId, latitude: pin?.latitude, longitude: pin?.longitude,
  });
  const cleared = await clearMatchingPins(trx, customer, primary, pin, visitContext, {
    clearMirrors: true,
    additionalPins: [customer, primary],
  });
  await auditResolution(trx, customerId, actorId, input.action, { cleared });
  return { addressBriefIds: cleared.visitIds };
}

async function revokePin({ trx, customerId, input, actorId, customer, primary, storedReview, visitContext }) {
  if (!pinsMatch(customer, storedReview) && !pinsMatch(primary, storedReview)) {
    throw actionError('The current pin has no matching review provenance.', 409, 'review_pin_missing');
  }
  await reviewStore.saveReview(trx, customer, {
    status: 'needs_pin', reason: 'verification_revoked', source: storedReview.source || null,
    evidence: storedReview.evidence || null, latitude: storedReview.latitude, longitude: storedReview.longitude,
  });
  const cleared = await clearMatchingPins(trx, customer, primary, storedReview, visitContext, {
    clearMirrors: true,
    additionalPins: [customer, primary],
  });
  await auditResolution(trx, customerId, actorId, input.action, { cleared });
  return { addressBriefIds: cleared.visitIds };
}

async function requestRetry({ trx, customerId, input, actorId, customer, primary, storedReview }) {
  if (hasUsablePin(customer) || hasUsablePin(primary)) {
    throw actionError('Resolve the current primary location pin before retrying the lookup.', 409, 'pin_present');
  }
  await reviewStore.saveReview(trx, customer, {
    status: 'pending', reason: 'retry_requested', source: storedReview?.source || null,
    evidence: storedReview?.evidence || null, latitude: storedReview?.latitude, longitude: storedReview?.longitude,
  });
  await auditResolution(trx, customerId, actorId, input.action, {});
  return { retryAddress: require('./geocoder').buildAddress(customer) };
}

const ACTION_HANDLERS = {
  verify_pin: verifyPin,
  outside_service_area: markOutside,
  revoke: revokePin,
  retry: requestRetry,
};

async function resolveCustomerGeocodeReview(customerId, input, actorId, conn = db) {
  let retryAddress = null;
  let addressBriefIds = [];
  await conn.transaction(async trx => {
    // Address fan-out reuses this lock. Take it before visit/customer locks,
    // matching admin address edits and primary-property changes.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['property-preferences', String(customerId)]);
    const needsVisitFence = ['verify_pin', 'outside_service_area', 'revoke'].includes(input.action);
    const includeProtected = ['outside_service_area', 'revoke'].includes(input.action);
    const prelocked = needsVisitFence
      ? await prelockVisitContext(trx, customerId)
      : { visits: [], rootIds: [], seriesIds: [] };
    const proposedAddress = input.action === 'verify_pin' ? reviewAddressPatch(input.address) : null;
    const { customer, primary, visitReference, storedReview } = await lockedContext(
      trx, customerId, proposedAddress,
    );
    if (!reviewStore.reviewEnabled()) throw actionError('Geocode review is disabled.', 404, 'review_disabled');
    assertRevision(customer, primary, storedReview, input.revision);
    const visitContext = needsVisitFence
      ? await lockVisitContext(trx, customerId, prelocked, {
        includeProtected, customer: visitReference, primary, verifyPin: input.action === 'verify_pin',
      })
      : { visits: [], parents: [] };
    const outcome = await ACTION_HANDLERS[input.action]({
      trx, customerId, input, actorId, customer, primary, visitReference, storedReview, visitContext,
    }) || null;
    retryAddress = outcome?.retryAddress || null;
    addressBriefIds = [...new Set(outcome?.addressBriefIds || [])];
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
  if (addressBriefIds.length) {
    void Promise.resolve()
      .then(() => require('./appointment-address').refreshAppointmentAddressBriefs(conn, addressBriefIds))
      .catch(() => logger.warn('[customer-geocode-review] Address brief refresh failed after commit', {
        code: 'address_brief_refresh_failed', customerId, visitCount: addressBriefIds.length,
      }));
    const { emitDispatchJobUpdate, flushDispatchQualityDates } = require('./dispatch-assignment');
    const qualityDates = new Set();
    const broadcasts = await Promise.allSettled(addressBriefIds.map(jobId => emitDispatchJobUpdate({
      jobId, actorId, qualityDates,
    })));
    try {
      await flushDispatchQualityDates(qualityDates);
    } catch {
      logger.warn('[customer-geocode-review] Route quality refresh failed after commit', {
        code: 'dispatch_quality_refresh_failed', customerId, visitCount: addressBriefIds.length,
      });
    }
    if (broadcasts.some(result => result.status === 'rejected')) {
      logger.warn('[customer-geocode-review] Dispatch refresh failed after commit', {
        code: 'dispatch_refresh_failed', customerId, visitCount: addressBriefIds.length,
      });
    }
  } else {
    await require('./scheduling/quality-after-change')
      .refreshScheduleQualityAfterChange({ customerIds: [customerId] }, conn)
      .catch(() => {});
  }
  return reviewStore.getReviewDetail(customerId, conn);
}

module.exports = { resolveCustomerGeocodeReview };
