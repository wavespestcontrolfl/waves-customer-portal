/**
 * The Home tab's pet-name ask (GATE_PET_NAME_TEXT): GET /api/property/pet-name-ask answers { ask: true } only while
 * the pet-named visit text is live, the customer is a WaveGuard member and no name the text could use is on file.
 * Gate off or a non-member answers { ask: false } without reading the database.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const MEMBER = { id: 'cust-1', waveguard_tier: 'Gold', lawn_type: null };
const mockSession = { customer: MEMBER };
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = mockSession.customer;
    next();
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/termite-stations', () => ({}));
jest.mock('../services/irrigation-weekly-email', () => ({ hasLawnServiceEvidence: jest.fn(), hasIrrigationEmailOptIn: jest.fn(async () => false) }));
jest.mock('../services/irrigation-app-plan', () => ({ appPlanEnabled: jest.fn(() => false), loadCustomerWateringPlan: jest.fn() }));

// One in-memory property_preferences row (null = the customer has none yet).
jest.mock('../models/db', () => {
  const state = { row: null };
  const dbFn = jest.fn((table) => {
    if (table !== 'property_preferences') throw new Error(`Unexpected table ${table}`);
    const q = {};
    q.where = jest.fn(() => q);
    q.first = jest.fn(async () => state.row);
    return q;
  });
  dbFn._state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');

const app = express();
app.use('/api/property', require('../routes/property'));
app.use((_err, _req, res, _next) => res.status(500).json({ error: 'Unavailable' }));

let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  jest.clearAllMocks();
  db._state.row = null;
  mockSession.customer = MEMBER;
  process.env.GATE_PET_NAME_TEXT = 'true';
});
afterEach(() => { delete process.env.GATE_PET_NAME_TEXT; });

const get = async () => (await fetch(`${base}/api/property/pet-name-ask`)).json();
const withPets = (pets) => { db._state.row = { id: 'pref-1', customer_id: 'cust-1', pets_structured: JSON.stringify(pets) }; };

describe('GET /api/property/pet-name-ask', () => {
  test('a member with no preferences row, or no pets on file: asked', async () => {
    expect(await get()).toEqual({ ask: true });
    withPets([]);
    expect(await get()).toEqual({ ask: true });
  });

  test('a member whose only pets the text cannot name (no name, a description, an Other pet): asked', async () => {
    withPets([{ name: '', type: 'Dog' }, { name: 'dog', type: 'Dog' }, { name: 'Kiwi', type: 'Other' }]);
    expect(await get()).toEqual({ ask: true });
  });

  test('a named dog or cat on file: not asked', async () => {
    withPets([{ name: 'Biscuit', type: 'Dog' }]);
    expect(await get()).toEqual({ ask: false });
    withPets([{ name: 'Luna', type: 'Cat', indoor: 'Indoor' }]);
    expect(await get()).toEqual({ ask: false });
  });

  test('a non-member: not asked, and no read; a legacy member with a monthly rate: asked', async () => {
    mockSession.customer = { id: 'cust-1', waveguard_tier: null, monthly_rate: 0 };
    expect(await get()).toEqual({ ask: false });
    expect(db).not.toHaveBeenCalled();
    mockSession.customer = { id: 'cust-1', waveguard_tier: null, monthly_rate: 49 };
    expect(await get()).toEqual({ ask: true });
  });

  test('gate off (unset or anything but exactly "true"): not asked, and no read', async () => {
    for (const value of [undefined, '1', 'TRUE']) {
      if (value === undefined) delete process.env.GATE_PET_NAME_TEXT;
      else process.env.GATE_PET_NAME_TEXT = value;
      withPets([]);
      expect(await get()).toEqual({ ask: false });
    }
    expect(db).not.toHaveBeenCalled();
  });

  test('a failed read: not asked, never an error', async () => {
    db.mockImplementationOnce(() => { throw new Error('db down'); });
    const res = await fetch(`${base}/api/property/pet-name-ask`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ask: false });
  });
});
