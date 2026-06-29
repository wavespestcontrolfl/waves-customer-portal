/**
 * customer_properties service — Phase 1 of the multi-property model.
 *
 * One customer → many service addresses (each with an occupancy type). Phase 1
 * is additive: `customers.address_*` remains the denormalized mirror of the
 * PRIMARY property, so existing readers are untouched. This module is the only
 * writer of the new table for the call pipeline + admin reads.
 *
 * Behind GATE_CUSTOMER_PROPERTIES (default off) at the call sites so it ships
 * dark until the owner enables it after the migration has run in prod.
 */

const db = require('../models/db');
const logger = require('./logger');

const OCCUPANCY_TYPES = ['owner_occupied', 'rental_investment', 'commercial', 'seasonal', 'vacant', 'unknown'];

/** Case/space/punctuation-insensitive street key — "12338 Amber Creek" ≠ "12398 Amber Creek". */
const normStreet = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Canonical street-suffix forms. We EXPAND abbreviations to one canonical spelling
// (st -> street) so "123 Main St" and "123 Main Street" key identically — but we
// never STRIP the suffix, so "Main St" and "Main Ave" stay DISTINCT streets.
const STREET_SUFFIX_CANON = {
  st: 'street', street: 'street', ave: 'avenue', avenue: 'avenue', rd: 'road', road: 'road',
  dr: 'drive', drive: 'drive', ln: 'lane', lane: 'lane', ct: 'court', court: 'court',
  blvd: 'boulevard', boulevard: 'boulevard', cir: 'circle', circle: 'circle',
  pl: 'place', place: 'place', ter: 'terrace', terrace: 'terrace', way: 'way',
  trl: 'trail', trail: 'trail', pkwy: 'parkway', parkway: 'parkway', hwy: 'highway', highway: 'highway',
};
const canonicalizeAddress = (s) => String(s || '').toLowerCase().replace(/[.,#]/g, ' ')
  .split(/\s+/).map((w) => STREET_SUFFIX_CANON[w] || w).join(' ');

/** First 5 ZIP digits, so "34205" and "34205-1234" (ZIP+4) key identically. */
const normalizeZip = (z) => (String(z || '').match(/\d{5}/) || [''])[0];

/** Suffix-canonical street key — "123 Main St" == "123 Main Street", but != "123 Main Ave". */
const streetKey = (s) => canonicalizeAddress(s).replace(/[^a-z0-9]/g, '');

/**
 * Normalized key for the FULL service address — street + unit + city + ZIP — so
 * "100 Main St, Bradenton" and "100 Main St, Sarasota" are DISTINCT, and so are
 * two units at one street ("100 Main Unit A" vs "Unit B"). Suffix-canonical
 * ("123 Main St" == "123 Main Street") and ZIP+4-insensitive. Stored in the
 * customer_properties.address_key column and uniquely indexed, so the DB
 * uniqueness uses the SAME normalization as this helper (no JS/SQL drift).
 */
function addressKey({ address_line1, address_line2, city, zip } = {}) {
  return canonicalizeAddress([address_line1, address_line2, city, normalizeZip(zip)].filter(Boolean).join(' ')).replace(/[^a-z0-9]/g, '');
}

/** Coerce to a known occupancy enum value (pure). */
function normalizeOccupancy(v) {
  return OCCUPANCY_TYPES.includes(v) ? v : 'unknown';
}

/** True when `candidate` has a street and its full address isn't already in `existingProps` (pure). */
function isNewAddress(existingProps, candidate = {}) {
  if (!String(candidate.address_line1 || '').trim()) return false;
  const key = addressKey(candidate);
  if (!key) return false;
  return !(existingProps || []).some((p) => addressKey(p) === key);
}

/** Active properties for a customer, primary first. */
async function listProperties(customerId) {
  if (!customerId) return [];
  return db('customer_properties')
    .where({ customer_id: customerId, active: true })
    .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'created_at', order: 'asc' }]);
}

/**
 * Ensure a customer has a PRIMARY property row (lazily backfills customers
 * created after the migration). Idempotent — the partial-unique index makes a
 * concurrent double-create safe. Returns { created, propertyId }.
 */
async function ensurePrimaryProperty(customerOrId) {
  const customer = typeof customerOrId === 'string'
    ? await db('customers').where({ id: customerOrId }).first()
    : customerOrId;
  if (!customer || !customer.id) return { created: false, propertyId: null };

  const existing = await db('customer_properties').where({ customer_id: customer.id, is_primary: true }).first();
  if (existing) return { created: false, propertyId: existing.id };
  if (!String(customer.address_line1 || '').trim()) return { created: false, propertyId: null };

  try {
    const [row] = await db('customer_properties').insert({
      customer_id: customer.id,
      label: customer.profile_label || 'Primary',
      occupancy_type: 'owner_occupied',
      is_primary: true,
      address_line1: customer.address_line1,
      address_line2: customer.address_line2 || null,
      city: customer.city || null,
      state: customer.state || 'FL',
      zip: customer.zip || null,
      latitude: customer.latitude ?? null,
      longitude: customer.longitude ?? null,
      // Mirror the same property-grained attributes the migration backfill copies,
      // so a customer created AFTER the migration doesn't lose size/lawn data.
      property_type: customer.property_type ?? null,
      lawn_type: customer.lawn_type ?? null,
      property_sqft: customer.property_sqft ?? null,
      lot_sqft: customer.lot_sqft ?? null,
      bed_sqft: customer.bed_sqft ?? null,
      linear_ft_perimeter: customer.linear_ft_perimeter ?? null,
      palm_count: customer.palm_count ?? null,
      canopy_type: customer.canopy_type ?? null,
      address_key: addressKey({ address_line1: customer.address_line1, address_line2: customer.address_line2, city: customer.city, zip: customer.zip }),
      source: 'backfill',
      active: true,
    }).returning('id');
    return { created: true, propertyId: row && (row.id || row) };
  } catch (e) {
    // Partial-unique race (another writer created the primary) — treat as exists.
    logger.warn(`[customer-properties] ensurePrimaryProperty(${customer.id}) skipped: ${e.message}`);
    return { created: false, propertyId: null };
  }
}

/**
 * Record a service address as a property when its FULL address (street + unit +
 * city + ZIP) isn't already on file. Normally a NON-primary property — but when
 * the customer has NO primary yet (e.g. an addressless customer adding their
 * first property via the API), this one becomes the primary AND is mirrored into
 * customers.address_* (filled only when empty), so the ~310 mirror readers see a
 * service address. Returns { created, propertyId }.
 */
async function recordCallProperty({ customerId, address_line1, address_line2, city, state, zip, occupancyType, label, source = 'call_pipeline' }) {
  const street = String(address_line1 || '').trim();
  if (!customerId || !street) return { created: false, propertyId: null };

  const candidate = { address_line1: street, address_line2, city, zip };
  // Fast-path dedup on the full address; the partial-unique index (migration) is
  // the atomic backstop against a concurrent double-insert.
  const existing = await db('customer_properties').where({ customer_id: customerId });
  if (!isNewAddress(existing, candidate)) return { created: false, propertyId: null };

  const key = addressKey(candidate);
  const baseRow = {
    customer_id: customerId,
    label: label || null,
    occupancy_type: normalizeOccupancy(occupancyType),
    address_line1: street,
    address_line2: address_line2 || null,
    city: city || null,
    state: state || 'FL',
    zip: zip || null,
    address_key: key,
    source,
    active: true,
  };

  // Insert as primary only if the customer has none yet. On a one-primary race
  // (two concurrent first-address writes), the loser retries as a NON-primary so
  // a genuinely distinct address isn't dropped; an address-uniqueness violation
  // means the same address already exists → already-present.
  const insertRow = async (isPrimary) => {
    const [r] = await db('customer_properties')
      .insert({ ...baseRow, is_primary: isPrimary, label: baseRow.label || (isPrimary ? 'Primary' : null) })
      .returning('id');
    return r && (r.id || r);
  };

  let isPrimary = !existing.some((p) => p.is_primary);
  let propertyId;
  try {
    propertyId = await insertRow(isPrimary);
  } catch (e) {
    const constraint = e && (e.constraint || '');
    if (e && e.code === '23505' && constraint === 'customer_properties_one_primary' && isPrimary) {
      // Lost the primary race — another address won. Keep ours as a secondary.
      try {
        isPrimary = false;
        propertyId = await insertRow(false);
      } catch (e2) {
        if (e2 && e2.code === '23505') return { created: false, propertyId: null };
        throw e2;
      }
    } else if (e && e.code === '23505') {
      return { created: false, propertyId: null }; // same address already present
    } else {
      throw e;
    }
  }

  if (isPrimary) {
    // Mirror the new primary into customers.address_* — only when empty so we
    // never clobber an existing mirror.
    await db('customers')
      .where({ id: customerId })
      .andWhere((q) => q.whereNull('address_line1').orWhere('address_line1', ''))
      .update({
        address_line1: street,
        address_line2: address_line2 || null,
        city: city || null,
        state: state || 'FL',
        zip: zip || null,
        updated_at: new Date(),
      })
      .catch((e) => logger.warn(`[customer-properties] primary mirror sync failed for ${customerId}: ${e.message}`));
  }

  logger.info(`[customer-properties] recorded ${source} ${isPrimary ? 'primary' : 'secondary'} property ${propertyId} for customer ${customerId} (occupancy=${normalizeOccupancy(occupancyType)})`);
  return { created: true, propertyId };
}

module.exports = {
  OCCUPANCY_TYPES,
  normStreet,
  addressKey,
  streetKey,
  normalizeZip,
  normalizeOccupancy,
  isNewAddress,
  listProperties,
  ensurePrimaryProperty,
  recordCallProperty,
};
