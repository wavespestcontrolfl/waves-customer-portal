/**
 * Audit repro r1-sched-series-2 — DELETE /api/admin/schedule/:id/prepaid wipes an
 * annual_prepay_invoice coverage stamp (single form, technician token; series
 * form, admin token) with no annual-coverage refusal, and the completion gate
 * (annualPrepayCoversVisit) then reports the visit as NOT covered.
 *
 * Real Postgres (DATABASE_URL must point at a private clone of waves_audit_tpl).
 * The real admin-schedule router runs; only adminAuthenticate is stubbed to
 * inject the role (same pattern as tests/admin-tech-role-scoping.test.js).
 *
 * Skips cleanly without DATABASE_URL, and every fixture write rides a
 * per-test transaction rolled back in afterEach — same harness as
 * tests/delete-prepaid-annual-coverage.test.js and
 * tests/series-prepay-booster-fanout.test.js — so this never commits rows
 * against, or requires, whichever database happens to be configured.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(60000);

let mockCurrentRole = 'technician';
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: global.__TECH_ID, role: mockCurrentRole };
      req.technicianId = global.__TECH_ID;
      req.techRole = mockCurrentRole;
      return next();
    },
  };
});
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});

const express = require('express');
const db = require('../models/db');
const scheduleRouter = require('../routes/admin-schedule');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { etDateString, addETDays } = require('../utils/datetime-et');

const SERVICE = 'Quarterly Pest Control';

postgres('r1-sched-series-2: DELETE /:id/prepaid on annual coverage', () => {
  let database;
  let trx;
  let server;
  let baseUrl;

  beforeAll(() => new Promise((resolve) => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local clone');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    db.connection = database;
    const app = express();
    app.use(express.json());
    app.use('/api/admin/schedule', scheduleRouter);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  }));
  beforeEach(async () => {
    trx = await database.transaction();
    db.connection = trx;
  });
  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await new Promise((r) => server.close(r)); await database?.destroy(); });

  async function call(method, path) {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' } });
    let json = null; try { json = await res.json(); } catch { /* none */ }
    return { status: res.status, body: json || {} };
  }

  async function seed({ children = 0 } = {}) {
    const [customer] = await trx('customers').insert({
      first_name: 'Audit', last_name: 'Series2', phone: `555${Date.now() % 10000000}`, email: `audit-s2-${Date.now()}-${Math.random()}@example.com`,
    }).returning('id');
    const customerId = customer.id || customer;
    const [tech] = await trx('technicians').insert({
      name: 'Tech Repro', email: `tech-s2-${Date.now()}-${Math.random()}@example.com`, role: 'technician', active: true,
    }).returning('id');
    const techId = tech.id || tech;
    const [term] = await trx('annual_prepay_terms').insert({
      customer_id: customerId, term_start: etDateString(addETDays(new Date(), -30)), term_end: etDateString(addETDays(new Date(), 335)),
      status: 'active', prepay_amount: 400, coverage_service_type: SERVICE, coverage_visit_count: 4, plan_label: 'Quarterly',
    }).returning('id');
    const termId = term.id || term;
    const stamp = { prepaid_amount: 100, prepaid_method: 'annual_prepay_invoice', prepaid_at: new Date(), annual_prepay_term_id: termId };
    const [parent] = await trx('scheduled_services').insert({
      customer_id: customerId, technician_id: techId, scheduled_date: etDateString(addETDays(new Date(), 3)), service_type: SERVICE,
      status: 'pending', is_recurring: children > 0, estimated_price: 100, ...stamp,
    }).returning('id');
    const parentId = parent.id || parent;
    const childIds = [];
    for (let i = 1; i <= children; i++) {
      const [c] = await trx('scheduled_services').insert({
        customer_id: customerId, technician_id: techId, scheduled_date: etDateString(addETDays(new Date(), 3 + 90 * i)), service_type: SERVICE,
        status: 'pending', is_recurring: true, recurring_parent_id: parentId, estimated_price: 100, ...stamp,
      }).returning('id');
      childIds.push(c.id || c);
    }
    return { customerId, techId, termId, parentId, childIds };
  }

  const row = (id) => trx('scheduled_services').where({ id }).first('id', 'status', 'prepaid_amount', 'prepaid_method', 'annual_prepay_term_id', 'technician_id');

  test('single form, TECHNICIAN token on own live visit: 200, stamp wiped, term id left, coverage gate now false', async () => {
    const { techId, parentId } = await seed();
    global.__TECH_ID = techId; mockCurrentRole = 'technician';
    const before = await row(parentId);
    expect(await AnnualPrepayRenewals.annualPrepayCoversVisit(before, trx)).toBe(true); // covered before

    const res = await call('DELETE', `/api/admin/schedule/${parentId}/prepaid`);
    const after = await row(parentId);
    console.log('single/tech DELETE ->', res.status, JSON.stringify(res.body), '\nrow after:', JSON.stringify(after));

    // EXPECTED (symmetry with POST /:id/prepaid at admin-schedule.js:13384-13388): refusal
    expect(res.status).toBe(409);
    expect(after.prepaid_method).toBe('annual_prepay_invoice');
    expect(await AnnualPrepayRenewals.annualPrepayCoversVisit(after, trx)).toBe(true);
  });

  test('single form: a MANUAL (cash) stamp on a row merely LINKED to a term is clearable — the link alone must not trap a genuine out-of-band payment', async () => {
    const { techId, termId, parentId } = await seed();
    // Overwrite the seeded row to the exact shape attachScheduledServices +
    // applyPrepaidCoverageForTerm leave behind when a visit was manually
    // prepaid (cash) BEFORE the annual term ever claimed it: LINKED
    // (annual_prepay_term_id set, by date/service match) but the stamp
    // itself is the manual method — applyPrepaidCoverageForTerm
    // deliberately never overwrites it ("its stamp is a real out-of-band
    // payment", annual-prepay-renewals.js).
    await trx('scheduled_services').where({ id: parentId }).update({ prepaid_method: 'cash', prepaid_amount: 90 });
    global.__TECH_ID = techId; mockCurrentRole = 'technician';
    const spy = jest.spyOn(AnnualPrepayRenewals, 'refreshTermSnapshot');
    const res = await call('DELETE', `/api/admin/schedule/${parentId}/prepaid`);
    console.log('manual-stamp-on-linked-row DELETE ->', res.status, JSON.stringify(res.body));
    // EXPECTED: this is a genuine manual payment, not annual coverage —
    // clearable like any other manual stamp (not the 409 a real annual
    // stamp gets).
    expect(res.status).toBe(200);
    // The term coverage is reapplied for the now-freed row's term.
    expect(spy).toHaveBeenCalledWith(termId, expect.anything());
    spy.mockRestore();
    const after = await row(parentId);
    // The audit link survives the clear either way; the row's coverage is
    // whatever refreshTermSnapshot's real logic decides (it may reclaim the
    // row into the term's own coverage, since it is now unstamped and
    // in-window) — the load-bearing assertion here is that the clear
    // itself was never refused just because the link was present.
    expect(after.annual_prepay_term_id).toBe(termId);
  });

  test('series form, ADMIN token: every stamped sibling wiped in one call, term ids left, gate false on all', async () => {
    const { techId, parentId, childIds } = await seed({ children: 3 });
    global.__TECH_ID = techId; mockCurrentRole = 'admin';
    const res = await call('DELETE', `/api/admin/schedule/${parentId}/prepaid?series=1`);
    const rows = await Promise.all([parentId, ...childIds].map(row));
    const covered = await Promise.all(rows.map((r) => AnnualPrepayRenewals.annualPrepayCoversVisit(r, trx)));
    console.log('series/admin DELETE ->', res.status, JSON.stringify(res.body), '\nrows after:', JSON.stringify(rows.map((r) => [r.prepaid_method, r.annual_prepay_term_id != null])), 'covered:', JSON.stringify(covered));

    // EXPECTED (symmetry with stampSeriesPrepaid prepaid-series.js:188): 409 'annual prepay coverage'
    expect(res.status).toBe(409);
    for (const c of covered) expect(c).toBe(true);
  });
});
