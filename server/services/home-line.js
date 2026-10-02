/**
 * Customer home line sweep (owner ruling 2026-10-02, "local line everywhere").
 *
 * Stamps customers.home_line_location_id with the office line their service
 * address names (config/locations.js matchServiceLocation), together
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
const { matchServiceLocation } = require('../config/locations');
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
  let noOffice = 0;
  for (const row of rows) {
    const key = addressKey(row);
    if (row.home_line_location_id && row.home_line_address_key === key) {
      unchanged += 1;
      continue;
    }
    // Only an address that names an office is stamped. A blank or out-of-area
    // address stays unstamped, so the readers keep their own fallbacks (texts:
    // the default office; calls: the main line) instead of a stored default.
    const office = matchServiceLocation(row);
    if (!office) {
      noOffice += 1;
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
        home_line_location_id: office.id,
        home_line_address_key: key,
        home_line_source: 'derived',
        home_line_set_at: now,
      });
    if (updated) stamped += 1;
    else lostRace += 1;
  }
  logger.info(`[home-line] sweep: ${stamped} stamped, ${unchanged} unchanged, ${noOffice} no office, ${lostRace} changed meanwhile`);
  return { stamped, unchanged, noOffice, lostRace };
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

// Owner ruling 2026-10-02: a staff reply stays on the conversation's line
// while the person texted us there within this window.
const CONVERSATION_WINDOW_DAYS = 30;

/**
 * The line a staff-composed text to this person leaves from under
 * GATE_HOME_LINE (home-line PR 3, owner ruling 2026-10-02):
 *   1. the Waves line (an office line or the main line) they last texted
 *      within the last 30 days — keep the conversation where it is;
 *   2. else their home line (homeLineCallerId: an office the address names);
 *   3. else the main line (no customer, or a lead with no office).
 * Callers check homeLineLive() first; gate off keeps the old derivation.
 *
 * @param {{ phone: string, customerId?: string|null, database?: Function, now?: Date }} args
 * @returns {Promise<{ fromNumber: string, reason: 'conversation'|'home_line'|'main' }>}
 */
async function staffTextSender({ phone, customerId = null, database = db, now = new Date() }) {
  const TWILIO_NUMBERS = require('../config/twilio-numbers');
  const customerLines = [TWILIO_NUMBERS.mainLine.number, ...Object.values(TWILIO_NUMBERS.locations).map((l) => l.number)];
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length === 10) {
    const since = new Date(now.getTime() - CONVERSATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
    const last = await database('sms_log')
      .modify(excludeUnresolvedSendReservations)
      .where('direction', 'inbound')
      .whereIn('to_phone', customerLines)
      .where('created_at', '>=', since)
      .whereRaw("right(regexp_replace(coalesce(from_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [digits])
      .orderBy('created_at', 'desc')
      .first('to_phone');
    if (last?.to_phone) return { fromNumber: last.to_phone, reason: 'conversation' };
  }
  const customer = customerId
    ? await database('customers').where({ id: customerId }).whereNull('deleted_at').first()
    : null;
  const fromNumber = homeLineCallerId(customer);
  return { fromNumber, reason: fromNumber === TWILIO_NUMBERS.mainLine.number ? 'main' : 'home_line' };
}

module.exports = { stampHomeLines, homeLineCallerId, staffTextSender, CONVERSATION_WINDOW_DAYS };
