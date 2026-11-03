/** County-roll pins for the hourly geocoder backstop (GATE_GEOCODE_COUNTY_FALLBACK, dark).
 *
 * Three passes after the existing sweeps, none of them calling Google:
 *  1. customer-geocode-review retryCountyNeedsPin: rows already on the staff needs_pin list.
 *  2. sweepUnpinnedProperties: active customer_properties rows with no pin. The customer sweep only
 *     fills the customers row and mirrors the PRIMARY property, so a non-primary or
 *     address-mismatched property never gets a pin. A row takes the customer's pin when the
 *     address is the customer's, else the county lot for its own address.
 *  3. sweepPropertyVisitPins: upcoming visits with no pin whose stamp is their property's address
 *     take the property's pin, through the service-location recovery write.
 * Gate off: nothing here runs, no county call is made. Logs carry counts only (PII rule).
 */
const db = require('../models/db');
const logger = require('./logger');
// Read at call time with an optional call: a test that mocks feature-gates wholesale must not crash the backstop.
// The pass also needs GATE_GEOCODE_REVIEW: without it the write fence takes no locks and the review rechecks
// are no-ops, so nothing here runs unless both gates are on.
const countyFallbackLive = () => require('../config/feature-gates').geocodeCountyFallbackLive?.() === true
  && require('./customer-geocode-review').reviewEnabled();
const { etDateString, addETDays } = require('../utils/datetime-et');
const { toDateStr } = require('./auto-dispatch/dates');

const PROPERTY_BATCH = 25;
const VISIT_BATCH = 25;
// The service-location backstop's window; a later visit takes the pin once it is in range.
const VISIT_WINDOW_DAYS = 30;
const UNRESOLVED_CAP = 2000;
// When a remembered row is asked again without an address edit: a county miss after 7 days (the needs_pin
// retry's interval; the roll gains new lots), a pin a review withholds after 6 hours (staff can verify it).
const COUNTY_MISS_RETRY_MS = 7 * 86400000;
const WITHHELD_RETRY_MS = 6 * 3600000;
const ADDRESS_COLUMNS = ['address_line1', 'address_line2', 'city', 'state', 'zip'];
const STAMP_COLUMNS = ['service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_state', 'service_address_zip'];

// Properties the county could not place, or whose customer pin a review withholds, keyed property
// id -> { key: the address string that missed, retryAt }. An address edit changes the string and
// re-admits the row, so does reaching retryAt, and a restart clears the map.
const unresolvedProperties = new Map();

const addressKey = row => [row.address_line1, row.city, row.zip].map(part => String(part || '').trim().toLowerCase()).join('|');
const coordinate = value => (value == null ? null : Number(value));
const hasCoordinates = row => ['latitude', 'longitude'].every(field => row[field] != null
  && Number.isFinite(Number(row[field])) && Number(row[field]) !== 0);

async function pruneUnresolvedProperties(conn, now) {
  while (unresolvedProperties.size > UNRESOLVED_CAP) unresolvedProperties.delete(unresolvedProperties.keys().next().value);
  for (const [id, entry] of unresolvedProperties) if (entry.retryAt <= now.getTime()) unresolvedProperties.delete(id);
  if (!unresolvedProperties.size) return;
  const rows = await conn('customer_properties').whereIn('id', [...unresolvedProperties.keys()])
    .select('id', 'address_line1', 'city', 'zip');
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const [id, entry] of unresolvedProperties) {
    if (!byId.has(id) || addressKey(byId.get(id)) !== entry.key) unresolvedProperties.delete(id);
  }
}

const norm = column => `lower(btrim(COALESCE(${column}, '')))`;
const pinnedSql = alias => `(${alias}.latitude IS NOT NULL AND ${alias}.longitude IS NOT NULL AND ${alias}.latitude <> 0 AND ${alias}.longitude <> 0)`;
const sameRowsSql = (left, right) => `jsonb_build_array(${ADDRESS_COLUMNS.map(column => `COALESCE(${left}.${column}, '')`).join(', ')})`
  + ` = jsonb_build_array(${ADDRESS_COLUMNS.map(column => `COALESCE(${right}.${column}, '')`).join(', ')})`;
// The customer's own address with no effective customer pin yet, on the customer row or on a primary at
// that address (effectiveCustomer's rule): the customer sweep will pin both.
const WAITS_FOR_CUSTOMER_PIN_SQL = ['address_line1', 'city', 'zip'].map(column => `${norm(`p.${column}`)} = ${norm(`c.${column}`)}`).join(' AND ')
  + ` AND NOT ${pinnedSql('c')}`
  + ' AND NOT EXISTS (SELECT 1 FROM customer_properties pp WHERE pp.customer_id = c.id AND pp.active = true AND pp.is_primary = true'
  + ` AND ${sameRowsSql('pp', 'c')} AND ${pinnedSql('pp')})`;

function candidatePropertiesQuery(conn, review) {
  const query = conn('customer_properties as p').join('customers as c', 'c.id', 'p.customer_id')
    .where('p.active', true).whereNull('c.deleted_at')
    .where(function () { this.whereNull('p.latitude').orWhereNull('p.longitude'); })
    .whereRaw("NULLIF(btrim(p.address_line1), '') IS NOT NULL")
    // A primary row at the customer's own address is the customer sweep's.
    .whereRaw(`NOT (COALESCE(p.is_primary, false) AND ${review.PRIMARY_ADDRESS_MATCH_SQL})`)
    .whereRaw(`NOT (${WAITS_FOR_CUSTOMER_PIN_SQL})`);
  const excluded = [...unresolvedProperties.keys()];
  if (excluded.length) query.whereNotIn('p.id', excluded);
  return review.excludePrimaryPropertyReviewBlocks(query, 'p');
}

// Null-aware equality, so the write lands only on the row exactly as read.
function whereUnchanged(query, row, columns) {
  for (const column of columns) {
    if (row[column] == null) query.whereNull(column); else query.where(column, row[column]);
  }
  return query;
}

// The customer's address and pin exactly as the candidate query read them (c_<column>).
const customerAsRead = (customer, row) => ADDRESS_COLUMNS.every(column => (customer[column] ?? null) === (row[`c_${column}`] ?? null))
  && ['latitude', 'longitude'].every(column => coordinate(customer[column]) === coordinate(row[`c_${column}`]));

/**
 * The property pin, under the background property write fence (call-property-lookup
 * withReviewWriteFence): try-locks on the customer and this row, so the pass never waits on a staff
 * transaction, and a staff geocode decision, which locks the customer first, cannot interleave. The
 * customer's address and pin, the row and its primary flag must be as read, and a review that holds
 * this primary row's address blocks the write. `lot` null = copy the customer's pin, read here through
 * the review: a pin the review withholds is never copied.
 * Resolves 'pinned', 'withheld', or 'stale' (something changed or a lock was held; the next run retries).
 */
async function writePropertyPin(row, lot) {
  const { withReviewWriteFence, isReviewFenceBusy } = require('./call-property-lookup');
  const review = require('./customer-geocode-review');
  try {
    const outcome = await withReviewWriteFence({ propertyId: row.id, customerId: row.customer_id }, async (trx) => {
      const customer = await trx('customers').where({ id: row.customer_id }).whereNull('deleted_at').first();
      if (!customer || !customerAsRead(customer, row)) return 'stale';
      const located = lot ? null : await review.reviewedCustomerLocation(customer, trx);
      const pin = lot || (located && hasCoordinates(located) ? { lat: Number(located.latitude), lng: Number(located.longitude) } : null);
      if (!pin) return 'withheld';
      const write = whereUnchanged(trx('customer_properties').where({ id: row.id, active: true }), row,
        [...ADDRESS_COLUMNS, 'latitude', 'longitude', 'is_primary']);
      const count = await review.excludePrimaryPropertyReviewForId(write, row.id)
        .update({ latitude: pin.lat, longitude: pin.lng, updated_at: new Date() });
      return count ? 'pinned' : 'stale';
    });
    return outcome || 'stale';
  } catch (err) {
    if (isReviewFenceBusy(err)) return 'stale';
    throw err;
  }
}

async function sweepUnpinnedProperties({ limit = PROPERTY_BATCH, now = new Date(), conn = db } = {}) {
  const results = { checked: 0, pinned: 0, unresolved: 0 };
  if (!countyFallbackLive()) return results;
  const review = require('./customer-geocode-review');
  await pruneUnresolvedProperties(conn, now);
  const rows = await candidatePropertiesQuery(conn, review).orderBy('p.id').limit(limit)
    .select('p.id', 'p.customer_id', 'p.is_primary', 'p.latitude', 'p.longitude', ...ADDRESS_COLUMNS.map(column => `p.${column}`),
      ...ADDRESS_COLUMNS.map(column => `c.${column} as c_${column}`), 'c.latitude as c_latitude', 'c.longitude as c_longitude');
  for (const row of rows) {
    results.checked += 1;
    // The customer's own address takes the customer's pin; any other address asks the county.
    let lot = null;
    if (addressKey(row) !== addressKey({ address_line1: row.c_address_line1, city: row.c_city, zip: row.c_zip })) {
      try {
        lot = await require('./property-lookup/county-lot-pin').countyLotPinForAddress(row);
      } catch (err) {
        // County outage: write nothing, remember nothing, and stop asking this hour.
        logger.warn(`[geocoder] county property pin stopped: ${err.message}`);
        break;
      }
      if (!lot) {
        results.unresolved += 1;
        unresolvedProperties.set(row.id, { key: addressKey(row), retryAt: now.getTime() + COUNTY_MISS_RETRY_MS });
        continue;
      }
    }
    const outcome = await writePropertyPin(row, lot);
    if (outcome === 'pinned') {
      results.pinned += 1;
      continue;
    }
    results.unresolved += 1;
    if (outcome === 'withheld') unresolvedProperties.set(row.id, { key: addressKey(row), retryAt: now.getTime() + WITHHELD_RETRY_MS });
  }
  return results;
}

// The visit's stamp names this property: exactly, or the same premise with complete localities on
// both sides (serviceReviewDecision's rule), so a stamp missing its city or ZIP never borrows the property's.
function stampIsProperty(visit) {
  const reference = Object.fromEntries(STAMP_COLUMNS.map((column, index) => [column, visit[`p_${ADDRESS_COLUMNS[index]}`]]));
  if (STAMP_COLUMNS.every(column => (visit[column] || null) === (reference[column] || null))) return true;
  const complete = row => STAMP_COLUMNS.filter(column => column !== 'service_address_line2').every(column => String(row[column] || '').trim());
  if (!complete(visit) || !complete(reference)) return false;
  const { premiseStampConflicts, inheritReferenceUnit } = require('./stamped-address');
  return !premiseStampConflicts(inheritReferenceUnit(visit, reference), reference)
    && String(visit.service_address_state).trim().toLowerCase() === String(reference.service_address_state).trim().toLowerCase();
}

// Upcoming visits with no pin on an active, pinned property of the same customer: the service-location
// backstop's population (unlocked, not excluded, stamped) plus a legacy NULL status, which is a live visit.
function unpinnedVisitsQuery(conn, now, snapshotColumns) {
  return conn('scheduled_services as s')
    .join('customers as c', 'c.id', 's.customer_id')
    .join('customer_properties as p', function () { this.on('p.id', '=', 's.property_id').andOn('p.customer_id', '=', 's.customer_id'); })
    .whereNull('c.deleted_at').where('p.active', true)
    .whereRaw('p.latitude IS NOT NULL AND p.longitude IS NOT NULL AND p.latitude <> 0 AND p.longitude <> 0')
    .where(function () { this.whereNull('s.status').orWhereIn('s.status', ['pending', 'confirmed']); })
    .whereBetween('s.scheduled_date', [etDateString(now), etDateString(addETDays(now, VISIT_WINDOW_DAYS))])
    .whereRaw('NOT COALESCE(s.auto_dispatch_locked, false) AND NOT COALESCE(s.auto_dispatch_excluded, false)')
    .whereRaw('(s.lat IS NULL OR s.lng IS NULL OR s.lat = 0 OR s.lng = 0)')
    .whereRaw("NULLIF(btrim(s.service_address_line1), '') IS NOT NULL")
    .select(...snapshotColumns.map(column => `s.${column}`), ...ADDRESS_COLUMNS.map(column => `p.${column} as p_${column}`),
      'p.latitude as p_latitude', 'p.longitude as p_longitude');
}

// Inside the visit write: the source property, share-locked against a concurrent pin correction, is still
// active, the visit customer's, and at the address and pin the pass read. NOWAIT, so this background pass
// never waits on a staff transaction; a held row is retried next run.
const sourcePropertyAsRead = row => async (trx) => {
  const current = await trx('customer_properties').where({ id: row.property_id }).forShare().noWait()
    .first('active', 'customer_id', ...ADDRESS_COLUMNS, 'latitude', 'longitude');
  return !!current && current.active === true && String(current.customer_id) === String(row.customer_id)
    && ADDRESS_COLUMNS.every(column => (current[column] ?? null) === (row[`p_${column}`] ?? null))
    && ['latitude', 'longitude'].every(column => coordinate(current[column]) === coordinate(row[`p_${column}`]));
};

/**
 * Each visit goes through persistServicePin, the service-location backstop's write: the technician-day
 * lock, the source property recheck and the review recheck under it (a withheld pin writes nothing, a
 * staff-verified point wins), and a write only on the visit exactly as read. Needs GATE_ROUTE_REORDER +
 * GATE_ROUTE_REORDER_REPAIR like that backstop. Returns { checked, pinned, stale, failed }.
 */
async function sweepPropertyVisitPins({ limit = VISIT_BATCH, now = new Date(), conn = db } = {}) {
  const results = { checked: 0, pinned: 0, stale: 0, failed: 0 };
  if (!countyFallbackLive()) return results;
  const { SNAPSHOT_COLUMNS, persistServicePin } = require('./geocoder-service-locations');
  const { isReviewFenceBusy } = require('./call-property-lookup');
  const review = require('./customer-geocode-review');
  const query = unpinnedVisitsQuery(conn, now, SNAPSHOT_COLUMNS);
  // Page past visits stamped for another address or withheld by a review (filterServiceReviewBlocks,
  // as the service-location backstop does), so they cannot starve later ones.
  const visits = [];
  for (let offset = 0; visits.length < limit; offset += limit) {
    const batch = await query.clone().orderBy('s.scheduled_date').orderBy('s.id').offset(offset).limit(limit);
    visits.push(...await review.filterServiceReviewBlocks(batch.filter(stampIsProperty), conn));
    if (batch.length < limit) break;
  }
  const dates = new Set();
  for (const row of visits.slice(0, limit)) {
    results.checked += 1;
    const snapshot = Object.fromEntries(SNAPSHOT_COLUMNS.map(column => [column, row[column]]));
    try {
      const pin = { lat: Number(row.p_latitude), lng: Number(row.p_longitude) };
      if (!await persistServicePin(conn, snapshot, pin, { source: 'property_pin', recheck: sourcePropertyAsRead(row) })) {
        results.stale += 1;
        continue;
      }
      results.pinned += 1;
      dates.add(toDateStr(row.scheduled_date));
      await require('./dispatch-assignment').emitDispatchJobUpdate({ jobId: row.id, qualityDates: dates })
        .catch(error => logger.error(`[geocoder] county visit refresh failed for ${row.id} (${error.code || 'broadcast_error'})`));
    } catch (error) {
      if (isReviewFenceBusy(error)) {
        results.stale += 1;
        continue;
      }
      results.failed += 1;
      logger.error(`[geocoder] county visit pin failed for ${row.id}`, { code: error.code });
    }
  }
  if (dates.size) await require('./scheduling/quality-after-change').refreshScheduleQualityAfterChange({ dates: [...dates], now }, conn);
  return results;
}

// One pass failing never stops the next; the error code alone is logged.
async function runPass(label, fallbackCode, pass) {
  try {
    return await pass();
  } catch (err) {
    logger.error(`[geocoder] county ${label} failed (${err.code || fallbackCode})`);
    return undefined;
  }
}

async function sweepCountyFallback() {
  if (!countyFallbackLive()) return null;
  const review = require('./customer-geocode-review');
  const results = {};
  results.needsPin = await runPass('needs_pin retry', 'county_retry_error', async () => {
    const needsPin = await review.retryCountyNeedsPin({ conn: db });
    if (needsPin.customerIds.length) {
      await require('./scheduling/quality-after-change').refreshScheduleQualityAfterChange({ customerIds: needsPin.customerIds });
    }
    return needsPin;
  });
  results.properties = await runPass('property sweep', 'county_property_error', () => sweepUnpinnedProperties({ conn: db }));
  results.visits = await runPass('visit pass', 'county_visit_error', () => sweepPropertyVisitPins({ conn: db }));
  const count = (pass, field) => results[pass]?.[field] ?? 0;
  if (count('needsPin', 'checked') + count('properties', 'checked') + count('visits', 'checked')) {
    logger.info(`[geocoder] county fallback: needs_pin checked=${count('needsPin', 'checked')} pinned=${count('needsPin', 'pinned')}, `
      + `properties checked=${count('properties', 'checked')} pinned=${count('properties', 'pinned')}, `
      + `visits checked=${count('visits', 'checked')} pinned=${count('visits', 'pinned')}`);
  }
  return results;
}

module.exports = { sweepCountyFallback, sweepUnpinnedProperties, sweepPropertyVisitPins, _unresolvedProperties: unresolvedProperties };
