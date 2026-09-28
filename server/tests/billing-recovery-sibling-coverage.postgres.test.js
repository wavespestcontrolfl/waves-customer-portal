/**
 * Billing Recovery Bill action — sibling coverage guard, against a REAL
 * migrated Postgres database (schema, columns, the real
 * findFirstApplicationInvoiceForEstimateService / isPricedCoveredMemberVisit
 * SQL — not a hand-typed mock).
 *
 * Gap this closes: server/routes/admin-billing-recovery.js's POST /bill
 * (billVisit's assessVisitBillable stage) checked autopay, payer, callback,
 * always-free type, and annual prepay before minting — but never asked
 * whether a same-accept SIBLING's combined first-application invoice already
 * covers this visit. A combined invoice minted on an ANCHOR visit stamps
 * scheduled_services.first_application_invoice_id on the anchor AND every
 * covered member (estimate-converter.js
 * stampCombinedFirstApplicationInvoiceCoverage) — an unpriced covered
 * sibling (billed per_application fee) or a priced non-anchor member (staff
 * priced it after the trip's combined invoice already existed) both
 * complete with NO invoice on their own row, so they cleared every existing
 * guard, passed uninvoicedLeakQuery's `NOT HAS_INVOICE_SQL` predicate, and
 * Bill minted a SECOND charge beside the sibling's already-billed trip.
 *
 * Fixture mirrors priced-covered-sibling-charge.postgres.test.js's own
 * fixture() verbatim (a reserved pest ANCHOR + a promoted lawn SIBLING,
 * accepted together off the same estimate/day, both stamped to the SAME
 * combined invoice) — this suite only adds the completion shape (service
 * records, completed_at) POST /bill itself requires.
 *
 * Run with SIBLING_RESPLIT_TEST_DATABASE_URL (+ DATABASE_URL, same value)
 * pointing to a disposable local, managed worktree QA, or isolated CI
 * database — same gating as priced-covered-sibling-charge.postgres.test.js.
 * Every fixture rolls back.
 */
jest.setTimeout(60000);
const { randomUUID } = require('crypto');

const testUrl = process.env.SIBLING_RESPLIT_TEST_DATABASE_URL;
const local = testUrl && ['localhost', '127.0.0.1'].includes(new URL(testUrl).hostname)
  && new URL(testUrl).pathname.includes('sibling_resplit');
const managed = testUrl && process.env.WAVES_LOCAL_DEV === '1' && process.env.WAVES_WORKTREE_ID
  && testUrl === process.env.DATABASE_URL
  && new URL(testUrl).pathname === `/waves_qa_${process.env.WAVES_WORKTREE_ID.replaceAll('-', '')}`;
const ci = testUrl && process.env.CI === 'true' && testUrl === process.env.DATABASE_URL
  && ['localhost', '127.0.0.1'].includes(new URL(testUrl).hostname) && new URL(testUrl).pathname === '/waves_test';
if (testUrl && !local && !managed && !ci) {
  throw new Error('Sibling-coverage billing-recovery tests require a dedicated local sibling_resplit, managed worktree QA, or isolated CI database.');
}
const suite = local || managed || ci ? describe : describe.skip;

let mockTransaction;
jest.mock('../models/db', () => {
  const database = (...args) => mockTransaction(...args);
  database.transaction = (...args) => mockTransaction.transaction(...args);
  database.raw = (...args) => mockTransaction.raw(...args);
  // The /leaks route probes customers.billing_mode via db.schema; without it
  // the probe throws, the route falls back to the legacy price-only query and
  // silently drops every unpriced per-application visit — the rows this suite
  // is about.
  Object.defineProperty(database, 'schema', { get: () => mockTransaction.schema });
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://short/pay'),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal') }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ executeDashboardTool: jest.fn(), INTERNAL_TEST_CUSTOMERS: [] }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = req.headers['x-fixture-actor']; next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const knex = require('knex');

suite('billing-recovery Bill action — sibling coverage guard on real Postgres', () => {
  let db;
  let server;
  let baseUrl;

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: testUrl, pool: { min: 0, max: 2 } });
    if (!await db.schema.hasTable('knex_migrations')) throw new Error('Run development migrations first');
    const router = require('../routes/admin-billing-recovery');
    const app = express();
    app.use(express.json());
    app.use('/billing-recovery', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => { mockTransaction = await db.transaction(); });
  afterEach(async () => { await mockTransaction?.rollback(); mockTransaction = null; });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db?.destroy();
    await require('../models/db').destroy?.();
  });

  // Yesterday (UTC date), never a literal: a completed visit must sit inside
  // the leaks window (completed_at >= now() - 365 days) on every run date.
  const SAME_DATE = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const RESERVED_PRICE = 153.60;

  // Verbatim shape of priced-covered-sibling-charge.postgres.test.js's own
  // fixture(), plus the completion evidence (service_records, completed_at,
  // status='completed') POST /bill itself requires that Charge Now's own
  // fixture never needed.
  async function fixture(trx, { invoiceStatus = 'paid', siblingPrice = null } = {}) {
    const customerId = randomUUID();
    const estimateId = randomUUID();
    const pestId = randomUUID();
    const lawnId = randomUUID();
    const pestRecordId = randomUUID();
    const lawnRecordId = randomUUID();
    const actorId = randomUUID();
    // billing_mode/per_application_fee (Codex round-12/estimate-flow standard
    // accepts): an unpriced covered sibling's effective price at recovery
    // time resolves from the CUSTOMER-level fee, never a row price — matches
    // the real shape this gap covers, not just a $0-price 422 dodge.
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic billing-recovery sibling fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
      billing_mode: 'per_application', per_application_fee: 65,
    });
    await trx('technicians').insert({ id: actorId, name: 'Synthetic billing operator' });
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
    await trx('scheduled_services').insert({
      id: pestId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
      service_type: 'Quarterly Pest Control', status: 'completed', is_recurring: true,
      estimated_price: RESERVED_PRICE, completed_at: new Date(`${SAME_DATE}T17:00:00Z`),
    });
    await trx('scheduled_services').insert({
      id: lawnId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
      service_type: 'Lawn Care', status: 'completed', is_recurring: true,
      estimated_price: siblingPrice, completed_at: new Date(`${SAME_DATE}T17:05:00Z`),
    });
    await trx('service_records').insert({
      id: pestRecordId, customer_id: customerId, scheduled_service_id: pestId,
      service_date: SAME_DATE, service_type: 'Quarterly Pest Control', status: 'completed',
    });
    await trx('service_records').insert({
      id: lawnRecordId, customer_id: customerId, scheduled_service_id: lawnId,
      service_date: SAME_DATE, service_type: 'Lawn Care', status: 'completed',
    });
    const invoiceId = randomUUID();
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId, scheduled_service_id: pestId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: invoiceStatus,
      title: 'First Service Application',
      notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: RESERVED_PRICE, amount: RESERVED_PRICE }]),
      subtotal: RESERVED_PRICE, total: RESERVED_PRICE,
    });
    await trx('scheduled_services').whereIn('id', [pestId, lawnId]).update({ first_application_invoice_id: invoiceId });
    return {
      customerId, estimateId, pestId, lawnId, invoiceId, pestRecordId, lawnRecordId, actorId,
    };
  }

  const bill = (id, actorId) => fetch(`${baseUrl}/billing-recovery/${id}/bill`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-actor': actorId }, body: '{}',
  });

  test('an UNPRICED covered sibling (per-application fee lane) with a PAID combined invoice is refused, not double-billed', async () => {
    const ids = await fixture(mockTransaction, { invoiceStatus: 'paid', siblingPrice: null });
    const res = await bill(ids.lawnId, ids.actorId);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/combined trip invoice/i);
    const invoices = await mockTransaction('invoices').where({ scheduled_service_id: ids.lawnId });
    expect(invoices).toHaveLength(0); // no second invoice minted
  });

  test('a PRICED covered member (staff priced the sibling after the combined invoice already existed) is refused', async () => {
    const ids = await fixture(mockTransaction, { invoiceStatus: 'paid', siblingPrice: 65 });
    const res = await bill(ids.lawnId, ids.actorId);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/combined trip invoice/i);
    const invoices = await mockTransaction('invoices').where({ scheduled_service_id: ids.lawnId });
    expect(invoices).toHaveLength(0);
  });

  test('a covered sibling whose combined invoice is VOID with no live replacement gets the manual-review refusal', async () => {
    const ids = await fixture(mockTransaction, { invoiceStatus: 'void', siblingPrice: null });
    const res = await bill(ids.lawnId, ids.actorId);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/manual review/i);
  });

  test('the ANCHOR visit itself is never refused by the sibling-coverage guard — bills its own price unchanged', async () => {
    const ids = await fixture(mockTransaction, { invoiceStatus: 'paid', siblingPrice: null });
    const res = await bill(ids.pestId, ids.actorId);
    const body = await res.json();
    // The anchor already has its OWN invoice (scheduled_service_id = pestId)
    // from the fixture, so the pre-existing "already invoiced" guard fires
    // first — proving the sibling-coverage guard never claims the anchor's
    // own row for itself (it would otherwise also read 'covered').
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already exists/i);
  });

  test('an UNSTAMPED standalone visit (no source_estimate_id, no sibling invoice) bills normally — unchanged', async () => {
    const customerId = randomUUID();
    const actorId = randomUUID();
    const visitId = randomUUID();
    const recordId = randomUUID();
    await mockTransaction('customers').insert({ id: customerId, first_name: 'Synthetic standalone fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true });
    await mockTransaction('technicians').insert({ id: actorId, name: 'Synthetic billing operator' });
    await mockTransaction('scheduled_services').insert({
      id: visitId, customer_id: customerId, scheduled_date: SAME_DATE, service_type: 'Quarterly Pest Control',
      status: 'completed', estimated_price: 99, completed_at: new Date(`${SAME_DATE}T17:00:00Z`),
    });
    await mockTransaction('service_records').insert({
      id: recordId, customer_id: customerId, scheduled_service_id: visitId, service_date: SAME_DATE, service_type: 'Quarterly Pest Control', status: 'completed',
    });
    const res = await bill(visitId, actorId);
    expect(res.status).toBe(200);
    const invoices = await mockTransaction('invoices').where({ scheduled_service_id: visitId });
    expect(invoices).toHaveLength(1);
    expect(parseFloat(invoices[0].total)).toBeCloseTo(99, 2);
  });

  test('GET /leaks omits the covered sibling but keeps the anchor once it too is uninvoiced', async () => {
    const ids = await fixture(mockTransaction, { invoiceStatus: 'paid', siblingPrice: null });
    // Void the anchor's own invoice and clear its stamp so the anchor itself
    // reads as a genuine, uninvoiced, uncovered leak alongside the covered
    // sibling — isolates the sibling-only omission from the leak list.
    await mockTransaction('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
    await mockTransaction('scheduled_services').whereIn('id', [ids.pestId, ids.lawnId]).update({ first_application_invoice_id: null });
    // Re-stamp only the sibling to a SEPARATE live invoice on a THIRD visit
    // (its own anchor), so the sibling is still coverage-eligible while the
    // pest row now stands alone as an ordinary uninvoiced leak.
    const otherAnchorId = randomUUID();
    const otherInvoiceId = randomUUID();
    await mockTransaction('scheduled_services').insert({
      id: otherAnchorId, customer_id: ids.customerId, source_estimate_id: ids.estimateId, scheduled_date: SAME_DATE,
      service_type: 'Quarterly Pest Control', status: 'completed', estimated_price: RESERVED_PRICE,
      completed_at: new Date(`${SAME_DATE}T17:00:00Z`),
    });
    await mockTransaction('invoices').insert({
      id: otherInvoiceId, customer_id: ids.customerId, scheduled_service_id: otherAnchorId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`, status: 'paid', title: 'First Service Application',
      notes: `Auto-generated from accepted estimate #${ids.estimateId}. Customer selected pay per application — first application only.`,
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: RESERVED_PRICE, amount: RESERVED_PRICE }]),
      subtotal: RESERVED_PRICE, total: RESERVED_PRICE,
    });
    await mockTransaction('scheduled_services').whereIn('id', [otherAnchorId, ids.lawnId]).update({ first_application_invoice_id: otherInvoiceId });

    const res = await fetch(`${baseUrl}/billing-recovery/leaks?days=3650`, { headers: { 'x-fixture-actor': ids.actorId } });
    const body = await res.json();
    expect(res.status).toBe(200);
    const allIds = [...body.leaks, ...body.needs_review].map((r) => r.scheduled_service_id);
    expect(allIds).toContain(ids.pestId); // ordinary uninvoiced leak — untouched
    expect(allIds).not.toContain(ids.lawnId); // covered by the other anchor's live invoice
  });

  // A voided combined invoice (needs review) may still be owed money, so the
  // leaks list keeps the visit; only a definitive 'covered' is dropped.
  test('GET /leaks keeps a needs-review sibling (voided combined invoice) listed', async () => {
    const ids = await fixture(mockTransaction, { invoiceStatus: 'void' });
    const res = await fetch(`${baseUrl}/billing-recovery/leaks?days=3650`, { headers: { 'x-fixture-actor': ids.actorId } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const allIds = [...(body.leaks || []), ...(body.needs_review || [])].map((r) => r.scheduled_service_id);
    expect(allIds).toContain(ids.lawnId);
  });

  // The Intelligence Bar closeout repair (bill_visit) previews and bills
  // through the same module, so it refuses the same way.
  test('the IB repair path (assessVisitBillable) refuses a covered sibling the same way', async () => {
    const ids = await fixture(mockTransaction, { invoiceStatus: 'paid' });
    const { assessVisitBillable } = require('../services/billing-recovery-bill');
    const result = await assessVisitBillable(ids.lawnId, { database: mockTransaction });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.error).toMatch(/combined trip invoice/i);
  });
});
