/**
 * Customer home line sweep (owner ruling 2026-10-02, "local line everywhere").
 *
 * Stamps customers.home_line_location_id with the office line their service
 * address resolves to (config/locations.js resolveServiceLocation), together
 * with the address key it was derived from. homeLineLocationId() trusts the
 * stamp only while that key still matches the row's address, so:
 *   - a stamped customer keeps their line when the city map or a geocode
 *     changes later (the point of storing it);
 *   - a customer whose address changed is re-derived at once by the reader
 *     and re-stamped here on the next run;
 *   - a new customer is derived by the reader until the next run stamps it.
 * A staff-set line (home_line_source 'staff') holds until the address
 * changes, like a derived one.
 *
 * Gated by GATE_HOME_LINE (homeLineLive, read at call time): off, the sweep
 * writes nothing. Internal column writes only — no customer communication.
 */

const db = require('../models/db');
const logger = require('./logger');
const { resolveServiceLocation } = require('../config/locations');
const { addressKey } = require('./customer-property-address-keys');
const { homeLineLive } = require('../config/feature-gates');

const COLUMNS = [
  'id', 'address_line1', 'address_line2', 'city', 'zip', 'latitude', 'longitude',
  'home_line_location_id', 'home_line_address_key',
];

async function stampHomeLines({ now = new Date(), database = db } = {}) {
  if (!homeLineLive()) return { skipped: 'gated' };
  const rows = await database('customers').whereNull('deleted_at').select(COLUMNS);
  let stamped = 0;
  let unchanged = 0;
  let lostRace = 0;
  for (const row of rows) {
    const key = addressKey(row);
    if (row.home_line_location_id && row.home_line_address_key === key) {
      unchanged += 1;
      continue;
    }
    // Compare-and-set on the key the row was read with: an address edit or a
    // staff pick that landed since this read is left for the next run.
    const updated = await database('customers')
      .where({ id: row.id })
      .whereRaw('home_line_address_key IS NOT DISTINCT FROM ?', [row.home_line_address_key ?? null])
      .whereRaw('home_line_location_id IS NOT DISTINCT FROM ?', [row.home_line_location_id ?? null])
      .update({
        home_line_location_id: resolveServiceLocation(row).id,
        home_line_address_key: key,
        home_line_source: 'derived',
        home_line_set_at: now,
      });
    if (updated) stamped += 1;
    else lostRace += 1;
  }
  logger.info(`[home-line] sweep: ${stamped} stamped, ${unchanged} unchanged, ${lostRace} changed meanwhile`);
  return { stamped, unchanged, lostRace };
}

module.exports = { stampHomeLines };
