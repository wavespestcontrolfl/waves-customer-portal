/**
 * AUDIT REPRO r1-sched-series-2 — DELETE /api/admin/schedule/:id/prepaid
 * (single and ?series=1) wipes annual_prepay_invoice coverage stamps.
 *
 * Asserts the EXPECTED behaviour (symmetric with POST /:id/prepaid, bulk
 * mark_prepaid and stampSeriesPrepaid, which all refuse annual-covered rows):
 * a clear must not remove the annual stamp, and annualPrepayCoversVisit must
 * still be true afterwards. Fails on current code if the bug is real.
 *
 * Real migrated PostgreSQL (DATABASE_URL = a private clone of waves_audit_tpl),
 * synthetic rows, rolled back after every test — same harness as
 * server/tests/prepaid-integrity-postgres.test.js.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'synthetic-notification' })) }));
// Staff token shape from headers: x-role technician|admin, x-tech-id uuid.
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.techRole = req.headers['x-role'] || 'admin';
    req.technicianId = req.headers['x-tech-id'] || null;
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'admin' })),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.setTimeout(60000);

const { randomUUID } = require('node:crypto');
const express = require('express');
const { clearSeriesPrepaid, hasAnnualCoverage } = require('../services/prepaid-series');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { etDateString } = require('../utils/datetime-et');

const ANNUAL = AnnualPrepayRenewals.ANNUAL_PREPAY_PREPAID_METHOD;

postgres('r1-sched-series-2: clearing prepaid must not erase annual coverage evidence', () => {
  let database;
  let trx;
  let customerId;
  let technicianId;
  let termId;
  let app;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local clone');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    const router = require('../routes/admin-schedule');
    app = express();
    app.use(express.json());
    app.use('/admin/schedule', router);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  });

  // Same in-process HTTP pattern as tests/schedule-prepay-switch.test.js (no supertest here).
  async function del(path, headers) {
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/schedule${path}`, { method: 'DELETE', headers });
      return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    technicianId = randomUUID();
    termId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
    await trx('technicians').insert({ id: technicianId, name: 'Synthetic Tech', role: 'technician', active: true });
    // A live, paid annual term (ACTIVE_STATUSES carry no invoice condition).
    await trx('annual_prepay_terms').insert({ id: termId, customer_id: customerId, status: 'active',
      term_start: '2020-01-01', term_end: '2099-12-31', prepay_amount: 1200,
      coverage_service_type: 'Monthly Pest Control Service' });
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  // Today (ET) keeps the row inside technicianCurrentVisitFilter's 7-day window.
  async function annualVisit(overrides = {}) {
    const [row] = await trx('scheduled_services').insert({ id: randomUUID(), customer_id: customerId,
      technician_id: technicianId,
      service_type: 'Monthly Pest Control Service', service_key_snapshot: 'pest_general_monthly',
      status: 'pending', scheduled_date: etDateString(new Date()), estimated_price: 100,
      is_recurring: true, recurring_pattern: 'monthly',
      prepaid_method: ANNUAL, prepaid_amount: 100, prepaid_at: new Date(), annual_prepay_term_id: termId,
      ...overrides }).returning('*');
    return row;
  }
  const reload = (id) => trx('scheduled_services').where({ id }).first();

  test('sanity: the seeded stamp is live annual coverage before any clear', async () => {
    const root = await annualVisit();
    expect(hasAnnualCoverage(root)).toBe(true);
    expect(await AnnualPrepayRenewals.annualPrepayCoversVisit(root, trx)).toBe(true);
  });

  test('clearSeriesPrepaid refuses (or leaves intact) rows carrying annual coverage', async () => {
    const root = await annualVisit();
    const child = await annualVisit({ recurring_parent_id: root.id });
    let result;
    let error;
    try { result = await clearSeriesPrepaid(trx, root); } catch (err) { error = err; }
    for (const id of [root.id, child.id]) {
      const after = await reload(id);
      console.log('[repro] after clearSeriesPrepaid', { id, result, error: error?.message, prepaid_method: after.prepaid_method, prepaid_amount: after.prepaid_amount, annual_prepay_term_id: after.annual_prepay_term_id, coversVisit: await AnnualPrepayRenewals.annualPrepayCoversVisit(after, trx) });
    }
    if (!error) expect(result).toMatchObject({ clearedCount: 0 });
    for (const id of [root.id, child.id]) {
      const after = await reload(id);
      expect(after.prepaid_method).toBe(ANNUAL);
      expect(Number(after.prepaid_amount)).toBe(100);
      expect(await AnnualPrepayRenewals.annualPrepayCoversVisit(after, trx)).toBe(true);
    }
  });

  test('TECHNICIAN token: DELETE /:id/prepaid must not strip annual coverage from its own live visit', async () => {
    const root = await annualVisit();
    const res = await del(`/${root.id}/prepaid`, { 'x-role': 'technician', 'x-tech-id': technicianId });
    { const after = await reload(root.id);
      console.log('[repro] after TECH DELETE', { status: res.status, body: res.body, prepaid_method: after.prepaid_method, prepaid_amount: after.prepaid_amount, annual_prepay_term_id: after.annual_prepay_term_id, coversVisit: await AnnualPrepayRenewals.annualPrepayCoversVisit(after, trx) }); }
    expect([404, 409]).toContain(res.status);
    const after = await reload(root.id);
    expect(after.prepaid_method).toBe(ANNUAL);
    expect(await AnnualPrepayRenewals.annualPrepayCoversVisit(after, trx)).toBe(true);
  });

  test('ADMIN token: DELETE /:id/prepaid?series=1 must not strip annual coverage from the family', async () => {
    const root = await annualVisit();
    const child = await annualVisit({ recurring_parent_id: root.id });
    const res = await del(`/${root.id}/prepaid?series=1`, { 'x-role': 'admin' });
    for (const id of [root.id, child.id]) { const after = await reload(id);
      console.log('[repro] after ADMIN series DELETE', { id, status: res.status, body: res.body, prepaid_method: after.prepaid_method, prepaid_amount: after.prepaid_amount, annual_prepay_term_id: after.annual_prepay_term_id, coversVisit: await AnnualPrepayRenewals.annualPrepayCoversVisit(after, trx) }); }
    expect(res.status).not.toBe(200);
    for (const id of [root.id, child.id]) {
      const after = await reload(id);
      expect(after.prepaid_method).toBe(ANNUAL);
      expect(await AnnualPrepayRenewals.annualPrepayCoversVisit(after, trx)).toBe(true);
    }
  });
});
