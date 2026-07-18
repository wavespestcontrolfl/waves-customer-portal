/**
 * Technician-role scoping on admin schedule + customers routes (07-18 admin
 * audit, finding #1). Both routers sit behind requireTechOrAdmin, but a
 * technician token previously had ORGANIZATION-WIDE reach: the schedule
 * board endpoints filtered only by date (returning every customer's contact
 * info and billing context), the per-visit money endpoints (prepaid stamp/
 * clear, invoice mint) had no ownership check, and the customer routes
 * exposed payment methods, SMS threads, credits, and CRM writes to any
 * staff token. Pins the new contract:
 *
 *  - Board list queries (day/week/month/list) add technician_id = self for
 *    technician tokens and stay unscoped for admins (scopeToAssignedTech).
 *  - Per-visit endpoints 404 (not 403 — existence must not leak) when a
 *    technician touches a visit assigned to someone else, before any
 *    side effect runs.
 *  - Customer endpoints with no tech surface (comms/timeline/credits/
 *    pipeline view/stage/tags/interactions/follow-up) are requireAdmin.
 *  - Tech-surface customer endpoints (360 detail, cards) 404 for customers
 *    with no visit assigned to the requesting tech.
 *  - The list/search endpoint strips financial/CRM fields from rows for
 *    technician tokens (techSafeListRow).
 *
 * The real requireAdmin/requireTechOrAdmin middlewares run; only
 * adminAuthenticate is stubbed to inject a controllable role. db is mocked
 * at the ownership-lookup level — denial paths must return before any other
 * query runs, so nothing else needs to exist.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockCurrentRole = 'technician';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'tech-1', role: mockCurrentRole };
      req.technicianId = 'tech-1';
      req.techRole = mockCurrentRole;
      return next();
    },
  };
});

// Where-aware fake for the two lookups the guards perform:
//   scheduled_services.where({ id }).first('technician_id')
//   scheduled_services.where({ customer_id, technician_id }).first('id')
// Any write reaching the fake is a test failure (denials must be side-effect
// free), recorded in state.writes.
jest.mock('../models/db', () => {
  const state = { scheduledServices: [], writes: [] };
  const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
  const dbFn = (table) => {
    const builder = {
      _where: {},
      where(w) { if (w && typeof w === 'object') Object.assign(builder._where, w); return builder; },
      async first() {
        if (table !== 'scheduled_services') return undefined;
        const found = state.scheduledServices.find((r) => matches(r, builder._where));
        return found ? { ...found } : undefined;
      },
      async update(u) { state.writes.push({ table, op: 'update', u }); return 0; },
      async insert(r) { state.writes.push({ table, op: 'insert', r }); return [1]; },
      async del() { state.writes.push({ table, op: 'del' }); return 0; },
    };
    return builder;
  };
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql) => sql;
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const scheduleRouter = require('../routes/admin-schedule');
const customersRouter = require('../routes/admin-customers');

const { scopeToAssignedTech, technicianOwnsScheduledService } = scheduleRouter._test;
const { technicianServicesCustomer, techSafeListRow, TECH_LIST_STRIPPED_FIELDS } = customersRouter._private;

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', scheduleRouter);
  app.use('/api/admin/customers', customersRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json || {} };
}

beforeEach(() => {
  mockCurrentRole = 'technician';
  db.__state.scheduledServices = [
    { id: 'svc-own', technician_id: 'tech-1', customer_id: 'cust-own' },
    { id: 'svc-other', technician_id: 'tech-2', customer_id: 'cust-other' },
  ];
  db.__state.writes = [];
});

describe('schedule per-visit ownership (technician role)', () => {
  const denials = [
    ['POST', '/api/admin/schedule/svc-other/prepaid', { amount: 50, method: 'cash' }],
    ['DELETE', '/api/admin/schedule/svc-other/prepaid', undefined],
    ['POST', '/api/admin/schedule/svc-other/invoice', {}],
    ['PUT', '/api/admin/schedule/svc-other/status', { status: 'completed' }],
    ['GET', '/api/admin/schedule/svc-other/wdo-brief', undefined],
    ['GET', '/api/admin/schedule/svc-other/estimate-source', undefined],
    ['POST', '/api/admin/schedule/svc-other/regenerate-brief', {}],
    ['GET', '/api/admin/schedule/eta/svc-other', undefined],
    ['POST', '/api/admin/schedule/generate-report', { scheduledServiceId: 'svc-other' }],
    ['GET', '/api/admin/schedule/vehicle-location?serviceId=svc-other', undefined],
    ['GET', '/api/admin/schedule/next-visit?customerId=cust-other', undefined],
  ];

  test.each(denials)('%s %s on another tech\'s visit → 404 and no writes', async (method, path, body) => {
    const { status, body: res } = await call(method, path, body);
    expect(status).toBe(404);
    expect(res.error).toMatch(/not found/i);
    expect(db.__state.writes).toHaveLength(0);
  });

  test('a nonexistent visit id also 404s (no existence oracle)', async () => {
    const { status } = await call('POST', '/api/admin/schedule/svc-nope/prepaid', { amount: 50 });
    expect(status).toBe(404);
    expect(db.__state.writes).toHaveLength(0);
  });

  test('update-details is admin-only — its inputs can propagate to recurring siblings', async () => {
    const { status, body } = await call('PUT', '/api/admin/schedule/svc-own/update-details', { notes: 'x' });
    expect(status).toBe(403);
    expect(body.error).toMatch(/admin access required/i);
    expect(db.__state.writes).toHaveLength(0);
  });

  test.each([
    ['POST', '/api/admin/schedule/optimize', {}],
    ['POST', '/api/admin/schedule/optimize-route', {}],
    ['GET', '/api/admin/schedule/recurring-alerts', undefined],
    ['POST', '/api/admin/schedule/recurring-alerts/alert-1/action', { action: 'renew' }],
  ])('%s %s is admin-only (dispatch/office function)', async (method, path, body) => {
    const { status, body: res } = await call(method, path, body);
    expect(status).toBe(403);
    expect(res.error).toMatch(/admin access required/i);
    expect(db.__state.writes).toHaveLength(0);
  });

  test('vehicle-location by techId is restricted to the tech\'s own id', async () => {
    const { status, body } = await call('GET', '/api/admin/schedule/vehicle-location?techId=tech-2');
    expect(status).toBe(403);
    expect(body.error).toMatch(/own vehicle location/i);
  });

  test('series prepayment modes are admin-only even on the tech\'s OWN anchor visit', async () => {
    const stamp = await call('POST', '/api/admin/schedule/svc-own/prepaid', {
      amount: 360, method: 'cash', applyToSeries: true,
    });
    expect(stamp.status).toBe(403);
    expect(stamp.body.error).toMatch(/series/i);

    const clear = await call('DELETE', '/api/admin/schedule/svc-own/prepaid?series=1', undefined);
    expect(clear.status).toBe(403);
    expect(clear.body.error).toMatch(/series/i);

    expect(db.__state.writes).toHaveLength(0);
  });
});

describe('technicianOwnsScheduledService', () => {
  const reqFor = (role, techId = 'tech-1') => ({ techRole: role, technicianId: techId });

  test('admin bypasses the lookup entirely', async () => {
    await expect(technicianOwnsScheduledService(reqFor('admin'), 'svc-other')).resolves.toBe(true);
  });

  test('technician owns their assigned visit', async () => {
    await expect(technicianOwnsScheduledService(reqFor('technician'), 'svc-own')).resolves.toBe(true);
  });

  test('technician does not own another tech\'s visit or a missing one', async () => {
    await expect(technicianOwnsScheduledService(reqFor('technician'), 'svc-other')).resolves.toBe(false);
    await expect(technicianOwnsScheduledService(reqFor('technician'), 'svc-nope')).resolves.toBe(false);
  });
});

describe('scopeToAssignedTech', () => {
  const fakeQuery = () => {
    const calls = [];
    return { calls, where(...args) { calls.push(args); return this; } };
  };

  test('technician requests are pinned to their own technician_id', () => {
    const q = fakeQuery();
    scopeToAssignedTech({ techRole: 'technician', technicianId: 'tech-1' }, q);
    expect(q.calls).toEqual([['scheduled_services.technician_id', 'tech-1']]);
  });

  test('admin requests stay unscoped', () => {
    const q = fakeQuery();
    scopeToAssignedTech({ techRole: 'admin', technicianId: 'admin-1' }, q);
    expect(q.calls).toHaveLength(0);
  });
});

describe('customer routes: requireAdmin on non-tech surfaces', () => {
  const adminOnly = [
    ['GET', '/api/admin/customers/pipeline/view'],
    ['GET', '/api/admin/customers/cust-own/comms'],
    ['GET', '/api/admin/customers/cust-own/timeline'],
    ['GET', '/api/admin/customers/cust-own/credits'],
    ['PUT', '/api/admin/customers/cust-own/stage'],
    ['POST', '/api/admin/customers/cust-own/tags'],
    ['DELETE', '/api/admin/customers/cust-own/tags/vip'],
    ['POST', '/api/admin/customers/cust-own/interactions'],
    ['POST', '/api/admin/customers/cust-own/follow-up'],
  ];

  test.each(adminOnly)('%s %s → 403 for a technician token', async (method, path) => {
    const { status, body } = await call(method, path, method === 'GET' ? undefined : {});
    expect(status).toBe(403);
    expect(body.error).toMatch(/admin access required/i);
    expect(db.__state.writes).toHaveLength(0);
  });
});

describe('customer routes: assigned-customer proxy (technician role)', () => {
  test('360 detail and cards 404 for a customer with no visit assigned to this tech', async () => {
    for (const path of ['/api/admin/customers/cust-other', '/api/admin/customers/cust-other/cards']) {
      const { status, body } = await call('GET', path);
      expect(status).toBe(404);
      expect(body.error).toMatch(/customer not found/i);
    }
  });

  test('technicianServicesCustomer: admin unscoped, tech scoped to assigned customers', async () => {
    await expect(technicianServicesCustomer({ techRole: 'admin' }, 'cust-other')).resolves.toBe(true);
    await expect(technicianServicesCustomer({ techRole: 'technician', technicianId: 'tech-1' }, 'cust-own')).resolves.toBe(true);
    await expect(technicianServicesCustomer({ techRole: 'technician', technicianId: 'tech-1' }, 'cust-other')).resolves.toBe(false);
  });
});

describe('techSafeListRow', () => {
  test('strips financial/CRM fields and keeps identity/service context', () => {
    const mapped = {
      id: 'c1', firstName: 'Pat', lastName: 'Lee', email: 'p@x.com', phone: '941',
      address: '1 Main St', tier: 'gold', monthlyRate: 89, propertyType: 'residential',
      lifetimeRevenue: 1234, balanceOwed: 50, cardsOnFile: 2, healthScore: 88,
      pipelineStage: 'active_customer', leadScore: 90, leadSource: 'ads',
      leadSourceDetail: 'ppc', landingPageUrl: 'https://x', lastContactDate: 'd',
      lastContactType: 'sms', nextFollowUp: 'd', lastRating: 9, tags: ['vip'],
    };
    const safe = techSafeListRow(mapped);
    for (const field of TECH_LIST_STRIPPED_FIELDS) {
      expect(safe).not.toHaveProperty(field);
    }
    expect(safe).toEqual(expect.objectContaining({
      id: 'c1', firstName: 'Pat', lastName: 'Lee', phone: '941',
      address: '1 Main St', tier: 'gold', monthlyRate: 89,
    }));
  });
});
