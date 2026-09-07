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

/**
 * Occupancy a lazily-backfilled PRIMARY should carry when nothing better is
 * known, derived from customers.contact_role (constants/contact-roles.js):
 *  - owner / NULL       → owner_occupied (the residential majority)
 *  - property_manager   → rental_investment (the default address is one of
 *                         the managed rentals, never the manager's home)
 *  - tenant             → unknown (occupies but does not own — asserting
 *                         owner-occupied would contradict the role)
 */
function defaultOccupancyForContactRole(contactRole) {
  switch (String(contactRole || '').trim().toLowerCase()) {
    case 'property_manager': return 'rental_investment';
    case 'tenant': return 'unknown';
    default: return 'owner_occupied';
  }
}

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

/**
 * The bare unit token from a UNIT string (a line2 like "Apt 4" / "Unit 4" / "#4" /
 * "4"), with interchangeable designators stripped, so they all collapse to "4" —
 * the SAME normalization addressKey applies. Use this (not a raw normStreet, which
 * keeps the designator word) when comparing two units for equality, so the
 * classifier can't disagree with the dedup key. Pass a unit string, NOT a street.
 */
function unitKey(s) {
  return normStreet(stripUnitDesignators(s));
}

/**
 * The trailing unit embedded in a ONE-LINE street ("100 Main St Apt 4" → "4"),
 * anchored to a designator + end-of-string so a bare number is NOT pulled out of a
 * house number ("14 Main St" → ""). '#' is kept OUT of the \b group — \b is a word
 * boundary and '#' is a non-word char, so "\b#" never matches "St #4".
 */
function streetEmbeddedUnitKey(s) {
  const m = String(s || '').match(/(?:\b(?:apt|apartment|unit|ste|suite)|#)\.?\s*([a-z0-9-]+)\s*$/i);
  return m ? normStreet(m[1]) : '';
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
async function listProperties(customerId, conn = db) {
  if (!customerId) return [];
  return conn('customer_properties')
    .where({ customer_id: customerId, active: true })
    .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'created_at', order: 'asc' }]);
}

/**
 * Ensure a customer has a PRIMARY property row (lazily backfills customers
 * created after the migration). Idempotent — the partial-unique index makes a
 * concurrent double-create safe. Returns { created, propertyId }.
 */
async function ensurePrimaryProperty(customerOrId, opts = {}) {
  // Optional processing-claim fence (#3418 r18): FOR UPDATE on the
  // call_log row inside one transaction spanning the existence check and
  // the insert, so a reclaimed stale worker cannot lazily create the
  // primary from its obsolete extraction. Unfenced callers unchanged.
  // opts.conn (codex #3504 r11): a caller already inside a transaction
  // that holds the customers row (the wizard series activation, via its
  // setup-fee stamp) must run the core on THAT connection — a fresh pool
  // transaction here would wait on the row the caller holds and the
  // caller can't commit while awaiting it (self-deadlock).
  const { claimFence = null, conn = null } = opts;
  if (claimFence && claimFence.callLogId && claimFence.procToken) {
    return db.transaction(async (trx) => {
      // LOCK ORDER: customers row FIRST, then call_log (codex #3418 r22)
      // — same reasoning and order as completePrimaryFromCall's fence.
      const custId = typeof customerOrId === 'string' ? customerOrId : customerOrId?.id;
      if (custId) await trx('customers').where({ id: custId }).forUpdate().first('id');
      const owned = await trx('call_log')
        .where({ id: claimFence.callLogId, processing_token: claimFence.procToken })
        .forUpdate()
        .first('id');
      if (!owned) return { created: false, propertyId: null, claimLost: true };
      return ensurePrimaryCore(customerOrId, opts, trx);
    });
  }
  return ensurePrimaryCore(customerOrId, opts, conn && conn.isTransaction ? conn : db);
}

async function ensurePrimaryCore(customerOrId, { occupancyType, source } = {}, conn = db) {
  const customer = typeof customerOrId === 'string'
    ? await conn('customers').where({ id: customerOrId }).first()
    : customerOrId;
  if (!customer || !customer.id) return { created: false, propertyId: null };

  const existing = await conn('customer_properties').where({ customer_id: customer.id, is_primary: true }).first();
  if (existing) return { created: false, propertyId: existing.id };
  if (!String(customer.address_line1 || '').trim()) return { created: false, propertyId: null };

  try {
    // The insert runs in a NESTED transaction (savepoint under a fence
    // trx; a plain top-level trx otherwise) so the 23505 primary-race
    // catch below never poisons an enclosing transaction.
    const [row] = await conn.transaction((sp) => sp('customer_properties').insert({
      customer_id: customer.id,
      label: customer.profile_label || 'Primary',
      // Honor a caller-supplied occupancy (a primary created from a
      // tenant/rental call); otherwise derive the default from the profile's
      // contact_role so a tenant / property-manager profile is never
      // backfilled as owner-occupied.
      occupancy_type: occupancyType
        ? normalizeOccupancy(occupancyType)
        : defaultOccupancyForContactRole(customer.contact_role),
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
      // Provenance: default lazy backfill, but a caller in a specific flow
      // (the call pipeline) stamps its own source — downstream lanes fence
      // paid work on it (call-property-lookup's recovery sweep).
      source: source || 'backfill',
      active: true,
    }).returning('id'));
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
async function recordCallProperty({ customerId, address_line1, address_line2, city, state, zip, occupancyType, label, source = 'call_pipeline', claimFence = null, conn = null }) {
  const street = String(address_line1 || '').trim();
  if (!customerId || !street) return { created: false, propertyId: null };

  const candidate = { address_line1: street, address_line2, city, zip };
  // Customer-lock fence (#3391 GitHub round): the click-to-estimate mint's
  // single-premises proof reads customer_properties under the CTA writer's
  // customer row lock — an unfenced insert here could land between that
  // proof and the estimate insert, publishing primary-property terms for a
  // report the new evidence says belongs elsewhere. Everything below runs
  // in ONE transaction that takes the same customer lock first
  // (customers → child table, the repo's order), so this write lands
  // wholly before or wholly after any in-flight mint. The 23505 retry
  // branches run in SAVEPOINTS (nested trx) — a failed insert inside a
  // plain transaction would poison it (try/catch in a TXN is not
  // fail-open).
  // Runs on the caller's transaction when given one (codex #3504 r11 —
  // see ensurePrimaryProperty's opts.conn): the customers FOR UPDATE below
  // is then a re-lock of a row the caller already holds (no-op), and the
  // 23505 retry savepoints nest under the caller's transaction as before.
  const run = async (trx) => {
  await trx('customers').where({ id: customerId }).forUpdate().first('id');
  // Optional processing-claim fence (#3418 r16): a call-pipeline caller
  // passes { callLogId, procToken } so THIS durable insert is conditioned
  // on the live claim ATOMICALLY — FOR UPDATE on the call_log row holds
  // it through commit, so the reclaim either already rotated the token
  // (we bail, nothing written) or queues behind this transaction. Lock
  // order customers → call_log row matches the staging/triage writers;
  // the reclaim UPDATE holds no prior locks.
  if (claimFence && claimFence.callLogId && claimFence.procToken) {
    const owned = await trx('call_log')
      .where({ id: claimFence.callLogId, processing_token: claimFence.procToken })
      .forUpdate()
      .first('id');
    if (!owned) return { created: false, propertyId: null, claimLost: true };
  }
  // Fast-path dedup on the full address; the partial-unique index (migration) is
  // the atomic backstop against a concurrent double-insert.
  const existing = await trx('customer_properties').where({ customer_id: customerId });
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
  const insertRow = async (isPrimary) => trx.transaction(async (sp) => {
    // Nested trx = SAVEPOINT: the 23505 retry below must not poison the
    // outer customer-lock transaction.
    const [r] = await sp('customer_properties')
      .insert({ ...baseRow, is_primary: isPrimary, label: baseRow.label || (isPrimary ? 'Primary' : null) })
      .returning('id');
    return r && (r.id || r);
  });

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
    // never clobber an existing mirror. In-transaction (the row is already
    // locked above); a failure here must not roll back the recorded
    // property, so it runs in its own SAVEPOINT and stays fail-soft.
    await trx.transaction(async (sp) => sp('customers')
      .where({ id: customerId })
      .andWhere((q) => q.whereNull('address_line1').orWhere('address_line1', ''))
      .update({
        address_line1: street,
        address_line2: address_line2 || null,
        city: city || null,
        state: state || 'FL',
        zip: zip || null,
        updated_at: new Date(),
      }))
      .catch((e) => logger.warn(`[customer-properties] primary mirror sync failed for ${customerId}: ${e.code || e.name || 'db_error'}`));
  }

  logger.info(`[customer-properties] recorded ${source} ${isPrimary ? 'primary' : 'secondary'} property ${propertyId} for customer ${customerId} (occupancy=${normalizeOccupancy(occupancyType)})`);
  return { created: true, propertyId };
  };
  return conn && conn.isTransaction ? run(conn) : db.transaction(run);
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
async function completePrimaryFromCall(customerId, call = {}, { claimFence = null, conn = null } = {}) {
  if (!customerId || !String(call.address_line1 || '').trim()) return undefined;
  // Optional processing-claim fence (#3418 r18): same shape as
  // recordCallProperty's — FOR UPDATE on the call_log row inside one
  // transaction spanning the reads and both completion writes, so a
  // reclaimed stale worker cannot graft its obsolete city/ZIP. Unfenced
  // callers keep the exact legacy behavior (bare db, swallowed per-write
  // errors).
  if (claimFence && claimFence.callLogId && claimFence.procToken) {
    return db.transaction(async (trx) => {
      // LOCK ORDER: customers row FIRST, then call_log (codex #3418 r22)
      // — Apply holds the customer row before updating the same call_log
      // row, so taking call_log first here was an AB-BA half. Same order
      // recordCallProperty and role staging use.
      await trx('customers').where({ id: customerId }).forUpdate().first('id');
      const owned = await trx('call_log')
        .where({ id: claimFence.callLogId, processing_token: claimFence.procToken })
        .forUpdate()
        .first('id');
      if (!owned) return { claimLost: true };
      return completePrimaryCore(customerId, call, trx);
    });
  }
  return completePrimaryCore(customerId, call, conn && conn.isTransaction ? conn : db);
}

async function completePrimaryCore(customerId, call, conn) {
  // Inside a fence transaction a swallowed failed statement would POISON
  // the trx (later statements 25P02) — so errors propagate there and only
  // the legacy bare-db path keeps its per-write swallow.
  const swallow = (p, label) => (conn === db
    ? p.catch((e) => logger.warn(`[customer-properties] ${label} skipped for ${customerId}: ${e.code || e.name || 'db_error'}`))
    : p);
  const cust = await conn('customers').where({ id: customerId })
    .select('address_line1', 'address_line2', 'city', 'zip').first();
  if (!cust || !String(cust.address_line1 || '').trim()) return undefined;
  if (streetKey(cust.address_line1) !== streetKey(call.address_line1)) return undefined;

  const gap = (cur) => !String(cur || '').trim();
  const patch = {};
  if (gap(cust.city) && call.city) patch.city = call.city;
  if (gap(cust.zip) && call.zip) patch.zip = call.zip;
  if (Object.keys(patch).length) {
    await swallow(
      conn('customers').where({ id: customerId }).update({ ...patch, updated_at: new Date() }),
      'mirror complete',
    );
  }

  const primary = await conn('customer_properties').where({ customer_id: customerId, is_primary: true, active: true }).first();
  if (!primary) return undefined;
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
    // Log the error CODE only — a DB error on an address_key write can echo the
    // canonicalized address (PII) in its message.
    await swallow(
      conn('customer_properties').where({ id: primary.id }).update(ppatch),
      'primary complete',
    );
  }
  return undefined;
}

/**
 * After an admin edits customers.address_* (the primary's mirror), bring the
 * primary customer_properties row back in sync — including recomputing its
 * address_key — so the properties API and the call-pipeline dedup match the
 * corrected address instead of the stale one. Address fields ONLY; never touches
 * occupancy_type, label, or the property-grained attributes. No-op when the
 * primary already matches.
 */
async function syncPrimaryAddress(customerOrId, conn = db, { explicitLine2 = false, preserveCoords = false } = {}) {
  const customer = typeof customerOrId === 'string'
    ? await conn('customers').where({ id: customerOrId }).first()
    : customerOrId;
  if (!customer || !customer.id) return;
  const primary = await conn('customer_properties')
    .where({ customer_id: customer.id, is_primary: true, active: true }).first();
  if (!primary) return;

  const next = {
    address_line1: customer.address_line1 || null,
    // A null customer line2 is ambiguous: legacy callers pass rows where
    // null means "not stated" (keep the primary's unit), but a caller that
    // DELIBERATELY wrote the clear (explicit unit removal, whole-street
    // move) passes explicitLine2 so the null propagates — otherwise the
    // property's address_key keeps a unit the customer record no longer
    // has and exact-unit matching diverges.
    address_line2: explicitLine2
      ? (customer.address_line2 ?? null)
      : (customer.address_line2 ?? primary.address_line2 ?? null),
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
  // The address changed, so the old coordinates point at the wrong place — clear
  // them (better NULL than wrong). The route re-geocodes the customer after this and
  // calls syncPrimaryCoordsFromCustomer to re-mirror the fresh coords onto the
  // primary, so the row regains a location rather than staying permanently null.
  // preserveCoords (r43): a unit-only edit does not move the building — the
  // caller keeps the still-valid coordinates instead of gambling on the
  // best-effort re-geocode.
  if (!preserveCoords) {
    next.latitude = null;
    next.longitude = null;
  }
  next.updated_at = new Date();
  // Errors PROPAGATE (no swallow) so a transactional caller can roll back the
  // mirror edit + surface a 409 on a unique address-index collision rather than
  // leaving customers.address_* and the property's dedup key desynced.
  await conn('customer_properties').where({ id: primary.id }).update(next);
}

/**
 * Mirror the customer's CURRENT lat/lng onto their primary property. Called after a
 * re-geocode (the address edit cleared the primary's coords in syncPrimaryAddress)
 * so the primary regains its location instead of staying null. No-op when the
 * customer has no coords yet or no primary row. Best-effort (caller fire-and-forgets).
 */
async function syncPrimaryCoordsFromCustomer(customerId, conn = db) {
  if (!customerId) return;
  const c = await conn('customers').where({ id: customerId }).select('latitude', 'longitude').first();
  if (!c || c.latitude == null || c.longitude == null) return;
  await conn('customer_properties')
    .where({ customer_id: customerId, is_primary: true, active: true })
    .update({ latitude: c.latitude, longitude: c.longitude, updated_at: new Date() });
}

/**
 * The UNAMBIGUOUS property for a booking that carries no explicit property
 * identity: the customer's sole ACTIVE property (GH codex #3699 r3 — the
 * visit-group stamp needs a property anchor, and the estimate-linkage
 * regroup only covers estimate-backed rows). Two or more active
 * properties → null: the office places those, same exactly-one rule the
 * 20260829000050 linkage backfill applied. Best-effort — null on error.
 * Inside a caller transaction the read runs in a SAVEPOINT (knex nested
 * transaction): a failed statement aborts a PostgreSQL transaction, so a
 * swallowed error here would otherwise fail every later scheduling write
 * with 25P02 (pre-push audit #3837 r3 P1; same shape as
 * visit-groups.maybeGroupRow).
 */
async function soleActivePropertyId(customerId, conn = db) {
  if (!customerId) return null;
  const read = (c) => c('customer_properties')
    .where({ customer_id: customerId, active: true })
    .limit(2)
    .select('id');
  try {
    const rows = conn.isTransaction ? await conn.transaction((sp) => read(sp)) : await read(conn);
    return rows.length === 1 ? rows[0].id : null;
  } catch {
    return null;
  }
}

/**
 * Sole-property anchor for a SPAWNED row (recurring follow-ups, series
 * extensions, next-visit rolls): when the row copied from its parent carries
 * no property_id, stamp the customer's sole active property so the visit-group
 * seam (visit-groups.js groupRowOn) can see it — a null-property row never
 * groups automatically. Prod 2026-09-03: 11 of 23 admin-created rows since
 * Sep 1 inherited a parent's empty value this way. Rules: never overrides an
 * explicit stamp; only an UNSTAMPED row (no service_address_line1) — an
 * unstamped row resolves to the customer's address by every reader's
 * COALESCE, which for a sole-property customer IS that property, while a
 * stamped row may name an address the customer never registered; the
 * 20260903000050 backfill applies the same rule to existing rows.
 * Estimate-backed rows (source_estimate_id) are NOT anchored here (GH
 * codex #3837 r1 P1): an accepted estimate for a NEW address seeds its
 * children before the post-commit estimate linkage creates that property,
 * and the linker only stamps rows still NULL — anchoring them to the old
 * sole property would dispatch the series to the wrong house. The
 * linkage owns those rows.
 * Cols-guarded like the stamp copy; best-effort (null on error).
 */
async function anchorSoleProperty(target, cols, conn = db) {
  if (!target || !cols || !cols.property_id) return;
  if (target.property_id != null || !target.customer_id) return;
  if (cols.service_address_line1 && target.service_address_line1) return;
  if (cols.source_estimate_id && target.source_estimate_id) return;
  target.property_id = await soleActivePropertyId(target.customer_id, conn);
}

const PROPERTY_FIELD_LIMITS = Object.freeze({ address_line1: 200, address_line2: 100, city: 50, zip: 10, label: 100 });

function propertyActionError(message, statusCode = 400, code = 'invalid_property') {
  return Object.assign(new Error(message), { statusCode, status: statusCode, isOperational: true, code });
}

function manualPropertyFields(kind, input = {}) {
  for (const [field, max] of Object.entries(PROPERTY_FIELD_LIMITS)) {
    if (input[field] == null) continue;
    if (typeof input[field] !== 'string') throw propertyActionError(`${field} must be text`);
    if (input[field].length > max) throw propertyActionError(`${field} must be ${max} characters or fewer`);
  }
  const changes = {};
  if (input.label !== undefined) changes.label = input.label || null;
  if (input.occupancy_type !== undefined) {
    if (!OCCUPANCY_TYPES.includes(input.occupancy_type)) throw propertyActionError('invalid occupancy_type');
    changes.occupancy_type = input.occupancy_type;
  }
  if (kind !== 'add') return changes;
  if (!String(input.address_line1 || '').trim()) throw propertyActionError('address_line1 is required');
  if (!String(input.city || '').trim() || !String(input.zip || '').trim()) throw propertyActionError('city and zip are required');
  const state = String(input.state || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) throw propertyActionError('state is required as a two-letter code');
  return { address_line1: input.address_line1.trim(), address_line2: input.address_line2 || null,
    city: input.city.trim(), state, zip: input.zip.trim(), occupancy_type: 'unknown', label: null, ...changes };
}

async function manualPropertyContext(customerId, conn = db, lock = false) {
  let customerQuery = conn('customers').where({ id: customerId }).whereNull('deleted_at')
    .select('*', conn.raw('updated_at::text as row_version'));
  if (lock) customerQuery = customerQuery.forUpdate();
  const customer = await customerQuery.first();
  if (!customer) throw propertyActionError('Customer not found', 404, 'customer_not_found');
  let propertyQuery = conn('customer_properties').where({ customer_id: customerId }).orderBy('id')
    .select('*', conn.raw('updated_at::text as row_version'));
  if (lock) propertyQuery = propertyQuery.forUpdate();
  return { customer, properties: await propertyQuery };
}

function propertyAddressLabel(property) {
  return [property.address_line1, property.address_line2, property.city, property.state, property.zip].filter(Boolean).join(', ');
}

// Shared read-only preview for the property editor and IB. The opaque version
// binds the normalized action to the full-precision customer/portfolio versions.
async function previewManualPropertyChange(customerId, kind, input = {}, propertyId = null, conn = db, loaded = null) {
  const { customer, properties } = loaded || await manualPropertyContext(customerId, conn);
  const changes = manualPropertyFields(kind, input);
  const target = propertyId && properties.find(p => p.id === propertyId && p.active);
  const primary = properties.find(p => p.is_primary && p.active);
  const base = { proposal: true, customer: { id: customerId, name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') } };
  let preview;
  if (kind === 'add') {
    if (!isNewAddress(properties, changes) || addressKey(customer) === addressKey(changes)) {
      throw propertyActionError('A property with that street already exists for this customer', 409, 'property_exists');
    }
    const firstProperty = !properties.some(p => p.is_primary) && !customer.address_line1;
    if (firstProperty && !changes.label) changes.label = 'Primary';
    preview = { ...base, address: propertyAddressLabel(changes), changes,
      effects: !firstProperty
        ? 'Saves an additional property. Registers the existing account address as primary if needed. Existing appointments, recurring services and invoices keep their locations.'
        : 'Saves the first property as primary and fills the empty account address. No appointments are created and no messages are sent.' };
  } else {
    if (!target) throw propertyActionError('property not found', 404, 'property_not_found');
    if (kind === 'edit') {
      if (!Object.keys(changes).length) throw propertyActionError('nothing to update');
      preview = { ...base, property: { id: target.id, address: propertyAddressLabel(target) },
        before: Object.fromEntries(Object.keys(changes).map(key => [key, target[key]])), changes,
        effects: 'Updates only this saved property’s label or occupancy. Account, billing, appointment and recurring-service addresses are unchanged.' };
    } else if (kind === 'primary') {
      preview = { ...base, ...await previewPrimaryPropertyChange(conn, customerId, target, primary, customer) };
    } else throw propertyActionError('Unknown property operation');
  }
  preview._version = require('crypto').createHash('sha256').update(JSON.stringify([
    kind, customerId, propertyId, changes, customer.row_version,
    properties.map(p => [p.id, p.row_version]), preview._invoice_ids || [],
  ])).digest('hex');
  return preview;
}

async function previewPrimaryPropertyChange(conn, customerId, target, primary, customer) {
  if (target.is_primary) throw propertyActionError('This property is already primary', 409, 'already_primary');
  if (require('./pricing-engine/commercial-helpers').normalizePropertyType(target.property_type) === 'commercial'
    || !['owner_occupied', 'unknown'].includes(normalizeOccupancy(target.occupancy_type))) {
    throw propertyActionError('The existing primary-residence workflow requires an owner-occupied or unclassified residential property', 409, 'primary_role_unavailable');
  }
  if (!['address_line1', 'city', 'state', 'zip'].every(field => String(target[field] || '').trim())) {
    throw propertyActionError('Complete the saved property’s street, city, state and ZIP before making it primary', 409, 'property_incomplete');
  }
  const invoices = await conn('invoices').where({ customer_id: customerId }).whereNull('customer_address_snapshot').orderBy('id').select('id');
  const oldAddress = primary || (customer.address_line1 ? customer : null);
  return { previous_primary: oldAddress ? { id: primary?.id || null, address: propertyAddressLabel(oldAddress) } : null,
    primary_property: { id: target.id, address: propertyAddressLabel(target) },
    protected_invoice_count: invoices.length, _invoice_ids: invoices.map(row => row.id),
    effects: [
      'Makes this property primary and mirrors its address, coordinates and saved property measurements onto the customer profile.',
      'Registers the existing account address as a saved property if needed. Preserves existing appointment and recurring-service locations. Historical service records stay unchanged.',
      'Preserves the displayed address on existing invoices and receipts. Third-party billing addresses and all amounts stay unchanged.',
      'The new primary is owner-occupied; custom labels are retained. Sprinkler settings require review for the new property. Sends no messages.',
    ] };
}

async function writeManualProperty(customerId, kind, input, propertyId, options, apply) {
  const changes = manualPropertyFields(kind, input);
  return db.transaction(async trx => {
    await require('../utils/customer-comms-lock').lockCustomerComms(trx, customerId);
    const loaded = await manualPropertyContext(customerId, trx, true);
    if (kind === 'primary') {
      // Credit application locks invoice -> customer, while merge undo locks
      // comms -> customer -> invoice. Never wait on invoices while holding the
      // property operation's customer lock: NOWAIT safely refuses contention
      // and rolls back, avoiding a cycle with either existing workflow.
      try {
        await trx('invoices').where({ customer_id: customerId }).orderBy('id').forUpdate().noWait().select('id');
      } catch (err) {
        if (err.code === '55P03') throw propertyActionError('Billing records are being updated. Try the primary-property change again after that operation finishes.', 409, 'property_busy');
        throw err;
      }
    }
    const preview = await previewManualPropertyChange(customerId, kind, changes, propertyId, trx, loaded);
    if (options.expectedVersion && options.expectedVersion !== preview._version) {
      throw propertyActionError('The customer or properties changed. Request a fresh preview.', 409, 'preview_changed');
    }
    const savedId = await apply(trx, loaded, changes);
    const auditId = await require('./audit-log').recordAuditEvent({
      actor_type: 'admin', actor_id: options.actorId || null, action: `customer_property_${kind}`,
      resource_type: 'customer_property', resource_id: savedId, metadata: { customer_id: customerId, fields: Object.keys(changes) },
      critical: true, trx,
    });
    const properties = await listProperties(customerId, trx);
    const saved = properties.find(p => p.id === savedId);
    const matches = saved && Object.entries(preview.changes || {}).every(([key, value]) => saved[key] === value);
    if (!matches || (kind === 'primary' && !saved.is_primary)) throw propertyActionError('The saved property did not match the requested change', 409, 'verification_failed');
    if (saved.is_primary && kind !== 'edit') {
      const account = await trx('customers').where({ id: customerId }).first();
      if (addressKey(account) !== addressKey(saved)) throw propertyActionError('The primary property and account address did not match', 409, 'verification_failed');
    }
    return { success: true, propertyId: savedId, customer_id: customerId, properties, audit_id: auditId,
      verification: { property_id: savedId, persisted: true, fields_match: true },
      href: `/admin/customers?customerId=${encodeURIComponent(customerId)}` };
  });
}

async function addManualProperty(customerId, input, options = {}) {
  return writeManualProperty(customerId, 'add', input, null, options, async (trx, _loaded, changes) => {
    await completePrimaryFromCall(customerId, changes, { conn: trx });
    await ensurePrimaryProperty(customerId, { conn: trx });
    const result = await recordCallProperty({ customerId, ...changes, occupancyType: changes.occupancy_type, source: 'manual', conn: trx });
    if (!result.created) throw propertyActionError('A property with that street already exists for this customer', 409, 'property_exists');
    return result.propertyId;
  });
}

async function editManualProperty(customerId, propertyId, input, options = {}) {
  return writeManualProperty(customerId, 'edit', input, propertyId, options, async (trx, _loaded, changes) => {
    await trx('customer_properties').where({ id: propertyId, customer_id: customerId, active: true })
      .update({ ...changes, updated_at: trx.fn.now() });
    return propertyId;
  });
}

async function changePrimaryProperty(customerId, propertyId, options = {}) {
  if (!options.expectedVersion) throw propertyActionError('Review the primary-property preview first', 409, 'preview_required');
  return writeManualProperty(customerId, 'primary', {}, propertyId, options, async (trx, { customer, properties }) => {
    await ensurePrimaryProperty(customer, { conn: trx });
    const primary = await trx('customer_properties').where({ customer_id: customerId, is_primary: true, active: true }).first();
    if (customer.address_line1 && !primary) throw propertyActionError('The existing account property could not be preserved. Review the saved properties before changing the primary.', 409, 'primary_missing');
    const target = properties.find(p => p.id === propertyId);
    await require('./invoice-address').freezeCustomerInvoiceAddresses(trx, customer);
    const result = await require('./property-role-proposals').applyPropertyRoleProposals(trx, { customerId, proposals: [{
      kind: 'primary_flip', new_primary_property_id: propertyId, new_primary_address_key: addressKey(target),
      old_primary_property_id: primary?.id || null, old_primary_address_key: primary ? addressKey(primary) : null,
    }] });
    if (result.applied !== 1 || result.skipped) throw propertyActionError('The primary property could not be changed. Request a fresh preview.', 409, 'preview_changed');
    return propertyId;
  });
}

module.exports = {
  PROPERTY_FIELD_LIMITS,
  manualPropertyFields,
  previewManualPropertyChange,
  addManualProperty,
  editManualProperty,
  changePrimaryProperty,
  soleActivePropertyId,
  anchorSoleProperty,
  OCCUPANCY_TYPES,
  normStreet,
  addressKey,
  canonicalizeAddress,
  stripUnitDesignators,
  unitKey,
  streetEmbeddedUnitKey,
  streetKey,
  normalizeZip,
  normalizeOccupancy,
  defaultOccupancyForContactRole,
  isNewAddress,
  completePrimaryFromCall,
  syncPrimaryAddress,
  syncPrimaryCoordsFromCustomer,
  listProperties,
  ensurePrimaryProperty,
  recordCallProperty,
};
