/**
 * Audit repro r1-platform-3: /api/admin/ical-history is guarded only by
 * adminAuthenticate + requireTechOrAdmin, so a role='technician' staff token
 * can read every legacy appointment row (name/phone/email/address/price) and
 * the company's revenue aggregates (stats.total_revenue, timeline[].revenue).
 *
 * Expected behaviour asserted here: a technician token gets 403 on both
 * routes (financial / PII export is owner-only, like admin-dashboard,
 * admin-kpi-targets and admin-equipment financials); an admin token still
 * gets 200 (control).
 *
 * Runs only against a private clone, e.g.:
 *   DATABASE_URL=postgres://wavespestcontrol@localhost:5432/waves_audit_fixauthz_1 \
 *     npx jest --runInBand tests/admin-ical-history-tech-authz.pg.test.js
 * The router reads req.app.get('db'), so a real knex on the clone is handed
 * to the app; only adminAuthenticate is stubbed to inject the caller's role.
 * requireTechOrAdmin / requireAdmin are the REAL middleware. Skipped (not
 * failed) whenever DATABASE_URL is absent or is not a waves_audit_* clone —
 * so CI's own DATABASE_URL (e.g. a shared waves_test database) never gets
 * mutated by this suite's setup/teardown, and normal `jest` discovery never
 * throws for lack of a DB.
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
      req.technician = { id: 'staff-1', role: mockCurrentRole };
      req.technicianId = 'staff-1';
      req.techRole = mockCurrentRole;
      return next();
    },
  };
});

const express = require('express');
const knex = require('knex');
const icalRouter = require('../routes/admin-ical-history');

const SKIP = !/waves_audit_/.test(process.env.DATABASE_URL || '');
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('r1-platform-3: /api/admin/ical-history is owner-only', () => {
  let db, server, baseUrl;

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 2 } });
    await db('ical_appointments').del();
    await db('ical_appointments').insert([
      {
        ical_uid: 'audit-r1p3-1', customer_name: 'Legacy Customer One', phone: '9415550101',
        email: 'one@example.com', address: '1 Legacy Ln, Bradenton FL', service_type: 'Pest Control',
        price: 150.00, scheduled_date: '2025-03-10T14:00:00Z', status: 'completed',
      },
      {
        ical_uid: 'audit-r1p3-2', customer_name: 'Legacy Customer Two', phone: '9415550102',
        email: 'two@example.com', address: '2 Legacy Ln, Sarasota FL', service_type: 'Lawn Care',
        price: 275.50, scheduled_date: '2025-04-12T15:00:00Z', status: 'completed',
      },
    ]);

    const app = express();
    app.use(express.json());
    app.set('db', db);
    app.use('/api/admin/ical-history', icalRouter);
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) {
      await db('ical_appointments').where('ical_uid', 'like', 'audit-r1p3-%').del();
      await db.destroy();
    }
  });

  async function get(path) {
    const res = await fetch(`${baseUrl}${path}`);
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: json || {} };
  }

  test('control: admin token reads the legacy list with revenue stats', async () => {
    mockCurrentRole = 'admin';
    const res = await get('/api/admin/ical-history?limit=1000');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(Number(res.body.stats.total_revenue)).toBeCloseTo(425.5, 2);
  });

  test('technician token is refused on GET /api/admin/ical-history', async () => {
    mockCurrentRole = 'technician';
    const res = await get('/api/admin/ical-history?limit=1000');
    // Diagnostic: what a technician actually receives on current code.
    const leaked = {
      status: res.status,
      total_revenue: res.body?.stats?.total_revenue,
      rows: (res.body?.appointments || []).map((r) => ({ name: r.customer_name, email: r.email, phone: r.phone, price: r.price })),
    };
    expect({ leaked, status: res.status }).toEqual({ leaked, status: 403 });
  });

  test('technician token is refused on GET /api/admin/ical-history/timeline', async () => {
    mockCurrentRole = 'technician';
    const res = await get('/api/admin/ical-history/timeline');
    const leaked = { status: res.status, timeline: res.body?.timeline };
    expect({ leaked, status: res.status }).toEqual({ leaked, status: 403 });
  });
});
