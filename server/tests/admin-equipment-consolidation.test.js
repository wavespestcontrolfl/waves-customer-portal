process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/equipment-maintenance', () => ({
  recordMaintenance: jest.fn(),
}));
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn(() => '2026-05-17'),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: 'admin-1', role: 'admin', name: 'Owner' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../models/db');
const equipmentService = require('../services/equipment-maintenance');
const equipmentRouter = require('../routes/admin-equipment');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/equipment', equipmentRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeThenableQuery(result) {
  const q = {};
  [
    'leftJoin',
    'select',
    'where',
    'whereILike',
    'orWhereILike',
    'orderBy',
    'limit',
    'offset',
    'groupBy',
    'sum',
    'avg',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.count = jest.fn(() => q);
  q.clone = jest.fn(() => q);
  q.first = jest.fn(async () => Array.isArray(result) ? result[0] : result);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

describe('admin equipment consolidation routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    db.raw = jest.fn((sql) => ({ __raw: sql }));
    db.fn = { now: jest.fn(() => 'NOW()') };
    equipmentService.recordMaintenance.mockResolvedValue({
      id: 'maintenance-record-1',
      equipment_id: 'equipment-1',
      task_name: 'Oil Change',
    });
  });

  test('legacy equipment maintenance POST writes through canonical maintenance service', async () => {
    const equipmentUpdates = [];

    db.mockImplementation((table) => {
      if (table !== 'equipment') throw new Error(`Unexpected table ${table}`);
      const q = makeThenableQuery([]);
      q.where = jest.fn(() => q);
      q.first = jest.fn(async () => ({
        id: 'equipment-1',
        name: 'Pump 1',
        current_hours: 118,
      }));
      q.update = jest.fn(async (updates) => {
        equipmentUpdates.push(updates);
        return 1;
      });
      return q;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/equipment/equipment/equipment-1/maintenance`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_type: 'oil_change',
          hours_at_service: 120,
          cost: 42.5,
          parts_used: 'filter, oil',
          notes: 'changed on route',
          performed_by: 'Adam',
          service_date: '2026-05-16',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.maintenance.id).toBe('maintenance-record-1');
      expect(equipmentService.recordMaintenance).toHaveBeenCalledWith(expect.objectContaining({
        equipmentId: 'equipment-1',
        maintenanceType: 'legacy',
        taskName: 'oil_change',
        hoursAtService: 120,
        partsCost: 42.5,
        performedBy: 'Adam',
        performedAt: '2026-05-16',
      }));
      expect(equipmentService.recordMaintenance.mock.calls[0][0].description)
        .toBe('changed on route\nParts used: filter, oil');
      expect(equipmentUpdates).toContainEqual(expect.objectContaining({
        current_hours: 120,
        last_service_date: '2026-05-16',
      }));
    });
  });

  test('equipment calibration POST writes calibration records into maintenance_records', async () => {
    db.mockImplementation((table) => {
      if (table !== 'equipment') throw new Error(`Unexpected table ${table}`);
      const q = makeThenableQuery([]);
      q.where = jest.fn(() => q);
      q.first = jest.fn(async () => ({
        id: 'equipment-1',
        name: 'Sprayer 1',
        current_hours: 22,
      }));
      return q;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/equipment/equipment/equipment-1/calibration`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flow_rate_oz_min: 9.25,
          nozzle_type: 'TeeJet',
          pressure_psi: 45,
          service_date: '2026-05-15',
        }),
      });

      expect(res.status).toBe(201);
      expect(equipmentService.recordMaintenance).toHaveBeenCalledWith(expect.objectContaining({
        equipmentId: 'equipment-1',
        maintenanceType: 'calibration',
        taskName: 'Calibration',
        description: 'Flow rate: 9.25 oz/min | Nozzle: TeeJet | Pressure: 45 PSI',
        performedAt: '2026-05-15',
      }));
    });
  });

  test('tank mix list keeps canonical and legacy response keys in sync', async () => {
    const rows = [{ id: 'mix-1', name: 'Perimeter Mix' }];
    db.mockImplementation((table) => {
      if (table !== 'tank_mixes') throw new Error(`Unexpected table ${table}`);
      return makeThenableQuery(rows);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/equipment/tank-mixes`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.tank_mixes).toEqual(rows);
      expect(body.mixes).toEqual(rows);
    });
  });

  test('job cost list keeps canonical and legacy response keys in sync', async () => {
    const jobs = [{ id: 'job-cost-1', margin_pct: '55.50' }];
    const jobQuery = makeThenableQuery(jobs);
    const countQuery = { count: jest.fn(async () => [{ count: '1' }]) };
    let jobCostsCall = 0;

    db.mockImplementation((table) => {
      if (table !== 'job_costs') throw new Error(`Unexpected table ${table}`);
      jobCostsCall += 1;
      return jobCostsCall === 1 ? jobQuery : countQuery;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/equipment/job-costs?limit=30`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.job_costs).toEqual(jobs);
      expect(body.costs).toEqual(jobs);
      expect(body.total).toBe(1);
    });
  });

  test('job cost summary includes old and normalized client shapes', async () => {
    const byType = [{
      service_type: 'lawn',
      total_jobs: '2',
      total_revenue: '300.00',
      total_costs: '120.00',
      avg_margin: '60.1234',
    }];
    const overall = {
      total_jobs: '2',
      total_revenue: '300.00',
      total_costs: '120.00',
      avg_margin: '60.1234',
    };
    let cloneCall = 0;
    const baseQuery = {
      where: jest.fn(() => baseQuery),
      clone: jest.fn(() => {
        cloneCall += 1;
        const q = makeThenableQuery(cloneCall === 1 ? byType : overall);
        q.first = jest.fn(async () => overall);
        return q;
      }),
    };

    db.mockImplementation((table) => {
      if (table !== 'job_costs') throw new Error(`Unexpected table ${table}`);
      return baseQuery;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/equipment/job-costs/summary`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.by_service_type[0]).toEqual(expect.objectContaining({
        service_type: 'lawn',
        avg_margin: 60.12,
      }));
      expect(body.overall.avg_margin).toBe(60.12);
      expect(body.byServiceType.lawn).toEqual({
        count: 2,
        avgRevenue: 150,
        avgCost: 60,
        avgMargin: 60.12,
      });
      expect(body.avgMargin).toBe(60.12);
      expect(body.avgRevenue).toBe(150);
      expect(body.avgCost).toBe(60);
      expect(body.totalJobs).toBe(2);
    });
  });
});

describe('equipment/fleet consolidation schema guards', () => {
  test('fleet fallback mileage schema uses vehicle_id, not an incompatible equipment_id table', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'routes', 'admin-equipment-maintenance.js'),
      'utf8',
    );

    expect(source).toContain('CREATE TABLE IF NOT EXISTS vehicle_mileage_log');
    expect(source).toContain('vehicle_id uuid NOT NULL');
    expect(source).toContain('UNIQUE(vehicle_id, log_date)');
    expect(source).not.toContain('equipment_id uuid NOT NULL, logged_by uuid');
    expect(source).not.toContain('odometer_reading integer NOT NULL');
  });

  test('fleet named routes cannot be swallowed by generic equipment id routes', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'routes', 'admin-equipment-maintenance.js'),
      'utf8',
    );

    expect(source).toContain("router.get('/:id([0-9a-fA-F-]{36})'");
    expect(source).toContain("router.get('/alerts'");
    expect(source).not.toContain("router.get('/:id',");
  });

  test('legacy equipment maintenance writes are migrated into canonical records', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'models', 'migrations', '20260517000001_backfill_legacy_equipment_maintenance.js'),
      'utf8',
    );

    expect(source).toContain('FROM equipment_maintenance_log eml');
    expect(source).toContain('INSERT INTO maintenance_records');
    expect(source).toContain('legacy_equipment_maintenance_log_id');
    expect(source).toContain('maintenance_records_legacy_equipment_log_uidx');
  });
});
