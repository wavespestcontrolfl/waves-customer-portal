/**
 * Owner ruling 2026-11-27 "yes booking": a NEW WDO inspection booking fills the home size and construction table price
 * ($150 to $275, PR #8631's priceWDO), not the flat catalog $250. A typed price and a price agreed on a call win.
 * Behavior: the office booking (buildAppointmentPricing, POST /wdo-inspection-quote), the new caller booked by address and
 * the phone bookings (wdoCallBookingPrice; the call pipeline's read before its transaction) price a blank WDO line from
 * the cached property record of the home the visit is booked at, through the estimate tool's own translator and engine.
 * Regressions it guards: the flat $250 on a new booking; a typed or quoted price replaced by the table; a commercial site or
 * another customer's property priced off the table; a property record read inside a booking transaction; a booked visit or
 * an invoice read or repriced; a WDO main line with add-ons table-priced (its WDO filing bills the flat fee); a save that
 * books a price the screen did not show. Fixtures are fictitious.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/discount-engine', () => ({
  manualEligibilityFailures: jest.fn(),
  clearCache: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Book for a new caller runs only with its gate on (GATE_NEW_CALLER_BOOKING, read once at load): on here, as in
// new-caller-visit.test.js.
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: (gate) => (gate === 'newCallerBooking' ? true : actual.isEnabled(gate)) };
});
// The property record: the lookup's own cache, read strictly (no live or paid lookup). Each test says what it holds.
jest.mock('../services/service-report/start-offer-lookup', () => ({ strictCacheOnlyPropertyLookup: jest.fn() }));

const fs = require('fs');
const path = require('path');
const dbMock = require('../models/db');
const { strictCacheOnlyPropertyLookup: lookup } = require('../services/service-report/start-offer-lookup');
const {
  wdoBookingPrice, wdoCallBookingPrice, wdoCallPriceBeforeBooking, wdoCallPriceForBooking, callBookingPriceNote, wdoTableNote,
  wdoExpectedPriceFrom, WDO_WITH_OTHER_LINES_NOTE,
} = require('../services/wdo-booking-price');
const adminSchedule = require('../routes/admin-schedule');

const { buildAppointmentPricing } = adminSchedule._test;

const CUSTOMER_ID = '3f2c8a52-0b1e-4c1a-9a47-2f6f6c1f0a11';
const PROPERTY_ID = '7a1d2e90-4c5b-4d0e-8b21-9e0f3a6c5d77';
const HOME = { id: CUSTOMER_ID, address_line1: '100 Example Ln', city: 'Bradenton', state: 'FL', zip: '34201', property_type: 'single_family' };
const RENTAL = {
  id: PROPERTY_ID, customer_id: CUSTOMER_ID, active: true, is_primary: false, address_line1: '200 Sample Rd', address_line2: null,
  city: 'Parrish', state: 'FL', zip: '34219', property_type: 'single_family',
};
const WDO = { id: 'svc-wdo', name: 'WDO Inspection Service', service_key: 'wdo_inspection', category: 'termite', base_price: '250.00' };

// The db handle: each table answers from `rows` (a row, or a function of the where clause); every table read is recorded.
const touched = [];
function wireDb(rows = {}) {
  dbMock.mockImplementation((table) => {
    touched.push(table);
    const answer = (cond) => (typeof rows[table] === 'function' ? rows[table](cond) : rows[table]);
    return { where: (cond) => ({ first: async () => answer(cond), select: async () => answer(cond) || [] }) };
  });
}

// A cached property record whose walls or foundation the county record backs (the evidence #8631 trusts).
const county = (field, value) => ({ [field]: [{ sourceType: 'county', value }] });
const WALLS = {
  block: { constructionMaterial: 'CONCRETE_BLOCK', fieldEvidence: county('constructionMaterial', 'CONCRETE_BLOCK') },
  frame: { constructionMaterial: 'WOOD_FRAME', fieldEvidence: county('constructionMaterial', 'WOOD_FRAME') },
  crawl: { foundationType: 'CRAWL_SPACE', fieldEvidence: county('foundationType', 'CRAWL_SPACE') },
};
const record = (homeSqFt, walls) => ({ enriched: { homeSqFt, ...WALLS[walls] } });
const CONSTRUCTION_WORDS = { block: 'concrete block', frame: 'wood frame', crawl: 'crawl space or raised foundation' };

// The owner's table (PR #8631): one home size in each step, by construction.
const TABLE = [
  [1600, { block: 150, frame: 175, crawl: 200 }],
  [2600, { block: 175, frame: 200, crawl: 225 }],
  [3600, { block: 200, frame: 225, crawl: 250 }],
  [4200, { block: 225, frame: 250, crawl: 275 }],
];
const STEPS = TABLE.flatMap(([size, prices]) => Object.entries(prices).map(([walls, price]) => [size, walls, price]));

const bookBlankWdo = (over = {}) => buildAppointmentPricing({
  serviceRecord: WDO, estimatedPrice: null, primaryLinePrice: null, serviceAddons: [], customer: HOME, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  touched.length = 0;
  wireDb({ customer_properties: undefined, customers: HOME, services: WDO });
});

// Whatever a test did, it read no visit and no invoice (an existing booking keeps its price).
afterEach(() => {
  expect(touched.filter((table) => /scheduled_services|invoice/.test(table))).toEqual([]);
});

describe('a blank WDO line books at the table price of the home', () => {
  test.each(STEPS)('a %i sq ft %s home books at $%i, and the office sees what the table read', async (size, walls, price) => {
    lookup.mockResolvedValue(record(size, walls));
    const pricing = await bookBlankWdo();
    expect(pricing.finalPrice).toBe(price);
    expect(await wdoBookingPrice({ customer: HOME })).toEqual({
      price, basis: `${size.toLocaleString('en-US')} sq ft, ${CONSTRUCTION_WORDS[walls]}`, staffNote: null,
    });
    // The record is the customer's own home, read from the cache by its address.
    expect(lookup).toHaveBeenCalledWith(expect.stringContaining('100 Example Ln'));
  });

  test('a customer with no street on file and no saved property gets no table price: the home cannot be told', async () => {
    lookup.mockResolvedValue(null);
    for (const street of [null, '', '  ']) {
      expect((await bookBlankWdo({ customer: { ...HOME, address_line1: street } })).finalPrice).toBe(250);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  test('no property record: the first size step as concrete block on a slab, with an office note that says so', async () => {
    for (const none of [null, { enriched: {} }]) {
      lookup.mockResolvedValue(none);
      expect((await bookBlankWdo()).finalPrice).toBe(150);
      const table = await wdoBookingPrice({ customer: HOME });
      expect(table).toMatchObject({ price: 150, basis: 'no home size on record, construction not verified' });
      expect(table.staffNote).toMatch(/^No home size on record: priced as 2,000 sq ft\. Priced as concrete block on a slab \(\$150\)/);
      // The engine's quote-only instruction is not on a booking.
      expect(table.staffNote).not.toMatch(/before sending/);
    }
  });

  test('a size on record but no construction, or a reading its evidence does not back: priced as concrete block on a slab', async () => {
    for (const enriched of [{ homeSqFt: 2600 }, { homeSqFt: 2600, constructionMaterial: 'WOOD_FRAME' }]) {
      lookup.mockResolvedValue({ enriched });
      expect((await bookBlankWdo()).finalPrice).toBe(175);
      const table = await wdoBookingPrice({ customer: HOME });
      expect(table).toMatchObject({ price: 175, basis: '2,600 sq ft, construction not verified' });
      expect(table.staffNote).toMatch(/^Priced as concrete block on a slab \(\$175\).*wood frame on a slab would be \$200/);
    }
  });

  test('a commercial site gets no table price: the catalog price stands', async () => {
    lookup.mockResolvedValue(record(2600, 'frame'));
    // The customer row, the primary property row at the customer's address, or the record itself calls it commercial.
    expect((await bookBlankWdo({ customer: { ...HOME, property_type: 'commercial' } })).finalPrice).toBe(250);
    wireDb({ customer_properties: { ...RENTAL, address_line1: HOME.address_line1, city: HOME.city, zip: HOME.zip, is_primary: true, occupancy_type: 'commercial' } });
    expect((await bookBlankWdo()).finalPrice).toBe(250);
    expect(lookup).not.toHaveBeenCalled();
    wireDb({ customer_properties: undefined });
    lookup.mockResolvedValue({ enriched: { homeSqFt: 2600, propertyType: 'commercial' } });
    expect((await bookBlankWdo()).finalPrice).toBe(250);
    expect(await wdoBookingPrice({ customer: HOME })).toBeNull();
  });

  test('a property that is not the customer\'s gets no table price and no record read: the catalog price stands', async () => {
    lookup.mockResolvedValue(record(1600, 'block'));
    const pricing = await bookBlankWdo({ refillContext: { propertyId: PROPERTY_ID, sourceEstimateId: null } });
    expect(pricing.finalPrice).toBe(250);
    expect(lookup).not.toHaveBeenCalled();
  });

  test('another saved property of the customer is priced from its own address, never the primary home\'s', async () => {
    wireDb({ customer_properties: (cond) => (cond.id === PROPERTY_ID ? RENTAL : undefined) });
    lookup.mockResolvedValue(record(4200, 'crawl'));
    const pricing = await bookBlankWdo({ refillContext: { propertyId: PROPERTY_ID, sourceEstimateId: null } });
    expect(pricing.finalPrice).toBe(275);
    expect(lookup).toHaveBeenCalledWith(expect.stringContaining('200 Sample Rd'));
    expect(lookup).not.toHaveBeenCalledWith(expect.stringContaining('100 Example Ln'));
  });

  test('no property named: the visit is the customer\'s own address, where dispatch shows it; a lone property at another address gets no table price', async () => {
    lookup.mockResolvedValue(record(4200, 'crawl'));
    // The sole active property read (no id, no primary flag), the read by id, and the primary property.
    const rows = (active, primary) => (cond) => {
      if (cond.id) return active.find((property) => property.id === cond.id);
      return cond.is_primary ? primary : active;
    };
    // The customer's one active property is at their own address, not marked primary: the save stamps it, and its own
    // records count.
    const AT_HOME = { ...RENTAL, address_line1: HOME.address_line1, city: HOME.city, zip: HOME.zip };
    wireDb({ customers: HOME, customer_properties: rows([AT_HOME]) });
    expect((await bookBlankWdo()).finalPrice).toBe(275);
    expect(lookup).toHaveBeenCalledWith(expect.stringContaining('100 Example Ln'));
    wireDb({ customers: HOME, customer_properties: rows([{ ...AT_HOME, occupancy_type: 'commercial' }]) });
    expect((await bookBlankWdo()).finalPrice).toBe(250);
    // Only the account calls it commercial: that property is the customer's own address, so the account's type counts.
    const OFFICE = { ...HOME, property_type: 'commercial' };
    wireDb({ customers: OFFICE, customer_properties: rows([AT_HOME]) });
    expect((await bookBlankWdo({ customer: OFFICE })).finalPrice).toBe(250);
    // The one active property is the customer's own street under another town name of its ZIP: the same home by the
    // address key, so it is priced, and its own records count.
    const AT_HOME_ALIAS = { ...AT_HOME, city: 'Lakewood Ranch' };
    wireDb({ customers: HOME, customer_properties: rows([AT_HOME_ALIAS]) });
    expect((await bookBlankWdo()).finalPrice).toBe(275);
    wireDb({ customers: HOME, customer_properties: rows([{ ...AT_HOME_ALIAS, occupancy_type: 'commercial' }]) });
    expect((await bookBlankWdo()).finalPrice).toBe(250);
    // The one active property is a rental at another address. The save stamps the visit with it but no street, so
    // dispatch shows the customer's own address: two homes, so the catalog price stands and no record is read.
    lookup.mockClear();
    wireDb({ customers: HOME, customer_properties: rows([RENTAL]) });
    const stampedElsewhere = await bookBlankWdo();
    expect(stampedElsewhere.finalPrice).toBe(250);
    expect(stampedElsewhere.wdoTable).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    // Two active properties, the primary at another address: the save stamps neither, so the customer's own home is
    // priced, never the primary's.
    const primaryElsewhere = { ...RENTAL, is_primary: true };
    const SECOND = { ...RENTAL, id: 'b9e1c3d4-1111-4a2b-9c3d-5e6f7a8b9c0d', address_line1: '300 Sample Ave' };
    wireDb({ customers: HOME, customer_properties: rows([primaryElsewhere, SECOND], primaryElsewhere) });
    expect((await bookBlankWdo()).finalPrice).toBe(275);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(expect.stringContaining('100 Example Ln'));
  });

  test('inside the save, a booking that named no property is stamped with the home its WDO price was read at, or it refuses and the screen reads the price again', async () => {
    const { assertWdoTableHomeUnchanged } = adminSchedule._test;
    lookup.mockResolvedValue(record(4200, 'crawl'));
    const rows = (active) => (cond) => {
      if (cond.id) return active.find((property) => property.id === cond.id);
      return cond.is_primary ? undefined : active;
    };
    // The customer's one active property, at their own address.
    const AT_HOME = { ...RENTAL, address_line1: HOME.address_line1, city: HOME.city, zip: HOME.zip };
    wireDb({ customers: HOME, customer_properties: rows([AT_HOME]) });
    const pricing = await bookBlankWdo();
    expect(pricing.finalPrice).toBe(275);
    const check = (table, propertyId) => assertWdoTableHomeUnchanged(table, { customerId: CUSTOMER_ID, propertyId, trx: dbMock });
    // The save stamps the same sole property: it goes on.
    await expect(check(pricing.wdoTable, PROPERTY_ID)).resolves.toBeUndefined();
    // The customer's own street changed after pricing: dispatch now shows another address than the home priced.
    wireDb({ customers: { ...HOME, address_line1: '400 New St' }, customer_properties: rows([AT_HOME]) });
    await expect(check(pricing.wdoTable, PROPERTY_ID)).rejects.toMatchObject({ status: 409, code: 'WDO_PRICE_CHANGED' });
    // The property was replaced by one at another address, or its address was edited, before the save stamped it.
    const OTHER = { ...RENTAL, id: 'c0d1e2f3-2222-4b3c-8d4e-6f7a8b9c0d1e', address_line1: '300 Sample Ct' };
    wireDb({ customers: HOME, customer_properties: rows([OTHER]) });
    await expect(check(pricing.wdoTable, OTHER.id)).rejects.toMatchObject({ status: 409, code: 'WDO_PRICE_CHANGED' });
    wireDb({ customers: HOME, customer_properties: rows([{ ...AT_HOME, address_line1: '300 Sample Ct' }]) });
    await expect(check(pricing.wdoTable, PROPERTY_ID)).rejects.toMatchObject({ status: 409, code: 'WDO_PRICE_CHANGED' });
    // Two active properties: the visit is stamped with neither, and the customer's own home was priced: it goes on.
    wireDb({ customers: HOME, customer_properties: rows([AT_HOME, OTHER]) });
    const atHome = await bookBlankWdo();
    await expect(check(atHome.wdoTable, null)).resolves.toBeUndefined();
    // The property record is read only before the save; a booking with no table price has nothing to check.
    expect(lookup).toHaveBeenCalledTimes(2);
    await expect(check(undefined, null)).resolves.toBeUndefined();
  });

  test('inside the save, a booking from an estimate is checked at that estimate\'s home, read again: an estimate moved to another property refuses', async () => {
    const { assertWdoTableHomeUnchanged } = adminSchedule._test;
    lookup.mockResolvedValue(record(4200, 'crawl'));
    const ESTIMATE_ID = 'e5f6a7b8-3333-4c4d-9e5f-7a8b9c0d1e2f';
    const OTHER = { ...RENTAL, id: 'c0d1e2f3-2222-4b3c-8d4e-6f7a8b9c0d1e', address_line1: '300 Sample Ct' };
    let estimate = { id: ESTIMATE_ID, customer_id: CUSTOMER_ID, property_id: PROPERTY_ID, address: null };
    wireDb({
      customers: HOME,
      estimates: () => estimate,
      customer_properties: (cond) => (cond.id ? [RENTAL, OTHER].find((property) => property.id === cond.id) : (cond.is_primary ? undefined : [RENTAL, OTHER])),
    });
    const pricing = await bookBlankWdo({ refillContext: { propertyId: null, sourceEstimateId: ESTIMATE_ID } });
    expect(pricing.finalPrice).toBe(275);
    expect(lookup).toHaveBeenCalledWith(expect.stringContaining('200 Sample Rd'));
    const check = () => assertWdoTableHomeUnchanged(pricing.wdoTable, { customerId: CUSTOMER_ID, propertyId: null, estimateId: ESTIMATE_ID, trx: dbMock });
    await expect(check()).resolves.toBeUndefined();
    estimate = { ...estimate, property_id: OTHER.id };
    await expect(check()).rejects.toMatchObject({ status: 409, code: 'WDO_PRICE_CHANGED' });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('a booking from an estimate that quotes the customer\'s own address is priced there, and never beside a stamp at another property', async () => {
    const { assertWdoTableHomeUnchanged } = adminSchedule._test;
    lookup.mockResolvedValue(record(1600, 'block'));
    const ESTIMATE_ID = 'f7a8b9c0-4444-4d5e-8f6a-8b9c0d1e2f3a';
    const estimates = () => ({ id: ESTIMATE_ID, customer_id: CUSTOMER_ID, property_id: null, address: '100 Example Ln, Bradenton, FL 34201' });
    const fromEstimate = { refillContext: { propertyId: null, sourceEstimateId: ESTIMATE_ID } };
    // The customer's one active property is a rental at another address. The save stamps the visit with it, so the
    // estimate's home and the visit's are two homes: the catalog price stands.
    wireDb({
      customers: HOME, estimates,
      customer_properties: (cond) => (cond.id ? [RENTAL].find((property) => property.id === cond.id) : (cond.is_primary ? undefined : [RENTAL])),
    });
    const stampedElsewhere = await bookBlankWdo(fromEstimate);
    expect(stampedElsewhere.finalPrice).toBe(250);
    expect(stampedElsewhere.wdoTable).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    // Two active properties, the primary saved at another address: the save stamps neither, so the visit is the customer's
    // own address and is priced there. A primary elsewhere does not stand in for it.
    const primaryElsewhere = { ...RENTAL, is_primary: true };
    const SECOND = { ...RENTAL, id: 'b3c4d5e6-1111-4a2b-8c3d-4e5f6a7b8c9d', address_line1: '300 Sample Ave' };
    const twoProperties = (cond) => {
      if (cond.id) return [primaryElsewhere, SECOND].find((property) => property.id === cond.id);
      return cond.is_primary ? primaryElsewhere : [primaryElsewhere, SECOND];
    };
    wireDb({ customers: HOME, estimates, customer_properties: twoProperties });
    const atAddress = await bookBlankWdo(fromEstimate);
    expect(atAddress.finalPrice).toBe(150);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(expect.stringContaining('100 Example Ln'));
    // The save's own check: no property stamped, the same home, so it goes on.
    await expect(assertWdoTableHomeUnchanged(atAddress.wdoTable, { customerId: CUSTOMER_ID, propertyId: null, estimateId: ESTIMATE_ID, trx: dbMock }))
      .resolves.toBeUndefined();
    // A visit stamped with another property than the estimate's address is refused before any write, as is one whose
    // other property became the only active one in between (the save would stamp it).
    await expect(assertWdoTableHomeUnchanged(atAddress.wdoTable, { customerId: CUSTOMER_ID, propertyId: SECOND.id, estimateId: ESTIMATE_ID, trx: dbMock }))
      .rejects.toMatchObject({ status: 409, code: 'WDO_PRICE_CHANGED' });
    wireDb({ customers: HOME, estimates, customer_properties: (cond) => (cond.id === RENTAL.id || cond.is_primary ? primaryElsewhere : [primaryElsewhere]) });
    await expect(assertWdoTableHomeUnchanged(atAddress.wdoTable, { customerId: CUSTOMER_ID, propertyId: null, estimateId: ESTIMATE_ID, trx: dbMock }))
      .rejects.toMatchObject({ status: 409, code: 'WDO_PRICE_CHANGED' });
    // The account's own type still counts at that address.
    wireDb({ customers: { ...HOME, property_type: 'commercial' }, estimates, customer_properties: twoProperties });
    expect((await bookBlankWdo({ customer: { ...HOME, property_type: 'commercial' }, ...fromEstimate })).finalPrice).toBe(250);
  });

  test('the office save runs that check inside its transaction for every save, right after the property stamps', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    const stamp = source.indexOf('.soleActivePropertyId(customerId, trx);');
    const call = '      await assertWdoTableHomeUnchanged(pricing.wdoTable, {';
    const checked = source.indexOf(call);
    expect(stamp).toBe(source.lastIndexOf('.soleActivePropertyId(customerId, trx);'));
    expect(stamp).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(stamp);
    expect(source.indexOf('assertWdoTableHomeUnchanged(pricing.wdoTable', checked + call.length)).toBe(-1);
    // At the save's own level, under no condition: a property the office chose is checked too, and so is an estimate's home.
    const between = source.slice(stamp, checked);
    expect(between).not.toMatch(/bookingProperty|if \(/);
    expect(between.split('\n').length).toBeLessThan(8);
  });

  test('inside the save, a property the office chose is read again: one marked commercial after pricing refuses', async () => {
    const { assertWdoTableHomeUnchanged } = adminSchedule._test;
    lookup.mockResolvedValue(record(4200, 'crawl'));
    let rental = RENTAL;
    wireDb({ customers: HOME, customer_properties: (cond) => (cond.id === PROPERTY_ID ? rental : undefined) });
    const pricing = await bookBlankWdo({ refillContext: { propertyId: PROPERTY_ID, sourceEstimateId: null } });
    expect(pricing.finalPrice).toBe(275);
    const check = () => assertWdoTableHomeUnchanged(pricing.wdoTable, { customerId: CUSTOMER_ID, propertyId: PROPERTY_ID, chosenPropertyId: PROPERTY_ID, trx: dbMock });
    await expect(check()).resolves.toBeUndefined();
    rental = { ...RENTAL, occupancy_type: 'commercial' };
    await expect(check()).rejects.toMatchObject({ status: 409, code: 'WDO_PRICE_CHANGED' });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('inside the save, a chosen property beside a linked estimate is the home checked, as pricing read it', async () => {
    const { assertWdoTableHomeUnchanged } = adminSchedule._test;
    lookup.mockResolvedValue(record(4200, 'crawl'));
    const ESTIMATE_ID = 'a1b2c3d4-5555-4e6f-8a7b-9c0d1e2f3a4b';
    // The estimate quotes the customer's own address; the office chose the rental.
    wireDb({
      customers: HOME,
      estimates: () => ({ id: ESTIMATE_ID, customer_id: CUSTOMER_ID, property_id: null, address: '100 Example Ln, Bradenton, FL 34201' }),
      customer_properties: (cond) => (cond.id === PROPERTY_ID ? RENTAL : (cond.id ? undefined : [RENTAL])),
    });
    const pricing = await bookBlankWdo({ refillContext: { propertyId: PROPERTY_ID, sourceEstimateId: ESTIMATE_ID } });
    expect(pricing.finalPrice).toBe(275);
    expect(lookup).toHaveBeenCalledWith(expect.stringContaining('200 Sample Rd'));
    await expect(assertWdoTableHomeUnchanged(pricing.wdoTable, {
      customerId: CUSTOMER_ID, propertyId: PROPERTY_ID, chosenPropertyId: PROPERTY_ID, estimateId: ESTIMATE_ID, trx: dbMock,
    })).resolves.toBeUndefined();
  });

  test('a failed read never blocks a booking: the catalog price stands', async () => {
    lookup.mockRejectedValue(Object.assign(new Error('connection reset at 100 Example Ln'), { code: 'ECONNRESET' }));
    expect((await bookBlankWdo()).finalPrice).toBe(250);
    expect(await wdoBookingPrice({ customer: HOME })).toBeNull();
    // The log names the error code only, never the address it was reading.
    const logger = require('../services/logger');
    expect(logger.info.mock.calls.flat().join(' ')).not.toMatch(/Example Ln/);
  });
});

describe('the office booking keeps the price a person gives', () => {
  test('a typed price wins, and nothing is read', async () => {
    lookup.mockResolvedValue(record(1600, 'block'));
    expect((await bookBlankWdo({ primaryLinePrice: 300 })).finalPrice).toBe(300);
    expect(lookup).not.toHaveBeenCalled();
    expect(touched).not.toContain('customer_properties');
  });

  test('a blank WDO add-on line gets the table price; a typed add-on price stands', async () => {
    lookup.mockResolvedValue(record(2600, 'frame'));
    const pest = { service_key: 'general_pest', category: 'pest_control', base_price: 150 };
    const blank = await buildAppointmentPricing({
      serviceRecord: pest, estimatedPrice: null, primaryLinePrice: 150, customer: HOME,
      serviceAddons: [{ serviceId: 'svc-wdo', name: 'WDO Inspection Service', basePrice: null, price: null }],
    });
    expect(blank.addonLines[0].base).toBe(200);
    expect(blank.finalPrice).toBe(350);
    lookup.mockClear();
    const typed = await buildAppointmentPricing({
      serviceRecord: pest, estimatedPrice: null, primaryLinePrice: 150, customer: HOME,
      serviceAddons: [{ serviceId: 'svc-wdo', name: 'WDO Inspection Service', basePrice: 260, price: 260 }],
    });
    expect(typed.addonLines[0].base).toBe(260);
    expect(lookup).not.toHaveBeenCalled();
  });

  test('the table price is read before a booking transaction opens: inside one it refuses, unless the price read before is passed in', async () => {
    lookup.mockResolvedValue(record(2600, 'frame'));
    const trx = jest.fn();
    await expect(bookBlankWdo({ conn: trx })).rejects.toThrow(/read before the booking transaction opens/);
    const table = { price: 200, basis: '2,600 sq ft, wood frame', staffNote: null };
    expect((await bookBlankWdo({ conn: trx, wdoTable: table })).finalPrice).toBe(200);
    expect((await bookBlankWdo({ conn: trx, wdoTable: null })).finalPrice).toBe(250);
    expect(lookup).not.toHaveBeenCalled();
    expect(trx).not.toHaveBeenCalled();
  });

  test('a WDO main line beside a paid add-on line keeps the catalog price; a free one leaves the table price (the WDO filing fills its fee from the visit price only when the inspection is the only paid line)', async () => {
    lookup.mockResolvedValue(record(1600, 'block'));
    const PEST = { id: 'svc-pest', service_key: 'one_time_pest', category: 'pest_control', base_price: '150.00' };
    const DISCOUNTS = {
      'disc-free': { id: 'disc-free', name: 'Free add-on', discount_type: 'percentage', amount: '100.00', max_discount_dollars: null, is_active: true, show_in_invoices: true },
      'disc-min200': { id: 'disc-min200', name: 'Big job credit', discount_type: 'fixed_amount', amount: '20.00', max_discount_dollars: null, is_active: true, show_in_invoices: true },
    };
    wireDb({ customer_properties: undefined, customers: HOME, services: (cond) => (cond.id === 'svc-pest' ? PEST : WDO), discounts: (cond) => DISCOUNTS[cond.id] });
    const { manualEligibilityFailures } = require('../services/discount-engine');
    manualEligibilityFailures.mockImplementation(async (row, _customer, { subtotal }) => (row.id === 'disc-min200' && subtotal < 200 ? ['needs a $200 line'] : []));
    const pest = (basePrice) => [{ serviceId: 'svc-pest', name: 'One-Time Pest', basePrice, price: basePrice }];
    expect((await bookBlankWdo({ serviceAddons: pest(150) })).finalPrice).toBe(400);
    // The screen showed the catalog price for that line, and the save is checked against it.
    expect((await bookBlankWdo({ serviceAddons: pest(150), wdoExpectedPrice: 250 })).finalPrice).toBe(400);
    await expect(bookBlankWdo({ serviceAddons: pest(150), wdoExpectedPrice: 150 })).rejects.toMatchObject({ status: 409, code: 'WDO_PRICE_CHANGED' });
    // A free add-on line ($0, or left blank): the inspection is still the visit's only paid line.
    expect((await bookBlankWdo({ serviceAddons: pest(0) })).finalPrice).toBe(150);
    expect((await bookBlankWdo({ serviceAddons: pest(null), wdoExpectedPrice: 150 })).finalPrice).toBe(150);
    // An add-on line with a price is a paid line even when a discount takes it to $0: beside an appointment credit, the
    // discount stacking stores part of that price on it, and the filing reads it as paid.
    expect((await bookBlankWdo({ serviceAddons: [{ ...pest(50)[0], discountId: 'disc-free' }] })).finalPrice).toBe(250);
    // A main-line discount is checked once, at the price the line books at: one that needs a $200 line passes at the
    // $250 catalog price beside a paid line ($230 + $150), and is refused at the $150 table price alone.
    manualEligibilityFailures.mockClear();
    expect((await bookBlankWdo({ serviceAddons: pest(150), primaryLineDiscount: { discountId: 'disc-min200' } })).finalPrice).toBe(380);
    expect(manualEligibilityFailures.mock.calls.filter(([row]) => row.id === 'disc-min200')).toHaveLength(1);
    await expect(bookBlankWdo({ primaryLineDiscount: { discountId: 'disc-min200' } })).rejects.toMatchObject({ status: 400 });
    manualEligibilityFailures.mockReset();
    // The same inspection alone on its visit takes the table price.
    expect((await bookBlankWdo()).finalPrice).toBe(150);
  });

  test('the save books the WDO price the screen showed, or refuses with nothing written; a typed price is not checked', async () => {
    lookup.mockResolvedValue(record(2600, 'frame'));
    expect((await bookBlankWdo({ wdoExpectedPrice: 200 })).finalPrice).toBe(200);
    await expect(bookBlankWdo({ wdoExpectedPrice: 175 })).rejects.toMatchObject({
      status: 409, code: 'WDO_PRICE_CHANGED', isOperational: true,
      message: 'The WDO price for this home is now $200.00, not the $175.00 shown. This visit was not booked. Check the price and save again.',
    });
    // A blank WDO add-on line is checked the same way.
    const pest = { service_key: 'general_pest', category: 'pest_control', base_price: 150 };
    const withAddon = (wdoExpectedPrice) => buildAppointmentPricing({
      serviceRecord: pest, estimatedPrice: null, primaryLinePrice: 150, customer: HOME, wdoExpectedPrice,
      serviceAddons: [{ serviceId: 'svc-wdo', name: 'WDO Inspection Service', basePrice: null, price: null }],
    });
    expect((await withAddon(200)).addonLines[0].base).toBe(200);
    await expect(withAddon(250)).rejects.toMatchObject({ status: 409, code: 'WDO_PRICE_CHANGED' });
    // A screen that showed no price (the Intelligence Bar, the preview) books without the check.
    expect((await bookBlankWdo()).finalPrice).toBe(200);
    expect(touched.filter((table) => /scheduled_services|invoice/.test(table))).toEqual([]);
  });

  test('a shown price with no WDO line to check it against refuses: the catalog row failed to read, so the posted total would be booked', async () => {
    const PEST = { id: 'svc-pest', service_key: 'one_time_pest', category: 'pest_control', base_price: '50.00' };
    wireDb({ customer_properties: undefined, customers: HOME, services: (cond) => (cond.id === 'svc-pest' ? PEST : WDO) });
    // The create route caught the failed read: no service row, and estimatedPrice is the group's $300 total.
    await expect(buildAppointmentPricing({
      serviceRecord: null, estimatedPrice: 300, primaryLinePrice: null, customer: HOME, wdoExpectedPrice: 250,
      serviceAddons: [{ serviceId: 'svc-pest', name: 'One-Time Pest', basePrice: 50, price: 50 }],
    })).rejects.toMatchObject({ status: 409, code: 'WDO_PRICE_UNCHECKED' });
    // No line to check: a typed WDO price with a shown price refuses the same way (the screen sends a shown price only
    // for a blank WDO line).
    await expect(bookBlankWdo({ primaryLinePrice: 300, wdoExpectedPrice: 175 })).rejects.toMatchObject({ code: 'WDO_PRICE_UNCHECKED' });
  });

  test('the shown price is read from the request as a price, or refused', () => {
    for (const absent of [undefined, null, '']) expect(wdoExpectedPriceFrom(absent)).toBeUndefined();
    expect(wdoExpectedPriceFrom('200')).toBe(200);
    expect(wdoExpectedPriceFrom(175.5)).toBe(175.5);
    for (const bad of ['abc', -1, {}]) expect(() => wdoExpectedPriceFrom(bad)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('POST /wdo-inspection-quote (the booking screen shows the price before save)', () => {
  const layer = adminSchedule.stack.find((l) => l.route && l.route.path === '/wdo-inspection-quote' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  // The question is a POST body, never a query string, so no address reaches a request log.
  const run = async (body) => {
    const res = { json: jest.fn() };
    const next = jest.fn();
    await handler({ body, query: {} }, res, next);
    return { res, next };
  };

  test('is a POST only: no GET route answers it', () => {
    expect(adminSchedule.stack.some((l) => l.route?.path === '/wdo-inspection-quote' && l.route.methods.get)).toBe(false);
  });

  test('answers the table price, what it was read at and the office note for the customer\'s home', async () => {
    lookup.mockResolvedValue(record(2600, 'frame'));
    const { res } = await run({ customerId: CUSTOMER_ID });
    expect(res.json).toHaveBeenCalledWith({ price: 200, source: 'wdo_table', basis: '2,600 sq ft, wood frame', staffNote: null });
  });

  test('the property the screen names is the one priced; malformed ids are refused before any read', async () => {
    wireDb({ customers: HOME, customer_properties: (cond) => (cond.id === PROPERTY_ID ? RENTAL : undefined) });
    lookup.mockResolvedValue(record(1600, 'crawl'));
    const { res } = await run({ customerId: CUSTOMER_ID, propertyId: PROPERTY_ID });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ price: 200, source: 'wdo_table' }));
    expect(lookup).toHaveBeenCalledWith(expect.stringContaining('200 Sample Rd'));
    touched.length = 0;
    for (const body of [{ customerId: 'nope' }, { customerId: CUSTOMER_ID, propertyId: 'nope' }, { customerId: CUSTOMER_ID, estimateId: 'nope' }]) {
      const bad = await run(body);
      expect(bad.next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    }
    expect(touched).toEqual([]);
  });

  test('no table price: the catalog price, marked as the catalog\'s', async () => {
    wireDb({ customers: { ...HOME, property_type: 'commercial' }, services: WDO });
    const { res } = await run({ customerId: CUSTOMER_ID });
    expect(res.json).toHaveBeenCalledWith({ price: 250, source: 'catalog_base', basis: null, staffNote: null });
  });

  test('a new caller booked by address is priced from the picked address; an address not picked from the suggestions is refused', async () => {
    lookup.mockResolvedValue(record(3600, 'block'));
    const picked = { line1: '300 Sample Ct', city: 'Venice', state: 'FL', zip: '34285', lat: '27.09', lng: '-82.44' };
    const { res } = await run(picked);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ price: 200, source: 'wdo_table', basis: '3,600 sq ft, concrete block' }));
    expect(lookup).toHaveBeenCalledWith(expect.stringContaining('300 Sample Ct'));
    expect(touched).not.toContain('customers');
    lookup.mockClear();
    const bad = await run({ line1: '300 Sample Ct', city: 'Venice', zip: '34285' });
    expect(bad.next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(lookup).not.toHaveBeenCalled();
  });

  test('an unknown customer is a 404', async () => {
    wireDb({ customers: undefined });
    const { next } = await run({ customerId: CUSTOMER_ID });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
  });

  test('a WDO main line with other lines answers the catalog price and why, and reads no home', async () => {
    lookup.mockResolvedValue(record(1600, 'block'));
    for (const body of [{ customerId: CUSTOMER_ID, withOtherLines: '1' }, { line1: '300 Sample Ct', zip: '34285', withOtherLines: '1' }]) {
      touched.length = 0;
      const { res } = await run(body);
      expect(res.json).toHaveBeenCalledWith({ price: 250, source: 'catalog_base', basis: null, staffNote: WDO_WITH_OTHER_LINES_NOTE });
      expect(touched).toEqual(['services']);
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('phone bookings (the call pipeline, the voice agent, the new caller booked by address)', () => {
  const ADDRESS = { line1: '100 Example Ln', line2: '', city: 'Bradenton', state: 'FL', zip: '34201' };
  const CATALOG = { price: 250, source: 'catalog' };

  test('a price agreed on the call wins: nothing is read, and the visit note says it was quoted', async () => {
    const quoted = { price: 199, source: 'transcript' };
    const resolveLinkage = jest.fn();
    expect(await wdoCallBookingPrice(quoted, { catalogRow: WDO, customerId: CUSTOMER_ID, linkage: { address: ADDRESS } })).toBe(quoted);
    expect(await wdoCallPriceBeforeBooking(quoted, { catalogRow: WDO, customerId: CUSTOMER_ID, resolveLinkage })).toBeNull();
    expect(wdoCallPriceForBooking(quoted, null, { address: ADDRESS })).toBe(quoted);
    expect(resolveLinkage).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(callBookingPriceNote(quoted)).toBe('Price quoted on call: $199.00.');
    // A new caller's typed price is the same: only a catalog price is replaced.
    const typed = { price: 260, source: 'typed' };
    expect(await wdoCallBookingPrice(typed, { catalogRow: WDO, linkage: { address: ADDRESS } })).toBe(typed);
  });

  test('a catalog-priced WDO call booking gets the table price and an office note; any other service keeps its price', async () => {
    lookup.mockResolvedValue(record(2600, 'frame'));
    const priced = await wdoCallBookingPrice(CATALOG, { catalogRow: WDO, customerId: CUSTOMER_ID, linkage: { propertyId: null, address: ADDRESS } });
    expect(priced).toEqual({ price: 200, source: 'wdo_table', wdoTable: { price: 200, basis: '2,600 sq ft, wood frame', staffNote: null } });
    expect(callBookingPriceNote(priced)).toBe('Price by home size and construction: $200.00.');
    expect(wdoTableNote(priced.wdoTable)).toBe('WDO price from the home size and construction table: $200.00 (2,600 sq ft, wood frame).');
    expect(callBookingPriceNote(CATALOG)).toBe('Price from service catalog: $250.00.');
    expect(wdoTableNote(null)).toBeNull();
    // A new caller has no customer yet: the address the call gave is the home.
    lookup.mockClear();
    touched.length = 0;
    const byAddress = await wdoCallBookingPrice(CATALOG, { catalogRow: WDO, linkage: { address: { ...ADDRESS, line1: '300 Sample Ct' } } });
    expect(byAddress.price).toBe(200);
    expect(lookup).toHaveBeenCalledWith(expect.stringContaining('300 Sample Ct'));
    expect(touched).toEqual([]);
    // Not a WDO inspection: unchanged, nothing read.
    lookup.mockClear();
    const pest = { service_key: 'one_time_pest' };
    expect(await wdoCallBookingPrice(CATALOG, { catalogRow: pest, customerId: CUSTOMER_ID, linkage: { address: ADDRESS } })).toBe(CATALOG);
    expect(lookup).not.toHaveBeenCalled();
  });

  test('a call booked at an address that is not the customer\'s home is priced on its own record: the home\'s commercial records do not apply there', async () => {
    lookup.mockResolvedValue(record(2600, 'frame'));
    const elsewhere = { propertyId: null, address: { ...ADDRESS, line1: '300 Sample Ct' } };
    // The customer's primary property is a commercial site.
    wireDb({ customers: HOME, customer_properties: { ...RENTAL, is_primary: true, occupancy_type: 'commercial' } });
    expect(await wdoCallBookingPrice(CATALOG, { catalogRow: WDO, customerId: CUSTOMER_ID, linkage: elsewhere }))
      .toMatchObject({ price: 200, source: 'wdo_table' });
    expect(lookup).toHaveBeenCalledWith(expect.stringContaining('300 Sample Ct'));
    // A call for that commercial site itself: the catalog price stands.
    const site = { line1: RENTAL.address_line1, line2: '', city: RENTAL.city, state: RENTAL.state, zip: RENTAL.zip };
    expect(await wdoCallBookingPrice(CATALOG, { catalogRow: WDO, customerId: CUSTOMER_ID, linkage: { propertyId: null, address: site } })).toBe(CATALOG);
    // A commercial account is commercial at any address.
    wireDb({ customers: { ...HOME, waveguard_tier: 'commercial' }, customer_properties: undefined });
    expect(await wdoCallBookingPrice(CATALOG, { catalogRow: WDO, customerId: CUSTOMER_ID, linkage: elsewhere })).toBe(CATALOG);
    // The customer's own home under another town name of its ZIP is the home: its own records still call it commercial,
    // and a home they call a house is read at its own address.
    const homeAlias = { propertyId: null, address: { ...ADDRESS, city: 'Lakewood Ranch' } };
    wireDb({ customers: { ...HOME, property_type: 'commercial' }, customer_properties: undefined });
    expect(await wdoCallBookingPrice(CATALOG, { catalogRow: WDO, customerId: CUSTOMER_ID, linkage: homeAlias })).toBe(CATALOG);
    wireDb({ customers: HOME, customer_properties: undefined });
    expect(await wdoCallBookingPrice(CATALOG, { catalogRow: WDO, customerId: CUSTOMER_ID, linkage: homeAlias })).toMatchObject({ price: 200, source: 'wdo_table' });
    expect(lookup).toHaveBeenLastCalledWith(expect.stringContaining('Bradenton'));
    // A call at the customer's own address while the primary property is saved elsewhere: the account's own type describes
    // that address.
    wireDb({ customers: { ...HOME, property_type: 'commercial' }, customer_properties: { ...RENTAL, is_primary: true } });
    expect(await wdoCallBookingPrice(CATALOG, { catalogRow: WDO, customerId: CUSTOMER_ID, linkage: { propertyId: null, address: ADDRESS } })).toBe(CATALOG);
  });

  test('a call linked to a saved property is priced at it only while the property still has the call\'s address (by its address key: one ZIP carries several town names)', async () => {
    lookup.mockResolvedValue(record(2600, 'frame'));
    wireDb({ customers: HOME, customer_properties: RENTAL });
    const rental = { line1: RENTAL.address_line1, line2: '', city: RENTAL.city, state: RENTAL.state, zip: RENTAL.zip };
    const linked = (address) => wdoCallBookingPrice(CATALOG, { catalogRow: WDO, customerId: CUSTOMER_ID, linkage: { propertyId: PROPERTY_ID, address } });
    expect(await linked(rental)).toMatchObject({ price: 200, source: 'wdo_table' });
    expect(await linked({ ...rental, city: 'Duette' })).toMatchObject({ price: 200, source: 'wdo_table' });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenLastCalledWith(expect.stringContaining('200 Sample Rd'));
    // The property's address was edited after the call linked it, and the visit is stamped with the call's address: the
    // catalog price stands, and nothing is read.
    lookup.mockClear();
    wireDb({ customers: HOME, customer_properties: { ...RENTAL, address_line1: '300 Sample Ct' } });
    expect(await linked(rental)).toBe(CATALOG);
    expect(lookup).not.toHaveBeenCalled();
  });

  test('the call pipeline reads the table before its transaction, and keeps it only for the same home', async () => {
    lookup.mockResolvedValue(record(4200, 'crawl'));
    const linkage = { propertyId: null, address: ADDRESS };
    const before = await wdoCallPriceBeforeBooking(CATALOG, {
      catalogRow: WDO, customerId: CUSTOMER_ID, resolveLinkage: async () => linkage,
    });
    expect(before.priceInfo).toMatchObject({ price: 275, source: 'wdo_table' });
    // Inside the transaction (no reads): the same home keeps it, a home that changed keeps the call's own price.
    lookup.mockClear();
    expect(wdoCallPriceForBooking(CATALOG, before, { propertyId: null, address: { ...ADDRESS } })).toBe(before.priceInfo);
    expect(wdoCallPriceForBooking(CATALOG, before, { propertyId: PROPERTY_ID, address: ADDRESS })).toBe(CATALOG);
    expect(wdoCallPriceForBooking(CATALOG, before, { propertyId: null, address: { ...ADDRESS, line2: 'Unit 2' } })).toBe(CATALOG);
    expect(lookup).not.toHaveBeenCalled();
    // A home that cannot be resolved before the transaction: no table price.
    const failed = await wdoCallPriceBeforeBooking(CATALOG, {
      catalogRow: WDO, customerId: CUSTOMER_ID, resolveLinkage: async () => { throw new Error('ambiguous address'); },
    });
    expect(failed).toBeNull();
    expect(wdoCallPriceForBooking(CATALOG, failed, linkage)).toBe(CATALOG);
  });

  test('each booking path reads the table price before its booking transaction opens', () => {
    const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const order = (text, ...anchors) => anchors.map((anchor) => {
      const at = text.indexOf(anchor);
      expect(at).toBeGreaterThan(-1);
      return at;
    });
    // The call pipeline: the read, then its one booking transaction, then the in-transaction choice.
    const pipeline = source('services/call-recording-processor.js');
    expect(pipeline.split('const svc = await db.transaction(').length - 1).toBe(1);
    const [read, trx, keep] = order(pipeline, 'wdoCallPriceBeforeBooking(priceInfo', 'const svc = await db.transaction(', 'wdoCallPriceForBooking(priceInfo');
    expect(read).toBeLessThan(trx);
    expect(keep).toBeGreaterThan(trx);
    // The new caller booked by address: the read, then the transaction.
    const newCaller = source('services/booking/new-caller-visit.js');
    const book = newCaller.slice(newCaller.indexOf('async function bookNewCallerVisit('), newCaller.indexOf('async function linkNewCallerVisit('));
    const [callerRead, callerTrx] = order(book, 'await wdoCallBookingPrice(', 'conn.transaction(');
    expect(callerRead).toBeLessThan(callerTrx);
  });

  test('Book for a new caller books the WDO price the screen showed, or refuses before its booking transaction', async () => {
    const { bookNewCallerVisit } = require('../services/booking/new-caller-visit');
    lookup.mockResolvedValue(record(2600, 'frame'));
    const transaction = jest.fn(async () => ({ id: 'visit-1' }));
    const conn = Object.assign((table) => ({ where: () => ({ first: async () => (table === 'services' ? WDO : null) }) }), { transaction });
    const input = {
      scheduledDate: '2027-01-20', windowStart: '10:00', serviceId: 'svc-wdo',
      address: { line1: '300 Sample Ct', city: 'Venice', state: 'FL', zip: '34285', lat: 27.09, lng: -82.44 },
    };
    await expect(bookNewCallerVisit({ input: { ...input, wdoExpectedPrice: 175 }, conn }))
      .rejects.toMatchObject({ status: 409, code: 'WDO_PRICE_CHANGED' });
    expect(transaction).not.toHaveBeenCalled();
    await bookNewCallerVisit({ input: { ...input, wdoExpectedPrice: 200 }, conn });
    // A typed price books as typed; a shown price with no blank WDO line to check refuses.
    await bookNewCallerVisit({ input: { ...input, linePrice: 260 }, conn });
    await expect(bookNewCallerVisit({ input: { ...input, linePrice: 260, wdoExpectedPrice: 175 }, conn }))
      .rejects.toMatchObject({ status: 409, code: 'WDO_PRICE_UNCHECKED' });
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});

describe('a booked visit is never repriced', () => {
  test('the module reads no visit and no invoice and writes nothing', () => {
    const code = fs.readFileSync(path.join(__dirname, '../services/wdo-booking-price.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/scheduled_services|invoices|\.insert\(|\.update\(|\.del\(|\.delete\(/);
  });

  test('only the new-booking paths ask for the table price (a reschedule, rebook or copy keeps the price it was booked at)', () => {
    const root = path.join(__dirname, '..');
    const skip = new Set(['node_modules', 'tests', '__tests__', 'migrations', 'coverage', 'dist', 'fixtures']);
    const callers = [];
    const walkDir = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!skip.has(entry.name)) walkDir(full); continue; }
        if (/\.(js|cjs|mjs)$/.test(entry.name) && /wdo-booking-price['"]/.test(fs.readFileSync(full, 'utf8'))) {
          callers.push(path.relative(root, full).split(path.sep).join('/'));
        }
      }
    };
    walkDir(root);
    expect(callers.sort()).toEqual([
      'routes/admin-schedule.js',
      'services/booking/new-caller-visit.js',
      'services/call-recording-processor.js',
      'services/intelligence-bar/tools.js',
      'services/voice-agent/relay-booking.js',
    ]);
  });
});
