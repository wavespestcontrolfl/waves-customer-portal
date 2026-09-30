// assertNoInvoiceChargeReconciliationPending({ readOnly: true }): the
// customer-dunning resolver and its dry-run read the pay page's sibling set
// inside a READ ONLY transaction. The writing fence releases or promotes
// stale saved-card claims; in a read-only transaction that UPDATE aborts the
// transaction (pre-push audit P1). Read-only mode must reach the same verdict
// without writing. Runs in a disposable schema on a private QA / isolated CI
// database (skipped without APP_TEST_DATABASE_URL, run for real in CI).
const { randomUUID } = require('node:crypto');
const knex = require('knex');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `recon_fence_${randomUUID().replaceAll('-', '')}`;

postgres('reconciliation fence read-only mode (PostgreSQL)', () => {
  let admin;
  let app;
  let StripeService;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await app.schema.createTable('stripe_invoice_charge_attempts', (t) => {
      t.uuid('id').primary();
      t.uuid('invoice_id');
      t.string('status');
      t.string('stripe_payment_intent_id');
      t.string('idempotency_key');
      t.text('error_message');
      t.timestamp('submitted_at');
      t.timestamp('resolved_at');
      t.timestamp('created_at');
      t.timestamp('updated_at');
    });
    await app.schema.createTable('stripe_orphan_charges', (t) => {
      t.uuid('invoice_id');
      t.boolean('resolved');
      t.string('stripe_payment_intent_id');
    });
    await app.schema.createTable('payments', (t) => {
      t.uuid('id').primary();
      t.string('status');
      t.string('stripe_payment_intent_id');
      t.jsonb('metadata');
      t.uuid('superseded_by_payment_id');
    });
    StripeService = require('../services/stripe');
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  async function staleClaim({ submitted }) {
    const invoiceId = randomUUID();
    const id = randomUUID();
    const staleAt = new Date(Date.now() - 10 * 60 * 1000);
    await app('stripe_invoice_charge_attempts').insert({
      id, invoice_id: invoiceId, status: 'claimed', idempotency_key: `inv_card_on_file_${invoiceId}_${id}`,
      submitted_at: submitted ? staleAt : null, created_at: staleAt, updated_at: staleAt,
    });
    return { invoiceId, id };
  }

  async function inReadOnly(fn) {
    const trx = await app.transaction();
    try {
      await trx.raw('SET TRANSACTION READ ONLY');
      const out = await fn(trx);
      await trx.raw('SELECT 1'); // still usable after the fence ran
      return out;
    } finally {
      await trx.rollback().catch(() => {});
    }
  }

  const verdict = (invoiceId, database, opts) => StripeService
    .assertNoInvoiceChargeReconciliationPending(invoiceId, database, opts)
    .then(() => null, (e) => e);

  test('stale SUBMITTED claim: ambiguous verdict, no write, transaction stays usable', async () => {
    const f = await staleClaim({ submitted: true });
    const err = await inReadOnly((trx) => verdict(f.invoiceId, trx, { readOnly: true }));
    expect(err && err.code).toBe('STRIPE_AMBIGUOUS_OUTCOME');
    expect((await app('stripe_invoice_charge_attempts').where({ id: f.id }).first('status')).status).toBe('claimed');
  });

  test('stale PRE-SUBMIT claim: treated as released, no write, transaction stays usable', async () => {
    const f = await staleClaim({ submitted: false });
    const err = await inReadOnly((trx) => verdict(f.invoiceId, trx, { readOnly: true }));
    expect(err).toBeNull();
    const row = await app('stripe_invoice_charge_attempts').where({ id: f.id }).first('status', 'resolved_at');
    expect(row).toMatchObject({ status: 'claimed', resolved_at: null });
  });

  test('writing mode unchanged: a stale pre-submit claim is released', async () => {
    const f = await staleClaim({ submitted: false });
    expect(await verdict(f.invoiceId, app)).toBeNull();
    expect((await app('stripe_invoice_charge_attempts').where({ id: f.id }).first('status')).status).toBe('failed');
  });
});
