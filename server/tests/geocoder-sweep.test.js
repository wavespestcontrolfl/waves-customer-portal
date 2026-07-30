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
      whereRaw: jest.fn(() => chain),
      where: jest.fn((arg) => {
        if (typeof arg === 'function') {
          arg.call(chain);
        } else if (arg && typeof arg === 'object' && arg.id) {
          chain._id = arg.id;
        }
        return chain;
      }),
      orderBy: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      modify: jest.fn((cb) => {
        cb(chain);
        return chain;
      }),
      whereNotIn: jest.fn((col, ids) => {
        chain._excluded = ids;
        return chain;
      }),
      whereIn: jest.fn((col, ids) => {
        chain._whereInIds = ids;
        return chain;
      }),
      select: jest.fn(async () => {
        if (chain._whereInIds) {
          return chain._whereInIds.map((id) => customersById[id]).filter(Boolean);
        }
        return listRows.filter((r) => !(chain._excluded || []).includes(r.id));
      }),
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
    const customersById = {
      'cust-3': { id: 'cust-3', latitude: null, longitude: null, address_line1: 'Nowhere At All', city: 'Bradenton', state: 'FL', zip: '34211' },
    };
    const updates = installDb({
      listRows: [{ id: 'cust-3' }],
      customersById,
    });
    mockGoogle('ZERO_RESULTS');

    const result = await sweepUngeocodedCustomers();

    expect(result).toEqual({ checked: 1, geocoded: 0, unresolved: 1 });
    expect(updates).toHaveLength(0);

    // Unresolved ids are skipped on later sweeps so they can't starve the
    // batch — the same candidate list now yields nothing to check.
    const second = await sweepUngeocodedCustomers();
    expect(second).toEqual({ checked: 0, geocoded: 0, unresolved: 0 });

    // But an address EDIT lifts the exclusion — the corrected address gets
    // a fresh attempt on the next sweep.
    customersById['cust-3'].address_line1 = '3 Corrected Ave';
    mockGoogle('OK', { lat: 27.7, lng: -82.3 });
    const third = await sweepUngeocodedCustomers();
    expect(third).toEqual({ checked: 1, geocoded: 1, unresolved: 0 });
    expect(updates).toHaveLength(1);
  });

  it('retries transient failures on later sweeps instead of excluding them', async () => {
    const updates = installDb({
      listRows: [{ id: 'cust-4' }],
      customersById: {
        'cust-4': { id: 'cust-4', latitude: null, longitude: null, address_line1: '4 Sweep Test Ln', city: 'Venice', state: 'FL', zip: '34293' },
      },
    });
    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    });

    const first = await sweepUngeocodedCustomers();
    expect(first).toEqual({ checked: 1, geocoded: 0, unresolved: 1 });
    expect(updates).toHaveLength(0);

    // Google recovers — the same customer is still eligible and resolves.
    mockGoogle('OK', { lat: 27.6, lng: -82.5 });
    const second = await sweepUngeocodedCustomers();
    expect(second).toEqual({ checked: 1, geocoded: 1, unresolved: 0 });
    expect(updates).toHaveLength(1);
  });

  it('repairs half-set coordinates (latitude present, longitude null)', async () => {
    const updates = installDb({
      listRows: [{ id: 'cust-5' }],
      customersById: {
        'cust-5': { id: 'cust-5', latitude: '27.1000000', longitude: null, address_line1: '5 Sweep Test Ln', city: 'Palmetto', state: 'FL', zip: '34221' },
      },
    });
    mockGoogle('OK', { lat: 27.11, lng: -82.55 });

    const result = await sweepUngeocodedCustomers();

    expect(result).toEqual({ checked: 1, geocoded: 1, unresolved: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.latitude).toBe(27.11);
    expect(updates[0].patch.longitude).toBe(-82.55);
  });

  it('returns zero counts when no customers are missing coordinates', async () => {
    installDb({ listRows: [], customersById: {} });
    mockGoogle('OK', { lat: 0, lng: 0 });

    const result = await sweepUngeocodedCustomers();

    expect(result).toEqual({ checked: 0, geocoded: 0, unresolved: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
