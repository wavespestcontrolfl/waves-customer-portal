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

// Strip a trailing unit designator so a STREET-ONLY comparison ignores units
// (units are compared separately and preserved in the full addressKey): a legacy
// "100 Main St Apt 4" and a later "100 Main St" share the same street key.
const stripTrailingUnit = (s) => String(s || '').replace(/\s+(?:apt|apartment|unit|ste|suite|#)\.?\s*[a-z0-9-]+\s*$/i, '').trim();

/** Suffix-canonical, unit-stripped street key — "123 Main St" == "123 Main Street", but != "123 Main Ave". */
const streetKey = (s) => canonicalizeAddress(stripTrailingUnit(s)).replace(/[^a-z0-9]/g, '');

// Interchangeable unit designators are written loosely for the SAME unit, so
// strip the designator WORD wherever it appears (in line2 OR embedded in line1) —
// "Apt 4" / "Unit 4" / "Ste 4" / "#4" / "4", and "100 Main St Apt 4" vs
// "100 Main St" + "Apt 4", all key identically. The bare unit id is preserved so
// different units stay distinct. Same designator set stripTrailingUnit recognizes.
const stripUnitDesignators = (s) => String(s || '')
  .replace(/[.,#]/g, ' ')
  .replace(/\b(?:apt|apartment|unit|ste|suite)\b\.?/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Normalized key for the FULL service address — street + unit + city + ZIP — so
 * "100 Main St, Bradenton" and "100 Main St, Sarasota" are DISTINCT, and so are
 * two units at one street ("100 Main Unit A" vs "Unit B"). Suffix-canonical
 * ("123 Main St" == "123 Main Street") and ZIP+4-insensitive. Stored in the
 * customer_properties.address_key column and uniquely indexed, so the DB
 * uniqueness uses the SAME normalization as this helper (no JS/SQL drift).
 */
function addressKey({ address_line1, address_line2, city, zip } = {}) {
  // Strip unit designators across the COMBINED street + unit so an embedded unit
  // ("100 Main St Apt 4") keys the same as the split form ("100 Main St" + "Apt 4").
  const streetUnit = stripUnitDesignators([address_line1, address_line2].filter(Boolean).join(' '));
  return canonicalizeAddress([streetUnit, city, normalizeZip(zip)].filter(Boolean).join(' ')).replace(/[^a-z0-9]/g, '');
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
async function ensurePrimaryProperty(customerOrId, { occupancyType } = {}) {
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
      // Default owner-occupied for a plain backfill, but honor a caller-supplied
      // occupancy so a primary created from a tenant/rental call isn't mislabeled.
      occupancy_type: occupancyType ? normalizeOccupancy(occupancyType) : 'owner_occupied',
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
    // ONLY the partial-unique primary race (another writer created the primary
    // first, code 23505) means "already exists". Any OTHER DB error is a real
    // failure — surface it rather than silently returning "no primary", which a
    // caller would read as success.
    if (e && e.code === '23505') {
      logger.warn(`[customer-properties] ensurePrimaryProperty(${customer.id}) lost the primary race`);
      return { created: false, propertyId: null };
    }
    throw e;
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
      .catch((e) => logger.warn(`[customer-properties] primary mirror sync failed for ${customerId}: ${e.code || e.name || 'db_error'}`));
  }

  logger.info(`[customer-properties] recorded ${source} ${isPrimary ? 'primary' : 'secondary'} property ${propertyId} for customer ${customerId} (occupancy=${normalizeOccupancy(occupancyType)})`);
  return { created: true, propertyId };
}

/**
 * When a call's address is the customer's PRIMARY street but supplies city / ZIP
 * the records are missing, fill those gaps into BOTH the customers mirror AND the
 * existing primary property (recomputing its address_key) — so the primary stays
 * complete and a later full-address call dedups instead of duplicating. Fill-only
 * (never overwrites a present value); same-street guard so a different address's
 * details are never grafted on. Call BEFORE ensurePrimaryProperty so a newly-
 * created primary also inherits the completed mirror.
 *
 * Deliberately does NOT fill the UNIT (address_line2): a call that adds a unit to
 * a unitless primary is classified upstream as a SECOND service address (the unit
 * makes it a distinct property), so grafting that unit onto the primary would both
 * corrupt the primary's identity and make the later secondary insert dedup against
 * the now-mutated primary. The unit-bearing call is handled by recordCallProperty.
 */
async function completePrimaryFromCall(customerId, call = {}) {
  if (!customerId || !String(call.address_line1 || '').trim()) return;
  const cust = await db('customers').where({ id: customerId })
    .select('address_line1', 'address_line2', 'city', 'zip').first();
  if (!cust || !String(cust.address_line1 || '').trim()) return;
  if (streetKey(cust.address_line1) !== streetKey(call.address_line1)) return;

  const gap = (cur) => !String(cur || '').trim();
  const patch = {};
  if (gap(cust.city) && call.city) patch.city = call.city;
  if (gap(cust.zip) && call.zip) patch.zip = call.zip;
  if (Object.keys(patch).length) {
    await db('customers').where({ id: customerId }).update({ ...patch, updated_at: new Date() })
      .catch((e) => logger.warn(`[customer-properties] mirror complete skipped for ${customerId}: ${e.code || e.name || 'db_error'}`));
  }

  const primary = await db('customer_properties').where({ customer_id: customerId, is_primary: true, active: true }).first();
  if (!primary) return;
  const ppatch = {};
  if (gap(primary.city) && call.city) ppatch.city = call.city;
  if (gap(primary.zip) && call.zip) ppatch.zip = call.zip;
  if (Object.keys(ppatch).length) {
    ppatch.address_key = addressKey({
      address_line1: primary.address_line1,
      address_line2: primary.address_line2,
      city: ppatch.city || primary.city,
      zip: ppatch.zip || primary.zip,
    });
    ppatch.updated_at = new Date();
    await db('customer_properties').where({ id: primary.id }).update(ppatch)
      // Log the error CODE only — a DB error on an address_key write can echo the
      // canonicalized address (PII) in its message.
      .catch((e) => logger.warn(`[customer-properties] primary complete skipped for ${customerId}: ${e.code || e.name || 'db_error'}`));
  }
}

/**
 * After an admin edits customers.address_* (the primary's mirror), bring the
 * primary customer_properties row back in sync — including recomputing its
 * address_key — so the properties API and the call-pipeline dedup match the
 * corrected address instead of the stale one. Address fields ONLY; never touches
 * occupancy_type, label, or the property-grained attributes. No-op when the
 * primary already matches.
 */
async function syncPrimaryAddress(customerOrId, conn = db) {
  const customer = typeof customerOrId === 'string'
    ? await conn('customers').where({ id: customerOrId }).first()
    : customerOrId;
  if (!customer || !customer.id) return;
  const primary = await conn('customer_properties')
    .where({ customer_id: customer.id, is_primary: true, active: true }).first();
  if (!primary) return;

  const next = {
    address_line1: customer.address_line1 || null,
    address_line2: customer.address_line2 ?? primary.address_line2 ?? null,
    city: customer.city || null,
    state: customer.state || primary.state || 'FL',
    zip: customer.zip || null,
  };
  const changed = ['address_line1', 'address_line2', 'city', 'state', 'zip']
    .some((f) => String(primary[f] || '') !== String(next[f] || ''));
  if (!changed) return;

  next.address_key = addressKey({
    address_line1: next.address_line1, address_line2: next.address_line2, city: next.city, zip: next.zip,
  });
  next.updated_at = new Date();
  // Errors PROPAGATE (no swallow) so a transactional caller can roll back the
  // mirror edit + surface a 409 on a unique address-index collision rather than
  // leaving customers.address_* and the property's dedup key desynced.
  await conn('customer_properties').where({ id: primary.id }).update(next);
}

module.exports = {
  OCCUPANCY_TYPES,
  normStreet,
  addressKey,
  streetKey,
  normalizeZip,
  normalizeOccupancy,
  isNewAddress,
  completePrimaryFromCall,
  syncPrimaryAddress,
  listProperties,
  ensurePrimaryProperty,
  recordCallProperty,
};
