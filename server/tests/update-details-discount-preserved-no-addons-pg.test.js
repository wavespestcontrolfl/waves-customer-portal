/**
 * ADMIN-BUG-R01 — Edit-appointment save on a discounted no-add-on visit
 * strips the appointment discount and re-bills at gross.
 *
 * Real Postgres, run with UPDATE_DETAILS_DISCOUNT_TEST_DATABASE_URL pointing
 * at a disposable localhost/dev database. Fixture rows and writes live in a
 * rolled-back transaction (pattern mirrors admin-arrival-window-save-db.test.js)
 * — nothing here is ever committed, so the suite is skipped rather than
 * risking a stray write when that env var is unset (e.g. under plain
 * `npm test`).
 *
 * Fixture: a pending visit with NO add-on rows whose stored economics are
 * primary_line_price=100 (gross), discount 10% (discount_type='percentage',
 * discount_amount=10), estimated_price=90 (net) — the shape POST create
 * (admin-schedule.js primary_line_price = pricing.primaryBase) and a prior
 * modal save both leave behind.
 *
 * The desktop Edit-appointment modal seeds its Price field from the list DTO
 * through the SHARED deriveLegacyPrimarySubmission (SchedulePage.jsx): the
 * DTO always ships serviceAddons as an array, so the seed is the GROSS 100.
 * The modal never seeds the appointment discount, and with no add-on lines it
 * posts no `addons` key, so an unrelated notes-only save posts
 * { estimatedPrice: 100, notes } and nothing about the discount. This test
 * posts exactly that payload and asserts the stored economics survive.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'update-details-discount-fixture-secret';
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
const { deriveLegacyPrimarySubmission } = require('../../shared/legacy-visit-money-submission.cjs');

const connection = process.env.UPDATE_DETAILS_DISCOUNT_TEST_DATABASE_URL;
const describeDb = connection ? describe : describe.skip;

const GROSS = 100;
const NET = 90;
const CUSTOMER = '30000000-0000-4000-8000-000000000011';
const SERVICE = '20000000-0000-4000-8000-000000000011';

describeDb('r2-sched-update-details-financials-1: unrelated edit on a discounted no-add-on visit (PostgreSQL)', () => {
  let database;
  let server;
  let baseUrl;

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

  beforeEach(async () => {
    mockConn = await database.transaction();
    for (const table of ['scheduled_services', 'customers']) {
      await mockConn.raw('CREATE TEMP TABLE ?? ON COMMIT DROP AS SELECT * FROM public.?? WITH NO DATA', [table, table]);
    }
    await mockConn('customers').insert({
      id: CUSTOMER, first_name: 'Audit', last_name: 'R2UpdDet', phone: '5550000042',
      email: `audit-r2-upddet-${Date.now()}@example.com`,
    });
    await mockConn('scheduled_services').insert({
      id: SERVICE,
      customer_id: CUSTOMER,
      scheduled_date: '2099-01-15',
      service_type: 'Quarterly Pest Control',
      status: 'pending',
      is_recurring: false,
      estimated_price: NET,
      primary_line_price: GROSS,
      discount_type: 'percentage',
      discount_amount: 10,
      discount_dollars: 10,
    });
  });
  afterEach(async () => { await mockConn.rollback(); });

  async function readEconomics() {
    return mockConn('scheduled_services').where({ id: SERVICE })
      .first('estimated_price', 'primary_line_price', 'discount_type', 'discount_amount', 'discount_dollars', 'notes');
  }

  test('notes-only save posted the way the Schedule modal posts it keeps estimated_price=90 and the discount stamp', async () => {
    const before = await readEconomics();
    expect(Number(before.estimated_price)).toBe(NET);
    expect(before.discount_type).toBe('percentage');

    // What the Schedule-page modal seeds into its Price field from the list DTO
    // (serviceAddons is ALWAYS an array on the list DTO; primaryLinePrice is the
    // stored gross). This is the shared module the client imports.
    const seededPrice = deriveLegacyPrimarySubmission({
      primaryLinePrice: Number(before.primary_line_price),
      estimatedPrice: Number(before.estimated_price),
      addons: [], // list DTO: addonsByServiceId.get(s.id) || []
    });
    expect(seededPrice).toBe(GROSS); // the modal shows 100, not 90

    // The modal's payload for an unrelated (notes-only) save: no `addons` key
    // (no lines, none initially), estimatedPrice = form.price (the seed),
    // discountType/discountAmount/discountId undefined (never seeded).
    const res = await fetch(`${baseUrl}/api/admin/schedule/${SERVICE}/update-details`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ estimatedPrice: seededPrice, notes: 'gate code 1234' }),
    });
    const body = await res.json().catch(() => ({}));
    expect(res.status).toBe(200);

    const after = await readEconomics();
    expect(after.notes).toBe('gate code 1234');
    // EXPECTED: an unrelated save leaves the stored economics untouched.
    expect(Number(after.estimated_price)).toBe(NET);
    expect(after.discount_type).toBe('percentage');
    expect(Number(after.discount_amount)).toBe(10);
    expect(Number(after.discount_dollars)).toBe(10);
    expect(Number(after.primary_line_price)).toBe(GROSS);
    void body;
  });

  test('a MobileServiceEditModal notes-only save (echoes the stored NET) also keeps the discount', async () => {
    const before = await readEconomics();
    // MobileServiceEditModal seeds its price state from the stored NET
    // `estimatedPrice` (90) and posts it back verbatim.
    const res = await fetch(`${baseUrl}/api/admin/schedule/${SERVICE}/update-details`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ estimatedPrice: Number(before.estimated_price), notes: 'gate code 1234' }),
    });
    expect(res.status).toBe(200);

    const after = await readEconomics();
    expect(after.notes).toBe('gate code 1234');
    expect(Number(after.estimated_price)).toBe(NET);
    expect(after.discount_type).toBe('percentage');
    expect(Number(after.discount_amount)).toBe(10);
    expect(Number(after.primary_line_price)).toBe(GROSS);
  });
});
