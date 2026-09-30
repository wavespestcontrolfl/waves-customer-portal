// /book offer location (Codex #4992 P1). createSelfBooking commits an existing
// customer's booking at its stored pin, else a staff-verified pin or the
// canonical geocode, and refuses an offer signed on any other grid cell — so
// /availability and /find-slots must build that customer's offers on the same
// pin (resolveOfferCoords → customerBookingLocation), or every retry of a
// customer whose verified pin the address geocoder never returns is refused.
// Table-keyed db mock: `.first()` answers firstResults[table], an awaited
// chain answers listResults[table].
const firstResults = {};
const listResults = {};
jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = { filters: {} };
    // Object-form where() filters are remembered so a row the query's own
    // filter would exclude (active: true vs an inactive row) is not returned.
    q.where = (arg) => {
      if (typeof arg === 'function') arg.call(q, q);
      else if (arg && typeof arg === 'object') Object.assign(q.filters, arg);
      return q;
    };
    for (const m of ['whereNot', 'andWhere', 'whereIn', 'whereNull', 'whereRaw', 'andWhereRaw', 'orWhere', 'orWhereRaw', 'select', 'limit']) {
      q[m] = (arg) => {
        if (typeof arg === 'function') arg.call(q, q);
        return q;
      };
    }
    q.first = async () => {
      const row = firstResults[table] !== undefined ? firstResults[table] : null;
      if (row && q.filters.active === true && row.active === false) return null;
      return row;
    };
    q.then = (onOk, onErr) => Promise.resolve(listResults[table] || []).then(onOk, onErr);
    return q;
  };
  const dbFn = jest.fn((table) => mkChain(table));
  dbFn.raw = (sql) => sql;
  return dbFn;
});

const db = require('../models/db');
const geocoder = require('../services/geocoder');
const { resolveOfferCoords } = require('../routes/booking')._internals;

const CUSTOMER_ID = '5b8d1c9e-4a2f-4b6e-9c3d-8e7f6a5b4c3d';
const PROPERTY_B_ID = '7d0f3b2a-6c4e-4d8f-9a1b-2c3d4e5f6a7b';
const ESTIMATE_ID = '6c9e2d0f-5b3a-4c7f-8d4e-9f0a7b6c5d4e';
const ADDRESS = { address_line1: '123 Test Ave', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34236' };
const TYPED = '123 Test Ave, Sarasota, FL 34236';
const CALLER = { lat: '27.3', lng: '-82.5' };
const customerRow = (pin = {}) => ({
  id: CUSTOMER_ID, latitude: null, longitude: null, ...ADDRESS, ...pin,
});

let savedReviewGate;
beforeEach(() => {
  savedReviewGate = process.env.GATE_GEOCODE_REVIEW;
  process.env.GATE_GEOCODE_REVIEW = 'true';
  db.mockClear();
});
afterEach(() => {
  for (const key of Object.keys(firstResults)) delete firstResults[key];
  for (const key of Object.keys(listResults)) delete listResults[key];
  if (savedReviewGate === undefined) delete process.env.GATE_GEOCODE_REVIEW;
  else process.env.GATE_GEOCODE_REVIEW = savedReviewGate;
  jest.restoreAllMocks();
});

test('an estimate\'s coordinate-less customer is offered at its staff-verified pin — over caller coordinates, never echoed exactly', async () => {
  const verifiedPin = { lat: 27.40123, lng: -82.50123 };
  firstResults.estimates = { customer_id: CUSTOMER_ID };
  firstResults.customers = customerRow();
  listResults.customer_geocode_reviews = [{
    customer_id: CUSTOMER_ID, status: 'verified', latitude: verifiedPin.lat, longitude: verifiedPin.lng,
    address_snapshot: [ADDRESS.address_line1, ADDRESS.address_line2, ADDRESS.city, ADDRESS.state, ADDRESS.zip],
  }];
  const geocode = jest.spyOn(geocoder, 'geocodeAddress');

  await expect(resolveOfferCoords({ ...CALLER, address: TYPED, estimate_id: ESTIMATE_ID }))
    .resolves.toEqual({ ...verifiedPin, disclosable: false });
  expect(geocode).not.toHaveBeenCalled();
});

test('a typed address that uniquely matches a returning customer is offered at that customer\'s stored pin', async () => {
  const storedPin = { lat: 27.35, lng: -82.52 };
  listResults.customers = [{ id: CUSTOMER_ID, ...ADDRESS }];
  firstResults.customers = customerRow({ latitude: storedPin.lat, longitude: storedPin.lng });

  await expect(resolveOfferCoords({ ...CALLER, address: TYPED }))
    .resolves.toEqual({ ...storedPin, disclosable: false });
});

test('a bearer-proven account supplied under customers-only wins over an identical global address and caller coordinates', async () => {
  const otherAccountId = '8e1f4c3b-7d5a-4e9f-a2b3-4d5e6f7a8b9c';
  const accountPin = { lat: 27.40123, lng: -82.50123 };
  const otherPin = { lat: 27.49999, lng: -82.59999 };
  const authedCustomer = customerRow({
    account_id: CUSTOMER_ID,
    address_line2: 'Apt A',
  });
  listResults.customers = [
    authedCustomer,
    customerRow({ id: otherAccountId, account_id: otherAccountId, address_line2: 'Apt A' }),
  ];
  listResults.customer_geocode_reviews = [
    {
      customer_id: CUSTOMER_ID, status: 'verified',
      latitude: accountPin.lat, longitude: accountPin.lng,
      address_snapshot: [ADDRESS.address_line1, 'Apt A', ADDRESS.city, ADDRESS.state, ADDRESS.zip],
    },
    {
      customer_id: otherAccountId, status: 'verified',
      latitude: otherPin.lat, longitude: otherPin.lng,
      address_snapshot: [ADDRESS.address_line1, 'Apt A', ADDRESS.city, ADDRESS.state, ADDRESS.zip],
    },
  ];

  await expect(resolveOfferCoords({
    ...CALLER,
    address: TYPED,
    unit: 'Apt A',
    authedCustomer,
    // Body/query customer identity is intentionally ignored; only the
    // middleware-resolved bearer row reaches resolveOfferCoords.
    customer_id: otherAccountId,
  })).resolves.toEqual({ ...accountPin, disclosable: false });
  await expect(resolveOfferCoords({ ...CALLER, address: TYPED, unit: 'Apt A' }))
    .resolves.toEqual({ ...CALLER, lat: 27.3, lng: -82.5, disclosable: true });
});

test('public identity admits a new property, while a supplied customers-only bearer requires an account match', async () => {
  const authedCustomer = customerRow({
    account_id: CUSTOMER_ID,
    address_line1: '999 Existing Customer Road',
  });
  listResults.customers = [];

  // Customers-only off: confirmation still admits a public/new property, so
  // an unrelated ambient portal session must not suppress its public offer.
  await expect(resolveOfferCoords({
    ...CALLER,
    address: TYPED,
    authedCustomer: null,
  })).resolves.toEqual({ lat: 27.3, lng: -82.5, disclosable: true });

  // Customers-only on: confirmation binds the bearer account and refuses
  // this address, so offer construction fails closed on the same boundary.
  await expect(resolveOfferCoords({
    ...CALLER,
    address: TYPED,
    authedCustomer,
  })).resolves.toEqual({ lat: null, lng: null, disclosable: false });
});

test('a dedicated unit only reuses the pin for the matching household', async () => {
  const storedPin = { lat: 27.35, lng: -82.52 };
  listResults.customers = [{ id: CUSTOMER_ID, ...ADDRESS, address_line2: 'Apt A' }];
  firstResults.customers = customerRow({
    address_line2: 'Apt A', latitude: storedPin.lat, longitude: storedPin.lng,
  });

  await expect(resolveOfferCoords({ ...CALLER, address: TYPED, unit: 'Apt A' }))
    .resolves.toEqual({ ...storedPin, disclosable: false });
  await expect(resolveOfferCoords({ ...CALLER, address: TYPED, unit: 'Apt B' }))
    .resolves.toEqual({ lat: 27.3, lng: -82.5, disclosable: true });
});

test('an estimate identity follows the typed address to another property on the same account', async () => {
  const propertyAPin = { lat: 27.35, lng: -82.52 };
  const propertyBPin = { lat: 27.401, lng: -82.501 };
  firstResults.estimates = { customer_id: CUSTOMER_ID };
  firstResults.customers = customerRow({
    account_id: CUSTOMER_ID, address_line2: 'Apt A',
    latitude: propertyAPin.lat, longitude: propertyAPin.lng,
  });
  listResults.customers = [{
    ...customerRow({
      id: PROPERTY_B_ID, account_id: CUSTOMER_ID, address_line2: 'Apt B',
      latitude: propertyBPin.lat, longitude: propertyBPin.lng,
    }),
  }];

  await expect(resolveOfferCoords({
    ...CALLER, address: TYPED, unit: 'Apt B', estimate_id: ESTIMATE_ID,
  })).resolves.toEqual({ ...propertyBPin, disclosable: false });
});

test('structured locality selects the same-street/unit property in the submitted ZIP', async () => {
  const propertyAPin = { lat: 27.35, lng: -82.52 };
  const propertyBPin = { lat: 26.64, lng: -81.87 };
  firstResults.estimates = { customer_id: CUSTOMER_ID };
  firstResults.customers = customerRow({
    account_id: CUSTOMER_ID, address_line2: 'Apt A', zip: '34236',
    latitude: propertyAPin.lat, longitude: propertyAPin.lng,
  });
  listResults.customers = [{
    ...customerRow({
      id: PROPERTY_B_ID, account_id: CUSTOMER_ID, address_line2: 'Apt A',
      city: 'Fort Myers', zip: '33901', latitude: propertyBPin.lat, longitude: propertyBPin.lng,
    }),
  }];

  await expect(resolveOfferCoords({
    address: ADDRESS.address_line1,
    city: 'Fort Myers',
    state: 'FL',
    zip: '33901',
    unit: 'Apt A',
    estimate_id: ESTIMATE_ID,
  })).resolves.toEqual({ ...propertyBPin, disclosable: false });
});

test('street-only offer input retains structured locality for geocoding', async () => {
  listResults.customers = [];
  const savedKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'fixture-key';
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
    json: async () => ({ status: 'OK', results: [{ geometry: { location: { lat: 27.34, lng: -82.53 } } }] }),
  });
  try {
    await expect(resolveOfferCoords({
      address: ADDRESS.address_line1,
      city: ADDRESS.city,
      state: ADDRESS.state,
      zip: ADDRESS.zip,
    })).resolves.toEqual({ lat: 27.34, lng: -82.53, disclosable: true });
    const requested = new URL(fetchMock.mock.calls[0][0]);
    expect(requested.searchParams.get('address')).toBe('123 Test Ave, Sarasota, FL 34236');
  } finally {
    fetchMock.mockRestore();
    if (savedKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = savedKey;
  }
});

test('an estimate identity with no matching account property never falls through to caller coordinates', async () => {
  firstResults.estimates = { customer_id: CUSTOMER_ID };
  firstResults.customers = customerRow({ address_line1: '999 Other Road' });
  listResults.customers = [];
  const geocode = jest.spyOn(geocoder, 'geocodeAddress');
  const ambientAuthedCustomer = customerRow({
    id: PROPERTY_B_ID,
    account_id: PROPERTY_B_ID,
    address_line1: ADDRESS.address_line1,
  });

  await expect(resolveOfferCoords({
    ...CALLER,
    address: TYPED,
    estimate_id: ESTIMATE_ID,
    authedCustomer: ambientAuthedCustomer,
  }))
    .resolves.toEqual({ lat: null, lng: null, disclosable: false });
  expect(geocode).not.toHaveBeenCalled();
});

test('a new visitor (no estimate, no matching customer) keeps the caller\'s own coordinates, disclosable', async () => {
  listResults.customers = [];

  await expect(resolveOfferCoords({ ...CALLER, address: TYPED }))
    .resolves.toEqual({ lat: 27.3, lng: -82.5, disclosable: true });
});

test('a malformed estimate_id is never queried', async () => {
  listResults.customers = [];

  await expect(resolveOfferCoords({ ...CALLER, address: TYPED, estimate_id: 'not-a-uuid' }))
    .resolves.toEqual({ lat: 27.3, lng: -82.5, disclosable: true });
  expect(db.mock.calls.map(([table]) => table)).not.toContain('estimates');
});

// The texting AI's OPEN TIMES for a new visit (GATE_SMS_OFFERS_SCHEDULER):
// what /book would offer this customer for one funnel service, or nothing
// when /book has nothing to commit against.
describe('availabilityForExistingCustomer — refusals before any picker runs', () => {
  const { availabilityForExistingCustomer } = require('../routes/booking')._internals;

  test('no customer id or a service the funnel does not book (empty / rodent bait / unknown) → null with no lookup at all', async () => {
    await expect(availabilityForExistingCustomer({ customerId: null, serviceKey: 'pest_control' })).resolves.toBeNull();
    for (const serviceKey of ['', null, 'rodent_bait', 'termite_bait', 'nonsense']) {
      await expect(availabilityForExistingCustomer({ customerId: CUSTOMER_ID, serviceKey })).resolves.toBeNull();
    }
    expect(db).not.toHaveBeenCalled();
  });

  test('/book off (the selfBooking gate) → null before the customer is even loaded', async () => {
    jest.spyOn(require('../config/feature-gates'), 'isEnabled').mockImplementation((gate) => gate !== 'selfBooking');
    await expect(availabilityForExistingCustomer({ customerId: CUSTOMER_ID, serviceKey: 'pest_control' })).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('customer gone, or no resolvable pin (no coordinates, address does not geocode, staff review holds it) → null', async () => {
    await expect(availabilityForExistingCustomer({ customerId: CUSTOMER_ID, serviceKey: 'pest_control' })).resolves.toBeNull();
    firstResults.customers = customerRow();
    jest.spyOn(geocoder, 'geocodeAddress').mockResolvedValue(null);
    await expect(availabilityForExistingCustomer({ customerId: CUSTOMER_ID, serviceKey: 'lawn_care' })).resolves.toBeNull();
  });

  // The bearer resolver (middleware/auth.js resolveBearerCustomer) only signs
  // in { active: true } customers — an inactive one could not commit a /book
  // offer, so the texting AI must not be handed one.
  test('an INACTIVE customer (active = false) → null: the lookup requires active: true, and no pin is even resolved', async () => {
    firstResults.customers = customerRow({ latitude: 27.3, longitude: -82.5, active: false });
    const geocode = jest.spyOn(geocoder, 'geocodeAddress').mockResolvedValue({ lat: 27.3, lng: -82.5 });
    await expect(availabilityForExistingCustomer({ customerId: CUSTOMER_ID, serviceKey: 'pest_control' })).resolves.toBeNull();
    expect(geocode).not.toHaveBeenCalled();
    const customersQuery = db.mock.results.map((r, i) => ({ table: db.mock.calls[i][0], chain: r.value })).find((c) => c.table === 'customers');
    expect(customersQuery.chain.filters).toEqual({ id: CUSTOMER_ID, active: true });
  });
});
