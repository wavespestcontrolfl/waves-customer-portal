// Invoice amount edits versus a saved-card authentication challenge. A stable
// hold must fail at the actionable preflight; one committed after that read
// must fail the final correlated predicate while the invoice row is locked.
// Metadata edits and a challenge with exact cancellation evidence remain
// editable. Runs only on a local migrated QA/CI database.
const { randomUUID } = require('node:crypto');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  Object.defineProperty(db, 'client', { get: () => db.connection.client });
  return db;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.setTimeout(30000);

postgres('InvoiceService.update authentication hold (PostgreSQL)', () => {
  let database;
  let InvoiceService;
  const customerIds = [];
  const invoiceIds = [];

  beforeAll(() => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');

    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 5 } });
    require('../models/db').connection = database;
    InvoiceService = require('../services/invoice');
  });

  afterEach(async () => {
    const invoices = invoiceIds.splice(0);
    const customers = customerIds.splice(0);
    if (invoices.length) {
      await database('stripe_invoice_charge_attempts').whereIn('invoice_id', invoices).del();
      await database('invoice_followup_sequences').whereIn('invoice_id', invoices).del();
      await database('activity_log').whereIn('customer_id', customers).del();
      await database('invoices').whereIn('id', invoices).del();
    }
    if (customers.length) await database('customers').whereIn('id', customers).del();
  });

  afterAll(async () => { await database?.destroy(); });

  async function fixture() {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    customerIds.push(customerId);
    invoiceIds.push(invoiceId);
    await database('customers').insert({
      id: customerId,
      first_name: 'Synthetic Invoice Edit',
      phone: `qa-${customerId.slice(0, 8)}`,
      active: true,
      property_type: 'residential',
    });
    await database('invoices').insert({
      id: invoiceId,
      customer_id: customerId,
      token: randomUUID(),
      invoice_number: `EDIT-AUTH-${invoiceId.slice(0, 8)}`,
      status: 'draft',
      title: 'Synthetic invoice edit',
      notes: 'before',
      line_items: JSON.stringify([
        { description: 'Service', quantity: 1, unit_price: 100, amount: 100 },
      ]),
      subtotal: 100,
      discount_amount: 0,
      tax_rate: 0,
      tax_amount: 0,
      total: 100,
      credit_applied: 0,
    });
    return { customerId, invoiceId };
  }

  async function insertAuthenticationHold(conn, invoiceId) {
    const attemptId = randomUUID();
    const intentId = `pi_${attemptId.replaceAll('-', '')}`;
    await conn('stripe_invoice_charge_attempts').insert({
      id: attemptId,
      invoice_id: invoiceId,
      status: 'failed',
      decline_code: 'authentication_required',
      stripe_payment_intent_id: intentId,
      stripe_payment_intent_bound_at: new Date(),
      stripe_payment_method_id: 'pm_synthetic_invoice_edit',
      idempotency_key: `edit-auth-${attemptId}`,
      submitted_at: new Date(),
      resolved_at: new Date(),
    });
    return { attemptId, intentId };
  }

  const editedLines = [
    { description: 'Service', quantity: 1, unit_price: 125, amount: 125 },
  ];

  test('a stable authentication hold blocks only the retotal; exact cancellation makes it inactive', async () => {
    const { invoiceId } = await fixture();
    const { attemptId, intentId } = await insertAuthenticationHold(database, invoiceId);

    await expect(InvoiceService.update(invoiceId, { notes: 'metadata remains editable' }))
      .resolves.toMatchObject({ notes: 'metadata remains editable', total: '100.00' });
    await expect(InvoiceService.update(invoiceId, { line_items: editedLines }))
      .rejects.toThrow('A saved-card charge for this invoice is still processing or awaiting reconciliation');
    await expect(database('invoices').where({ id: invoiceId }).first('total'))
      .resolves.toMatchObject({ total: '100.00' });

    await database('stripe_invoice_charge_attempts').where({ id: attemptId }).update({
      authentication_canceled_intent_id: intentId,
    });
    await expect(InvoiceService.update(invoiceId, { line_items: editedLines }))
      .resolves.toMatchObject({ total: '125.00' });
  });

  test('a challenge committed after preflight blocks the final under-lock retotal with the existing changed-state error', async () => {
    const { invoiceId } = await fixture();
    const holder = await database.transaction();
    let editSettled = false;
    try {
      const { rows: [holderConnection] } = await holder.raw('SELECT pg_backend_pid() AS pid');
      await holder('invoices').where({ id: invoiceId }).forUpdate().first('id');

      const edit = InvoiceService.update(invoiceId, { line_items: editedLines });
      const outcome = edit.then(
        (value) => { editSettled = true; return { value }; },
        (error) => { editSettled = true; return { error }; },
      );

      const deadline = Date.now() + 5000;
      while (true) {
        // Poll outside the long-running holder transaction: PostgreSQL caches
        // statistics snapshots inside a transaction, which can hide the edit
        // connection that appeared after the holder's first stats read.
        const { rows: [blockedWorker] } = await database.raw(
          `SELECT pid, pg_blocking_pids(pid) AS blockers
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND ?::int = ANY(pg_blocking_pids(pid))
            ORDER BY pid
            LIMIT 1`,
          [holderConnection.pid],
        );
        if (blockedWorker) {
          expect(blockedWorker.blockers).toContain(holderConnection.pid);
          break;
        }
        if (editSettled) throw new Error('Invoice edit completed before reaching the held row lock');
        if (Date.now() >= deadline) throw new Error('Invoice edit did not wait for the invoice row lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await insertAuthenticationHold(holder, invoiceId);
      await holder.commit();

      const { error, value } = await outcome;
      expect(value).toBeUndefined();
      expect(error).toMatchObject({
        message: 'Only unpaid invoices can be edited — its status or payment state changed while you were editing',
      });
      await expect(database('invoices').where({ id: invoiceId }).first('total'))
        .resolves.toMatchObject({ total: '100.00' });
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
  });
});
