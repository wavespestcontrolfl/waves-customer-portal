/**
 * Owner ruling 2026-11-26 "ok well say the one time price when asked": staff see the system's one-time pest price for the
 * home. READ ONLY: the helper and the quote route change no booking, line price or invoice.
 * Behavior: the price is the engine's one-time list price for the property the visit is booked at (its own facts, never
 * the primary's), read from cached property facts; no home square footage, commercial records, a failed settings refresh
 * or any read failure answer null, never $0 or a guess.
 * Regressions it guards: a second home or commercial site getting the primary home's residential rate; stale or built-in
 * rates quoted after a failed settings refresh; the member perk inside a list price; a malformed id reaching a read.
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

const mockResolveContext = jest.fn();
jest.mock('../services/customer-pricing-ai', () => ({
  resolvePropertyContext: (...args) => mockResolveContext(...args),
  loadTurfProfile: jest.fn(async () => null),
}));
jest.mock('../services/service-report/start-offer-lookup', () => ({ strictCacheOnlyPropertyLookup: jest.fn() }));
// The engine's settings refresh is steered per test (true = refreshed, false = the read failed).
const mockNeedsSync = jest.fn(() => false);
const mockSync = jest.fn(async () => true);
jest.mock('../services/pricing-engine', () => ({
  ...jest.requireActual('../services/pricing-engine'),
  needsSync: () => mockNeedsSync(),
  syncConstantsFromDB: (...args) => mockSync(...args),
}));

const logger = require('../services/logger');
const { generateEstimate } = require('../services/pricing-engine');
const {
  oneTimePestBookingPrice,
} = require('../services/one-time-pest-booking-price');

// The engine's own settings refresh reads the mocked db handle and falls back to defaults; keep the log quiet.
beforeAll(() => { jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => { console.error.mockRestore?.(); });

const HOME = {
  homeSqFt: 2400, lotSqFt: 9000, stories: 1, storiesSource: 'lookup', propertyType: 'single_family', features: {}, yearBuilt: 1998,
};
const conn = (customer, property) => (table) => ({ where: () => ({ first: async () => (table === 'customer_properties' ? property : customer) }) });
const lineFor = (input) => generateEstimate({
  ...input, recurringCustomer: false, services: { oneTimePest: { urgency: 'NONE', afterHours: false } },
}).lineItems.find((l) => l.service === 'one_time_pest');

describe('one-time pest system price (read only)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNeedsSync.mockReturnValue(false);
    mockSync.mockResolvedValue(true);
  });

  test('the price is the engine one-time list price for the home, not the flat catalog price', async () => {
    mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
    const expected = lineFor(HOME).price;
    expect(expected).toBeGreaterThanOrEqual(199);
    expect(expected).not.toBe(250);
    const price = await oneTimePestBookingPrice('cust-1', { conn: conn({ id: 'cust-1' }) });
    expect(price).toBe(expected);
    // A bigger home prices higher: it follows the property, not a flat number.
    mockResolveContext.mockResolvedValue({ propertyInput: { ...HOME, homeSqFt: 3000, lotSqFt: 15000 }, hasHomeSqFt: true });
    expect(await oneTimePestBookingPrice('cust-1', { conn: conn({ id: 'cust-1' }) })).toBeGreaterThan(expected);
  });

  test('no member discount is inside the returned list price', async () => {
    mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
    const member = generateEstimate({
      ...HOME, recurringCustomer: true, services: { oneTimePest: { urgency: 'NONE', afterHours: false } },
    }).lineItems.find((l) => l.service === 'one_time_pest').price;
    const price = await oneTimePestBookingPrice('cust-1', { conn: conn({ id: 'cust-1' }) });
    expect(price).toBeGreaterThan(member);
  });

  describe('the property the visit is booked at', () => {
    const RENTAL = {
      id: 'prop-2', customer_id: 'cust-1', active: true, is_primary: false, address_line1: '200 Rental Rd', address_line2: null,
      city: 'Parrish', state: 'FL', zip: '34219', lot_sqft: 5000, property_sqft: null, bed_sqft: null, property_type: 'single_family',
    };
    const PRIMARY_CUSTOMER = {
      id: 'cust-1', address_line1: '100 Home Ln', city: 'Bradenton', state: 'FL', zip: '34201', lot_sqft: 20000, property_type: 'single_family', palm_count: 4,
    };

    test('another saved property is priced from its own address and measurements, never the primary home\'s', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      await oneTimePestBookingPrice('cust-1', { conn: conn(PRIMARY_CUSTOMER, RENTAL), propertyId: 'prop-2' });
      const arg = mockResolveContext.mock.calls[0][0];
      expect(arg.customer).toMatchObject({ id: 'cust-1', address_line1: '200 Rental Rd', city: 'Parrish', zip: '34219', lot_sqft: 5000, palm_count: null });
      expect(arg.customer.lot_sqft).not.toBe(20000);
      // The primary's turf profile is not this property's.
      expect(arg.turfProfile).toBeNull();
    });

    test('a second home without facts, or a commercial site, answers null (no hint)', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: { ...HOME, homeSqFt: null }, hasHomeSqFt: false });
      expect(await oneTimePestBookingPrice('cust-1', { conn: conn(PRIMARY_CUSTOMER, RENTAL), propertyId: 'prop-2' })).toBeNull();
      mockResolveContext.mockResolvedValue({ propertyInput: { ...HOME, propertyType: 'commercial' }, hasHomeSqFt: true });
      expect(await oneTimePestBookingPrice('cust-1', { conn: conn(PRIMARY_CUSTOMER, { ...RENTAL, property_type: 'commercial' }), propertyId: 'prop-2' })).toBeNull();
    });

    test('the customer\'s primary property, or none named, reads the customer row as it is; a property that is not theirs is refused', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      await oneTimePestBookingPrice('cust-1', { conn: conn(PRIMARY_CUSTOMER, { ...RENTAL, is_primary: true }), propertyId: 'prop-2' });
      expect(mockResolveContext.mock.calls[0][0].customer).toBe(PRIMARY_CUSTOMER);
      mockResolveContext.mockClear();
      await oneTimePestBookingPrice('cust-1', { conn: conn(PRIMARY_CUSTOMER) });
      expect(mockResolveContext.mock.calls[0][0].customer).toBe(PRIMARY_CUSTOMER);
      mockResolveContext.mockClear();
      expect(await oneTimePestBookingPrice('cust-1', { conn: conn(PRIMARY_CUSTOMER, undefined), propertyId: 'prop-x' })).toBeNull();
      expect(mockResolveContext).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('not an active property'));
    });
  });

  describe('commercial records (the catalog price stands, even for the primary property)', () => {
    const PRIMARY = { id: 'cust-1', address_line1: '100 Home Ln', city: 'Bradenton', state: 'FL', zip: '34201', lot_sqft: 9000, property_type: 'single_family' };
    const PRIMARY_ROW = { id: 'prop-1', customer_id: 'cust-1', active: true, is_primary: true, address_line1: '100 Home Ln', city: 'Bradenton', state: 'FL', zip: '34201', occupancy_type: 'owner_occupied', property_type: 'single_family' };
    const price = (customer, property, propertyId) => oneTimePestBookingPrice('cust-1', { conn: conn(customer, property), propertyId });

    test('an occupancy_type commercial primary property, with or without the id named, falls back', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      expect(await price(PRIMARY, { ...PRIMARY_ROW, occupancy_type: 'commercial' })).toBeNull();
      expect(await price(PRIMARY, { ...PRIMARY_ROW, occupancy_type: 'commercial' }, 'prop-1')).toBeNull();
      expect(mockResolveContext).not.toHaveBeenCalled();
    });

    test('a commercial property type on the property row, the customer row, or the account tier falls back', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      expect(await price(PRIMARY, { ...PRIMARY_ROW, property_type: 'commercial' })).toBeNull();
      expect(await price({ ...PRIMARY, property_type: 'Commercial' }, PRIMARY_ROW)).toBeNull();
      expect(await price({ ...PRIMARY, waveguard_tier: 'Commercial' }, PRIMARY_ROW)).toBeNull();
      expect(await price({ ...PRIMARY, waveguard_tier: 'Commercial' }, { ...PRIMARY_ROW, is_primary: false }, 'prop-1')).toBeNull();
    });

    test('a residential primary is priced from its own row (the row is read, not discarded)', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      expect(await price(PRIMARY, PRIMARY_ROW)).toBe(lineFor(HOME).price);
      expect(mockResolveContext.mock.calls[0][0].customer).toBe(PRIMARY);
    });
  });

  describe('the engine\'s settings refresh', () => {
    test('a failed refresh (syncConstantsFromDB returns false) answers null instead of quoting stale rates', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      mockNeedsSync.mockReturnValue(true);
      mockSync.mockResolvedValue(false);
      expect(await oneTimePestBookingPrice('cust-1', { conn: conn({ id: 'cust-1' }) })).toBeNull();
      expect(mockSync).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('could not be refreshed'));
    });

    test('a good refresh prices as usual, and no refresh is asked when none is due', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      mockNeedsSync.mockReturnValue(true);
      mockSync.mockResolvedValue(true);
      expect(await oneTimePestBookingPrice('cust-1', { conn: conn({ id: 'cust-1' }) })).toBe(lineFor(HOME).price);
      mockSync.mockClear();
      mockNeedsSync.mockReturnValue(false);
      expect(await oneTimePestBookingPrice('cust-1', { conn: conn({ id: 'cust-1' }) })).toBe(lineFor(HOME).price);
      expect(mockSync).not.toHaveBeenCalled();
    });
  });

  test('no home square footage: null with a log line, never $0 or a guess', async () => {
    mockResolveContext.mockResolvedValue({ propertyInput: { ...HOME, homeSqFt: null }, hasHomeSqFt: false });
    expect(await oneTimePestBookingPrice('cust-1', { conn: conn({ id: 'cust-1' }) })).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('no home square footage'));
  });

  test('a commercial property, a missing customer and a failed read all answer null', async () => {
    mockResolveContext.mockResolvedValue({ propertyInput: { ...HOME, propertyType: 'commercial' }, hasHomeSqFt: true });
    expect(await oneTimePestBookingPrice('cust-1', { conn: conn({ id: 'cust-1' }) })).toBeNull();
    expect(await oneTimePestBookingPrice('cust-x', { conn: conn(undefined) })).toBeNull();
    mockResolveContext.mockRejectedValue(new Error('cache read failed'));
    expect(await oneTimePestBookingPrice('cust-1', { conn: conn({ id: 'cust-1' }) })).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('price lookup failed'));
  });
});

describe('GET /one-time-pest-quote (the Schedule modal hint)', () => {
  const router = require('../routes/admin-schedule');
  const layer = router.stack.find((l) => l.route && l.route.path === '/one-time-pest-quote' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const CUSTOMER = '3f2c8a52-0b1e-4c1a-9a47-2f6f6c1f0a11';
  const PROPERTY = '7a1d2e90-4c5b-4d0e-8b21-9e0f3a6c5d77';
  const run = async (query) => {
    const res = { json: jest.fn() };
    const next = jest.fn();
    await handler({ query }, res, next);
    return { res, next };
  };
  const dbMock = require('../models/db');
  beforeEach(() => {
    jest.clearAllMocks();
    mockNeedsSync.mockReturnValue(false);
    mockSync.mockResolvedValue(true);
    mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
    dbMock.mockImplementation(() => ({ where: () => ({ first: async () => ({ id: CUSTOMER }) }) }));
  });

  test("answers the system price for the customer's home as { price }", async () => {
    const { res } = await run({ customerId: CUSTOMER });
    expect(res.json).toHaveBeenCalledWith({ price: lineFor(HOME).price });
  });

  test('the property the modal names is the one priced; a malformed property id is refused', async () => {
    dbMock.mockImplementation((table) => ({
      where: () => ({
        first: async () => (table === 'customer_properties'
          ? { id: PROPERTY, customer_id: CUSTOMER, active: true, is_primary: false, address_line1: '200 Rental Rd', city: 'Parrish', state: 'FL', zip: '34219', lot_sqft: 5000 }
          : { id: CUSTOMER, address_line1: '100 Home Ln', lot_sqft: 20000 }),
      }),
    }));
    await run({ customerId: CUSTOMER, propertyId: PROPERTY });
    expect(mockResolveContext.mock.calls[0][0].customer).toMatchObject({ address_line1: '200 Rental Rd', lot_sqft: 5000 });
    mockResolveContext.mockClear();
    const bad = await run({ customerId: CUSTOMER, propertyId: 'nope' });
    expect(bad.next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(mockResolveContext).not.toHaveBeenCalled();
  });

  test('with no property chosen, the linked estimate\'s property is the one priced; the same rule as the save', async () => {
    const ESTIMATE = '5b8c9d10-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
    dbMock.mockImplementation((table) => ({
      where: () => ({
        first: async () => {
          if (table === 'estimates') return { property_id: PROPERTY };
          if (table === 'customer_properties') return { id: PROPERTY, customer_id: CUSTOMER, active: true, is_primary: false, address_line1: '300 Quoted Ct', city: 'Venice', state: 'FL', zip: '34285', lot_sqft: 7000 };
          return { id: CUSTOMER, address_line1: '100 Home Ln', lot_sqft: 20000 };
        },
      }),
    }));
    await run({ customerId: CUSTOMER, estimateId: ESTIMATE });
    expect(mockResolveContext.mock.calls[0][0].customer).toMatchObject({ address_line1: '300 Quoted Ct', lot_sqft: 7000 });
    // An explicit property choice still wins over the estimate's.
    mockResolveContext.mockClear();
    dbMock.mockImplementation((table) => ({
      where: (cond) => ({
        first: async () => {
          if (table === 'estimates') return { property_id: 'other-property' };
          if (table === 'customer_properties') return { id: cond.id, customer_id: CUSTOMER, active: true, is_primary: false, address_line1: cond.id === PROPERTY ? '200 Rental Rd' : '999 Wrong St', city: 'Parrish', state: 'FL', zip: '34219', lot_sqft: 5000 };
          return { id: CUSTOMER };
        },
      }),
    }));
    await run({ customerId: CUSTOMER, propertyId: PROPERTY, estimateId: ESTIMATE });
    expect(mockResolveContext.mock.calls[0][0].customer.address_line1).toBe('200 Rental Rd');
  });

  test('a bad customer id is refused before any read', async () => {
    const { res, next } = await run({ customerId: 'nope' });
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});
