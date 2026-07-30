// GOOGLE key must exist before geocoder.js is required — it captures the env at module load.
process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'test-key';

const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);

const { sweepUngeocodedCustomers } = require('../services/geocoder');

function installDb({ listRows, customersById }) {
  const updates = [];
  mockDb.mockImplementation(() => {
    const chain = {
      whereNull: jest.fn(() => chain),
      orWhereNull: jest.fn(() => chain),
      whereNotNull: jest.fn(() => chain),
      where: jest.fn((arg) => {
        if (typeof arg === 'function') {
          arg.call(chain);
        } else if (arg && arg.id) {
          chain._id = arg.id;
        }
        return chain;
      }),
      orderBy: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      select: jest.fn(async () => listRows),
      first: jest.fn(async () => customersById[chain._id] || null),
      update: jest.fn(async (patch) => {
        updates.push({ id: chain._id, patch });
        return 1;
      }),
    };
    return chain;
  });
  return updates;
}

function mockGoogle(status, location) {
  global.fetch = jest.fn(async () => ({
    json: async () => (status === 'OK'
      ? { status: 'OK', results: [{ geometry: { location } }] }
      : { status, results: [] }),
  }));
}

describe('sweepUngeocodedCustomers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('geocodes coordinate-less customers and writes lat/lng', async () => {
    const updates = installDb({
      listRows: [{ id: 'cust-1' }, { id: 'cust-2' }],
      customersById: {
        'cust-1': { id: 'cust-1', latitude: null, longitude: null, address_line1: '1 Sweep Test Ln', city: 'Bradenton', state: 'FL', zip: '34211' },
        'cust-2': { id: 'cust-2', latitude: null, longitude: null, address_line1: '2 Sweep Test Ln', city: 'Parrish', state: 'FL', zip: '34219' },
      },
    });
    mockGoogle('OK', { lat: 27.5, lng: -82.4 });

    const result = await sweepUngeocodedCustomers({ limit: 25 });

    expect(result).toEqual({ checked: 2, geocoded: 2, unresolved: 0 });
    expect(updates).toHaveLength(2);
    expect(updates[0].patch.latitude).toBe(27.5);
    expect(updates[0].patch.longitude).toBe(-82.4);
  });

  it('counts un-geocodable addresses as unresolved without writing', async () => {
    const updates = installDb({
      listRows: [{ id: 'cust-3' }],
      customersById: {
        'cust-3': { id: 'cust-3', latitude: null, longitude: null, address_line1: 'Nowhere At All', city: 'Bradenton', state: 'FL', zip: '34211' },
      },
    });
    mockGoogle('ZERO_RESULTS');

    const result = await sweepUngeocodedCustomers();

    expect(result).toEqual({ checked: 1, geocoded: 0, unresolved: 1 });
    expect(updates).toHaveLength(0);
  });

  it('returns zero counts when no customers are missing coordinates', async () => {
    installDb({ listRows: [], customersById: {} });
    mockGoogle('OK', { lat: 0, lng: 0 });

    const result = await sweepUngeocodedCustomers();

    expect(result).toEqual({ checked: 0, geocoded: 0, unresolved: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
