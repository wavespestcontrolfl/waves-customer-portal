/**
 * Text-side appointment times from the website booking engine
 * (GATE_MULTI_TECH_TEXT_TIMES, multi-technician booking PR 4, owner "go PR 4"
 * 2026-10-06).
 *
 * The callers that only READ times for a text — the lead reply agent's
 * next-available check, the text drafter's city-based OPEN TIMES fallback and
 * its send-time recheck, the estimate converter's first service day — used to
 * ask the old by-city engine (services/availability.js getAvailableSlots: a
 * city maps to a zone, hourly slots, no technicians, no routes). With the gate
 * on they ask the engine the website offers from (routes/booking.js
 * buildBookingAvailability, per technician and route-aware) through the ONE
 * pin-based reader availabilityForPin, so a time a text offers is a time /book
 * would offer, and a second technician's free time is offered too.
 *
 * Where the pin comes from, in order:
 *   1. the customer's own booking pin (customerId, or the customer behind an
 *      estimate): the stored pin, else the staff-verified or geocoded address —
 *      the same pin /book commits at (customerBookingLocation);
 *   2. the CITY CENTRE (owner 2026-10-06: a lead known only by city is placed
 *      in the middle of that city; the offer is a hint, never a booking).
 *
 * City centres: no new table. Waves' served cities already have fixed points in
 * services/pest-forecast/locations.js (Manatee, Sarasota and Charlotte county
 * rows). A served city with no row there (University Park, Fruitville, Murdock)
 * falls to the centre of its service zone — the same point /book uses when it
 * is handed only a city (routes/booking.js resolveBookingCoords). A city the
 * business does not serve resolves to nothing.
 *
 * Read-only: never writes, books or holds a slot.
 */

const db = require('../../models/db');
const logger = require('../logger');

// Counties Waves serves; the forecast table also lists Tampa, Fort Myers and
// other metros that must never become a booking pin.
const SERVED_COUNTIES = new Set(['Manatee', 'Sarasota', 'Charlotte']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cityKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/,?\s*(fl|florida)\.?$/i, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The fixed point for a served city from the forecast table, or null.
function tableCityCentre(city) {
  const key = cityKey(city);
  if (!key) return null;
  const { LOCATIONS } = require('../pest-forecast/locations');
  const row = LOCATIONS.find((l) => l.region === 'sw' && SERVED_COUNTIES.has(l.county) && cityKey(l.label) === key);
  return row ? { lat: row.lat, lng: row.lng } : null;
}

// { lat, lng, source: 'city_table' | 'zone_centre' } or null.
async function cityCentre(city) {
  const fixed = tableCityCentre(city);
  if (fixed) return { ...fixed, source: 'city_table' };
  if (!String(city || '').trim()) return null;
  // resolveBookingCoords given only a city reads the service zone's centre.
  const { resolveBookingCoords } = require('../../routes/booking')._internals;
  const zone = await resolveBookingCoords({ city: String(city).trim() });
  if (zone?.lat && zone?.lng) return { lat: zone.lat, lng: zone.lng, source: 'zone_centre' };
  return null;
}

async function customerIdFor({ customerId, estimateId }) {
  if (customerId) return customerId;
  if (!estimateId || !UUID_RE.test(String(estimateId))) return null;
  const est = await db('estimates').where({ id: estimateId }).first('customer_id');
  return est?.customer_id || null;
}

// { lat, lng, source } or null.
async function resolveTextOfferPin({ customerId = null, estimateId = null, city = null } = {}) {
  const booking = require('../../routes/booking')._internals;
  const cid = await customerIdFor({ customerId, estimateId });
  if (cid) {
    const customer = await db('customers').where({ id: cid }).whereNull('deleted_at')
      .first('id', 'account_id', 'latitude', 'longitude', 'address_line1', 'address_line2', 'city', 'state', 'zip');
    const pin = customer ? await booking.customerBookingLocation(customer) : null;
    if (pin) return { lat: pin.lat, lng: pin.lng, source: 'customer' };
  }
  return cityCentre(city);
}

/**
 * The days the website booking engine would offer for a text.
 * Returns { days, pinSource } or null when nothing can be offered (no usable
 * pin, no funnel service, /book off). `days` is /book's own day shape
 * (date, dayOfWeek, dayNum, month, fullDate, slots[{ startTime24, ... }]).
 * Errors throw: every caller already fails closed or falls back.
 */
async function textOfferDays({ customerId = null, estimateId = null, city = null, serviceKey = 'pest_control' } = {}) {
  const pin = await resolveTextOfferPin({ customerId, estimateId, city });
  if (!pin) {
    logger.info('[text-offer-times] no booking pin (no customer pin, no served city) — nothing offered');
    return null;
  }
  const { availabilityForPin } = require('../../routes/booking')._internals;
  const availability = await availabilityForPin({ lat: pin.lat, lng: pin.lng, serviceKey });
  if (!availability) return null;
  return { days: availability.days || [], pinSource: pin.source };
}

module.exports = { textOfferDays, resolveTextOfferPin, cityCentre, _internals: { cityKey, tableCityCentre, SERVED_COUNTIES } };
