process.env.GOOGLE_API_KEY = 'synthetic-geocoder-key';

const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn() }));

const { regeocodeCustomerAddressGuarded } = require('../services/geocoder');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function geocodeResponse(location) {
  return { json: async () => ({ status: 'OK', results: [{
    types: ['street_address'], geometry: { location, location_type: 'ROOFTOP' },
  }] }) };
}

// Evaluate every SQL predicate and return detached read snapshots so a
// deferred provider response cannot accidentally observe later fixture edits.
function installDb(customer, property) {
  const tables = { customers: [customer], customer_properties: [property] };
  mockDb.mockImplementation((table) => {
    const predicates = [];
    const rows = () => tables[table].filter((row) => predicates.every((test) => test(row)));
    const query = {
      where(key, value) {
        const fields = typeof key === 'object' ? key : { [key]: value };
        predicates.push((row) => Object.entries(fields).every(([field, expected]) => row[field] === expected));
        return query;
      },
      whereNull(key) { predicates.push((row) => row[key] == null); return query; },
      select() { return query; },
      async first() { const row = rows()[0]; return row ? { ...row } : undefined; },
      async update(patch) { const matched = rows(); matched.forEach((row) => Object.assign(row, patch)); return matched.length; },
    };
    return query;
  });
  mockDb.transaction = jest.fn(async (callback) => callback(mockDb));
}

describe('customer address geocode completion order', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; jest.clearAllMocks(); });

  it('keeps the newer address coordinates on both customer and primary property', async () => {
    const customer = { id: 'customer-race', address_line1: '100 Synthetic Race Lane',
      address_line2: null, city: 'Bradenton', state: 'FL', zip: '34211', latitude: null, longitude: null };
    const property = { customer_id: customer.id, is_primary: true, active: true, latitude: null, longitude: null };
    installDb(customer, property);
    const oldResponse = deferred();
    const oldStarted = deferred();
    global.fetch = jest.fn()
      .mockImplementationOnce(() => { oldStarted.resolve(); return oldResponse.promise; })
      .mockResolvedValueOnce(geocodeResponse({ lat: 27.5, lng: -82.4 }));

    const older = regeocodeCustomerAddressGuarded(customer.id);
    await oldStarted.promise;
    customer.address_line1 = '200 Synthetic Race Lane';
    expect(await regeocodeCustomerAddressGuarded(customer.id)).toEqual({ lat: 27.5, lng: -82.4 });
    oldResponse.resolve(geocodeResponse({ lat: 27.4, lng: -82.3 }));
    expect(await older).toBeNull();

    expect(customer).toMatchObject({ address_line1: '200 Synthetic Race Lane', latitude: 27.5, longitude: -82.4 });
    expect(property).toMatchObject({ latitude: 27.5, longitude: -82.4 });
  });

  it('leaves coordinates empty when the address changes while its geocode is pending', async () => {
    const customer = { id: 'customer-pending', address_line1: '300 Synthetic Pending Lane',
      address_line2: null, city: 'Bradenton', state: 'FL', zip: '34211', latitude: null, longitude: null };
    const property = { customer_id: customer.id, is_primary: true, active: true, latitude: null, longitude: null };
    installDb(customer, property);
    const response = deferred();
    const started = deferred();
    global.fetch = jest.fn(() => { started.resolve(); return response.promise; });
    const pending = regeocodeCustomerAddressGuarded(customer.id);
    await started.promise;
    customer.address_line1 = '400 Synthetic Pending Lane';
    response.resolve(geocodeResponse({ lat: 27.4, lng: -82.3 }));

    expect(await pending).toBeNull();
    expect(customer.latitude).toBeNull();
    expect(property.latitude).toBeNull();
  });
});
