// Technician visibility audit 2026-11-04 (A6 / C2): equipment reads give a
// technician operational columns only. No purchase price, vendor, book value,
// depreciation, tax link, maintenance or fuel spend, cost of ownership,
// revenue impact; no mileage log; no reconciliation. An admin still gets every
// field. Synthetic rows only.
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
const systemsRouter = require('../routes/admin-equipment-systems');

const equipmentId = '00000000-0000-4000-8000-000000000001';
const staff = Object.fromEntries(['admin', 'technician'].map(role => [role, {
  id: role, role, employment_status: 'active', auth_token_version: 1,
}]));

const equipmentRow = {
  id: equipmentId, name: 'Synthetic sprayer', category: 'sprayer', status: 'active',
  make: 'Example', model: 'S-1', serial_number: 'SN-0001', asset_tag: 'TAG-1',
  current_hours: '12', condition_rating: 8,
  purchase_price: '1234.00', purchase_vendor: 'Example Supply', book_value: '900.00',
  depreciation_annual: '100.00', depreciation_method: 'section_179',
  salvage_value: '50.00', tax_equipment_id: 'tax-1',
};
const recordRow = {
  id: 'rec-1', equipment_id: equipmentId, task_name: 'Oil change', maintenance_type: 'scheduled',
  performed_at: '2026-01-15T12:00:00Z', performed_by: 'Pat Example', vendor_name: 'Example Shop',
  parts_cost: '10.00', labor_cost: '20.00', vendor_cost: '5.00', total_cost: '35.00',
  receipt_url: 'https://example.test/receipt.png', hours_at_service: '12',
};
const scheduleRow = {
  id: 'sch-1', equipment_id: equipmentId, task_name: 'Oil change', priority: 'normal',
  is_overdue: false, next_due_at: '2026-03-01', estimated_cost: '45.00',
};
const downtimeRow = {
  id: 'down-1', equipment_id: equipmentId, reason: 'Pump', revenue_impact: '300.00',
  equipment_name: 'Synthetic sprayer',
};
const overviewRow = {
  total_assets: 3, overdue_maintenance: 1, ytd_maintenance_spend: 500, ytd_total_miles: 900,
  ytd_business_miles: 800, ytd_fuel_cost: 120, ytd_fuel_gallons: 40, ytd_irs_deduction: 560,
  active_downtime: 0, open_alerts: 1, low_condition_count: 0,
};
const reconciliationRow = { id: 'tax-1', name: 'Synthetic tax row', purchase_cost: '1234.00', current_book_value: '900.00' };

const MONEY = {
  equipment: ['purchase_price', 'purchase_vendor', 'book_value', 'depreciation_annual',
    'depreciation_method', 'salvage_value', 'tax_equipment_id', 'avg_maintenance_cost'],
  record: ['parts_cost', 'labor_cost', 'vendor_cost', 'total_cost', 'receipt_url'],
};

function rowsFor(table) {
  switch (table) {
    case 'equipment': return [equipmentRow];
    case 'maintenance_records': return [recordRow];
    case 'maintenance_schedules': return [scheduleRow];
    case 'equipment_downtime_log': return [downtimeRow];
    case 'equipment_systems': return [{ id: 'sys-1', name: 'Synthetic rig' }];
    case 'equipment_register': return [reconciliationRow];
    case 'equipment_calibrations': return [];
    default: return [];
  }
}

function query(table) {
  let where;
  const q = {};
  for (const method of ['leftJoin', 'join', 'select', 'orderBy', 'orderByRaw', 'limit', 'offset',
    'groupBy', 'whereNot', 'whereNotIn', 'whereILike', 'whereNull', 'whereNotNull', 'whereRaw',
    'count', 'orWhereILike']) {
    q[method] = jest.fn(() => q);
  }
  q.where = jest.fn((value) => { if (value && typeof value === 'object') where = value; return q; });
  q.first = jest.fn(async () => {
    if (table === 'technicians') return staff[where?.id];
    if (table === 'maintenance_schedules') return scheduleRow;
    if (table === 'maintenance_records') return { avg_cost: '35', count: '1' };
    if (table === 'equipment') return equipmentRow;
    return { count: '1' };
  });
  q.then = (resolve, reject) => Promise.resolve(rowsFor(table)).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(rowsFor(table)).catch(reject);
  return q;
}

let server, baseUrl;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/equipment', equipmentRouter);
  app.use('/api/admin/equipment-maintenance', maintenanceRouter);
  app.use('/api/admin/equipment-systems', systemsRouter);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
});
afterAll(async () => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(query);
  db.raw = jest.fn(async () => []);
  db.fn = { now: jest.fn(() => 'NOW()') };
  equipmentService.getFleetOverview.mockResolvedValue({ ...overviewRow });
  equipmentService.costOfOwnership.mockResolvedValue({ equipment_id: equipmentId, purchase_price: 1234, total_cost: 1500, monthly_cost: 40 });
});

async function get(route, role) {
  const headers = { Authorization: `Bearer ${jwt.sign({
    technicianId: role, type: 'access', tokenVersion: 1,
  }, config.jwt.secret, { expiresIn: '5m' })}` };
  const response = await fetch(baseUrl + route, { headers });
  return { status: response.status, body: await response.json() };
}

const absent = (row, keys) => keys.forEach(key => expect(row).not.toHaveProperty(key));
const present = (row, keys) => keys.forEach(key => expect(row).toHaveProperty(key));

describe('equipment list and calibration history', () => {
  test('a technician gets no money columns on GET /equipment/equipment', async () => {
    const { status, body } = await get('/equipment/equipment', 'technician');
    expect(status).toBe(200);
    absent(body.equipment[0], MONEY.equipment);
    // Operational columns stay.
    expect(body.equipment[0]).toMatchObject({ name: 'Synthetic sprayer', asset_tag: 'TAG-1', condition_rating: 8 });
  });

  test('an admin still gets every money column on GET /equipment/equipment', async () => {
    const { body } = await get('/equipment/equipment', 'admin');
    present(body.equipment[0], MONEY.equipment.filter(key => key !== 'avg_maintenance_cost'));
  });

  test('a technician gets no cost fields on calibration history; an admin does', async () => {
    const tech = await get(`/equipment/equipment/${equipmentId}/calibration-history`, 'technician');
    absent(tech.body.calibrations[0], MONEY.record);
    expect(tech.body.calibrations[0].task_name).toBe('Oil change');
    const admin = await get(`/equipment/equipment/${equipmentId}/calibration-history`, 'admin');
    present(admin.body.calibrations[0], MONEY.record);
  });
});

describe('equipment-maintenance reads', () => {
  test('a technician gets no money columns on the fleet list; an admin does', async () => {
    const tech = await get('/equipment-maintenance', 'technician');
    expect(tech.status).toBe(200);
    absent(tech.body.equipment[0], MONEY.equipment);
    expect(tech.body.equipment[0].name).toBe('Synthetic sprayer');
    const admin = await get('/equipment-maintenance', 'admin');
    present(admin.body.equipment[0], ['purchase_price', 'book_value', 'avg_maintenance_cost']);
  });

  test('a technician gets no money on the equipment detail and no cost of ownership', async () => {
    const tech = await get(`/equipment-maintenance/${equipmentId}`, 'technician');
    expect(tech.status).toBe(200);
    absent(tech.body.equipment, MONEY.equipment);
    absent(tech.body.recentRecords[0], MONEY.record);
    absent(tech.body.schedules[0], ['estimated_cost']);
    expect(tech.body.costOfOwnership).toBeNull();
    expect(equipmentService.costOfOwnership).not.toHaveBeenCalled();
    expect(tech.body.schedules[0].task_name).toBe('Oil change');
  });

  test('an admin still gets the detail with cost of ownership', async () => {
    const admin = await get(`/equipment-maintenance/${equipmentId}`, 'admin');
    present(admin.body.equipment, ['purchase_price', 'book_value']);
    present(admin.body.recentRecords[0], MONEY.record);
    expect(admin.body.schedules[0].estimated_cost).toBe('45.00');
    expect(admin.body.costOfOwnership).toMatchObject({ total_cost: 1500 });
  });

  test.each([
    [`/equipment-maintenance/${equipmentId}/records`, 'records'],
    ['/equipment-maintenance/records/recent', 'records'],
  ])('a technician gets no cost fields on %s; an admin does', async (route, key) => {
    const tech = await get(route, 'technician');
    expect(tech.status).toBe(200);
    absent(tech.body[key][0], MONEY.record);
    expect(tech.body[key][0].task_name).toBe('Oil change');
    const admin = await get(route, 'admin');
    present(admin.body[key][0], MONEY.record);
  });

  test.each([
    [`/equipment-maintenance/${equipmentId}/schedules`, 'schedules'],
    ['/equipment-maintenance/schedules/due', 'schedules'],
  ])('a technician gets no estimated cost on %s; an admin does', async (route, key) => {
    const tech = await get(route, 'technician');
    expect(tech.status).toBe(200);
    absent(tech.body[key][0], ['estimated_cost']);
    const admin = await get(route, 'admin');
    expect(admin.body[key][0].estimated_cost).toBe('45.00');
  });

  test('a technician gets no revenue impact on active downtime; an admin does', async () => {
    const tech = await get('/equipment-maintenance/downtime/active', 'technician');
    absent(tech.body.downtime[0], ['revenue_impact']);
    expect(tech.body.downtime[0].reason).toBe('Pump');
    const admin = await get('/equipment-maintenance/downtime/active', 'admin');
    expect(admin.body.downtime[0].revenue_impact).toBe('300.00');
  });

  test('a technician gets the fleet overview without spend, fuel cost or IRS deduction', async () => {
    const tech = await get('/equipment-maintenance/analytics/overview', 'technician');
    expect(tech.status).toBe(200);
    absent(tech.body, ['ytd_maintenance_spend', 'ytd_fuel_cost', 'ytd_irs_deduction']);
    expect(tech.body).toMatchObject({ total_assets: 3, ytd_total_miles: 900, open_alerts: 1 });
    const admin = await get('/equipment-maintenance/analytics/overview', 'admin');
    expect(admin.body).toMatchObject({ ytd_maintenance_spend: 500, ytd_fuel_cost: 120, ytd_irs_deduction: 560 });
  });

  test('GET /:id/mileage is admin only (personal miles, fuel cost, IRS deduction)', async () => {
    const tech = await get(`/equipment-maintenance/${equipmentId}/mileage`, 'technician');
    expect(tech.status).toBe(403);
    expect(tech.body).toEqual({ error: 'Admin access required' });
    const admin = await get(`/equipment-maintenance/${equipmentId}/mileage`, 'admin');
    expect(admin.status).toBe(200);
  });
});

describe('equipment-systems reads', () => {
  test('GET /reconciliation is admin only (tax register cost and book value)', async () => {
    const tech = await get('/equipment-systems/reconciliation', 'technician');
    expect(tech.status).toBe(403);
    expect(tech.body).toEqual({ error: 'Admin access required' });
    const admin = await get('/equipment-systems/reconciliation', 'admin');
    expect(admin.status).toBe(200);
  });

  test('a technician still reads the systems list', async () => {
    const tech = await get('/equipment-systems', 'technician');
    expect(tech.status).toBe(200);
    expect(tech.body.systems[0].name).toBe('Synthetic rig');
  });
});
