/**
 * PUT /admin/customers/:id/properties/:propertyId/reclaimed-water (GATE_LAWN_RECLAIMED_HALF_N): the office says a property's water is
 * reclaimed (true), not (false), or hands it back to the county meter match (null). Dark while the gate is off (404, nothing written);
 * the list answer carries the gate so the panel mounts its control only while it is on.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const mockGate = { on: true };
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false), gateEnvValue: jest.fn(() => false), lawnReclaimedHalfNLive: jest.fn(() => mockGate.on),
}));
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
const mockEdit = jest.fn(async () => ({ success: true, propertyId: 'p1', properties: [{ id: 'p1', reclaimed_water: true, reclaimed_water_source: 'office' }] }));
const mockList = jest.fn(async () => [{ id: 'p1' }]);
jest.mock('../services/customer-properties', () => ({
  editManualProperty: (...args) => mockEdit(...args),
  listProperties: (...args) => mockList(...args),
  ensurePrimaryProperty: jest.fn(async () => ({})),
  OCCUPANCY_TYPES: ['unknown'],
}));
jest.mock('../services/property-service-areas', () => ({ propertyServiceAreasEnabled: () => false }));

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
const put = (baseUrl, body) => fetch(`${baseUrl}/admin/customers/cust-1/properties/p1/reclaimed-water`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => { jest.clearAllMocks(); mockGate.on = true; });

test.each([[true], [false], [null]])('saves %s as the office answer and answers with the property list', async (value) => {
  await withServer(async (baseUrl) => {
    const res = await put(baseUrl, { reclaimed: value });
    expect(res.status).toBe(200);
    expect((await res.json()).properties).toHaveLength(1);
  });
  // The audited, locked domain writer, with the actor (the same writer the PATCH above uses).
  expect(mockEdit).toHaveBeenCalledWith('cust-1', 'p1', { reclaimed_water: value }, { actorId: 'admin-1' });
});

test.each([[{}], [{ reclaimed: 'yes' }], [{ reclaimed: 1 }], [undefined]])('refuses %j before writing', async (body) => {
  await withServer(async (baseUrl) => {
    const res = await put(baseUrl, body ?? {});
    expect(res.status).toBe(400);
  });
  expect(mockEdit).not.toHaveBeenCalled();
});

test('a property the writer does not find is its 404, passed through', async () => {
  mockEdit.mockRejectedValue(Object.assign(new Error('property not found'), { status: 404 }));
  await withServer(async (baseUrl) => { expect((await put(baseUrl, { reclaimed: true })).status).toBe(404); });
});

test('the gate off: 404 and nothing is written', async () => {
  mockGate.on = false;
  await withServer(async (baseUrl) => { expect((await put(baseUrl, { reclaimed: true })).status).toBe(404); });
  expect(mockEdit).not.toHaveBeenCalled();
});

test('the list answer carries the gate for the panel while it is on; off, the key is not sent and the body is the old one', async () => {
  await withServer(async (baseUrl) => {
    expect((await (await fetch(`${baseUrl}/admin/customers/cust-1/properties`)).json()).reclaimedWater).toBe(true);
    mockGate.on = false;
    const off = await (await fetch(`${baseUrl}/admin/customers/cust-1/properties`)).json();
    expect(off).not.toHaveProperty('reclaimedWater');
    expect(Object.keys(off).sort()).toEqual(['canChangeAppointmentAddress', 'canChangePrimary', 'properties', 'propertyServiceAreas']);
  });
});
