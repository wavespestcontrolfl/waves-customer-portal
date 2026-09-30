/**
 * technicians.bouncie_imei_changed_at (Codex round-35 P2, PR #5334): the tracker-
 * remap instant is stamped ONLY when the IMEI actually changes — never by an
 * unchanged re-save or by an ordinary technician edit — so the live-ETA path and the
 * public tracker keep trusting a valid tech_status cache after name/phone/payroll
 * edits. Synthetic ids only.
 */
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);

const http = require('http');
const express = require('express');

let updates;
let reads;
function installDb() {
  updates = [];
  reads = 0;
  // The stamp is ATOMIC with the IMEI write (round-38 P2): the route must not read the
  // current IMEI first, so a read here is a test failure.
  mockDb.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  mockDb.mockImplementation((table) => {
    if (table !== 'technicians') throw new Error(`unexpected table ${table}`);
    return {
      where: () => ({
        first: async () => { reads += 1; return { bouncie_imei: 'unused' }; },
        update: async (patch) => { updates.push(patch); return 1; },
      }),
    };
  });
}

const CASE_SQL = 'CASE WHEN technicians.bouncie_imei IS DISTINCT FROM ?::varchar THEN NOW() ELSE technicians.bouncie_imei_changed_at END';

async function put(body) {
  const app = express();
  app.use(express.json());
  app.use('/', require('../routes/admin-geofence'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/vehicles/tech-1`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.status;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('an IMEI save is ONE atomic UPDATE: the stamp is a CASE on the row\'s current IMEI, with no separate read', async () => {
  installDb();
  expect(await put({ bouncie_imei: '222222222222222' })).toBe(200);
  expect(reads).toBe(0);
  expect(updates).toHaveLength(1);
  expect(updates[0].bouncie_imei).toBe('222222222222222');
  expect(updates[0].bouncie_imei_changed_at).toEqual({ __raw: CASE_SQL, bindings: ['222222222222222'] });
  expect(mockDb.raw).toHaveBeenCalledTimes(1);
});

test('clearing the IMEI compares against NULL in the same statement', async () => {
  installDb();
  await put({ bouncie_imei: '' });
  expect(reads).toBe(0);
  expect(updates[0].bouncie_imei).toBeNull();
  expect(updates[0].bouncie_imei_changed_at).toEqual({ __raw: CASE_SQL, bindings: [null] });
});

test('re-saving the same IMEI is decided by the database (CASE keeps the old stamp): the route sends the same statement, never a client-side guess', async () => {
  installDb();
  await put({ bouncie_imei: '111111111111111', vehicle_name: 'Truck 4' });
  expect(updates[0].vehicle_name).toBe('Truck 4');
  expect(updates[0].bouncie_imei_changed_at.bindings).toEqual(['111111111111111']);
  expect(updates[0].bouncie_imei_changed_at.__raw).toContain('ELSE technicians.bouncie_imei_changed_at END');
});

test('a vehicle-name / VIN edit without an IMEI touches neither bouncie_imei nor its stamp', async () => {
  installDb();
  await put({ vehicle_name: 'Truck 5', bouncie_vin: 'VIN123' });
  expect('bouncie_imei_changed_at' in updates[0]).toBe(false);
  expect('bouncie_imei' in updates[0]).toBe(false);
  expect(mockDb.raw).not.toHaveBeenCalled();
});
