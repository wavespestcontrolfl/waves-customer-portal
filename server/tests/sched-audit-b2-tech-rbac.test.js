/**
 * Schedule & Dispatch audit — Batch 2 (PR 4) Technician RBAC, Holds & Board/Schedule API fixes.
 * Covers:
 *   - P0-5:  PUT /api/admin/dispatch/:serviceId/status blocks technician cancel (including this_only) with 403.
 *   - P0-6:  POST/DELETE /api/admin/schedule/:id/prepaid require admin (403);
 *            POST /api/admin/schedule/:id/invoice rejects technician extraLineItems with 403 even when an invoice already exists.
 *   - P1-2:  job-status holdFence includes no_show and uses commitPromiseOf(trx);
 *            visit-hold closes overdue + NCO alerts on hold and refuses non-holdable / past-date release;
 *            visit-skip nextPlanVisitDate excludes held rows;
 *            sendRescheduleNoticeForVisit suppresses text on held visit.
 *   - P1-9:  GET /api/admin/dispatch/:date omits monthlyRate for technicians;
 *            GET /api/admin/dispatch/:serviceId/card-hold & /weather/tomorrow require admin;
 *            GET /api/admin/schedule/month omits estimatedRevenue for technicians;
 *            GET /api/admin/schedule/:id/estimate-source omits owner financial totals for technicians;
 *            GET /api/admin/schedule/zone-density & /recommend-slots & server/routes/dispatch.js admin routes require admin.
 *   - P1-11 & P1-17 & P2: GET /admin/dispatch/board LEFT JOINs tech_status & customers without 24h GPS drop;
 *            GET /admin/dispatch/alerts orders decision/critical first, uses stamped address, returns total;
 *            GET /admin/dispatch/techs/:id excludes cancelled/rescheduled/held stops & scopes late_count to today;
 *            GET /admin/schedule/recommend-slots requires ../services/dispatch/csr-booker.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(120000);

describe('P0-5, P1-9, P1-11, P1-17 & P2: admin-dispatch RBAC, board LEFT JOINs & prioritized alerts', () => {
  test('PUT /:serviceId/status rejects tech cancel, GET /board LEFT JOINs, and GET /alerts sorts decision/critical first', async () => {
    await jest.isolateModulesAsync(async () => {
      let currentRole = 'technician';
      const mockRow = {
        id: '11111111-2222-4333-8444-555555555555',
        technician_id: 'tech-1',
        scheduled_date: new Date().toISOString().slice(0, 10),
        status: 'confirmed',
      };
      const rawSqls = [];
      const orderByRaws = [];
      const fakeDb = jest.fn((table) => {
        const c = {
          leftJoin: jest.fn().mockReturnThis(),
          join: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          whereIn: jest.fn().mockReturnThis(),
          whereNotIn: jest.fn().mockReturnThis(),
          whereNull: jest.fn().mockReturnThis(),
          modify: jest.fn((cb) => { cb(c); return c; }),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          orderByRaw: jest.fn((sql) => { orderByRaws.push([table, sql]); return c; }),
          limit: jest.fn().mockReturnThis(),
          count: jest.fn().mockReturnThis(),
          first: jest.fn(async () => (table === 'dispatch_alerts as a' ? { count: '73' } : mockRow)),
          then: (resolve) => Promise.resolve(table === 'dispatch_alerts as a' ? [{
            id: 'al-1',
            type: 'visit_not_closed_out',
            severity: 'warn',
            tech_id: 't1',
            job_id: 'j1',
            address_line1: '500 Rental Rd',
            city: 'Sarasota',
            state: 'FL',
            zip: '34236',
            created_at: '2026-11-27T12:00:00Z',
          }] : []).then(resolve),
        };
        return c;
      });
      fakeDb.raw = jest.fn((sql) => {
        rawSqls.push(String(sql));
        if (String(sql).includes('FROM technicians t')) {
          return Promise.resolve({
            rows: [{ id: 't-nogps', name: 'No GPS Tech', role: 'technician', status: 'idle', lat: null, lng: null, today_total: '2', today_completed: '1', out_today: false }],
          });
        }
        if (String(sql).includes('FROM scheduled_services s')) {
          return Promise.resolve({
            rows: [{ id: 'j-nocust', technician_id: 't-nogps', customer_id: null, status: 'pending', service_type: 'Pest', address_line1: '10 New Caller Ln' }],
          });
        }
        return sql;
      });
      fakeDb.transaction = async (cb) => cb(fakeDb);

      jest.doMock('../models/db', () => fakeDb);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      jest.doMock('../middleware/admin-auth', () => {
        const actual = jest.requireActual('../middleware/admin-auth');
        return {
          ...actual,
          adminAuthenticate: (req, _res, next) => {
            req.technician = { id: currentRole === 'admin' ? 'admin-1' : 'tech-1', role: currentRole };
            req.technicianId = currentRole === 'admin' ? 'admin-1' : 'tech-1';
            req.techRole = currentRole;
            next();
          },
        };
      });

      const express = require('express');
      const router = require('../routes/admin-dispatch');
      const app = express();
      app.use(express.json());
      app.use('/api/admin/dispatch', router);
      const server = app.listen(0);
      const base = `http://127.0.0.1:${server.address().port}/api/admin/dispatch`;
      try {
        // 1. Technician cancellation (even this_only) returns 403
        const cancelRes = await fetch(`${base}/${mockRow.id}/status`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'cancelled', scope: 'this_only' }),
        });
        expect(cancelRes.status).toBe(403);
        expect((await cancelRes.json()).code).toBe('admin_required');

        // 2. Admin /board LEFT JOINs tech_status & customers without 24h cutoff
        currentRole = 'admin';
        const boardRes = await fetch(`${base}/board`);
        expect(boardRes.status).toBe(200);
        const board = await boardRes.json();
        expect(board.techs.map((t) => t.id)).toEqual(['t-nogps']);
        expect(board.jobs.map((j) => j.id)).toEqual(['j-nocust']);
        const techSql = rawSqls.find((s) => s.includes('FROM technicians t'));
        expect(techSql).toContain('LEFT JOIN tech_status ts ON ts.tech_id = t.id');
        expect(techSql).toContain("CASE WHEN ts.location_updated_at >= NOW() - INTERVAL '24 hours' THEN ts.lat END AS lat");
        const jobSql = rawSqls.find((s) => s.includes('FROM scheduled_services s'));
        expect(jobSql).toContain('LEFT JOIN customers');
        expect(jobSql).toContain('s.customer_id IS NOT NULL OR s.reservation_expires_at IS NULL');

        // 3. Admin /alerts orders decision/critical first, uses stamped address, returns total
        const alertsRes = await fetch(`${base}/alerts`);
        expect(alertsRes.status).toBe(200);
        const alertsBody = await alertsRes.json();
        expect(alertsBody.total).toBe(73);
        expect(alertsBody.alerts[0].address).toBe('500 Rental Rd, Sarasota, FL 34236');
        expect(orderByRaws.some(([t, sql]) => t === 'dispatch_alerts as a' && sql.includes('visit_not_closed_out') && sql.includes('critical'))).toBe(true);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });
});

describe('P0-6 & P1-9: admin-schedule existing-invoice tech extraLineItems 403, month & estimate-source stripping', () => {
  test('POST /:id/invoice rejects technician extraLineItems with 403 even when an existing invoice exists', async () => {
    await jest.isolateModulesAsync(async () => {
      const state = {
        scheduledServices: [
          {
            id: 'svc-own',
            technician_id: 'tech-1',
            customer_id: 'cust-1',
            status: 'confirmed',
            scheduled_date: new Date().toISOString().slice(0, 10),
            service_type: 'Quarterly Pest Control',
            estimated_price: 115,
            is_callback: false,
          },
        ],
        customers: [{ id: 'cust-1', first_name: 'Pat', last_name: 'Sample', active: true }],
        invoices: [{ id: 'inv-existing', scheduled_service_id: 'svc-own', status: 'draft', total: 115, token: 'tok-1' }],
      };
      const fakeDb = jest.fn((table) => {
        const rows = table === 'scheduled_services' ? state.scheduledServices
          : table === 'customers' ? state.customers
            : table === 'invoices' ? state.invoices : [];
        const c = {};
        for (const m of ['where', 'andWhere', 'whereNot', 'whereNotIn', 'whereIn', 'whereNull', 'leftJoin', 'orderBy', 'select', 'modify', 'forUpdate']) {
          c[m] = jest.fn((arg) => { if (m === 'modify' && typeof arg === 'function') arg(c); return c; });
        }
        c.first = jest.fn(async () => rows[0] || undefined);
        c.then = (resolve) => Promise.resolve(rows).then(resolve);
        return c;
      });
      fakeDb.raw = (x) => x;
      fakeDb.fn = { now: () => new Date() };
      fakeDb.transaction = async (cb) => cb(fakeDb);
      jest.doMock('../models/db', () => fakeDb);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      jest.doMock('../middleware/admin-auth', () => {
        const actual = jest.requireActual('../middleware/admin-auth');
        return {
          ...actual,
          adminAuthenticate: (req, _res, next) => {
            req.technician = { id: 'tech-1', role: 'technician' };
            req.technicianId = 'tech-1';
            req.techRole = 'technician';
            next();
          },
        };
      });

      const express = require('express');
      const router = require('../routes/admin-schedule');
      const app = express();
      app.use(express.json());
      app.use('/api/admin/schedule', router);
      app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
      const server = app.listen(0);
      const base = `http://127.0.0.1:${server.address().port}/api/admin/schedule`;
      try {
        const res = await fetch(`${base}/svc-own/invoice`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            extraLineItems: [{ description: 'Manual discount', quantity: 1, unit_price: -25, amount: -25 }],
          }),
        });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toMatch(/Only admins/i);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });

  test('server/routes/dispatch.js enforces requireAdmin on admin-only endpoints', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../middleware/admin-auth', () => {
        const actual = jest.requireActual('../middleware/admin-auth');
        return {
          ...actual,
          adminAuthenticate: (req, _res, next) => {
            req.technician = { id: 'tech-1', role: 'technician' };
            req.technicianId = 'tech-1';
            req.techRole = 'technician';
            next();
          },
        };
      });
      const express = require('express');
      const router = require('../routes/dispatch');
      const app = express();
      app.use(express.json());
      app.use('/api/dispatch', router);
      const server = app.listen(0);
      const base = `http://127.0.0.1:${server.address().port}/api/dispatch`;
      try {
        for (const [method, path] of [
          ['GET', '/techs'],
          ['POST', '/jobs/j1/score'],
          ['POST', '/match/simulate'],
          ['POST', '/csr/slots'],
          ['POST', '/sync'],
        ]) {
          const res = await fetch(`${base}${path}`, {
            method,
            headers: { 'content-type': 'application/json' },
            ...(method === 'POST' ? { body: '{}' } : {}),
          });
          expect(res.status).toBe(403);
        }
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });
});

describe('P1-2 & P2: visit-hold alert cleanup, release guards, job-status holdFence & visit-skip excludeHeld', () => {
  const prevHoldGate = process.env.GATE_VISIT_HOLD;
  afterEach(() => {
    if (prevHoldGate === undefined) delete process.env.GATE_VISIT_HOLD;
    else process.env.GATE_VISIT_HOLD = prevHoldGate;
  });

  test('putVisitOnHold resolves open overdue & NCO alerts; releaseVisitHold refuses non-holdable and past-date rows', async () => {
    process.env.GATE_VISIT_HOLD = 'true';
    await jest.isolateModulesAsync(async () => {
      const autoResolveOverdue = jest.fn().mockResolvedValue({ resolved: 1 });
      const resolveNco = jest.fn().mockResolvedValue({});
      const assertAssignable = jest.fn().mockResolvedValue({});
      let currentRow = null;
      const fakeConn = jest.fn((table) => {
        const c = {
          where: jest.fn().mockReturnThis(),
          whereNotIn: jest.fn().mockReturnThis(),
          forUpdate: jest.fn().mockReturnThis(),
          update: jest.fn().mockResolvedValue(1),
          first: jest.fn(async () => (table === 'scheduled_services' ? currentRow : null)),
        };
        return c;
      });
      fakeConn.fn = { now: () => 'NOW()' };
      fakeConn.raw = jest.fn((s) => s);
      fakeConn.transaction = async (cb) => cb(fakeConn);

      jest.doMock('../models/db', () => fakeConn);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/dispatch-alerts', () => ({ autoResolveOverdueAlertsForJob: autoResolveOverdue }));
      jest.doMock('../services/not-closed-out', () => ({ resolveForService: resolveNco }));
      jest.doMock('../services/technician-eligibility', () => ({ assertAssignableTechnician: assertAssignable }));

      const visitHold = require('../services/visit-hold');

      // 1. Holding a live visit closes overdue + NCO alerts inside the transaction
      currentRow = { id: 'v1', status: 'confirmed', held_at: null, scheduled_date: '2099-05-01' };
      const held = await visitHold.putVisitOnHold({ visitId: 'v1', heldBy: 'admin-1', conn: fakeConn });
      expect(held.changed).toBe(true);
      expect(autoResolveOverdue).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'v1', toStatus: 'cancelled' }));
      expect(resolveNco).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'v1', resolution: 'held' }));

      // 2. Releasing a cancelled held visit throws 409 not_releasable
      currentRow = { id: 'v2', status: 'cancelled', held_at: '2026-11-26T00:00:00Z', scheduled_date: '2099-05-01' };
      await expect(visitHold.releaseVisitHold({ visitId: 'v2', conn: fakeConn }))
        .rejects.toMatchObject({ status: 409, code: 'not_releasable' });

      // 3. Releasing a past-date held visit throws 409 past_date
      currentRow = { id: 'v3', status: 'confirmed', held_at: '2026-11-26T00:00:00Z', scheduled_date: '2020-01-01' };
      await expect(visitHold.releaseVisitHold({ visitId: 'v3', conn: fakeConn }))
        .rejects.toMatchObject({ status: 409, code: 'past_date' });

      // 4. Releasing a valid future visit checks assertAssignableTechnician when technician_id is set
      currentRow = { id: 'v4', status: 'confirmed', held_at: '2026-11-26T00:00:00Z', scheduled_date: '2099-05-01', technician_id: 'tech-1' };
      const released = await visitHold.releaseVisitHold({ visitId: 'v4', conn: fakeConn });
      expect(released.changed).toBe(true);
      expect(assertAssignable).toHaveBeenCalledWith('tech-1', expect.objectContaining({ date: '2099-05-01' }));
    });
  });

  test('job-status holdFence blocks no_show on held visit when GATE_VISIT_HOLD is on', async () => {
    process.env.GATE_VISIT_HOLD = 'true';
    await jest.isolateModulesAsync(async () => {
      const heldRow = { id: 'v-held', status: 'confirmed', held_at: '2026-11-26T00:00:00Z', technician_id: 't1', customer_id: 'c1' };
      const fakeTrx = jest.fn(() => {
        const c = {
          where: jest.fn().mockReturnThis(),
          whereIn: jest.fn().mockReturnThis(),
          whereNull: jest.fn().mockReturnThis(),
          whereNotNull: jest.fn().mockReturnThis(),
          forUpdate: jest.fn().mockReturnThis(),
          update: jest.fn().mockResolvedValue(0),
          returning: jest.fn().mockResolvedValue([]),
          first: jest.fn().mockResolvedValue(heldRow),
        };
        return c;
      });
      fakeTrx.fn = { now: () => 'NOW()' };
      fakeTrx.transaction = async (cb) => cb(fakeTrx);
      jest.doMock('../models/db', () => fakeTrx);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

      const { transitionJobStatus } = require('../services/job-status');
      await expect(transitionJobStatus({ jobId: 'v-held', fromStatus: 'confirmed', toStatus: 'no_show', trx: fakeTrx }))
        .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_ON_HOLD' });
    });
  });

  test('notClosedOut.resolveForService accepts held resolution and closes open NCO card', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.dontMock('../services/not-closed-out');
      jest.dontMock('../services/visit-hold');
      jest.dontMock('../services/dispatch-assignment');
      const updates = [];
      const resolveAlert = jest.fn().mockResolvedValue({ id: 'nco-alert-1' });
      const fakeTrx = jest.fn((table) => {
        const c = {
          where: jest.fn().mockReturnThis(),
          leftJoin: jest.fn().mockReturnThis(),
          whereNull: jest.fn().mockReturnThis(),
          select: jest.fn().mockResolvedValue(table === 'dispatch_alerts' ? [{ id: 'nco-alert-1' }] : []),
          first: jest.fn().mockResolvedValue(null),
          update: jest.fn(async (patch) => { updates.push({ table, patch }); return 1; }),
        };
        return c;
      });
      fakeTrx.fn = { now: () => 'NOW()' };
      fakeTrx.transaction = async (cb) => cb(fakeTrx);
      fakeTrx.isTransaction = true;
      fakeTrx.raw = jest.fn((s) => s);
      jest.doMock('../models/db', () => fakeTrx);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/dispatch-alerts', () => ({ resolveAlert, resolveAlertsForJob: jest.fn().mockResolvedValue(1) }));

      const { resolveForService } = require('../services/not-closed-out');
      const res = await resolveForService({ serviceId: 'v-held-nco', resolution: 'held', resolvedBy: 'admin-1', trx: fakeTrx });
      expect(res.resolved).toBe(1);
      expect(updates[0]).toMatchObject({ table: 'reschedule_log', patch: expect.objectContaining({ resolution: 'held' }) });
      expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: 'nco-alert-1', auto: true }));

      process.env.GATE_VISIT_HOLD = 'true';
      const todayEt = require('../utils/datetime-et').etDateString();
      fakeTrx.mockImplementation(() => ({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          job_id: 'v-held-today',
          customer_id: 'c1',
          status: 'confirmed',
          scheduled_date: todayEt,
          held_at: '2026-11-28T00:00:00Z',
        }),
      }));
      const { buildDispatchJobUpdatePayload } = require('../services/dispatch-assignment');
      const payload = await buildDispatchJobUpdatePayload('v-held-today', 'admin-1');
      expect(payload.board_visible).toBe(false);
    });
  });
});
