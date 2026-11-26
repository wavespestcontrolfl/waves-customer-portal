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

// The customer as the property resolver reads one, for the property the visit is booked at, and whether the stored records
// call that place commercial. No property named: the customer's primary property (its row is read too). A named property
// that is the primary: the customer row as it is. Any other saved property: that property's own address and measurements,
// and none of the primary's (a second home never gets the primary home's facts). Commercial = the account tier, the
// property's occupancy or type, or (for the primary) the customer's own property type. null when the named property is not
// one of the customer's active properties.
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
  if (isPrimary) return { customer, otherProperty: false, commercial };
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

// False when a due refresh of the pricing settings failed (syncConstantsFromDB answers false): the engine would then
// quote stale or built-in rates.
async function settingsAreCurrent(pricingEngine) {
  if (!(pricingEngine.needsSync && pricingEngine.needsSync())) return true;
  return (await pricingEngine.syncConstantsFromDB(db)) !== false;
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
    if (!(await settingsAreCurrent(pricingEngine))) return fallback(customer.id, 'the pricing settings could not be refreshed');
    const estimate = pricingEngine.generateEstimate({
      ...context.propertyInput,
      recurringCustomer: false,
      services: { oneTimePest: { urgency: 'NONE', afterHours: false } },
    });
    const line = (estimate?.lineItems || []).find((l) => l?.service === 'one_time_pest');
    const price = Number(line?.price);
    if (!line || line.quoteRequired || line.requiresManualReview || !Number.isFinite(price) || price <= 0) {
      return fallback(customer.id, 'the engine did not return a clean one-time pest price');
    }
    return Math.round(price * 100) / 100;
  } catch (err) {
    return fallback(customerId, `price lookup failed (${err.message})`);
  }
}

module.exports = { oneTimePestBookingPrice };
