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

// Where-aware fake for the lookups the guards perform against
// scheduled_services: object wheres, 3-arg comparisons (scheduled_date
// cutoffs), and whereNotIn (terminal-status exclusion). Any write reaching
// the fake is a test failure (denials must be side-effect free), recorded
// in state.writes.
jest.mock('../models/db', () => {
  const state = { scheduledServices: [], writes: [] };
  const normCol = (c) => String(c).replace(/^scheduled_services\./, '');
  const cmp = (a, op, v) => {
    if (op === '>') return a > v;
    if (op === '>=') return a >= v;
    if (op === '<') return a < v;
    if (op === '<=') return a <= v;
    return a === v;
  };
  const dbFn = (table) => {
    const builder = {
      _where: {},
      _cmp: [],
      _notIn: [],
      where(w, op, val) {
        if (w && typeof w === 'object') Object.assign(builder._where, w);
        else if (val !== undefined) builder._cmp.push([w, op, val]);
        else builder._where[w] = op;
        return builder;
      },
      andWhere(...args) { return builder.where(...args); },
      whereNot(col, val) { builder._notIn.push([col, [val]]); return builder; },
      whereNotIn(col, vals) { builder._notIn.push([col, vals]); return builder; },
      whereIn() { return builder; },
      modify(cb) { cb(builder); return builder; },
      leftJoin() { return builder; },
      forUpdate() { return builder; },
      orderBy() { return builder; },
      select() { return builder; },
      async first() {
        if (table !== 'scheduled_services') return undefined;
        const found = state.scheduledServices.find((r) =>
          Object.entries(builder._where).every(([k, v]) => r[normCol(k)] === v)
          && builder._cmp.every(([c, op, v]) => cmp(r[normCol(c)], op, v))
          && builder._notIn.every(([c, vals]) => !vals.includes(r[normCol(c)])));
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
  dbFn.transaction = async (cb) => {
    const trx = (table) => dbFn(table);
    trx.raw = async () => ({});
    return cb(trx);
  };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const { etDateString, addETDays } = require('../utils/datetime-et');
const scheduleRouter = require('../routes/admin-schedule');
const customersRouter = require('../routes/admin-customers');

const { scopeToAssignedTech, technicianOwnsScheduledService } = scheduleRouter._test;
const {
  technicianServicesCustomer, techSafeListRow, techSafeListFilters, techSafeSort,
  techSafe360Payload,
  TECH_LIST_STRIPPED_FIELDS, TECH_360_STRIPPED_KEYS, TECH_360_STRIPPED_CUSTOMER_FIELDS,
} = customersRouter._private;

const daysFromNow = (n) => etDateString(addETDays(new Date(), n));

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
    { id: 'svc-own', technician_id: 'tech-1', customer_id: 'cust-own', status: 'pending', scheduled_date: daysFromNow(3) },
    { id: 'svc-other', technician_id: 'tech-2', customer_id: 'cust-other', status: 'pending', scheduled_date: daysFromNow(3) },
    // Assignment-currency fixtures:
    { id: 'svc-recent', technician_id: 'tech-1', customer_id: 'cust-recent', status: 'completed', scheduled_date: daysFromNow(-2) },
    { id: 'svc-stale', technician_id: 'tech-1', customer_id: 'cust-stale', status: 'completed', scheduled_date: daysFromNow(-45) },
    { id: 'svc-stale-pending', technician_id: 'tech-1', customer_id: 'cust-stale-pending', status: 'pending', scheduled_date: daysFromNow(-45) },
    { id: 'svc-dead', technician_id: 'tech-1', customer_id: 'cust-dead', status: 'cancelled', scheduled_date: daysFromNow(3) },
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

  test('next-visit is scoped to the tech\'s own assignments — another tech\'s customer yields null, not their visit', async () => {
    const { status, body } = await call('GET', '/api/admin/schedule/next-visit?customerId=cust-other');
    expect(status).toBe(200);
    expect(body.nextVisit).toBeNull();
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

  test('technician owns their live assigned visit (read and mutation)', async () => {
    await expect(technicianOwnsScheduledService(reqFor('technician'), 'svc-own')).resolves.toBe(true);
    await expect(technicianOwnsScheduledService(reqFor('technician'), 'svc-own', { forMutation: true })).resolves.toBe(true);
  });

  test('technician does not own another tech\'s visit or a missing one', async () => {
    await expect(technicianOwnsScheduledService(reqFor('technician'), 'svc-other')).resolves.toBe(false);
    await expect(technicianOwnsScheduledService(reqFor('technician'), 'svc-nope')).resolves.toBe(false);
  });

  test('a recently completed own visit reads but does not authorize mutation', async () => {
    await expect(technicianOwnsScheduledService(reqFor('technician'), 'svc-recent')).resolves.toBe(true);
    await expect(technicianOwnsScheduledService(reqFor('technician'), 'svc-recent', { forMutation: true })).resolves.toBe(false);
  });

  test('stale or dead own visits authorize nothing', async () => {
    await expect(technicianOwnsScheduledService(reqFor('technician'), 'svc-stale')).resolves.toBe(false);
    await expect(technicianOwnsScheduledService(reqFor('technician'), 'svc-stale-pending')).resolves.toBe(false);
    await expect(technicianOwnsScheduledService(reqFor('technician'), 'svc-dead')).resolves.toBe(false);
  });
});

describe('scopeToAssignedTech', () => {
  const fakeQuery = () => {
    const calls = [];
    return {
      calls,
      where(...args) { calls.push(['where', ...args]); return this; },
      whereNotIn(...args) { calls.push(['whereNotIn', ...args]); return this; },
    };
  };

  test('technician requests get the FULL current-assignment predicate, not just technician_id', () => {
    const q = fakeQuery();
    scopeToAssignedTech({ techRole: 'technician', technicianId: 'tech-1' }, q);
    expect(q.calls).toContainEqual(['where', 'scheduled_services.technician_id', 'tech-1']);
    // Dead statuses excluded — ?status=all on /list must not re-open them.
    expect(q.calls.some(([op, col]) => op === 'whereNotIn' && col === 'scheduled_services.status')).toBe(true);
    // Date window — ?from=<years ago> must not re-open the archive.
    expect(q.calls.some(([op, col, cmp]) => op === 'where' && col === 'scheduled_services.scheduled_date' && cmp === '>=')).toBe(true);
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

  test('latest-scheduled-service prefill is the tech\'s OWN visit, not another tech\'s follow-up', async () => {
    db.__state.scheduledServices = [
      // Office already booked a follow-up with ANOTHER tech — listed first
      // so an unscoped query would surface it.
      { id: 'svc-follow-up', technician_id: 'tech-2', customer_id: 'cust-own', status: 'pending', scheduled_date: daysFromNow(10) },
      { id: 'svc-own', technician_id: 'tech-1', customer_id: 'cust-own', status: 'pending', scheduled_date: daysFromNow(3) },
    ];
    const { status, body } = await call('GET', '/api/admin/customers/cust-own/latest-scheduled-service');
    expect(status).toBe(200);
    expect(body.service.id).toBe('svc-own');
  });

  test('only CURRENT assignments authorize: recent completion yes, stale or cancelled no', async () => {
    const tech = { techRole: 'technician', technicianId: 'tech-1' };
    // Completed 2 days ago — inside the post-visit paperwork window.
    await expect(technicianServicesCustomer(tech, 'cust-recent')).resolves.toBe(true);
    // Completed 45 days ago — a dead assignment grants nothing.
    await expect(technicianServicesCustomer(tech, 'cust-stale')).resolves.toBe(false);
    // A never-actioned pending row from 45 days ago is equally dead.
    await expect(technicianServicesCustomer(tech, 'cust-stale-pending')).resolves.toBe(false);
    // Cancelled visit — never authorizes, even with a future date.
    await expect(technicianServicesCustomer(tech, 'cust-dead')).resolves.toBe(false);
  });
});

describe('techSafe360Payload', () => {
  test('strips billing/comms/CRM keys and customer financial fields, keeps service context', () => {
    const payload = {
      customer: {
        id: 'c1', firstName: 'Pat', phone: '941', tier: 'gold',
        monthlyRate: 89, annualValue: 1068, lifetimeRevenue: 5000, payerId: 'payer-1',
        billingMode: 'invoice', pipelineStage: 'active_customer', leadScore: 90,
        crmNotes: 'internal', referralCode: 'WAVES-XYZ1',
        address: { line1: '1 Main' }, property: { type: 'residential' },
      },
      accountProperties: [{ id: 'p1', monthlyRate: 89, pipelineStage: 'won', address: { line1: '1 Main' } }],
      interactions: [{ id: 1 }], smsLog: [{ id: 1 }], payments: [{ id: 1 }],
      invoices: [{ id: 1 }], cards: [{ id: 1 }], paymentMethodConsents: [{ id: 1 }],
      contracts: [{ id: 1 }], annualPrepayTerms: [{ id: 1 }], prepaidPlans: [{ id: 1 }],
      notificationPrefs: {}, referralInfo: {}, customerDiscounts: [{ id: 1 }],
      healthScore: 88, tags: ['vip'],
      preferences: { gate_code: '1234' }, services: [{ id: 's1' }],
      scheduled: [{ id: 'v1' }], upcomingScheduled: [{ id: 'v2' }],
      photos: [{ id: 'ph1' }], complianceRecords: [], nutrientLedger: { rows: [] },
      estimates: [{ id: 'e1' }],
    };
    const safe = techSafe360Payload(payload);
    for (const key of TECH_360_STRIPPED_KEYS) expect(safe).not.toHaveProperty(key);
    for (const field of TECH_360_STRIPPED_CUSTOMER_FIELDS) expect(safe.customer).not.toHaveProperty(field);
    expect(safe.customer).toEqual(expect.objectContaining({ id: 'c1', tier: 'gold' }));
    // Sibling-property addresses never ride a per-customer authorization.
    expect(safe).not.toHaveProperty('accountProperties');
    // Field-relevant context survives.
    expect(safe.preferences).toEqual({ gate_code: '1234' });
    expect(safe.services).toHaveLength(1);
    expect(safe.upcomingScheduled).toHaveLength(1);
    expect(safe.photos).toHaveLength(1);
    expect(safe.estimates).toHaveLength(1);
    // Original payload untouched (admin path reuses it).
    expect(payload.cards).toHaveLength(1);
    expect(payload.customer.monthlyRate).toBe(89);
  });
});

describe('invoice mint in-lock ownership recheck', () => {
  const { mintScheduledServiceInvoiceWithDeposit } = scheduleRouter._test;

  test('an assertEligibleInTrx failure aborts inside the lock — no invoice, no retry masking', async () => {
    const denied = Object.assign(new Error('Scheduled service not found'), { status: 404 });
    await expect(mintScheduledServiceInvoiceWithDeposit({
      // source_estimate_id set: without the fast rethrow, the deposit
      // retry ladder would swallow the auth failure into two extra
      // attempts before surfacing it.
      svc: { id: 'svc-own', source_estimate_id: 'est-1' },
      buildCreateParams: () => ({}),
      assertEligibleInTrx: async () => { throw denied; },
    })).rejects.toMatchObject({ status: 404 });
    expect(db.__state.writes).toHaveLength(0);
  });
});

describe('tech directory filter/sort sanitization', () => {
  test('techSafeListFilters drops CRM/financial filters — membership under ?hasBalance=true IS the stripped field', () => {
    const sanitized = techSafeListFilters({
      search: 'lee', stage: 'won', tier: 'gold', tag: 'vip', source: 'ads',
      area: 'sarasota', city: 'Venice', cards: 'true', hasBalance: 'true', lastVisited: '30',
    });
    expect(sanitized).toEqual({ search: 'lee', tier: 'gold', area: 'sarasota', city: 'Venice', lastVisited: '30' });
  });

  test('techSafeSort clamps sorts over stripped fields to name', () => {
    expect(techSafeSort('revenue')).toBe('name');
    expect(techSafeSort('lead_score')).toBe('name');
    expect(techSafeSort('last_contact')).toBe('name');
    expect(techSafeSort('rate')).toBe('name'); // monthlyRate is stripped — its sort goes too
    expect(techSafeSort('name')).toBe('name');
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
      address: '1 Main St', tier: 'gold',
    }));
    expect(safe).not.toHaveProperty('monthlyRate');
  });
});
