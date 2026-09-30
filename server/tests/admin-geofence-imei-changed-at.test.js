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
function installDb(currentImei) {
  updates = [];
  mockDb.mockImplementation((table) => {
    if (table !== 'technicians') throw new Error(`unexpected table ${table}`);
    return {
      where: () => ({
        first: async () => ({ bouncie_imei: currentImei }),
        update: async (patch) => { updates.push(patch); return 1; },
      }),
    };
  });
}

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

test('changing the IMEI stamps bouncie_imei_changed_at', async () => {
  installDb('111111111111111');
  expect(await put({ bouncie_imei: '222222222222222' })).toBe(200);
  expect(updates[0].bouncie_imei).toBe('222222222222222');
  expect(updates[0].bouncie_imei_changed_at).toBeInstanceOf(Date);
});

test('clearing the IMEI is a change too', async () => {
  installDb('111111111111111');
  await put({ bouncie_imei: '' });
  expect(updates[0].bouncie_imei).toBeNull();
  expect(updates[0].bouncie_imei_changed_at).toBeInstanceOf(Date);
});

test('re-saving the SAME IMEI does not restart the cutoff', async () => {
  installDb('111111111111111');
  await put({ bouncie_imei: '111111111111111', vehicle_name: 'Truck 4' });
  expect(updates[0].vehicle_name).toBe('Truck 4');
  expect('bouncie_imei_changed_at' in updates[0]).toBe(false);
});

test('a vehicle-name / VIN edit without an IMEI never stamps it (and never reads the current IMEI)', async () => {
  installDb('111111111111111');
  await put({ vehicle_name: 'Truck 5', bouncie_vin: 'VIN123' });
  expect('bouncie_imei_changed_at' in updates[0]).toBe(false);
  expect('bouncie_imei' in updates[0]).toBe(false);
});
