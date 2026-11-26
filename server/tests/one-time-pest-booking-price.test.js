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
// The bridge's "price from the committed rows" call is steered per test: by default it runs the price and answers priced.
const mockUnattended = jest.fn((price) => ({ priced: true, value: price() }));
jest.mock('../services/pricing-engine/db-bridge', () => ({
  ...jest.requireActual('../services/pricing-engine/db-bridge'),
  withSettingsForUnattendedPrice: async (price) => mockUnattended(price),
}));

const logger = require('../services/logger');
const dbMock = require('../models/db');
const { generateEstimate } = require('../services/pricing-engine');
const {
  oneTimePestBookingPrice,
} = require('../services/one-time-pest-booking-price');

// The global db handle answers only the one-time pest settings row (floor and multiplier stored) unless a test says otherwise.
const ONE_TIME_ROW = { data: { floor: 199, multiplier: 2.2 } };
const globalDb = (overrides = {}) => (table) => ({
  where: () => ({ first: async () => (table === 'pricing_config' ? (overrides.pricing_config ?? ONE_TIME_ROW) : overrides[table]) }),
});

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
    mockUnattended.mockImplementation((price) => ({ priced: true, value: price() }));
    dbMock.mockImplementation(globalDb());
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

    test('the customer\'s own home (same address), or none named, reads the customer row as it is; a property that is not theirs is refused', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      const SAME_HOME = { ...RENTAL, is_primary: true, address_line1: '100 Home Ln', city: 'Bradenton', state: 'FL', zip: '34201' };
      await oneTimePestBookingPrice('cust-1', { conn: conn(PRIMARY_CUSTOMER, SAME_HOME), propertyId: 'prop-2' });
      expect(mockResolveContext.mock.calls[0][0].customer).toBe(PRIMARY_CUSTOMER);
      mockResolveContext.mockClear();
      await oneTimePestBookingPrice('cust-1', { conn: conn(PRIMARY_CUSTOMER) });
      expect(mockResolveContext.mock.calls[0][0].customer).toBe(PRIMARY_CUSTOMER);
      mockResolveContext.mockClear();
      expect(await oneTimePestBookingPrice('cust-1', { conn: conn(PRIMARY_CUSTOMER, undefined), propertyId: 'prop-x' })).toBeNull();
      expect(mockResolveContext).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('not an active property'));
    });

    test('two units at one street, with the unit in the street line, are different homes (codex #8607 r1)', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      const UNIT_CUSTOMER = { ...PRIMARY_CUSTOMER, address_line1: '100 Main St Apt 1', address_line2: null };
      const UNIT_TWO = { ...RENTAL, is_primary: true, address_line1: '100 Main St Apt 2', address_line2: null, city: 'Bradenton', zip: '34201' };
      await oneTimePestBookingPrice('cust-1', { conn: conn(UNIT_CUSTOMER, UNIT_TWO), propertyId: 'prop-2' });
      expect(mockResolveContext.mock.calls[0][0].customer).not.toBe(UNIT_CUSTOMER);
      expect(mockResolveContext.mock.calls[0][0].customer).toMatchObject({ address_line1: '100 Main St Apt 2' });
      mockResolveContext.mockClear();
      // The same unit written on line 2 for one and in the street line for the other is one home.
      const SAME_UNIT = { ...UNIT_TWO, address_line1: '100 Main St', address_line2: 'Apt 1' };
      await oneTimePestBookingPrice('cust-1', { conn: conn(UNIT_CUSTOMER, SAME_UNIT), propertyId: 'prop-2' });
      expect(mockResolveContext.mock.calls[0][0].customer).toBe(UNIT_CUSTOMER);
    });

    test('a selected primary property whose row names a DIFFERENT address than the customer row is read with its own facts, never the customer row\'s', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      const MOVED_PRIMARY = { ...RENTAL, is_primary: true };
      await oneTimePestBookingPrice('cust-1', { conn: conn(PRIMARY_CUSTOMER, MOVED_PRIMARY), propertyId: 'prop-2' });
      const arg = mockResolveContext.mock.calls[0][0];
      expect(arg.customer).not.toBe(PRIMARY_CUSTOMER);
      expect(arg.customer).toMatchObject({ address_line1: '200 Rental Rd', lot_sqft: 5000, palm_count: null });
      expect(arg.customer.lot_sqft).not.toBe(20000);
      // The same when no id is named and the primary row is the one that differs.
      mockResolveContext.mockClear();
      await oneTimePestBookingPrice('cust-1', { conn: conn(PRIMARY_CUSTOMER, MOVED_PRIMARY) });
      expect(mockResolveContext.mock.calls[0][0].customer.address_line1).toBe('200 Rental Rd');
    });

    test('a customer row with no street, or a different city or ZIP, is not "the same home"', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      const row = { ...RENTAL, is_primary: true, address_line1: '100 Home Ln', city: 'Bradenton', state: 'FL', zip: '34201' };
      for (const customer of [{ ...PRIMARY_CUSTOMER, address_line1: null }, { ...PRIMARY_CUSTOMER, city: 'Venice' }, { ...PRIMARY_CUSTOMER, zip: '34285' }, { ...PRIMARY_CUSTOMER, zip: null }]) {
        mockResolveContext.mockClear();
        await oneTimePestBookingPrice('cust-1', { conn: conn(customer, row), propertyId: 'prop-2' });
        expect(mockResolveContext.mock.calls[0][0].customer).not.toBe(customer);
        expect(mockResolveContext.mock.calls[0][0].customer.address_line1).toBe('100 Home Ln');
      }
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

  describe('the rates must come from the database', () => {
    test('a refresh that did not load, rows that were edited, or standard pest rows that are incomplete answer null', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      for (const reason of ['not_loaded', 'edited', 'rows']) {
        mockUnattended.mockImplementation(() => ({ priced: false, reason }));
        expect(await oneTimePestBookingPrice('cust-1', { conn: conn({ id: 'cust-1' }) })).toBeNull();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`(${reason})`));
      }
    });

    test('the one-time pest row must be stored with a floor and a multiplier', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      for (const row of [undefined, { data: {} }, { data: { floor: 199 } }, { data: { multiplier: 2.2 } }, { data: { floor: 0, multiplier: 2.2 } }]) {
        dbMock.mockImplementation((table) => ({ where: () => ({ first: async () => (table === 'pricing_config' ? row : undefined) }) }));
        expect(await oneTimePestBookingPrice('cust-1', { conn: conn({ id: 'cust-1' }) })).toBeNull();
      }
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('one-time pest settings row'));
      // A stored row as text (the column can come back as a string) counts too.
      dbMock.mockImplementation(globalDb({ pricing_config: { data: JSON.stringify({ floor: 199, multiplier: 2.2 }) } }));
      expect(await oneTimePestBookingPrice('cust-1', { conn: conn({ id: 'cust-1' }) })).toBe(lineFor(HOME).price);
    });

    test('a good load prices, and the price is computed inside the bridge\'s own step', async () => {
      mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
      expect(await oneTimePestBookingPrice('cust-1', { conn: conn({ id: 'cust-1' }) })).toBe(lineFor(HOME).price);
      expect(mockUnattended).toHaveBeenCalledTimes(1);
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
  beforeEach(() => {
    jest.clearAllMocks();
    mockUnattended.mockImplementation((price) => ({ priced: true, value: price() }));
    mockResolveContext.mockResolvedValue({ propertyInput: HOME, hasHomeSqFt: true });
    dbMock.mockImplementation((table) => ({ where: () => ({ first: async () => (table === 'pricing_config' ? ONE_TIME_ROW : { id: CUSTOMER }) }) }));
  });

  test("answers the system price for the customer's home as { price }", async () => {
    const { res } = await run({ customerId: CUSTOMER });
    expect(res.json).toHaveBeenCalledWith({ price: lineFor(HOME).price });
  });

  // A db handle for the route: `answer(table, cond, how)` gives the row ('first') or the list ('select') per table.
  const routeDb = (answer) => (table) => ({
    where: (cond) => ({
      first: async () => (table === 'pricing_config' ? ONE_TIME_ROW : answer(table, cond, 'first')),
      select: async () => answer(table, cond, 'select'),
    }),
  });
  const ESTIMATE = '5b8c9d10-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
  const HOME_ROW = { id: CUSTOMER, address_line1: '100 Home Ln', city: 'Bradenton', state: 'FL', zip: '34201', lot_sqft: 20000 };
  const property = (id, over = {}) => ({ id, customer_id: CUSTOMER, active: true, is_primary: false, address_line1: '200 Rental Rd', city: 'Parrish', state: 'FL', zip: '34219', lot_sqft: 5000, ...over });

  test('the property the modal names is the one priced; a malformed property id is refused', async () => {
    dbMock.mockImplementation(routeDb((table) => (table === 'customer_properties' ? property(PROPERTY) : HOME_ROW)));
    await run({ customerId: CUSTOMER, propertyId: PROPERTY });
    expect(mockResolveContext.mock.calls[0][0].customer).toMatchObject({ address_line1: '200 Rental Rd', lot_sqft: 5000 });
    mockResolveContext.mockClear();
    const bad = await run({ customerId: CUSTOMER, propertyId: 'nope' });
    expect(bad.next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(mockResolveContext).not.toHaveBeenCalled();
  });

  test('with no property chosen, the linked estimate\'s property is the one priced; the same rule as the save', async () => {
    dbMock.mockImplementation(routeDb((table) => {
      if (table === 'estimates') return { property_id: PROPERTY, address: '300 Quoted Ct, Venice, FL 34285' };
      if (table === 'customer_properties') return property(PROPERTY, { address_line1: '300 Quoted Ct', city: 'Venice', zip: '34285', lot_sqft: 7000 });
      return HOME_ROW;
    }));
    await run({ customerId: CUSTOMER, estimateId: ESTIMATE });
    expect(mockResolveContext.mock.calls[0][0].customer).toMatchObject({ address_line1: '300 Quoted Ct', lot_sqft: 7000 });
    // An explicit property choice still wins over the estimate's.
    mockResolveContext.mockClear();
    dbMock.mockImplementation(routeDb((table, cond) => {
      if (table === 'estimates') return { property_id: 'other-property' };
      if (table === 'customer_properties') return property(cond.id, { address_line1: cond.id === PROPERTY ? '200 Rental Rd' : '999 Wrong St' });
      return { id: CUSTOMER };
    }));
    await run({ customerId: CUSTOMER, propertyId: PROPERTY, estimateId: ESTIMATE });
    expect(mockResolveContext.mock.calls[0][0].customer.address_line1).toBe('200 Rental Rd');
  });

  describe('a linked estimate that quotes an address but names no property', () => {
    const answerWith = ({ estimateAddress, saved = [], estimateCustomer = null }) => routeDb((table, cond, how) => {
      if (table === 'estimates') return { property_id: null, address: estimateAddress, customer_id: estimateCustomer };
      if (table === 'customer_properties') return how === 'select' ? saved : saved.find((row) => row.id === cond.id) || undefined;
      return HOME_ROW;
    });

    test('an address that is the customer\'s own prices the primary home', async () => {
      dbMock.mockImplementation(answerWith({ estimateAddress: '100 Home Ln, Bradenton, FL 34201' }));
      const { res } = await run({ customerId: CUSTOMER, estimateId: ESTIMATE });
      expect(res.json).toHaveBeenCalledWith({ price: lineFor(HOME).price });
      expect(mockResolveContext.mock.calls[0][0].customer).toMatchObject({ address_line1: '100 Home Ln', lot_sqft: 20000 });
    });

    test('a different address that matches ONE saved property prices that property', async () => {
      const rental = property('prop-rental', { address_line1: '200 Rental Rd', address_line2: null, city: 'Parrish', zip: '34219' });
      dbMock.mockImplementation(answerWith({ estimateAddress: '200 Rental Rd, Parrish, FL 34219', saved: [rental, property('prop-other', { address_line1: '900 Other Ave' })] }));
      await run({ customerId: CUSTOMER, estimateId: ESTIMATE });
      expect(mockResolveContext.mock.calls[0][0].customer).toMatchObject({ address_line1: '200 Rental Rd', lot_sqft: 5000 });
    });

    test('a different address that matches no saved property, or more than one, shows NO price (never the primary\'s)', async () => {
      dbMock.mockImplementation(answerWith({ estimateAddress: '555 Unknown Way, Venice, FL 34285', saved: [property('prop-rental')] }));
      const none = await run({ customerId: CUSTOMER, estimateId: ESTIMATE });
      expect(none.res.json).toHaveBeenCalledWith({ price: null });
      const twin = property('prop-rental');
      dbMock.mockImplementation(answerWith({ estimateAddress: '200 Rental Rd, Parrish, FL 34219', saved: [twin, { ...twin, id: 'prop-twin' }] }));
      const several = await run({ customerId: CUSTOMER, estimateId: ESTIMATE });
      expect(several.res.json).toHaveBeenLastCalledWith({ price: null });
      expect(mockResolveContext).not.toHaveBeenCalled();
    });

    test('an estimate that belongs to another customer, or does not exist, shows no price', async () => {
      dbMock.mockImplementation(answerWith({ estimateAddress: '100 Home Ln, Bradenton, FL 34201', estimateCustomer: 'someone-else' }));
      expect((await run({ customerId: CUSTOMER, estimateId: ESTIMATE })).res.json).toHaveBeenCalledWith({ price: null });
      dbMock.mockImplementation(routeDb((table) => (table === 'estimates' ? undefined : HOME_ROW)));
      expect((await run({ customerId: CUSTOMER, estimateId: ESTIMATE })).res.json).toHaveBeenCalledWith({ price: null });
      expect(mockResolveContext).not.toHaveBeenCalled();
    });
  });

  test('a bad customer id is refused before any read', async () => {
    const { res, next } = await run({ customerId: 'nope' });
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});
