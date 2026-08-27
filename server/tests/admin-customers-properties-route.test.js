/**
 * POST /admin/customers/:id/properties — the admin "Add service address"
 * path. customer_properties.state is varchar(2): a full state name must be
 * a 400 validation error, never a PostgreSQL insert failure surfaced as a
 * generic save error; the code is uppercased before it reaches the service.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const db = () => { throw new Error('db must not be touched by this route test'); };
  db.transaction = jest.fn();
  db.schema = { hasTable: jest.fn(async () => false) };
  return db;
});
const mockProps = {
  completePrimaryFromCall: jest.fn(async () => ({})),
  ensurePrimaryProperty: jest.fn(async () => ({})),
  recordCallProperty: jest.fn(async () => ({ created: true, propertyId: 'p-new' })),
  listProperties: jest.fn(async () => [{ id: 'p1', is_primary: true }, { id: 'p-new', is_primary: false }]),
  OCCUPANCY_TYPES: ['owner_occupied', 'rental_investment', 'commercial', 'seasonal', 'vacant', 'unknown'],
};
jest.mock('../services/customer-properties', () => mockProps);

const express = require('express');
const router = require('../routes/admin-customers');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/customers', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

const post = (baseUrl, body) => fetch(`${baseUrl}/admin/customers/cust-1/properties`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => jest.clearAllMocks());

describe('POST /admin/customers/:id/properties', () => {
  test('rejects a spelled-out state before touching the service', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { address_line1: '20 Oak St', city: 'Naples', state: 'Florida', zip: '34103' });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'state is required as a two-letter code' });
    });
    expect(mockProps.recordCallProperty).not.toHaveBeenCalled();
  });

  test('uppercases a two-letter code and records the property as manual', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { address_line1: '20 Oak St', city: 'Naples', state: 'fl', zip: '34103', occupancy_type: 'rental_investment', label: 'Rental' });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.propertyId).toBe('p-new');
      expect(body.properties).toHaveLength(2);
    });
    expect(mockProps.recordCallProperty).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', address_line1: '20 Oak St', state: 'FL', zip: '34103', occupancyType: 'rental_investment', label: 'Rental', source: 'manual',
    }));
  });

  test('state is REQUIRED — the service would otherwise default a missing state to FL silently', async () => {
    await withServer(async (baseUrl) => {
      const missingZip = await post(baseUrl, { address_line1: '20 Oak St', city: 'Naples', state: 'FL' });
      expect(missingZip.status).toBe(400);
      const missingState = await post(baseUrl, { address_line1: '20 Oak St', city: 'Naples', zip: '34103' });
      expect(missingState.status).toBe(400);
      await expect(missingState.json()).resolves.toEqual({ error: 'state is required as a two-letter code' });
      const blankState = await post(baseUrl, { address_line1: '20 Oak St', city: 'Naples', zip: '34103', state: '  ' });
      expect(blankState.status).toBe(400);
    });
    expect(mockProps.recordCallProperty).not.toHaveBeenCalled();
  });

  test('label longer than varchar(100) is a 400 on POST and PATCH, never a DB error', async () => {
    const long = 'x'.repeat(101);
    await withServer(async (baseUrl) => {
      const created = await post(baseUrl, { address_line1: '20 Oak St', city: 'Naples', state: 'FL', zip: '34103', label: long });
      expect(created.status).toBe(400);
      await expect(created.json()).resolves.toEqual({ error: 'label must be 100 characters or fewer' });
      const patched = await fetch(`${baseUrl}/admin/customers/cust-1/properties/p1`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: long }),
      });
      expect(patched.status).toBe(400);
      const exact = await post(baseUrl, { address_line1: '20 Oak St', city: 'Naples', state: 'FL', zip: '34103', label: 'y'.repeat(100) });
      expect(exact.status).toBe(201);
    });
    expect(mockProps.recordCallProperty).toHaveBeenCalledTimes(1);
  });

  test('every address column is capped at its varchar width with a field-named 400', async () => {
    const base = { address_line1: '20 Oak St', city: 'Naples', state: 'FL', zip: '34103' };
    const cases = [
      ['address_line1', 201, 200], ['address_line2', 101, 100], ['city', 51, 50], ['zip', 11, 10],
    ];
    await withServer(async (baseUrl) => {
      for (const [field, len, max] of cases) {
        const res = await post(baseUrl, { ...base, [field]: 'z'.repeat(len) });
        expect([field, res.status]).toEqual([field, 400]);
        await expect(res.json()).resolves.toEqual({ error: `${field} must be ${max} characters or fewer` });
      }
      const exact = await post(baseUrl, { ...base, address_line1: 'a'.repeat(200), address_line2: 'b'.repeat(100), city: 'c'.repeat(50), zip: 'd'.repeat(10) });
      expect(exact.status).toBe(201);
    });
    expect(mockProps.recordCallProperty).toHaveBeenCalledTimes(1);
  });

  test('duplicate street surfaces as 409', async () => {
    mockProps.recordCallProperty.mockResolvedValueOnce({ created: false, propertyId: null });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { address_line1: '10 Palm Ave', city: 'Naples', state: 'FL', zip: '34102' });
      expect(res.status).toBe(409);
    });
  });
});
