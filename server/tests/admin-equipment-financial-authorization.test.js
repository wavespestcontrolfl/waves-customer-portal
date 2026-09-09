process.env.JWT_SECRET = process.env.JWT_SECRET || 'equipment-authorization-test-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/equipment-maintenance', () => ({
  getFleetOverview: jest.fn(),
  costOfOwnership: jest.fn(),
  recordMaintenance: jest.fn(),
  logMileage: jest.fn(),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');
const equipmentService = require('../services/equipment-maintenance');
const equipmentRouter = require('../routes/admin-equipment');
const maintenanceRouter = require('../routes/admin-equipment-maintenance');

const equipmentId = '00000000-0000-4000-8000-000000000001';
const staff = Object.fromEntries(['admin', 'technician'].map(role => [role, {
  id: role, role, employment_status: 'active', auth_token_version: 1,
}]));
const financialRoutes = [
  ['GET', '/equipment/job-costs', 200],
  ['GET', '/equipment/job-costs/summary', 200],
  ['POST', '/equipment/job-costs', 201],
  ['POST', '/equipment/job-costs/auto-calculate/service-example', 201],
  ['GET', '/equipment/dashboard', 200],
  ['GET', '/equipment-maintenance/analytics/costs', 200],
  ['GET', '/equipment-maintenance/analytics/reliability', 200],
  ['GET', '/equipment-maintenance/mileage/summary', 200],
];
const financialRow = {
  id: equipmentId, name: 'Synthetic vehicle', category: 'vehicle', status: 'active',
  count: '1', total_jobs: '1', service_type: 'synthetic',
  total_revenue: '100', total_costs: '25', total_profit: '75', avg_margin: '75',
  total_book_value: '20000', total_purchase_value: '25000',
  current_hours: '100', next_service_hours: '110',
  total_miles: '100', business_miles: '100', personal_miles: '0',
  total_fuel_cost: '20', total_fuel_gallons: '5', total_irs_deduction: '70',
};

function query(table) {
  let where, inserted;
  const q = {};
  for (const method of ['leftJoin', 'join', 'select', 'orderBy', 'orderByRaw',
    'limit', 'offset', 'groupBy', 'sum', 'avg', 'count', 'clone', 'whereNot',
    'whereNotIn', 'whereNotNull', 'whereRaw']) {
    q[method] = jest.fn(() => q);
  }
  q.where = jest.fn((value) => { where = value; return q; });
  q.insert = jest.fn((value) => { inserted = value; return q; });
  q.returning = jest.fn(async () => [{ id: 'cost-example', ...inserted }]);
  q.first = jest.fn(async () => {
    if (table === 'technicians') return staff[where?.id];
    if (table === 'service_records') return {
      id: 'service-example', customer_id: 'customer-example', service_type: 'synthetic',
      service_date: '2026-01-15', price: 100,
    };
    if (table === 'maintenance_schedules') return null;
    return financialRow;
  });
  q.then = (resolve, reject) => Promise.resolve([financialRow]).then(resolve, reject);
  q.catch = reject => Promise.resolve([financialRow]).catch(reject);
  return q;
}

let server, baseUrl;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/equipment', equipmentRouter);
  app.use('/api/admin/equipment-maintenance', maintenanceRouter);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
});
afterAll(async () => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(query);
  // The legacy maintenance bootstrap runs after the new role guard. It must
  // never execute for rejected financial requests, even on the first request.
  db.raw = jest.fn(async () => []);
  db.fn = { now: jest.fn(() => 'NOW()') };
  equipmentService.getFleetOverview.mockResolvedValue({ total_assets: 1 });
  equipmentService.costOfOwnership.mockResolvedValue({ equipment_id: equipmentId, total_cost: 25 });
  equipmentService.recordMaintenance.mockResolvedValue({ id: 'maintenance-example' });
  equipmentService.logMileage.mockResolvedValue({ id: 'mileage-example' });
});

function request(method, route, role, claims = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers.Authorization = `Bearer ${jwt.sign({
    technicianId: role, type: 'access', tokenVersion: 1, ...claims,
  }, config.jwt.secret, { expiresIn: '5m' })}`;
  return fetch(baseUrl + route, {
    method, headers,
    ...(method === 'POST' ? { body: JSON.stringify({
      customer_id: 'customer-example', service_date: '2026-01-15', revenue: 100,
      taskName: 'Synthetic inspection', logDate: '2026-01-15',
    }) } : {}),
  });
}

describe('owner-only equipment financial APIs', () => {
  test.each(financialRoutes)('anonymous %s %s is rejected before data access', async (method, route) => {
    const response = await request(method, route);
    expect(response.status).toBe(401);
    expect(db).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
  });

  test.each(financialRoutes)('technician %s %s is rejected before financial work', async (method, route) => {
    const response = await request(method, route, 'technician');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Admin access required' });
    expect(db.mock.calls.map(([table]) => table)).toEqual(['technicians']);
    expect(db.raw).not.toHaveBeenCalled();
    expect(equipmentService.costOfOwnership).not.toHaveBeenCalled();
  });

  test.each(financialRoutes)('admin %s %s reaches the existing handler', async (method, route, status) => {
    const response = await request(method, route, 'admin');
    const body = await response.json();
    expect(body.error).toBeUndefined();
    expect(response.status).toBe(status);
    expect(db.mock.calls.some(([table]) => table !== 'technicians')).toBe(true);
  });

  test('a claimed admin role cannot override the current technician database role', async () => {
    const response = await request('GET', '/equipment/job-costs/summary', 'technician', { role: 'admin' });
    expect(response.status).toBe(403);
    expect(db.mock.calls.map(([table]) => table)).toEqual(['technicians']);
  });

  test('admin summary retains the revenue, cost and margin response', async () => {
    const response = await request('GET', '/equipment/job-costs/summary', 'admin');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      avgRevenue: 100, avgCost: 25, avgMargin: 75, totalJobs: 1,
      overall: expect.objectContaining({ total_revenue: '100' }),
    }));
  });
});

describe('operational equipment access', () => {
  test.each([
    '/equipment/equipment',
    '/equipment/tank-mixes',
    '/equipment-maintenance/analytics/overview',
    `/equipment-maintenance/${equipmentId}`,
    `/equipment-maintenance/${equipmentId}/mileage`,
  ])('technicians still read %s', async route => {
    const response = await request('GET', route, 'technician');
    const body = await response.json();
    expect(body.error).toBeUndefined();
    expect(response.status).toBe(200);
  });

  test.each([
    [`/equipment-maintenance/${equipmentId}/records`, 'recordMaintenance'],
    [`/equipment-maintenance/${equipmentId}/mileage`, 'logMileage'],
  ])('technicians still write %s', async (route, service) => {
    const response = await request('POST', route, 'technician');
    const body = await response.json();
    expect(body.error).toBeUndefined();
    expect(response.status).toBe(201);
    expect(equipmentService[service]).toHaveBeenCalledTimes(1);
  });
});
