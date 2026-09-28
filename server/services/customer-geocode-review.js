/** Primary service-address review, shared by Customer 360 and the existing geocoder. */
const { createHash } = require('node:crypto');
const db = require('../models/db');
const { gateEnvValue } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');

const ADDRESS_FIELDS = ['address_line1', 'address_line2', 'city', 'state', 'zip'];
const CUSTOMER_FIELDS = ['id', 'first_name', 'last_name', ...ADDRESS_FIELDS, 'latitude', 'longitude'];
const reviewEnabled = () => gateEnvValue('GATE_GEOCODE_REVIEW');
const addressSnapshot = customer => ADDRESS_FIELDS.map(field => customer[field] ?? null);
const normalizedAddress = values => (values || []).map(value => value || null);
const sameAddress = (customer, review) => JSON.stringify(normalizedAddress(addressSnapshot(customer)))
  === JSON.stringify(normalizedAddress(review?.address_snapshot));
const hasPin = customer => ['latitude', 'longitude'].every(field => customer[field] != null && Number.isFinite(Number(customer[field])) && Number(customer[field]) !== 0);
const needsCoordinatePairRepair = customer => customer?.latitude == null || customer?.longitude == null;
const samePin = (customer, review) => hasPin(customer) && ['latitude', 'longitude'].every(field => Number(customer[field]) === Number(review[field]));
const completeAddress = customer => ['address_line1', 'city', 'state', 'zip'].every(field => String(customer[field] || '').trim())
  && /^\d+[A-Za-z-]*\s+\S/.test(String(customer.address_line1 || '').trim());
const sameAddressRows = (left, right) => ADDRESS_FIELDS.every(field => (left?.[field] || null) === (right?.[field] || null));
const effectiveCustomer = (customer, primary) => primary && sameAddressRows(customer, primary) && hasPin(primary)
  ? { ...customer, latitude: primary.latitude, longitude: primary.longitude }
  : customer;

function reviewRevision(customer, review, primary = null) {
  const numeric = value => value == null ? null : Number(value);
  const saved = review ? [review.address_snapshot, review.status, review.reason, review.source, review.evidence,
    review.reviewed_by, new Date(review.updated_at).toISOString(), numeric(review.latitude), numeric(review.longitude)] : null;
  const primaryPin = primary
    ? [numeric(primary.latitude), numeric(primary.longitude)]
    : [numeric(customer.latitude), numeric(customer.longitude)];
  return createHash('sha256').update(JSON.stringify([
    addressSnapshot(customer), numeric(customer.latitude), numeric(customer.longitude), primaryPin, saved,
  ])).digest('hex');
}

function effectiveReview(customer, review) {
  if (review && !sameAddress(customer, review)) return { status: 'needs_pin', reason: 'address_changed' };
  if (review?.status === 'verified' && !samePin(customer, review)) return { status: 'needs_pin', reason: 'pin_changed' };
  if (review && !(review.status === 'geocoded' && !hasPin(customer))) return review;
  if (!completeAddress(customer)) return { status: 'needs_details', reason: 'incomplete_address' };
  return hasPin(customer) ? { status: 'geocoded', reason: 'coordinates_present' } : { status: 'pending', reason: 'not_attempted' };
}

async function saveReview(trx, customer, values) {
  const row = { customer_id: customer.id, address_snapshot: JSON.stringify(addressSnapshot(customer)),
    status: values.status, reason: values.reason, source: values.source || null, evidence: values.evidence || null,
    reviewed_by: values.reviewed_by || null, reviewed_at: values.reviewed_by ? trx.fn.now() : null,
    latitude: values.latitude ?? null, longitude: values.longitude ?? null, updated_at: trx.fn.now() };
  const [saved] = await trx('customer_geocode_reviews').insert(row).onConflict('customer_id').merge().returning('*');
  return saved;
}

function detail(customer, review, nextVisitDate, primary = null) {
  const displayed = effectiveCustomer(customer, primary);
  return { enabled: true, customer: Object.fromEntries(CUSTOMER_FIELDS.map(field => [field, displayed[field] ?? null])),
    review: effectiveReview(displayed, review), revision: reviewRevision(customer, review, primary), next_visit_date: nextVisitDate || null };
}

async function getReviewDetail(customerId, conn = db) {
  const customer = await conn('customers').where({ id: customerId }).whereNull('deleted_at').first();
  if (!customer) return null;
  const [review, primary] = await Promise.all([
    conn('customer_geocode_reviews').where({ customer_id: customerId }).first(),
    conn('customer_properties').where({ customer_id: customerId, active: true, is_primary: true }).first(),
  ]);
  const next = await conn('scheduled_services').where({ customer_id: customerId }).whereIn('status', ['pending', 'confirmed'])
    .where('scheduled_date', '>=', etDateString(new Date())).min('scheduled_date as date').first();
  return detail(customer, review, next?.date, primary);
}

const NORMALIZED_REVIEW_ADDRESS_SQL = "jsonb_build_array(COALESCE(NULLIF(r.address_snapshot->>0, ''), ''), COALESCE(NULLIF(r.address_snapshot->>1, ''), ''), COALESCE(NULLIF(r.address_snapshot->>2, ''), ''), COALESCE(NULLIF(r.address_snapshot->>3, ''), ''), COALESCE(NULLIF(r.address_snapshot->>4, ''), ''))";
const ADDRESS_MATCH_SQL = `${NORMALIZED_REVIEW_ADDRESS_SQL} = jsonb_build_array(COALESCE(NULLIF(c.address_line1, ''), ''), COALESCE(NULLIF(c.address_line2, ''), ''), COALESCE(NULLIF(c.city, ''), ''), COALESCE(NULLIF(c.state, ''), ''), COALESCE(NULLIF(c.zip, ''), ''))`;
const PRIMARY_ADDRESS_MATCH_SQL = "jsonb_build_array(COALESCE(p.address_line1, ''), COALESCE(p.address_line2, ''), COALESCE(p.city, ''), COALESCE(p.state, ''), COALESCE(p.zip, '')) = jsonb_build_array(COALESCE(c.address_line1, ''), COALESCE(c.address_line2, ''), COALESCE(c.city, ''), COALESCE(c.state, ''), COALESCE(c.zip, ''))";
const PRIMARY_HAS_PIN_SQL = `((${PRIMARY_ADDRESS_MATCH_SQL}) AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL AND p.latitude <> 0 AND p.longitude <> 0)`;
const EFFECTIVE_LAT_SQL = `(CASE WHEN ${PRIMARY_HAS_PIN_SQL} THEN p.latitude ELSE c.latitude END)`;
const EFFECTIVE_LNG_SQL = `(CASE WHEN ${PRIMARY_HAS_PIN_SQL} THEN p.longitude ELSE c.longitude END)`;
const HAS_PIN_SQL = `(${EFFECTIVE_LAT_SQL} IS NOT NULL AND ${EFFECTIVE_LNG_SQL} IS NOT NULL AND ${EFFECTIVE_LAT_SQL} <> 0 AND ${EFFECTIVE_LNG_SQL} <> 0)`;
const VERIFIED_PIN_SQL = `(r.status = 'verified' AND ${ADDRESS_MATCH_SQL} AND ${HAS_PIN_SQL} AND ${EFFECTIVE_LAT_SQL} = r.latitude AND ${EFFECTIVE_LNG_SQL} = r.longitude)`;

async function listReviewQueue({ limit = 25, offset = 0 } = {}, conn = db) {
  const upcoming = conn('scheduled_services').select('customer_id').min('scheduled_date as next_visit_date')
    .whereIn('status', ['pending', 'confirmed']).where('scheduled_date', '>=', etDateString(new Date())).groupBy('customer_id');
  const query = conn('customers as c').leftJoin('customer_geocode_reviews as r', 'r.customer_id', 'c.id')
    .leftJoin('customer_properties as p', function () {
      this.on('p.customer_id', '=', 'c.id').andOnVal('p.active', '=', true).andOnVal('p.is_primary', '=', true);
    })
    .leftJoin(upcoming.as('visits'), 'visits.customer_id', 'c.id').whereNull('c.deleted_at')
    .whereRaw("(NULLIF(btrim(c.address_line1), '') IS NOT NULL OR visits.next_visit_date IS NOT NULL)")
    .whereRaw(`NOT COALESCE(${VERIFIED_PIN_SQL}, false)`)
    .whereRaw(`NOT COALESCE(r.status = 'outside_area' AND r.reviewed_at IS NOT NULL AND ${ADDRESS_MATCH_SQL}, false)`)
    .whereRaw(`(NOT ${HAS_PIN_SQL} OR (r.customer_id IS NOT NULL AND (NOT (${ADDRESS_MATCH_SQL}) OR r.status <> 'geocoded')))`);
  const [{ count }] = await query.clone().count('* as count');
  const rows = await query.select('c.*', conn.raw('to_jsonb(r) as review_record'), 'visits.next_visit_date')
    .orderByRaw('visits.next_visit_date ASC NULLS LAST').orderBy('c.id').limit(limit).offset(offset);
  const primaries = rows.length ? await conn('customer_properties')
    .whereIn('customer_id', rows.map(row => row.id)).where({ active: true, is_primary: true })
    .select('customer_id', 'latitude', 'longitude', ...ADDRESS_FIELDS) : [];
  const primaryByCustomer = new Map(primaries.map(row => [String(row.customer_id), row]));
  return { enabled: true, total: Number(count), records: rows.map(row => detail(
    row, row.review_record, row.next_visit_date, primaryByCustomer.get(String(row.id)),
  )) };
}

/** Permanent review decisions are address-bound. Transient failures stay eligible.
 * Stale human verification needs a deliberate retry; a spelling edit must not
 * silently replace the reviewed property with a provider's known wrong point. */
function blocksAutomaticGeocode(customer, review) {
  if (!review) return false;
  if (!sameAddress(customer, review)) return review.status === 'verified';
  return ['needs_details', 'needs_pin', 'outside_area', 'verified'].includes(review.status);
}

function excludeReviewedAddresses(query, alias = 'customers') {
  return query.whereNotExists(function () {
    this.select('r.customer_id').from('customer_geocode_reviews as r').whereRaw('r.customer_id = ??.id', [alias])
      .where(function () {
        this.where('r.status', 'verified').orWhere(function () {
          this.whereIn('r.status', ['needs_details', 'needs_pin', 'outside_area'])
            .whereRaw(`${NORMALIZED_REVIEW_ADDRESS_SQL} = jsonb_build_array(COALESCE(NULLIF(??.address_line1, ''), ''), COALESCE(NULLIF(??.address_line2, ''), ''), COALESCE(NULLIF(??.city, ''), ''), COALESCE(NULLIF(??.state, ''), ''), COALESCE(NULLIF(??.zip, ''), ''))`, Array(5).fill(alias));
        });
      });
  });
}

function excludeMatchingPrimaryPins(query, customerAlias = 'customers') {
  if (!reviewEnabled()) return query;
  return query.whereNotExists(function () {
    this.select('p.id').from('customer_properties as p')
      .whereRaw('p.customer_id = ??.id', [customerAlias])
      .where({ 'p.active': true, 'p.is_primary': true })
      .whereNotNull('p.latitude').whereNotNull('p.longitude')
      .whereRaw('p.latitude <> 0 AND p.longitude <> 0')
      .whereRaw("jsonb_build_array(COALESCE(p.address_line1, ''), COALESCE(p.address_line2, ''), COALESCE(p.city, ''), COALESCE(p.state, ''), COALESCE(p.zip, '')) = jsonb_build_array(COALESCE(??.address_line1, ''), COALESCE(??.address_line2, ''), COALESCE(??.city, ''), COALESCE(??.state, ''), COALESCE(??.zip, ''))",
        Array(5).fill(customerAlias));
  });
}

function excludeCustomerAutomaticGeocodeForId(query, customerId) {
  if (!reviewEnabled()) return query;
  query.whereNotExists(function () {
    this.select('r.customer_id').from('customer_geocode_reviews as r')
      .join('customers as blocked_customer', 'blocked_customer.id', 'r.customer_id')
      .where({ 'r.customer_id': customerId })
      .where(function () {
        this.where('r.status', 'verified').orWhere(function () {
          this.whereIn('r.status', ['needs_details', 'needs_pin', 'outside_area'])
            .whereRaw(`${NORMALIZED_REVIEW_ADDRESS_SQL} = jsonb_build_array(COALESCE(NULLIF(blocked_customer.address_line1, ''), ''), COALESCE(NULLIF(blocked_customer.address_line2, ''), ''), COALESCE(NULLIF(blocked_customer.city, ''), ''), COALESCE(NULLIF(blocked_customer.state, ''), ''), COALESCE(NULLIF(blocked_customer.zip, ''), ''))`);
        });
      });
  });
  return query.whereNotExists(function () {
    this.select('p.id').from('customer_properties as p')
      .join('customers as primary_customer', 'primary_customer.id', 'p.customer_id')
      .where({ 'p.customer_id': customerId, 'p.active': true, 'p.is_primary': true })
      .whereNotNull('p.latitude').whereNotNull('p.longitude')
      .whereRaw('p.latitude <> 0 AND p.longitude <> 0')
      .whereRaw("jsonb_build_array(COALESCE(p.address_line1, ''), COALESCE(p.address_line2, ''), COALESCE(p.city, ''), COALESCE(p.state, ''), COALESCE(p.zip, '')) = jsonb_build_array(COALESCE(primary_customer.address_line1, ''), COALESCE(primary_customer.address_line2, ''), COALESCE(primary_customer.city, ''), COALESCE(primary_customer.state, ''), COALESCE(primary_customer.zip, ''))");
  });
}

async function reviewedCustomerLocation(customer, conn = db) {
  if (!customer || !reviewEnabled()) return customer;
  const [review, primary] = await Promise.all([
    conn('customer_geocode_reviews').where({ customer_id: customer.id }).first(),
    conn('customer_properties').where({ customer_id: customer.id, active: true, is_primary: true }).first(),
  ]);
  const effective = effectiveCustomer(customer, primary);
  if (!review || !sameAddress(customer, review)) {
    return review?.status === 'verified'
      ? { ...customer, latitude: null, longitude: null, geocode_review_blocked: true }
      : effective;
  }
  // verified_by_review distinguishes a pin backed by a matching, staff-
  // verified review from ordinary stored coordinates `effective` returns
  // for every other non-blocked case below (Codex P1: a caller that treats
  // ANY returned pin as review-authoritative would wrongly retain a
  // customer's plain stored coordinates — never reviewed at all — over a
  // freshly supplied correction).
  if (review.status === 'verified' && samePin(effective, review)) return { ...effective, verified_by_review: true };
  if (['verified', 'needs_details', 'needs_pin', 'outside_area'].includes(review.status)) {
    return { ...customer, latitude: null, longitude: null, geocode_review_blocked: true };
  }
  return effective;
}

async function withCustomerReviewWriteFence(customerId, conn = db, write, {
  lockWhenDisabled = false,
  wait = true,
} = {}) {
  if (!reviewEnabled() && !lockWhenDisabled) return write(conn);
  return conn.transaction(async (trx) => {
    const customerQuery = trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate();
    if (!wait) customerQuery.noWait();
    const customer = await customerQuery.first('id');
    if (!customer) return null;
    const primaryQuery = trx('customer_properties')
      .where({ customer_id: customerId, active: true, is_primary: true }).orderBy('id').forUpdate();
    if (!wait) primaryQuery.noWait();
    await primaryQuery.select('id');
    return write(trx);
  });
}

function blockingPropertyReview(builder, propertyAlias) {
  builder.where('r.status', 'verified').orWhere(function () {
    this.whereIn('r.status', ['needs_details', 'needs_pin', 'outside_area'])
      .whereRaw(`${NORMALIZED_REVIEW_ADDRESS_SQL} = jsonb_build_array(COALESCE(NULLIF(??.address_line1, ''), ''), COALESCE(NULLIF(??.address_line2, ''), ''), COALESCE(NULLIF(??.city, ''), ''), COALESCE(NULLIF(??.state, ''), ''), COALESCE(NULLIF(??.zip, ''), ''))`,
        Array(5).fill(propertyAlias));
  });
}

function excludePrimaryPropertyReviewBlocks(query, propertyAlias = 'customer_properties') {
  if (!reviewEnabled()) return query;
  return query.whereNotExists(function () {
    this.select('r.customer_id').from('customer_geocode_reviews as r')
      .whereRaw('r.customer_id = ??.customer_id', [propertyAlias])
      .whereRaw('??.is_primary = true', [propertyAlias])
      .where(function () { blockingPropertyReview(this, propertyAlias); });
  });
}

function excludePrimaryPropertyReviewForId(query, propertyId) {
  if (!reviewEnabled()) return query;
  return query.whereNotExists(function () {
    this.select('r.customer_id').from('customer_geocode_reviews as r')
      .join('customer_properties as blocked_primary', 'blocked_primary.customer_id', 'r.customer_id')
      .where({ 'blocked_primary.id': propertyId, 'blocked_primary.active': true, 'blocked_primary.is_primary': true })
      .where(function () { blockingPropertyReview(this, 'blocked_primary'); });
  });
}

const SERVICE_FIELDS = ['service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_state', 'service_address_zip'];
function serviceReviewDecision(service, review) {
  if (!review) return null;
  const linkedPrimaryBlock = ['needs_details', 'needs_pin', 'outside_area'].includes(review.status)
    && review.primary_address_matches_review === true
    && service.property_id != null && review.primary_property_id != null
    && String(service.property_id) === String(review.primary_property_id);
  const snapshot = SERVICE_FIELDS.map(field => service[field] || null);
  const reference = Object.fromEntries(SERVICE_FIELDS.map((field, index) => [field, review.address_snapshot[index]]));
  const exact = JSON.stringify(snapshot) === JSON.stringify(review.address_snapshot.map(value => value || null));
  if (!linkedPrimaryBlock && !exact) {
    // Complete localities are required before treating alternative spellings
    // as the same property. An incomplete primary must not claim a secondary
    // address that happens to share its street name.
    if (![service, reference].every(row => SERVICE_FIELDS.filter(field => field !== 'service_address_line2')
      .every(field => String(row[field] || '').trim()))) return null;
    const { inheritReferenceUnit, premiseStampConflicts } = require('./stamped-address');
    if (premiseStampConflicts(inheritReferenceUnit(service, reference), reference)
      || String(service.service_address_state).trim().toLowerCase() !== String(reference.service_address_state).trim().toLowerCase()) return null;
  }
  if (review.status === 'verified' && hasPin(review)) {
    if (review.primary_address_matches_review && !review.primary_pin_matches_review) {
      return { location: null, permanent: true, reason: 'address_review_required' };
    }
    return { location: { lat: Number(review.latitude), lng: Number(review.longitude) }, permanent: false };
  }
  if (['needs_details', 'needs_pin', 'outside_area'].includes(review.status)) return { location: null, permanent: true, reason: 'address_review_required' };
  return null;
}

async function serviceReviewContexts(customerIds, conn = db) {
  const ids = [...new Set((customerIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const reviews = await conn('customer_geocode_reviews').whereIn('customer_id', ids);
  if (!reviews.length) return new Map();
  const primaries = await conn('customer_properties')
    .whereIn('customer_id', reviews.map(review => review.customer_id))
    .where({ active: true, is_primary: true })
    .select('customer_id', 'id', ...ADDRESS_FIELDS, 'latitude', 'longitude');
  const primaryByCustomer = new Map(primaries.map(row => [String(row.customer_id), row]));
  return new Map(reviews.map(review => {
    const primary = primaryByCustomer.get(String(review.customer_id));
    const currentPrimarySnapshot = primary && addressSnapshot(primary);
    return [review.customer_id, {
      ...review,
      primary_property_id: primary?.id || null,
      primary_address_matches_review: !!primary && Array.isArray(review.address_snapshot)
        && JSON.stringify(currentPrimarySnapshot.map(value => value || null))
          === JSON.stringify(review.address_snapshot.map(value => value || null)),
      primary_pin_matches_review: !!primary && hasPin(primary) && samePin(primary, review),
    }];
  }));
}

async function reviewedServiceLocation(service, conn = db) {
  if (!reviewEnabled()) return null;
  const contexts = await serviceReviewContexts([service.customer_id], conn);
  return serviceReviewDecision(service, contexts.get(service.customer_id));
}

async function filterServiceReviewBlocks(rows, conn = db) {
  if (!reviewEnabled() || !rows.length) return rows;
  const byCustomer = await serviceReviewContexts(rows.map(row => row.customer_id), conn);
  return rows.filter(row => {
    const decision = serviceReviewDecision(row, byCustomer.get(row.customer_id));
    return !decision || decision.location;
  });
}

async function attemptReviewedGeocode(customerId, conn = db, { onCoordinatesCommitted } = {}) {
  const customer = await conn('customers').where({ id: customerId }).whereNull('deleted_at').first();
  if (!customer) return null;
  const [review, primary] = await Promise.all([
    conn('customer_geocode_reviews').where({ customer_id: customerId }).first(),
    conn('customer_properties').where({ customer_id: customerId, active: true, is_primary: true }).first(),
  ]);
  const effective = effectiveCustomer(customer, primary);
  if (sameAddress(customer, review) && review?.status === 'verified' && samePin(effective, review)) {
    return { lat: Number(effective.latitude), lng: Number(effective.longitude) };
  }
  if (blocksAutomaticGeocode(customer, review)) return null;
  if (hasPin(effective) && (!review || sameAddress(customer, review))) return { lat: Number(effective.latitude), lng: Number(effective.longitude) };
  const geocoder = require('./geocoder');
  const result = completeAddress(customer) ? await geocoder.geocodeAddressWithStatus(geocoder.buildAddress(customer))
    : { location: null, permanent: true, reason: 'incomplete_address' };
  const committed = await conn.transaction(async trx => {
    const current = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate().first();
    const latestReview = await trx('customer_geocode_reviews').where({ customer_id: customerId }).first();
    const currentPrimary = await trx('customer_properties')
      .where({ customer_id: customerId, active: true, is_primary: true }).forShare().first();
    if (!current || !reviewEnabled()
      || reviewRevision(current, latestReview, currentPrimary) !== reviewRevision(customer, review, primary)) return null;
    const location = result.location;
    const status = location ? 'geocoded' : !result.permanent ? 'provider_unavailable'
      : result.reason === 'incomplete_address' ? 'needs_details' : result.reason === 'outside_service_area' ? 'outside_area' : 'needs_pin';
    if (location) {
      await trx('customers').where({ id: customerId }).update({ latitude: location.lat, longitude: location.lng, updated_at: trx.fn.now() });
      await require('./customer-properties').syncPrimaryCoordsFromCustomer(customerId, trx);
    }
    await saveReview(trx, current, { status, reason: result.reason || (location ? 'provider_match' : 'geocode_unavailable'), source: 'google',
      latitude: location?.lat, longitude: location?.lng });
    return location;
  });
  if (committed && onCoordinatesCommitted) await onCoordinatesCommitted();
  return committed;
}

module.exports = { reviewEnabled, addressSnapshot, reviewRevision, saveReview, getReviewDetail, listReviewQueue,
  attemptReviewedGeocode, excludeReviewedAddresses, excludeMatchingPrimaryPins, excludeCustomerAutomaticGeocodeForId,
  reviewedCustomerLocation, withCustomerReviewWriteFence, effectiveReview, blocksAutomaticGeocode,
  needsCoordinatePairRepair,
  filterServiceReviewBlocks, reviewedServiceLocation, serviceReviewDecision, serviceReviewContexts,
  excludePrimaryPropertyReviewBlocks, excludePrimaryPropertyReviewForId };
