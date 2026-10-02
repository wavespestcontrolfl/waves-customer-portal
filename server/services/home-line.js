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
    // Compare-and-set on every column the line was derived from: an address
    // or geocode edit, or a staff pick, that landed since this read leaves the
    // row for the next run instead of stamping a line from stale inputs.
    let update = database('customers').where({ id: row.id });
    for (const column of COLUMNS.slice(1)) {
      update = update.whereRaw(`${column} IS NOT DISTINCT FROM ?`, [row[column] ?? null]);
    }
    const updated = await update.update({
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

/**
 * The caller ID a staff-placed outbound call to this customer presents
 * (home-line PR 2, owner ruling 2026-10-02): their home line while
 * GATE_HOME_LINE is on and their address identifies an office, else the main
 * line — a lead with no office, an unlinked number, or the gate off (the
 * pre-home-line behavior: every call from the main line).
 *
 * @param {object|null} customer  a customers row (address + home_line_* columns)
 * @returns {string} an E.164 Waves number
 */
function homeLineCallerId(customer) {
  const TWILIO_NUMBERS = require('../config/twilio-numbers');
  const main = TWILIO_NUMBERS.mainLine.number;
  if (!customer || !homeLineLive()) return main;
  const { homeLineOfficeId } = require('../config/locations');
  const officeId = homeLineOfficeId(customer);
  return (officeId && TWILIO_NUMBERS.locations[officeId]?.number) || main;
}

module.exports = { stampHomeLines, homeLineCallerId };
