/**
 * Audit repro r2-sched-update-details-financials-2 — PUT /:id/update-details
 * no-add-on price branch (admin-schedule.js ~10297-10404) and the multi-line
 * add-on branch (~10012-10046) accepted a NEGATIVE custom discount amount /
 * a NEGATIVE price and persisted estimated_price above gross / below zero.
 *
 * Real Postgres, run with UPDATE_DETAILS_NEGATIVE_MONEY_TEST_DATABASE_URL
 * pointing at a disposable localhost/dev database. Gated + isolated the same
 * way update-details-discount-preserved-no-addons-pg.test.js and
 * admin-arrival-window-save-db.test.js are: skipped entirely when the env
 * var is unset (so a plain `npm test` / CI run without it never connects),
 * and every fixture row + write lives in a transaction that is rolled back
 * in afterEach — nothing here is ever committed.
 *
 * EXPECTED (asserted): the save is refused (4xx) OR the stored estimated_price
 * never exceeds the gross / never goes below zero — the clamp the create path
 * (calculateDiscountDollars, :1790-1815) and the add-on branch (toMoney,
 * :10003-10007) already enforce.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit-repro-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: '10000000-0000-4000-8000-000000000001', role: 'admin' };
    req.technicianId = '10000000-0000-4000-8000-000000000001';
    req.techRole = 'admin';
    next();
  },
}));
jest.mock('../services/dispatch-assignment', () => ({
  ...jest.requireActual('../services/dispatch-assignment'),
  emitDispatchJobUpdate: jest.fn(),
}));
jest.mock('../services/tech-visit-notifications', () => ({
  notifyAssignmentChange: jest.fn().mockResolvedValue(null),
  notifyVisitRescheduled: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/appointment-tagger', () => ({
  classifyAppointmentType: jest.fn(() => ({ tag: 'general' })),
}));
jest.mock('../services/geocoder', () => ({
  ...jest.requireActual('../services/geocoder'), geocodeAddress: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/visit-groups', () => ({
  ...jest.requireActual('../services/visit-groups'),
  maybeGroupRow: jest.fn().mockResolvedValue(null),
  handleChildStopChanged: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/appointment-reminders', () => ({
  releaseMoveHoldIfRepaired: jest.fn().mockResolvedValue(null),
  handleReschedule: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/appointment-address', () => ({
  ...jest.requireActual('../services/appointment-address'),
  refreshAppointmentAddressBriefs: jest.fn().mockResolvedValue(null),
}));

// Same routing-proxy pattern as update-details-discount-preserved-no-addons-pg.test.js:
// every `db(...)` call the route makes (and every call this file makes) goes
// through the SAME per-test transaction, so nothing here can ever write
// outside a rollback.
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = async (...args) => mockConn.transaction(...args);
  Object.defineProperty(proxy, 'fn', { get: () => mockConn.fn });
  return proxy;
});

const knex = require('knex');
const express = require('express');
const router = require('../routes/admin-schedule');

const connection = process.env.UPDATE_DETAILS_NEGATIVE_MONEY_TEST_DATABASE_URL;
const describeDb = connection ? describe : describe.skip;

const GROSS = 100;
const CUSTOMER = '30000000-0000-4000-8000-000000000021';

describeDb('r2-sched-update-details-financials-2: negative discount / negative price on the no-add-on branch (PostgreSQL)', () => {
  let database;
  let server;
  let baseUrl;
  let serviceCounter = 0;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/api/admin/schedule', router);
    app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500)
      .json({ error: error.message, code: error.code }));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.destroy();
  });

  let serviceId;
  beforeEach(async () => {
    mockConn = await database.transaction();
    await mockConn('customers').insert({
      id: CUSTOMER, first_name: 'Audit', last_name: 'R2UpdDet2', phone: '5550000043',
      email: `audit-r2-upddet2-${Date.now()}@example.com`,
    }).onConflict('id').merge();
    serviceCounter += 1;
    serviceId = `40000000-0000-4000-8000-0000000000${String(serviceCounter).padStart(2, '0')}`;
    await mockConn('scheduled_services').insert({
      id: serviceId,
      customer_id: CUSTOMER,
      scheduled_date: '2099-01-15',
      service_type: 'Quarterly Pest Control',
      status: 'pending',
      is_recurring: false,
      estimated_price: GROSS,
      primary_line_price: GROSS,
    });
  });
  afterEach(async () => { await mockConn.rollback(); });

  async function readEconomics() {
    return mockConn('scheduled_services').where({ id: serviceId })
      .first('estimated_price', 'primary_line_price', 'discount_type', 'discount_amount', 'discount_dollars');
  }

  async function put(body) {
    const res = await fetch(`${baseUrl}/api/admin/schedule/${serviceId}/update-details`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  test('custom percentage -50 on a $100 visit must not persist estimated_price above gross', async () => {
    const { status, json } = await put({ estimatedPrice: GROSS, discountType: 'percentage', discountAmount: -50 });
    const after = await readEconomics();
    if (status === 200) {
      expect(Number(after.estimated_price)).toBeLessThanOrEqual(GROSS);
      expect(Number(after.discount_amount ?? 0)).toBeGreaterThanOrEqual(0);
    } else {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      void json;
    }
  });

  test('custom fixed_amount -25 on a $100 visit must not persist estimated_price above gross', async () => {
    const { status, json } = await put({ estimatedPrice: GROSS, discountType: 'fixed_amount', discountAmount: -25 });
    const after = await readEconomics();
    if (status === 200) {
      expect(Number(after.estimated_price)).toBeLessThanOrEqual(GROSS);
    } else {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      void json;
    }
  });

  test('negative estimatedPrice -40 must be refused or never stored', async () => {
    const { status, json } = await put({ estimatedPrice: -40 });
    const after = await readEconomics();
    if (status === 200) {
      expect(Number(after.estimated_price)).toBeGreaterThanOrEqual(0);
    } else {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      void json;
    }
  });

  // Shape 3 from the brief (r1-money-3): an add-on line with a negative
  // per-line discount, via the multi-line `addons` branch of the same
  // handler (no UI editor for this — direct API call only).
  test('add-on line with fixed_amount -25 discount must not persist an inflated add-on price', async () => {
    const { status, json } = await put({
      estimatedPrice: GROSS,
      addons: [{ serviceName: 'Fire Ant Treatment', basePrice: 100, discountType: 'fixed_amount', discountAmount: -25 }],
    });
    const addonRows = await mockConn('scheduled_service_addons').where({ scheduled_service_id: serviceId })
      .select('estimated_price', 'discount_amount');
    if (status === 200) {
      for (const row of addonRows) {
        expect(Number(row.estimated_price)).toBeLessThanOrEqual(100);
      }
    } else {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      void json;
    }
  });
});
