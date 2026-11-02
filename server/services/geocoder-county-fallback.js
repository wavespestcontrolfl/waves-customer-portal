/** County-roll pins for the hourly geocoder backstop (GATE_GEOCODE_COUNTY_FALLBACK, dark).
 *
 * Two passes after the existing sweeps, neither one calling Google:
 *  1. customer-geocode-review retryCountyNeedsPin: rows already on the staff needs_pin list.
 *  2. sweepUnpinnedProperties: active customer_properties rows with no pin. The customer sweep only
 *     fills the customers row and mirrors the PRIMARY property, so a non-primary or
 *     address-mismatched property never gets a pin. A row takes the customer's pin when the
 *     address is the customer's, else the county lot for its own address.
 * Gate off: nothing here runs, no county call is made. Logs carry counts only (PII rule).
 */
const db = require('../models/db');
const logger = require('./logger');
// Read at call time with an optional call: a test that mocks feature-gates wholesale must not crash the backstop.
const countyFallbackLive = () => require('../config/feature-gates').geocodeCountyFallbackLive?.() === true;
const { etDateString } = require('../utils/datetime-et');

const PROPERTY_BATCH = 25;
const UNRESOLVED_CAP = 2000;
const ADDRESS_COLUMNS = ['address_line1', 'address_line2', 'city', 'state', 'zip'];

// Properties the county could not place, keyed property id -> the address string that missed.
// An address edit changes the string and re-admits the row; a restart clears the map.
const unresolvedProperties = new Map();

const addressKey = row => [row.address_line1, row.city, row.zip].map(part => String(part || '').trim().toLowerCase()).join('|');
const hasCoordinates = row => ['latitude', 'longitude'].every(field => row[field] != null
  && Number.isFinite(Number(row[field])) && Number(row[field]) !== 0);

async function pruneUnresolvedProperties(conn) {
  while (unresolvedProperties.size > UNRESOLVED_CAP) unresolvedProperties.delete(unresolvedProperties.keys().next().value);
  if (!unresolvedProperties.size) return;
  const rows = await conn('customer_properties').whereIn('id', [...unresolvedProperties.keys()])
    .select('id', 'address_line1', 'city', 'zip');
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const [id, missed] of unresolvedProperties) {
    if (!byId.has(id) || addressKey(byId.get(id)) !== missed) unresolvedProperties.delete(id);
  }
}

const norm = column => `lower(btrim(COALESCE(${column}, '')))`;
// The customer's own address with no customer pin yet: the customer sweep will pin both.
const WAITS_FOR_CUSTOMER_PIN_SQL = ['address_line1', 'city', 'zip'].map(column => `${norm(`p.${column}`)} = ${norm(`c.${column}`)}`).join(' AND ')
  + ' AND (c.latitude IS NULL OR c.longitude IS NULL OR c.latitude = 0 OR c.longitude = 0)';

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

// The pin for one property row: the customer's own pin at the same address, else the county lot.
// Throws on a county outage; null is a clean miss.
async function pinForProperty(row) {
  const sameAsCustomer = addressKey(row) === addressKey({ address_line1: row.c_address_line1, city: row.c_city, zip: row.c_zip });
  if (sameAsCustomer && hasCoordinates({ latitude: row.c_latitude, longitude: row.c_longitude })) {
    return { lat: Number(row.c_latitude), lng: Number(row.c_longitude) };
  }
  if (sameAsCustomer) return null; // raced with the customer's pin being cleared; the SQL fence normally holds these back
  return require('./property-lookup/county-lot-pin').countyLotPinForAddress(row);
}

// Conditional write: the row's address and its missing pin must be as read. Also fills the
// property's upcoming visits that still have no pin. Returns true when the pin landed.
async function writePropertyPin(conn, row, pin) {
  return conn.transaction(async trx => {
    const count = await whereUnchanged(trx('customer_properties').where({ id: row.id, active: true }), row,
      [...ADDRESS_COLUMNS, 'latitude', 'longitude'])
      .update({ latitude: pin.lat, longitude: pin.lng, updated_at: new Date() });
    if (!count) return false;
    await trx('scheduled_services').where({ property_id: row.id })
      .where('scheduled_date', '>=', etDateString(new Date()))
      // A legacy NULL status is a live visit (customer-properties seriesAgreedPropertyId's rule).
      .where(function () { this.whereNull('status').orWhereNotIn('status', ['cancelled', 'completed']); })
      .where(function () { this.whereNull('lat').orWhereNull('lng'); })
      .update({ lat: pin.lat, lng: pin.lng, updated_at: new Date() });
    return true;
  });
}

async function sweepUnpinnedProperties({ limit = PROPERTY_BATCH, conn = db } = {}) {
  const results = { checked: 0, pinned: 0, unresolved: 0 };
  if (!countyFallbackLive()) return results;
  const review = require('./customer-geocode-review');
  await pruneUnresolvedProperties(conn);
  const rows = await candidatePropertiesQuery(conn, review).orderBy('p.id').limit(limit)
    .select('p.id', 'p.customer_id', 'p.latitude', 'p.longitude', ...ADDRESS_COLUMNS.map(column => `p.${column}`),
      'c.address_line1 as c_address_line1', 'c.city as c_city', 'c.zip as c_zip',
      'c.latitude as c_latitude', 'c.longitude as c_longitude');
  const pinnedCustomers = new Set();
  for (const row of rows) {
    results.checked += 1;
    let pin;
    try {
      pin = await pinForProperty(row);
    } catch (err) {
      // County outage: write nothing, remember nothing, and stop asking this hour.
      logger.warn(`[geocoder] county property pin stopped: ${err.message}`);
      break;
    }
    if (!pin) {
      results.unresolved += 1;
      unresolvedProperties.set(row.id, addressKey(row));
    } else if (await writePropertyPin(conn, row, pin)) {
      results.pinned += 1;
      pinnedCustomers.add(row.customer_id);
    } else results.unresolved += 1;
  }
  if (pinnedCustomers.size) {
    await require('./scheduling/quality-after-change').refreshScheduleQualityAfterChange({ customerIds: [...pinnedCustomers] });
  }
  return results;
}

async function sweepCountyFallback() {
  if (!countyFallbackLive()) return null;
  const review = require('./customer-geocode-review');
  const results = {};
  try {
    results.needsPin = await review.retryCountyNeedsPin({ conn: db });
    if (results.needsPin.customerIds.length) {
      await require('./scheduling/quality-after-change').refreshScheduleQualityAfterChange({ customerIds: results.needsPin.customerIds });
    }
  } catch (err) {
    logger.error(`[geocoder] county needs_pin retry failed (${err.code || 'county_retry_error'})`);
  }
  try {
    results.properties = await sweepUnpinnedProperties({ conn: db });
  } catch (err) {
    logger.error(`[geocoder] county property sweep failed (${err.code || 'county_property_error'})`);
  }
  const touched = (results.needsPin?.checked ?? 0) + (results.properties?.checked ?? 0);
  if (touched) logger.info(`[geocoder] county fallback: needs_pin checked=${results.needsPin?.checked ?? 0} pinned=${results.needsPin?.pinned ?? 0}, `
    + `properties checked=${results.properties?.checked ?? 0} pinned=${results.properties?.pinned ?? 0}`);
  return results;
}

module.exports = { sweepCountyFallback, sweepUnpinnedProperties, _unresolvedProperties: unresolvedProperties };
