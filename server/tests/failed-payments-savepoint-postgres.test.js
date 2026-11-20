const { randomUUID } = require('node:crypto');
const knex = require('knex');
const { loadFailedPaymentFacts, standaloneFailedTotal } = require('../services/failed-payments');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `failed_payment_savepoint_${randomUUID().replaceAll('-', '')}`;

postgres('failed-payment status lookup savepoint (PostgreSQL)', () => {
  let admin;
  let app;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const isolatedCi = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !isolatedCi) throw new Error('Use a private QA or isolated CI database');

    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await app.schema.createTable('payments', (table) => {
      table.uuid('id').primary();
      table.uuid('customer_id').notNullable();
      table.string('status').notNullable();
      table.decimal('amount', 10, 2).notNullable();
      table.jsonb('metadata');
      table.string('stripe_payment_intent_id');
      table.string('stripe_charge_id');
      table.string('description');
      table.uuid('payer_id');
      table.integer('retry_count');
      table.timestamp('next_retry_at', { useTz: true });
      table.uuid('superseded_by_payment_id');
      table.date('payment_date');
      table.timestamp('created_at', { useTz: true });
    });
    // Deliberately omit status: the failed-invoice classification statement
    // errors after entering PostgreSQL, exactly the case that poisons a
    // transaction unless it is isolated by a SAVEPOINT.
    await app.schema.createTable('invoices', (table) => {
      table.uuid('id').primary();
    });
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  test('Billing excludes string-encoded payer links with a bounded number of SQL parameters', async () => {
    const { excludeDirectPayerPayments, excludeLiveOwnedPayerPayments } = require('../services/payer-linkage');
    const owner = randomUUID();
    const invoiceId = randomUUID();
    const ownPayment = randomUUID();
    const rows = [
      [randomUUID(), { payer_id: randomUUID() }],
      [randomUUID(), { waves_invoice_id: invoiceId.toUpperCase() }],
      [ownPayment, { label: 'own ordinary payment' }],
    ];
    for (const [id, metadata] of rows) {
      await app('payments').insert({ id, customer_id: owner, amount: 1, status: 'failed',
        metadata: app.raw('to_jsonb(?::text)', [JSON.stringify(metadata)]) });
    }
    const payerInvRows = Array.from({ length: 17000 }, (_, i) => ({ id: i === 0 ? invoiceId : randomUUID(), invoice_number: `AP-${i}` }));
    const q = excludeLiveOwnedPayerPayments(excludeDirectPayerPayments(app('payments').where({ customer_id: owner })), { payerInvRows });
    expect(q.toSQL().bindings.length).toBeLessThan(10);
    expect(await q.pluck('id')).toEqual([ownPayment]);
  });

  test('string-encoded deferrals cannot win the portal latest-attempt query', async () => {
    const { excludeNeverAttemptedDeferrals } = require('../services/failed-payments');
    const customerId = randomUUID();
    const paidId = randomUUID();
    const lockId = randomUUID();
    const holdId = randomUUID();
    const absorbedId = randomUUID();
    await app('payments').insert([
      {
        id: paidId, customer_id: customerId, status: 'paid', amount: 33,
        metadata: {}, payment_date: '2026-11-01', created_at: new Date('2026-11-01T14:00:00Z'),
      },
      {
        id: lockId, customer_id: customerId, status: 'failed', amount: 33,
        metadata: app.raw('to_jsonb(?::text)', [JSON.stringify({ deferred_reason: 'lock_contention' })]),
        retry_count: 0, next_retry_at: new Date('2026-11-20T14:00:00Z'),
        payment_date: '2026-11-02', created_at: new Date('2026-11-02T14:00:00Z'),
      },
      {
        id: holdId, customer_id: customerId, status: 'failed', amount: 33,
        metadata: app.raw('to_jsonb(?::text)', [JSON.stringify({ deferred_reason: 'collection_hold' })]),
        retry_count: 0, next_retry_at: new Date('2026-11-20T14:00:00Z'),
        payment_date: '2026-11-03', created_at: new Date('2026-11-03T14:00:00Z'),
      },
      {
        id: absorbedId, customer_id: customerId, status: 'failed', amount: 33,
        metadata: app.raw('to_jsonb(?::text)', [JSON.stringify({
          deferred_reason: 'collection_hold', deferred_resolution: 'absorbed_annual_prepay',
        })]),
        retry_count: 0, superseded_by_payment_id: absorbedId,
        payment_date: '2026-11-04', created_at: new Date('2026-11-04T14:00:00Z'),
      },
    ]);

    const latest = await excludeNeverAttemptedDeferrals(app('payments')
      .where({ customer_id: customerId })
      .whereIn('status', ['paid', 'failed', 'refunded'])
      .whereNull('superseded_by_payment_id'))
      .orderBy('payment_date', 'desc')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .first('id', 'status');
    expect(latest).toEqual({ id: paidId, status: 'paid' });

    // The shared consumer predicate also recognizes the string-encoded
    // resolution field when the self-superseded row is not prefiltered.
    expect(await excludeNeverAttemptedDeferrals(app('payments')
      .where({ customer_id: customerId })).pluck('id')).toEqual([paidId]);
  });

  test('annual-prepay resolution normalization preserves legacy-string and object metadata', async () => {
    const { paymentMetadataObjectSql } = require('../services/payer-linkage');
    const customerId = randomUUID();
    const legacyId = randomUUID();
    const objectId = randomUUID();
    const legacy = { billed_month: '2026-08', base_amount: 33 };
    const object = { billed_month: '2026-09', base_amount: 44 };
    await app('payments').insert([
      {
        id: legacyId, customer_id: customerId, status: 'failed', amount: 33,
        metadata: app.raw('to_jsonb(?::text)', [JSON.stringify(legacy)]),
      },
      {
        id: objectId, customer_id: customerId, status: 'failed', amount: 44,
        metadata: object,
      },
    ]);

    await app('payments').whereIn('id', [legacyId, objectId]).update({
      metadata: app.raw(`${paymentMetadataObjectSql('payments')} || ?::jsonb`, [
        JSON.stringify({ deferred_resolution: 'absorbed_annual_prepay' }),
      ]),
    });

    const byId = new Map((await app('payments').whereIn('id', [legacyId, objectId])
      .select('id', 'metadata')).map((row) => [row.id, row.metadata]));
    expect(byId.get(legacyId)).toEqual({ ...legacy, deferred_resolution: 'absorbed_annual_prepay' });
    expect(byId.get(objectId)).toEqual({ ...object, deferred_resolution: 'absorbed_annual_prepay' });
  });

  test('a failed classification read is withheld and the read-only snapshot remains usable', async () => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    await app('invoices').insert({ id: invoiceId });
    await app('payments').insert([
      {
        id: randomUUID(), customer_id: customerId, status: 'failed', amount: 89,
        metadata: { invoice_id: invoiceId }, stripe_payment_intent_id: 'pi_linked', retry_count: 1,
      },
      {
        id: randomUUID(), customer_id: customerId, status: 'failed', amount: 12,
        stripe_payment_intent_id: 'pi_standalone', retry_count: 1,
      },
      {
        id: randomUUID(), customer_id: customerId, status: 'upcoming', amount: 17,
      },
    ]);

    await app.transaction(async (snapshot) => {
      const { rows: [mode] } = await snapshot.raw('SHOW transaction_read_only');
      expect(mode.transaction_read_only).toBe('on');
      const facts = await loadFailedPaymentFacts(customerId, snapshot);

      expect(facts.invoiceLookupFailed).toBe(true);
      expect([...facts.unresolvedInvoiceIds]).toEqual([invoiceId]);
      expect(standaloneFailedTotal(facts)).toBe(12);

      // PostgreSQL would raise 25P02 here if the failed statement had only
      // been caught in JavaScript instead of rolled back to a savepoint.
      const upcoming = await snapshot('payments')
        .where({ customer_id: customerId, status: 'upcoming' })
        .select('amount');
      expect(upcoming).toHaveLength(1);
      expect(Number(upcoming[0].amount)).toBe(17);
    }, { isolationLevel: 'repeatable read', readOnly: true });
  });
});
