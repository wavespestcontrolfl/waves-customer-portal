'use strict';

/**
 * The system's one-time pest price for a home, READ ONLY (owner 2026-11-26 "ok well say the one time price when asked").
 *
 * Staff quoting a one-time pest job should see the price the pricing engine gives for that home, not guess from the
 * flat catalog price. This module answers that one question for the Schedule screen's hint; it changes no booking,
 * no line price and no invoice. The price is the engine's LIST price for the home (generateEstimate with
 * services.oneTimePest at the routine rate, no member discount), from the same property facts the customer pricing
 * assistant resolves (customer-pricing-ai resolvePropertyContext over the CACHE-ONLY strict property lookup: no live
 * lookup, nothing stored). The property is the one the visit is booked at: a named saved property is read with its own
 * address and measurements, never the primary's.
 *
 * It never guesses: no home square footage, commercial records (the account tier, a property's occupancy or type, the
 * customer's own type for the primary), a line the engine marks for a hand check, a failed refresh of the pricing
 * settings, or any read failure returns null with a log line, and the screen shows no hint.
 */

const db = require('../models/db');
const logger = require('./logger');

function fallback(customerId, reason) {
  logger.info(`[one-time-pest-booking-price] customer ${customerId}: ${reason}; no system price to show`);
  return null;
}

// Is this saved property the home the customer row describes? Street (with unit), city and ZIP must agree, both sides
// must have a street; anything uncertain is "no", the safe direction (the property's own facts, or no price).
const fold = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function sameHome(property, customer) {
  const { streetKey, normalizeZip } = require('./customer-properties');
  const propertyStreet = streetKey(property.address_line1);
  const customerStreet = streetKey(customer.address_line1);
  if (!propertyStreet || !customerStreet || propertyStreet !== customerStreet) return false;
  if (fold(property.address_line2) !== fold(customer.address_line2)) return false;
  if (!fold(property.city) || !fold(customer.city) || fold(property.city) !== fold(customer.city)) return false;
  const propertyZip = normalizeZip(property.zip);
  const customerZip = normalizeZip(customer.zip);
  return !!propertyZip && !!customerZip && propertyZip === customerZip;
}

// The customer as the property resolver reads one, for the property the visit is booked at, and whether the stored records
// call that place commercial. No property named: the customer's primary property (its row is read too). The customer row's
// own measurements (lot, type, ...) are used ONLY when the property's address is the customer row's address; any other
// property, a second home or a primary whose row names a different address, is read with that row's own address and
// measurements and none of the customer row's. Commercial = the account tier, the property's occupancy or type, or (for the
// primary) the customer's own property type. null when the named property is not one of the customer's active properties.
async function customerAtBookingProperty(customer, propertyId, conn) {
  const { normalizePropertyType } = require('./pricing-engine/commercial-helpers');
  const rows = conn('customer_properties');
  const property = propertyId
    ? await rows.where({ id: propertyId, customer_id: customer.id, active: true }).first()
    : await rows.where({ customer_id: customer.id, is_primary: true, active: true }).first();
  if (propertyId && !property) return null;
  const isPrimary = !property || property.is_primary === true;
  const commercial = normalizePropertyType(customer.waveguard_tier) === 'commercial'
    || property?.occupancy_type === 'commercial'
    || normalizePropertyType(property?.property_type) === 'commercial'
    || (isPrimary && normalizePropertyType(customer.property_type) === 'commercial');
  if (!property || sameHome(property, customer)) return { customer, otherProperty: false, commercial };
  return {
    otherProperty: true,
    commercial,
    customer: {
      ...customer,
      address_line1: property.address_line1,
      address_line2: property.address_line2 || null,
      city: property.city,
      state: property.state,
      zip: property.zip,
      lot_sqft: property.lot_sqft ?? null,
      property_sqft: property.property_sqft ?? null,
      bed_sqft: property.bed_sqft ?? null,
      property_type: property.property_type ?? null,
      palm_count: null,
      lawn_type: null,
    },
  };
}

// The one-time pest row of pricing_config must carry its floor and multiplier as numbers: the engine otherwise quotes the
// in-code defaults for them.
async function oneTimePestRowIsStored() {
  const row = await db('pricing_config').where({ config_key: 'onetime_pest' }).first('data');
  const data = typeof row?.data === 'string' ? JSON.parse(row.data) : row?.data;
  return Number(data?.floor) > 0 && Number(data?.multiplier) > 0;
}

// The one-time pest line's price when the engine quotes it cleanly (a number above 0, no quote-required or hand-check mark).
function cleanOneTimePestPrice(estimate) {
  const line = (estimate?.lineItems || []).find((l) => l?.service === 'one_time_pest');
  const price = Number(line?.price);
  if (!line || line.quoteRequired || line.requiresManualReview || !Number.isFinite(price) || price <= 0) return null;
  return Math.round(price * 100) / 100;
}

// The engine's own one-time pest line for the property the visit is booked at (the customer's own property when no
// propertyId is given), or null with the reason logged.
async function oneTimePestBookingPrice(customerId, { conn = db, propertyId = null } = {}) {
  try {
    const found = customerId ? await conn('customers').where({ id: customerId }).first() : null;
    if (!found) return fallback(customerId, 'customer not found');
    const at = await customerAtBookingProperty(found, propertyId, conn);
    if (!at) return fallback(found.id, 'the booking property is not an active property of this customer');
    if (at.commercial) return fallback(found.id, 'the stored records call this a commercial property');
    const { customer } = at;
    const pricingEngine = require('./pricing-engine');
    const { resolvePropertyContext, loadTurfProfile } = require('./customer-pricing-ai');
    const { strictCacheOnlyPropertyLookup } = require('./service-report/start-offer-lookup');
    const turfProfile = at.otherProperty ? null : await loadTurfProfile(conn, customer.id).catch(() => null);
    const context = await resolvePropertyContext({ customer, turfProfile, propertyLookup: strictCacheOnlyPropertyLookup });
    if (!context.hasHomeSqFt) return fallback(customer.id, 'no home square footage on file');
    if (!(await oneTimePestRowIsStored())) return fallback(customer.id, 'the one-time pest settings row (floor and multiplier) is not in the database');
    // The engine prices from this process's constants. The bridge reloads the committed rows for this call and answers
    // only when the standard pest price rows (base and floor, footprint ladder, features, property types, tiers) were
    // all carried by the rows; the price is computed in the same step.
    const priced = await require('./pricing-engine/db-bridge').withSettingsForUnattendedPrice(() => pricingEngine.generateEstimate({
      ...context.propertyInput,
      recurringCustomer: false,
      services: { oneTimePest: { urgency: 'NONE', afterHours: false } },
    }));
    if (!priced.priced) return fallback(customer.id, `the pricing settings did not come from the database (${priced.reason})`);
    const estimate = priced.value;
    const price = cleanOneTimePestPrice(estimate);
    return price === null ? fallback(customer.id, 'the engine did not return a clean one-time pest price') : price;
  } catch (err) {
    return fallback(customerId, `price lookup failed (${err.message})`);
  }
}

module.exports = { oneTimePestBookingPrice };
