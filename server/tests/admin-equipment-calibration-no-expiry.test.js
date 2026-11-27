// Owner 2026-11-27 ("I am not going to calibrate them. We will use the best guess."): a sprayer number with no expiry stays that
// way. An explicit expires_at: null on create or verify is kept for field_verified and owner_estimate; every other status (and a
// body with no expires_at) keeps the 30-day default.
const writes = [];
jest.mock('../models/db', () => {
  const builder = (table) => {
    const query = {
      where: () => query,
      first: async () => (table === 'equipment_systems'
        ? { id: 'sys-1', name: 'Fixture sprayer' }
        : { id: 'cal-1', equipment_system_id: 'sys-1', active: true }),
      update: (values) => { writes.push({ table, kind: 'update', values }); return { returning: async () => [{ id: 'cal-1', ...values }] }; },
      insert: (values) => { writes.push({ table, kind: 'insert', values }); return { returning: async () => [{ id: 'cal-2', ...values }] }; },
    };
    return query;
  };
  const db = jest.fn(builder);
  db.transaction = async (work) => work(jest.fn(builder));
  db.fn = { now: () => 'now()' };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/equipment-reconciliation', () => ({
  SYSTEM_ASSET_FIELDS: [], COMPONENT_ASSET_FIELDS: [], SYSTEM_ASSET_LABELS: {}, buildEquipmentReconciliation: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; req.technicianId = 'staff-1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/equipment-systems', require('../routes/admin-equipment-systems'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { writes.length = 0; });

const post = (path, body) => fetch(`${base}/api/admin/equipment-systems${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const calibrationWrite = (kind) => writes.find((write) => write.table === 'equipment_calibrations' && write.kind === kind && 'expires_at' in write.values).values;

describe('creating a calibration', () => {
  const create = (body) => post('/sys-1/calibrations', { carrier_gal_per_1000: 2, calibrated_at: '2026-11-27T15:00:00Z', ...body });
  test.each(['field_verified', 'owner_estimate'])('an explicit null expiry is kept for %s', async (status) => {
    expect((await create({ calibration_status: status, expires_at: null })).status).toBe(200);
    expect(calibrationWrite('insert')).toMatchObject({ calibration_status: status, expires_at: null });
  });
  test('another status, or no expires_at in the body, keeps the 30-day default', async () => {
    await create({ calibration_status: 'estimated', expires_at: null });
    expect(calibrationWrite('insert').expires_at.toISOString()).toBe('2026-12-27T15:00:00.000Z');
    writes.length = 0;
    await create({ calibration_status: 'owner_estimate' });
    expect(calibrationWrite('insert').expires_at.toISOString()).toBe('2026-12-27T15:00:00.000Z');
  });
});

describe('verifying a calibration', () => {
  const verify = (body) => post('/calibrations/cal-1/verify', { verified_test_area_sqft: 1000, verified_captured_gallons: 2, verified_at: '2026-11-27T15:00:00Z', ...body });
  test('an explicit null expiry is kept; without it the 30-day default stands', async () => {
    expect((await verify({ expires_at: null })).status).toBe(200);
    expect(calibrationWrite('update')).toMatchObject({ calibration_status: 'field_verified', expires_at: null });
    writes.length = 0;
    await verify({});
    expect(new Date(calibrationWrite('update').expires_at).toISOString()).toBe('2026-12-27T15:00:00.000Z');
  });
});
