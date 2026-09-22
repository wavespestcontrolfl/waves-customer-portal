const { randomUUID } = require('node:crypto');
const express = require('express');
const knex = require('knex');

let mockTransaction;
jest.mock('../models/db', () => {
  const database = (...args) => mockTransaction(...args);
  database.transaction = (...args) => mockTransaction.transaction(...args);
  database.raw = (...args) => mockTransaction.raw(...args);
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice', () => ({ createFromService: jest.fn() }));
jest.mock('../services/job-costing', () => ({ calculateJobCost: jest.fn(async () => ({})) }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn(), autopayActivePredicate: jest.fn() }));
jest.mock('../services/mrr-breakdown', () => ({ listAtRiskMrrAccounts: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ executeDashboardTool: jest.fn(), INTERNAL_TEST_CUSTOMERS: [] }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(), invoiceShortCodePrefix: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = req.headers['x-fixture-actor']; next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const router = require('../routes/admin-billing-recovery');
const { calculateJobCost } = require('../services/job-costing');
const { acquireScheduledInvoiceMintLock } = require('../services/scheduled-invoice-mint');
const connection = process.env.C360_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;

postgres('billing-recovery dismissal on migrated PostgreSQL', () => {
  let database;
  let server;
  let baseUrl;
  let ids;

  beforeAll(async () => {
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) throw new Error('Use a verified private QA database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    if (!await database.schema.hasTable('knex_migrations')) throw new Error('Run development migrations first');
    const app = express();
    app.use(express.json());
    app.use('/billing-recovery', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTransaction = await database.transaction();
    ids = { customer: randomUUID(), actor: randomUUID(), visit: randomUUID(), otherVisit: randomUUID(), record: randomUUID() };
    await mockTransaction('customers').insert({
      id: ids.customer, first_name: 'Billing fixture', last_name: 'Synthetic', phone: '+19415550100',
      email: `${ids.customer}@example.invalid`, address_line1: '100 Example Lane', city: 'Test City', zip: '00000',
    });
    await mockTransaction('technicians').insert({ id: ids.actor, name: 'Synthetic billing operator' });
    await mockTransaction('scheduled_services').insert([ids.visit, ids.otherVisit].map(id => ({
      id, customer_id: ids.customer, scheduled_date: '2025-01-01', service_type: 'Synthetic visit',
      status: 'completed', completed_at: new Date('2025-01-01T17:00:00Z'),
    })));
  });

  afterEach(async () => { await mockTransaction?.rollback(); mockTransaction = null; });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await database?.destroy();
  });

  const dismiss = () => fetch(`${baseUrl}/billing-recovery/${ids.visit}/dismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-actor': ids.actor },
    body: JSON.stringify({ reason: 'Synthetic no-cost visit' }),
  });

  test.each([
    { name: 'unlinked unrelated invoice', link: 'none', status: 'sent', expected: 200 },
    { name: 'invoice on another visit', link: 'other', status: 'sent', expected: 200 },
    { name: 'invoice linked to this visit', link: 'visit', status: 'sent', expected: 409 },
    { name: 'invoice linked through this service record', link: 'record', status: 'sent', expected: 409 },
    { name: 'void invoice on this visit', link: 'visit', status: 'void', expected: 200 },
  ])('$name returns $expected', async ({ link, status, expected }) => {
    if (link === 'record') await mockTransaction('service_records').insert({
      id: ids.record, customer_id: ids.customer, scheduled_service_id: ids.visit,
      service_date: '2025-01-01', service_type: 'Synthetic visit',
    });
    await mockTransaction('invoices').insert({
      id: randomUUID(), token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 24)}`, customer_id: ids.customer, status,
      service_record_id: link === 'record' ? ids.record : null,
      scheduled_service_id: link === 'visit' ? ids.visit : link === 'other' ? ids.otherVisit : null,
    });
    const response = await dismiss();
    expect(response.status).toBe(expected);
    const rows = await mockTransaction('visit_billing_dispositions').where('scheduled_service_id', ids.visit);
    if (expected === 200) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ disposition: 'intentionally_free', service_record_id: null, actor_user_id: ids.actor });
      expect(calculateJobCost).toHaveBeenCalledWith(ids.visit, undefined, { recomputeRevenue: true });
      expect((await dismiss()).status).toBe(409);
    } else {
      expect((await response.json()).error).toMatch(/already invoiced/);
      expect(rows).toHaveLength(0);
      expect(calculateJobCost).not.toHaveBeenCalled();
    }
  });

  test('the invoice check waits for the canonical mint lock', async () => {
    const [{ pid }] = await mockTransaction.raw('SELECT pg_backend_pid() AS pid').then(result => result.rows);
    const blocker = await database.transaction();
    let pending;
    try {
      await acquireScheduledInvoiceMintLock(blocker, ids.visit);
      pending = dismiss();
      // Poll lock state instead of assuming a slow HTTP request proves contention.
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const result = await blocker.raw("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ? AND locktype = 'advisory' AND NOT granted) AS waiting", [pid]);
        waiting = result.rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally { await blocker.rollback(); }
    expect((await pending).status).toBe(200);
  });
});
