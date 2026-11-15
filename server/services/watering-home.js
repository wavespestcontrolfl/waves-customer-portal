'use strict';

/**
 * The watering-rule county of a customer's home, read as one consistent
 * snapshot. Shared by the lawn prep guide (prep-guide-sender
 * loadWateringInputs) and the visit page's watering-time line
 * (appointment-public wateringLineFor), so both build a legal watering
 * instruction on the same guarded inputs (GH Codex #3953 r1-r2, #7885 r1):
 *   - the preferences first;
 *   - the ACTIVE turf profile only (a retired profile's county is the
 *     former home's; the weekly sweep joins on tp.active = true);
 *   - the address re-read AFTER the preferences (a caller's customer or
 *     visit row may predate a move);
 *   - the move stamp re-read after the address. A stamp that moved between
 *     the reads means the inputs straddle a move: this throws, and the
 *     caller builds no watering instruction on them.
 * `customer` is { id, address_line1?, address_line2?, city?, zip? }; its
 * address is used only when the customers row is gone. Returns
 * { prefs, county, moveStamp, home }: the full preferences row, the county
 * (or null when none is established), the stamp the snapshot was read
 * against, and the home address it read (address_line1, address_line2,
 * city, zip: the customer side of stamped-address VISIT_HOME_COLUMNS), so a
 * caller can recheck a visit against the same home (GH Codex #7885 r2).
 */

const db = require('../models/db');
const { resolveRestrictionCounty } = require('../config/irrigation-restrictions');
const { countyConfirmedAfterMove } = require('./irrigation-schedule-confirmation');

const stampMs = (v) => (v ? new Date(v).getTime() : null);

async function loadWateringHome(customer) {
  const prefs = (await db('property_preferences').where({ customer_id: customer.id }).first()) || {};
  const turf = (await db('customer_turf_profiles').where({ customer_id: customer.id, active: true }).first()) || {};
  const home = (await db('customers').where({ id: customer.id }).first('address_line1', 'address_line2', 'city', 'zip')) || customer;
  const moveStamp = (await db('property_preferences').where({ customer_id: customer.id }).first('irrigation_home_changed_at'))?.irrigation_home_changed_at || null;
  const movedAt = prefs.irrigation_home_changed_at || null;
  if (stampMs(moveStamp) !== stampMs(movedAt)) {
    throw new Error('address changed while the watering inputs were being read');
  }
  const county = resolveRestrictionCounty({
    county: turf.county || null,
    profileCity: turf.city || null,
    city: home.city,
    zip: home.zip,
    homeMoved: !!movedAt,
    movedAt,
    countyConfirmed: countyConfirmedAfterMove(prefs),
  });
  return {
    prefs,
    county,
    moveStamp,
    home: { address_line1: home.address_line1, address_line2: home.address_line2, city: home.city, zip: home.zip },
  };
}

module.exports = { loadWateringHome };
