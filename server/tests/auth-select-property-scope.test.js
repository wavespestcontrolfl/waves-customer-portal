/**
 * /auth/properties?scope=saved and /auth/select-property { customerId, propertyId }
 * under GATE_APP_PROPERTY_SCOPE — and their gate-off behavior (today's).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/customer-credit', () => ({}));
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  authenticate: jest.fn((req, _res, next) => {
    req.customerId = 'cust-1';
    req.accountId = 'acct-1';
    req.customer = { id: 'cust-1', account_id: 'acct-1', active: true, first_name: 'Jordan', last_name: 'Rivera', profile_label: 'Primary', is_primary_profile: true };
    req.authSessionId = 'fam-1';
    req.propertyId = null;
    next();
  }),
  createRefreshSession: jest.fn(),
  generateToken: jest.fn(() => 'access-2'),
  reissueRefreshSessionForProperty: jest.fn(async () => ({ ok: true, familyId: 'fam-2', refreshToken: 'refresh-2' })),
  revokeCustomerRefreshSessions: jest.fn(),
  revokeRefreshSession: jest.fn(),
  rotateRefreshSession: jest.fn(),
}));
jest.mock('../services/account-properties', () => ({
  appPropertyScopeEnabled: jest.fn(() => false),
  accountSavedProperties: jest.fn(async () => ({
    properties: [{ key: 'cust-1:prop-a', customerId: 'cust-1', propertyId: 'prop-a' }, { key: 'cust-1:prop-b', customerId: 'cust-1', propertyId: 'prop-b' }],
    selected: { key: 'cust-1:prop-a', customerId: 'cust-1', propertyId: 'prop-a' },
  })),
}));

const express = require('express');
const db = require('../models/db');
const { generateToken, reissueRefreshSessionForProperty } = require('../middleware/auth');
const { appPropertyScopeEnabled, accountSavedProperties } = require('../services/account-properties');
const router = require('../routes/auth');

const TARGET = { id: '11111111-1111-4111-8111-111111111111', account_id: 'acct-1', active: true, deleted_at: null, first_name: 'Jordan', last_name: 'Rivera', profile_label: 'Primary', is_primary_profile: true };
const PROPERTY_ID = '22222222-2222-4222-8222-222222222222';

function chain(rows) {
  const c = {};
  for (const m of ['where', 'whereNull', 'orWhere', 'orderBy', 'select']) {
    c[m] = jest.fn((arg) => { if (typeof arg === 'function') arg.call(c, c); return c; });
  }
  c.first = jest.fn(async () => rows[0]);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

async function withServer(callback) {
  const app = express();
  app.use(express.json());
  app.use('/auth', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(baseUrl, body) {
  return fetch(`${baseUrl}/auth/select-property`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('saved-property session switch and list', () => {
  let tables;
  beforeEach(() => {
    jest.clearAllMocks();
    tables = {};
    db.mockImplementation((table) => {
      if (!(table in tables)) throw new Error(`unexpected table ${table}`);
      return chain(tables[table]);
    });
  });

  test('gate on: switching to a saved property on the same profile re-issues both tokens with the claim', async () => {
    appPropertyScopeEnabled.mockReturnValue(true);
    tables.customers = [TARGET];
    tables.customer_properties = [{ id: PROPERTY_ID, customer_id: TARGET.id, active: true, is_primary: false }];
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { customerId: TARGET.id, propertyId: PROPERTY_ID, refreshToken: 'refresh-1' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ token: 'access-2', refreshToken: 'refresh-2', selected: { customerId: TARGET.id, propertyId: PROPERTY_ID } });
      expect(reissueRefreshSessionForProperty).toHaveBeenCalledWith('refresh-1', TARGET.id, 'acct-1', 'cust-1', 'fam-1', { propertyId: PROPERTY_ID });
      expect(generateToken).toHaveBeenCalledWith(TARGET.id, 'acct-1', 'fam-2', { propertyId: PROPERTY_ID });
    });
  });

  test('gate on: a property that is not the target profile\'s (or inactive) is a 404 and mints nothing', async () => {
    appPropertyScopeEnabled.mockReturnValue(true);
    tables.customers = [TARGET];
    tables.customer_properties = [];
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { customerId: TARGET.id, propertyId: PROPERTY_ID, refreshToken: 'refresh-1' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Property not found' });
      expect(reissueRefreshSessionForProperty).not.toHaveBeenCalled();
      expect(generateToken).not.toHaveBeenCalled();
    });
  });

  test('gate on: omitting propertyId selects the profile primary — the claim is explicitly cleared', async () => {
    appPropertyScopeEnabled.mockReturnValue(true);
    tables.customers = [TARGET];
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { customerId: TARGET.id, refreshToken: 'refresh-1' });
      expect(res.status).toBe(200);
      expect((await res.json()).selected).toEqual({ customerId: TARGET.id, propertyId: null });
      expect(reissueRefreshSessionForProperty).toHaveBeenCalledWith('refresh-1', TARGET.id, 'acct-1', 'cust-1', 'fam-1', { propertyId: null });
      expect(generateToken).toHaveBeenCalledWith(TARGET.id, 'acct-1', 'fam-2', { propertyId: null });
    });
  });

  test('gate off: propertyId is ignored, the property table is never read, and the response is today\'s shape', async () => {
    appPropertyScopeEnabled.mockReturnValue(false);
    tables.customers = [TARGET];
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { customerId: TARGET.id, propertyId: PROPERTY_ID, refreshToken: 'refresh-1' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).not.toHaveProperty('selected');
      expect(body).toMatchObject({ token: 'access-2', refreshToken: 'refresh-2' });
      expect(db.mock.calls.map((c) => c[0])).not.toContain('customer_properties');
      expect(reissueRefreshSessionForProperty).toHaveBeenCalledWith('refresh-1', TARGET.id, 'acct-1', 'cust-1', 'fam-1', { propertyId: null });
      expect(generateToken).toHaveBeenCalledWith(TARGET.id, 'acct-1', 'fam-2', { propertyId: null });
    });
  });

  test('GET /auth/properties?scope=saved answers the unified list only while the gate is on', async () => {
    tables.customers = [TARGET];
    await withServer(async (baseUrl) => {
      appPropertyScopeEnabled.mockReturnValue(true);
      let res = await fetch(`${baseUrl}/auth/properties?scope=saved`);
      expect(res.status).toBe(200);
      let body = await res.json();
      expect(body.scope).toBe('saved');
      expect(body.properties.map((p) => p.key)).toEqual(['cust-1:prop-a', 'cust-1:prop-b']);
      expect(body.selected).toEqual({ key: 'cust-1:prop-a', customerId: 'cust-1', propertyId: 'prop-a' });
      expect(accountSavedProperties).toHaveBeenCalledTimes(1);

      appPropertyScopeEnabled.mockReturnValue(false);
      res = await fetch(`${baseUrl}/auth/properties?scope=saved`);
      expect(res.status).toBe(200);
      body = await res.json();
      // Today's profile list: keyed by customer id, no scope marker.
      expect(body).not.toHaveProperty('scope');
      expect(body.properties.map((p) => p.id)).toEqual([TARGET.id]);
      expect(accountSavedProperties).toHaveBeenCalledTimes(1);
    });
  });
});
