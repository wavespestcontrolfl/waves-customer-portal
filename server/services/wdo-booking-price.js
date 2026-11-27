'use strict';

/**
 * The WDO inspection price of a NEW booking (owner 2026-11-27 "yes booking").
 *
 * PR #8631 made a new ESTIMATE price a WDO inspection off the home size and construction table ($150 to $275). A WDO job is
 * almost never estimated: it is booked, and a booking filled the flat catalog price. This module is the ONE place a booking
 * gets the table price. The office booking screen (admin-schedule buildAppointmentPricing and its /wdo-inspection-quote),
 * the Intelligence Bar (ibBookingPricing), the booked-by-address new caller visit, and the two phone bookings (the call
 * pipeline and the voice agent) all ask it. A price a person typed, or one agreed on a call, never reaches it. It reads no
 * visit and no invoice: an existing booking keeps the price it was booked at.
 *
 * Nothing is priced here. The home's property record is the property lookup's own cached record for the booked address
 * (CACHE-ONLY and strict: no live lookup, no paid call, nothing stored). The estimate tool's own translator
 * (translateV2CallToV1Input) turns it into the engine input: the size, the walls and foundation, and the trust verdicts of
 * lookup-confidence. The engine's own WDO line (priceWDO) prices it. So a booking and an estimate of the same home agree,
 * and what earns a premium is decided in one place.
 *
 * What the engine's own defaults give a booking (priceWDO, resolvePestFootprint):
 *   - no property record, or a record with no home size: the engine's default size, so the first size step;
 *   - walls not on the record, or a reading the record's own evidence does not back: concrete block on a slab;
 *   - both together: the lowest table price, with a staff note that says so and what a confirmed home would cost.
 * A booking is never blocked. null means "no table price": the stored records call the property commercial (the engine
 * quotes those by hand), the booking property is not the customer's, the home cannot be told, or the read failed. The
 * caller then keeps the price it filled before this rule: the catalog price.
 */

const db = require('../models/db');
const logger = require('./logger');

// The catalog service a booking names, and the engine line that prices it (the two keys are the same word).
const WDO_SERVICE_KEY = 'wdo_inspection';
const ENGINE_WDO_LINE = 'wdo_inspection';
// The price source a phone booking and the Intelligence Bar card show for a table price.
const WDO_TABLE_SOURCE = 'wdo_table';

const isWdoInspectionService = (row) => (row?.service_key ?? row?.serviceKey) === WDO_SERVICE_KEY;

function noTablePrice(who, reason) {
  logger.info(`[wdo-booking-price] ${who}: ${reason}; the catalog price stands`);
  return null;
}

// A service address ({ line1, line2, city, state, zip }, the shape a visit is stamped with) as the lookup's address text,
// through the one builder the customer's own address goes through.
function serviceAddressText(address) {
  const { addressForCustomer } = require('./customer-pricing-ai');
  return addressForCustomer({
    address_line1: address.line1, address_line2: address.line2, city: address.city, state: address.state, zip: address.zip,
  });
}

// The home the visit is booked at, as the lookup's address text, or why no table price applies.
//   A saved property, or none (the customer's own home): customerAtBookingProperty, the rule the one-time pest price reads
//   the booked home by. It also says when the stored records call the place commercial.
//   A service address with no saved property (a phone booking at an address the call gave, a new caller with no customer
//   yet): that address as written. With a saved property (a phone booking whose address key-matched it): the property must
//   still be at that address. `customerAddress`: a linked estimate quoted the customer's own address, so no other
//   property stands in for it.
async function bookedHome({ customer, customerId, propertyId, serviceAddress, customerAddress = false, conn }) {
  const row = customer || (customerId ? await conn('customers').where({ id: customerId }).first() : null);
  const serviceRow = serviceAddress?.line1
    ? { address_line1: serviceAddress.line1, address_line2: serviceAddress.line2 || null, city: serviceAddress.city, zip: serviceAddress.zip }
    : null;
  const written = !propertyId && serviceRow ? serviceAddressText(serviceAddress) : null;
  if (!row) return written ? { address: written } : { refusal: 'no customer and no service address' };
  const { customerAtBookingProperty } = require('./one-time-pest-booking-price');
  const { addressForCustomer } = require('./customer-pricing-ai');
  const { addressKey } = require('./customer-properties');
  const { normalizePropertyType } = require('./pricing-engine/commercial-helpers');
  // No property named: a booking stamps the customer's sole active property when there is exactly one
  // (customer-properties soleActivePropertyId), so that property's own records count, even one not marked primary
  // (pre-push audit P0). Read only here: the stamp's own read can add a missing primary row.
  const activeRows = propertyId || written ? null : await conn('customer_properties').where({ customer_id: row.id, active: true }).select('id');
  const soleActive = Array.isArray(activeRows) && activeRows.length === 1 ? activeRows[0].id : null;
  let at = await customerAtBookingProperty(row, propertyId || soleActive, conn);
  if (!at) return { refusal: 'the booking property is not an active property of this customer' };
  // No property named and no address written: the save stamps no street, so dispatch shows the visit at the customer's
  // own address (COALESCE(service_address_line1, customers.address_line1)). A linked estimate that quoted the customer's
  // own address names the same home. A sole active property at another address is the one the save stamps the visit
  // with: the price would read one home and dispatch would show another, so the home cannot be told (pre-push audit P0).
  // With no sole property the save stamps none: a primary property saved at another address does not stand in for the
  // customer's own address, and only the account's own records can call it commercial (pre-push audit P0).
  if ((customerAddress || (!propertyId && !written)) && at.otherProperty) {
    if (soleActive) return { refusal: 'the visit is stamped with the customer\'s one property, at another address than the customer\'s own' };
    at = {
      customer: row,
      otherProperty: false,
      commercial: [row.waveguard_tier, row.property_type].some((type) => normalizePropertyType(type) === 'commercial'),
    };
  }
  // A saved property named with the address the visit is stamped with (a phone booking: the call's address, linked to the
  // property whose address key it matched, resolveCallBookingPropertyLinkage). The property must still have that address
  // now, by the same key (one ZIP carries several town names), or the visit would be stamped with one home and priced at
  // another (pre-push audit P0).
  if (propertyId && serviceRow) {
    const property = await conn('customer_properties').where({ id: propertyId, customer_id: row.id, active: true }).first('address_line1', 'address_line2', 'city', 'zip');
    if (!property || addressKey(property) !== addressKey(serviceRow)) return { refusal: 'the saved property no longer has the address the visit is stamped with' };
  }
  // A written address that is not the customer's home, by the same address key (one ZIP carries several town names), is
  // read on its own record: only the account's own tier calls it commercial, never the home's records. The home under
  // another town name is the home: its own records, read at its own address (pre-push audit P0).
  const writtenElsewhere = !!written && addressKey(serviceRow) !== addressKey(at.customer);
  // At the customer's own address the account's own type describes the same home: also when the property saved there is
  // not marked primary (the shared rule reads it only beside a primary property), and when a call names that address
  // while the primary property is saved elsewhere (pre-push audit P0).
  const atOwnAddress = writtenElsewhere ? addressKey(serviceRow) === addressKey(row) : !at.otherProperty;
  const commercial = (writtenElsewhere ? normalizePropertyType(row.waveguard_tier) === 'commercial' : at.commercial)
    || (atOwnAddress && normalizePropertyType(row.property_type) === 'commercial');
  if (commercial) return { refusal: 'the stored records call this a commercial property' };
  // No street: the lookup would miss and the engine would quote its smallest home. The home cannot be told (pre-push audit
  // P0).
  const street = writtenElsewhere ? serviceRow.address_line1 : at.customer.address_line1;
  if (!String(street || '').trim()) return { refusal: 'the home has no street address on record' };
  return { address: writtenElsewhere ? written : addressForCustomer(at.customer) };
}

// The engine's WDO line for a home's property record, as the estimate tool prices a looked-up home nobody has typed over.
// No record ({}) is the engine's own "nothing known" quote.
function wdoLineFor(profile) {
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  const { generateEstimate } = require('./pricing-engine');
  const estimate = generateEstimate(translateV2CallToV1Input(profile || {}, ['WDO'], {}));
  return (estimate?.lineItems || []).find((line) => line?.service === ENGINE_WDO_LINE) || null;
}

// What the table was read at, in words, for the person booking: "2,600 sq ft, wood frame". A size or a construction the
// engine did not read from the record says so ("no home size on record", "construction not verified"), never the default
// it priced on.
const CONSTRUCTION_WORDS = { block: 'concrete block', frame: 'wood frame', crawl: 'crawl space or raised foundation' };
const squareFeet = (value) => `${Number(value).toLocaleString('en-US')} sq ft`;
// No living area and no footprint on the record: the engine priced its default footprint.
const sizeWasDefaulted = (line) => line.footprintWasDefaulted === true && Number(line.sizeUsed) > 0 && line.sizeUsed === line.footprintUsed;
function sizeWords(line) {
  if (line.sizeUsed == null) return 'home size not confirmed';
  return sizeWasDefaulted(line) ? 'no home size on record' : squareFeet(line.sizeUsed);
}
function basisFor(line) {
  return `${sizeWords(line)}, ${line.wdoConstructionKnown ? CONSTRUCTION_WORDS[line.wdoConstructionClass] : 'construction not verified'}`;
}

// The engine writes its staff notes for a quote that is about to be sent ("Confirm before sending."). On a booking the
// same facts stand without that last instruction. A home with no size on record gets one more sentence: the engine marks
// that line for review on a quote, and a booking has no review step.
const QUOTE_ONLY_ENDING = /\s*Confirm (?:the home size )?before sending\.\s*$/;
function staffNoteFor(line) {
  const { SPECIALTY } = require('./pricing-engine/constants');
  const marker = SPECIALTY.wdo.sizeTable.staffNoteMarker;
  const notes = (line.warnings || [])
    .filter((warning) => typeof warning === 'string' && warning.startsWith(marker))
    .map((warning) => warning.slice(marker.length).replace(QUOTE_ONLY_ENDING, '').trim())
    .map((note) => note.charAt(0).toUpperCase() + note.slice(1));
  if (sizeWasDefaulted(line)) notes.unshift(`No home size on record: priced as ${squareFeet(line.sizeUsed)}.`);
  return notes.join(' ') || null;
}

/**
 * The table price of a WDO inspection booked at one home: { price, basis, staffNote }, or null (the catalog price stands).
 *
 *   customer / customerId  the customer the visit is for (the row, or its id); none for a new caller booked by address
 *   propertyId             the saved property the visit is booked at; none = the customer's own home
 *   serviceAddress         { line1, line2, city, state, zip } the visit is stamped with, used when no saved property is named
 *   conn                   reads the customer and property rows. The property record itself is read on the shared pool, so
 *                          call this BEFORE a booking transaction opens, never inside one.
 */
// The home each table price answer was read at (wdoBookingPrice), kept off the answer so the address never rides into a
// response or a log line with it (wdoTableStillApplies).
const pricedHomes = new WeakMap();

async function wdoBookingPrice({ customer = null, customerId = null, propertyId = null, serviceAddress = null, customerAddress = false, conn = db } = {}) {
  const who = `customer ${customer?.id || customerId || 'none (booked by address)'}`;
  try {
    const home = await bookedHome({ customer, customerId, propertyId, serviceAddress, customerAddress, conn });
    if (home.refusal) return noTablePrice(who, home.refusal);
    const { strictCacheOnlyPropertyLookup } = require('./service-report/start-offer-lookup');
    const lookup = home.address ? await strictCacheOnlyPropertyLookup(home.address) : null;
    const line = wdoLineFor(lookup?.enriched);
    const price = Number(line?.price);
    if (!Number.isFinite(price) || price <= 0) return noTablePrice(who, 'the engine has no table price for this property');
    const table = { price: Math.round(price * 100) / 100, basis: basisFor(line), staffNote: staffNoteFor(line) };
    pricedHomes.set(table, home.address);
    return table;
  } catch (err) {
    // The error code only: a database error can quote the address it was reading.
    return noTablePrice(who, `the property record could not be read (${err.code || err.name || 'error'})`);
  }
}

/**
 * Inside a booking transaction: whether a table price answer read before it (wdoBookingPrice) was read at the home the
 * visit books at now. A customer address or saved property edited in between is another home, so the caller refuses
 * rather than book that home's price (pre-push audit P0). Reads the customer's property rows on `conn`, never the
 * property record. No answer (null: the catalog price) always holds.
 */
async function wdoTableStillApplies(table, { customer, propertyId = null, customerAddress = false, conn }) {
  if (!table) return true;
  const home = await bookedHome({ customer, propertyId, customerAddress, conn });
  return !home.refusal && pricedHomes.has(table) && pricedHomes.get(table) === home.address;
}

// ── Phone bookings (the call pipeline, the voice agent, the new caller booked by address) ────────────────────────────────
// `priceInfo` is the booking's own price answer ({ price, source }: call-booking-catalog resolveCallBookingPrice, where a
// price agreed on the call wins, else the catalog list price; or a new caller's typed price, else the catalog's). Only a
// CATALOG price of a WDO inspection is replaced, by the table price of the home the visit is booked at (`linkage`: the
// visit's { propertyId, address }), with `wdoTable` for the office note. Anything else comes back as it was given.
async function wdoCallBookingPrice(priceInfo, { catalogRow, customerId, linkage, conn = db } = {}) {
  if (priceInfo?.source !== 'catalog' || !isWdoInspectionService(catalogRow)) return priceInfo;
  const table = await wdoBookingPrice({
    customerId, propertyId: linkage?.propertyId || null, serviceAddress: linkage?.address || null, conn,
  });
  return table ? { price: table.price, source: WDO_TABLE_SOURCE, wdoTable: table } : priceInfo;
}

// The call pipeline resolves the visit's property INSIDE its booking transaction, and a transaction must not read the
// property record (a second connection from the shared pool). So the pipeline reads the table price once BEFORE the
// transaction, for the property and address its own resolver gives then (`resolveLinkage`), and the transaction keeps it
// only when it resolves the same property and address. null = nothing to read (not a WDO inspection at the catalog price).
async function wdoCallPriceBeforeBooking(priceInfo, { catalogRow, customerId, resolveLinkage } = {}) {
  if (priceInfo?.source !== 'catalog' || !isWdoInspectionService(catalogRow)) return null;
  try {
    const linkage = await resolveLinkage();
    return { linkage, priceInfo: await wdoCallBookingPrice(priceInfo, { catalogRow, customerId, linkage }) };
  } catch (err) {
    return noTablePrice(`customer ${customerId || 'none'}`, `the booking address could not be resolved (${err.code || err.name || 'error'})`);
  }
}

const LINKAGE_ADDRESS_FIELDS = ['line1', 'line2', 'city', 'state', 'zip'];
function sameLinkage(a, b) {
  return String(a?.propertyId || '') === String(b?.propertyId || '')
    && LINKAGE_ADDRESS_FIELDS.every((field) => String(a?.address?.[field] || '') === String(b?.address?.[field] || ''));
}

// Inside the booking transaction: the price the visit is saved with. A home that changed since the read (a property saved
// or edited in between) keeps the call resolver's own price.
function wdoCallPriceForBooking(priceInfo, before, linkage) {
  if (!before) return priceInfo;
  if (sameLinkage(before.linkage, linkage)) return before.priceInfo;
  logger.info('[wdo-booking-price] the booked home changed after the table price was read; the call price stands');
  return priceInfo;
}

// A phone booking's price sentence in the customer-visible visit note.
function callBookingPriceNote(priceInfo) {
  if (priceInfo?.price == null) return null;
  const amount = `$${Number(priceInfo.price).toFixed(2)}`;
  if (priceInfo.source === 'transcript') return `Price quoted on call: ${amount}.`;
  if (priceInfo.source === WDO_TABLE_SOURCE) return `Price by home size and construction: ${amount}.`;
  return `Price from service catalog: ${amount}.`;
}

// The office-only line (internal_notes) of a visit a phone or new-caller booking saved at a table price (`table`, the
// wdoBookingPrice answer; none = no line): nobody saw that price before it was saved.
function wdoTableNote(table) {
  if (!table) return null;
  return [`WDO price from the home size and construction table: $${Number(table.price).toFixed(2)}${table.basis ? ` (${table.basis})` : ''}.`, table.staffNote]
    .filter(Boolean).join(' ');
}

// A WDO inspection that is the main line of a visit with another paid line keeps the catalog price (pre-push audit P0). Its
// WDO filing bills the inspection fee, and the filing form fills that fee from the visit's price only when the inspection
// is the visit's only paid line (wdoFeeSeedFromVisit, CreateProjectModal.jsx); a blank fee bills the flat default. A free
// line beside it changes nothing. A WDO add-on line on another service's visit is billed with that visit's total, so it
// keeps the table price.
const WDO_WITH_OTHER_LINES_NOTE = 'Other paid services are booked on this WDO visit, so the WDO line keeps the catalog price. Book the inspection as its own visit for the home size and construction price.';

function operationalError(status, message, code) {
  return Object.assign(new Error(message), { status, statusCode: status, isOperational: true, ...(code ? { code } : {}) });
}

// The WDO price the booking screen showed for a blank WDO line, as a request carries it: absent = undefined (no check: an
// older screen, the Intelligence Bar, a phone booking), else a non-negative amount.
function wdoExpectedPriceFrom(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw operationalError(400, 'wdoExpectedPrice must be the WDO price the screen showed');
  return amount;
}

// A save books the WDO price the screen showed, or refuses before any write (pre-push audit P0): a home read that fails or
// changes between the screen's check and the save must never book a price nobody saw. `price` is the line's price before
// discounts as the save resolved it (table, else catalog).
function assertWdoPriceAsShown(price, expected) {
  const known = price != null && Number.isFinite(Number(price));
  if (known && Math.round(Number(price) * 100) === Math.round(expected * 100)) return;
  throw operationalError(
    409,
    `The WDO price for this home is now ${known ? `$${Number(price).toFixed(2)}` : 'unknown'}, not the $${expected.toFixed(2)} shown. This visit was not booked. Check the price and save again.`,
    'WDO_PRICE_CHANGED',
  );
}

// The check one save runs on the WDO price its screen showed (`expected`, from wdoExpectedPriceFrom; undefined = the
// screen showed none, no check). line(price): a blank WDO line's resolved price must match. done(): a save that carried a
// shown price must have matched it against a WDO line; one whose WDO line could not be resolved (its catalog row failed
// to read, so the save would fall back to the posted total) refuses (pre-push audit P0). Used by the office save
// (buildAppointmentPricing) and Book for a new caller.
function wdoPriceCheck(expected) {
  let checked = false;
  return {
    line(price) {
      if (expected === undefined) return;
      assertWdoPriceAsShown(price, expected);
      checked = true;
    },
    done() {
      if (expected === undefined || checked) return;
      throw operationalError(409, 'Could not check the WDO price shown against this visit. This visit was not booked. Save again.', 'WDO_PRICE_UNCHECKED');
    },
  };
}

module.exports = {
  WDO_SERVICE_KEY,
  WDO_TABLE_SOURCE,
  WDO_WITH_OTHER_LINES_NOTE,
  wdoPriceCheck,
  wdoExpectedPriceFrom,
  isWdoInspectionService,
  wdoBookingPrice,
  wdoTableStillApplies,
  wdoCallBookingPrice,
  wdoCallPriceBeforeBooking,
  wdoCallPriceForBooking,
  callBookingPriceNote,
  wdoTableNote,
};
