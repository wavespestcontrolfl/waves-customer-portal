/** Primary service-address review, shared by Customer 360 and the existing geocoder. */
const { createHash } = require('node:crypto');
const db = require('../models/db');
const { gateEnvValue } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');

const ADDRESS_FIELDS = ['address_line1', 'address_line2', 'city', 'state', 'zip'];
const CUSTOMER_FIELDS = ['id', 'first_name', 'last_name', ...ADDRESS_FIELDS, 'latitude', 'longitude'];
const reviewEnabled = () => gateEnvValue('GATE_GEOCODE_REVIEW');
const addressSnapshot = customer => ADDRESS_FIELDS.map(field => customer[field] ?? null);
const sameAddress = (customer, review) => JSON.stringify(addressSnapshot(customer)) === JSON.stringify(review?.address_snapshot);
const hasPin = customer => ['latitude', 'longitude'].every(field => customer[field] != null && Number.isFinite(Number(customer[field])) && Number(customer[field]) !== 0);
const samePin = (customer, review) => hasPin(customer) && ['latitude', 'longitude'].every(field => Number(customer[field]) === Number(review[field]));
const completeAddress = customer => ['address_line1', 'city', 'state', 'zip'].every(field => String(customer[field] || '').trim())
  && /^\d+[A-Za-z-]*\s+\S/.test(String(customer.address_line1 || '').trim());

function reviewRevision(customer, review) {
  const numeric = value => value == null ? null : Number(value);
  const saved = review ? [review.address_snapshot, review.status, review.reason, review.source, review.evidence,
    review.reviewed_by, new Date(review.updated_at).toISOString(), numeric(review.latitude), numeric(review.longitude)] : null;
  return createHash('sha256').update(JSON.stringify([addressSnapshot(customer), numeric(customer.latitude), numeric(customer.longitude), saved])).digest('hex');
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

function detail(customer, review, nextVisitDate) {
  return { enabled: true, customer: Object.fromEntries(CUSTOMER_FIELDS.map(field => [field, customer[field] ?? null])),
    review: effectiveReview(customer, review), revision: reviewRevision(customer, review), next_visit_date: nextVisitDate || null };
}

async function getReviewDetail(customerId, conn = db) {
  const customer = await conn('customers').where({ id: customerId }).whereNull('deleted_at').first();
  if (!customer) return null;
  const review = await conn('customer_geocode_reviews').where({ customer_id: customerId }).first();
  const next = await conn('scheduled_services').where({ customer_id: customerId }).whereIn('status', ['pending', 'confirmed'])
    .where('scheduled_date', '>=', etDateString(new Date())).min('scheduled_date as date').first();
  return detail(customer, review, next?.date);
}

const ADDRESS_MATCH_SQL = 'r.address_snapshot = jsonb_build_array(c.address_line1, c.address_line2, c.city, c.state, c.zip)';
const HAS_PIN_SQL = '(c.latitude IS NOT NULL AND c.longitude IS NOT NULL AND c.latitude <> 0 AND c.longitude <> 0)';
const VERIFIED_PIN_SQL = `(r.status = 'verified' AND ${ADDRESS_MATCH_SQL} AND ${HAS_PIN_SQL} AND c.latitude = r.latitude AND c.longitude = r.longitude)`;

async function listReviewQueue({ limit = 25, offset = 0 } = {}, conn = db) {
  const upcoming = conn('scheduled_services').select('customer_id').min('scheduled_date as next_visit_date')
    .whereIn('status', ['pending', 'confirmed']).where('scheduled_date', '>=', etDateString(new Date())).groupBy('customer_id');
  const query = conn('customers as c').leftJoin('customer_geocode_reviews as r', 'r.customer_id', 'c.id')
    .leftJoin(upcoming.as('visits'), 'visits.customer_id', 'c.id').whereNull('c.deleted_at')
    .whereRaw("(NULLIF(btrim(c.address_line1), '') IS NOT NULL OR visits.next_visit_date IS NOT NULL)")
    .whereRaw(`NOT COALESCE(${VERIFIED_PIN_SQL}, false)`)
    .whereRaw(`NOT COALESCE(r.status = 'outside_area' AND r.reviewed_at IS NOT NULL AND ${ADDRESS_MATCH_SQL}, false)`)
    .whereRaw(`(NOT ${HAS_PIN_SQL} OR (r.customer_id IS NOT NULL AND (NOT (${ADDRESS_MATCH_SQL}) OR r.status <> 'geocoded')))`);
  const [{ count }] = await query.clone().count('* as count');
  const rows = await query.select('c.*', conn.raw('to_jsonb(r) as review_record'), 'visits.next_visit_date')
    .orderByRaw('visits.next_visit_date ASC NULLS LAST').orderBy('c.id').limit(limit).offset(offset);
  return { enabled: true, total: Number(count), records: rows.map(row => detail(row, row.review_record, row.next_visit_date)) };
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
            .whereRaw('r.address_snapshot = jsonb_build_array(??.address_line1, ??.address_line2, ??.city, ??.state, ??.zip)', Array(5).fill(alias));
        });
      });
  });
}

const SERVICE_FIELDS = ['service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_state', 'service_address_zip'];
function serviceReviewDecision(service, review) {
  if (!review) return null;
  const snapshot = SERVICE_FIELDS.map(field => service[field] || null);
  const reference = Object.fromEntries(SERVICE_FIELDS.map((field, index) => [field, review.address_snapshot[index]]));
  const exact = JSON.stringify(snapshot) === JSON.stringify(review.address_snapshot.map(value => value || null));
  if (!exact) {
    // Complete localities are required before treating alternative spellings
    // as the same property. An incomplete primary must not claim a secondary
    // address that happens to share its street name.
    if (![service, reference].every(row => SERVICE_FIELDS.filter(field => field !== 'service_address_line2')
      .every(field => String(row[field] || '').trim()))) return null;
    const { inheritReferenceUnit, premiseStampConflicts } = require('./stamped-address');
    if (premiseStampConflicts(inheritReferenceUnit(service, reference), reference)
      || String(service.service_address_state).trim().toLowerCase() !== String(reference.service_address_state).trim().toLowerCase()) return null;
  }
  if (review.status === 'verified' && hasPin(review)) return { location: { lat: Number(review.latitude), lng: Number(review.longitude) }, permanent: false };
  if (['needs_details', 'needs_pin', 'outside_area'].includes(review.status)) return { location: null, permanent: true, reason: 'address_review_required' };
  return null;
}

async function reviewedServiceLocation(service, conn = db) {
  if (!reviewEnabled()) return null;
  const review = await conn('customer_geocode_reviews').where({ customer_id: service.customer_id }).first();
  return serviceReviewDecision(service, review);
}

async function filterServiceReviewBlocks(rows, conn = db) {
  if (!reviewEnabled() || !rows.length) return rows;
  const reviews = await conn('customer_geocode_reviews').whereIn('customer_id', [...new Set(rows.map(row => row.customer_id))]);
  const byCustomer = new Map(reviews.map(review => [review.customer_id, review]));
  return rows.filter(row => {
    const decision = serviceReviewDecision(row, byCustomer.get(row.customer_id));
    return !decision || decision.location;
  });
}

async function attemptReviewedGeocode(customerId, conn = db, { onCoordinatesCommitted } = {}) {
  const customer = await conn('customers').where({ id: customerId }).whereNull('deleted_at').first();
  if (!customer) return null;
  const review = await conn('customer_geocode_reviews').where({ customer_id: customerId }).first();
  if (sameAddress(customer, review) && review?.status === 'verified' && samePin(customer, review)) {
    return { lat: Number(customer.latitude), lng: Number(customer.longitude) };
  }
  if (blocksAutomaticGeocode(customer, review)) return null;
  if (hasPin(customer) && (!review || sameAddress(customer, review))) return { lat: Number(customer.latitude), lng: Number(customer.longitude) };
  const geocoder = require('./geocoder');
  const result = completeAddress(customer) ? await geocoder.geocodeAddressWithStatus(geocoder.buildAddress(customer))
    : { location: null, permanent: true, reason: 'incomplete_address' };
  const committed = await conn.transaction(async trx => {
    const current = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate().first();
    const latestReview = await trx('customer_geocode_reviews').where({ customer_id: customerId }).first();
    if (!current || !reviewEnabled() || reviewRevision(current, latestReview) !== reviewRevision(customer, review)) return null;
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
  attemptReviewedGeocode, excludeReviewedAddresses, effectiveReview, blocksAutomaticGeocode,
  filterServiceReviewBlocks, reviewedServiceLocation, serviceReviewDecision };
