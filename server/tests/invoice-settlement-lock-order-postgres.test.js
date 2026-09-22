// Real PostgreSQL, two independent connections/transactions from the same
// pool, driven concurrently — a deterministic proof of a lock-ORDER
// invariant needs genuine cross-session contention; a single-connection
// nested transaction (the pattern most other *-postgres suites use) cannot
// produce it, since a knex/PostgreSQL savepoint never blocks against its
// own parent.
//
// settleZeroBalance (server/services/invoice.js) used to lock the invoice
// row, then the customer row. Most of the rest of the packet-invoice send/
// claim machinery — resolvePacketOwnershipLocked, claimPacketInvoiceForSend,
// and admin-schedule.js's Bill-To edit ("OWNERSHIP ROWS FIRST for a Bill-To
// edit") — locks the customer row first. A concurrent pair taking opposite
// orders on the SAME two rows is a textbook PostgreSQL deadlock (40P01):
// each session holds what the other wants. #4634 deferred the reorder to
// this slice (invoice.js ~1385) rather than patch it inline.
//
// This suite proves both halves: (1) the mismatched shape genuinely
// deadlocks — so this test rig would have caught the bug before the fix —
// and (2) the fixed shape (both sides customer-then-invoice, matching
// settleZeroBalance's current order) never does, for the identical pair of
// rows and the identical interleaving.
const { randomUUID } = require('crypto');
const knex = require('knex');

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
jest.setTimeout(30000);

// Structural tie-back: the two-connection tests above prove the GENERAL
// invariant (matched order never deadlocks); this ties it to the actual
// function, so a future edit reverting settleZeroBalance's order back to
// invoice-then-customer is caught even without a live database available.
// Runs unconditionally (no DATABASE_URL gate).
test('settleZeroBalance source locks the customer row before the invoice row', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');
  const fnAt = source.indexOf('async settleZeroBalance(id, database = db, { requireDueBy = null } = {}) {');
  expect(fnAt).toBeGreaterThan(-1);
  const fnBody = source.slice(fnAt, fnAt + 3000);
  const customerLockAt = fnBody.indexOf('trx("customers").where({ id: preCustomer.customer_id }).forUpdate()');
  const invoiceLockAt = fnBody.indexOf('trx("invoices").where({ id }).forUpdate()');
  expect(customerLockAt).toBeGreaterThan(-1);
  expect(invoiceLockAt).toBeGreaterThan(customerLockAt);
});

postgres('settleZeroBalance customer-then-invoice lock order (#4131 slice 5, #4634 deferral)', () => {
  let database;
  let customerId;
  let invoiceId;

  beforeAll(() => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } });
  });
  afterAll(async () => { if (database) await database.destroy(); });

  beforeEach(async () => {
    customerId = randomUUID();
    invoiceId = randomUUID();
    await database('customers').insert({
      id: customerId, first_name: 'Lock', last_name: 'Order',
      phone: '+12025550188', email: `${customerId}@example.invalid`,
    });
    await database('invoices').insert({
      id: invoiceId, customer_id: customerId, invoice_number: `TEST-LOCK-${invoiceId.slice(0, 8)}`,
      token: randomUUID(), status: 'draft', total: 117, subtotal: 117, line_items: '[]',
    });
  });
  afterEach(async () => {
    await database('invoices').where({ id: invoiceId }).del().catch(() => {});
    await database('customers').where({ id: customerId }).del().catch(() => {});
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const lockCustomer = (trx) => trx('customers').where({ id: customerId }).forUpdate().first('id');
  const lockInvoice = (trx) => trx('invoices').where({ id: invoiceId }).forUpdate().first('id');

  test('mismatched order (session A: invoice-then-customer, session B: customer-then-invoice — the pre-fix shape) genuinely deadlocks', async () => {
    const trxA = await database.transaction(); // plays settleZeroBalance's OLD order
    const trxB = await database.transaction(); // plays admin-schedule's Bill-To order (unchanged)
    try {
      await lockInvoice(trxA); // A holds invoice
      await lockCustomer(trxB); // B holds customer
      const aWantsCustomer = lockCustomer(trxA);
      // Let A's request actually register and block on B before B reaches
      // for the invoice — otherwise both requests could race in either
      // order and the cycle might not form on every run.
      await sleep(200);
      const bWantsInvoice = lockInvoice(trxB);
      const results = await Promise.allSettled([aWantsCustomer, bWantsInvoice]);
      const rejected = results.filter((r) => r.status === 'rejected');
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      // PostgreSQL's deadlock detector aborts exactly one side (40P01) and
      // lets the other proceed once the cycle breaks.
      expect(rejected).toHaveLength(1);
      expect(fulfilled).toHaveLength(1);
      expect(rejected[0].reason.code).toBe('40P01');
    } finally {
      await trxA.rollback().catch(() => {});
      await trxB.rollback().catch(() => {});
    }
  });

  test('matched order (both sessions customer-then-invoice — the fixed shape) never deadlocks, same rows and interleaving', async () => {
    const trxA = await database.transaction(); // plays settleZeroBalance's NEW order
    const trxB = await database.transaction(); // plays admin-schedule's Bill-To order
    try {
      await lockCustomer(trxA); // A holds customer first, exactly like B would
      // B wants the SAME first resource A already holds — it queues behind
      // A rather than reaching for the invoice out of order. Deliberately
      // not awaited yet: this is the moment a mismatched B would instead
      // have grabbed the invoice and formed the cycle above.
      const bWantsCustomer = lockCustomer(trxB);
      await sleep(200);
      // A proceeds to its second resource — uncontended, since B is still
      // queued on the first and holds nothing of its own yet.
      await lockInvoice(trxA);
      await trxA.commit();
      // A's release lets B's queued customer lock resolve; B then reaches
      // for the invoice too, now uncontended.
      await bWantsCustomer;
      await lockInvoice(trxB);
      await trxB.commit();
    } catch (err) {
      await trxA.rollback().catch(() => {});
      await trxB.rollback().catch(() => {});
      throw err;
    }
  });
});
