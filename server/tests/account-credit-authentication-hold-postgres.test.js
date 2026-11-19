// Account-credit settlement versus a saved-card authentication challenge.
// The challenge writer and credit draw serialize on the invoice row: credit
// must wait, see the committed authentication_required hold, and leave both
// the balance and ledger untouched. Once the exact PI cancellation is recorded,
// the ordinary idempotent credit path proceeds exactly once.
const { randomUUID } = require('node:crypto');
const knex = require('knex');

jest.mock('../services/collections/collection-hold', () => ({
  customerHasActiveCollectionHoldChecked: jest.fn(async () => false),
}));

const CustomerCredit = require('../services/customer-credit');
const { recordAuthenticationCancellation } = require('../services/invoice-payment-authentication');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `credit_auth_${randomUUID().replaceAll('-', '')}`;

jest.setTimeout(20000);

postgres('account credit authentication hold (PostgreSQL)', () => {
  let admin;
  let app;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');

    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } });

    await app.schema.createTable('customers', (table) => {
      table.uuid('id').primary();
      table.decimal('account_credits', 12, 2).notNullable().defaultTo(0);
      table.boolean('auto_apply_account_credit').notNullable().defaultTo(false);
      table.timestamp('updated_at');
    });
    await app.schema.createTable('invoices', (table) => {
      table.uuid('id').primary();
      table.uuid('customer_id').notNullable();
      table.string('invoice_number');
      table.string('status').notNullable();
      table.decimal('total', 12, 2).notNullable();
      table.decimal('subtotal', 12, 2);
      table.decimal('discount_amount', 12, 2).defaultTo(0);
      table.decimal('credit_applied', 12, 2).defaultTo(0);
      table.decimal('amount_paid', 12, 2).defaultTo(0);
      table.uuid('payer_id');
      table.string('stripe_payment_intent_id');
      table.timestamp('prepaid_at');
      table.string('prepaid_by');
      table.string('prepaid_prev_status');
      table.timestamp('paid_at');
      table.timestamp('updated_at');
    });
    await app.schema.createTable('stripe_invoice_charge_attempts', (table) => {
      table.uuid('id').primary();
      table.uuid('invoice_id').notNullable();
      table.uuid('payment_method_id');
      table.string('status').notNullable();
      table.string('stripe_payment_intent_id');
      table.string('stripe_payment_method_id');
      table.string('idempotency_key');
      table.decimal('amount', 12, 2);
      table.decimal('credit_applied_delta', 12, 2).notNullable().defaultTo(0);
      table.decimal('credit_applied_total', 12, 2).notNullable().defaultTo(0);
      table.string('decline_code');
      table.string('authentication_canceled_intent_id');
      table.timestamp('submitted_at');
      table.timestamp('resolved_at');
      table.timestamp('created_at');
    });
    await app.schema.createTable('payment_plans', (table) => {
      table.increments('id').primary();
      table.uuid('invoice_id');
      table.string('status');
    });
    await app.schema.createTable('stripe_orphan_charges', (table) => {
      table.uuid('invoice_id');
      table.boolean('resolved').notNullable().defaultTo(false);
      table.string('stripe_payment_intent_id');
    });
    await app.schema.createTable('payments', (table) => {
      table.increments('id').primary();
      table.string('status');
      table.string('stripe_payment_intent_id');
      table.jsonb('metadata');
      table.integer('superseded_by_payment_id');
    });
    await app.schema.createTable('customer_credit_ledger', (table) => {
      table.increments('id').primary();
      table.uuid('customer_id').notNullable();
      table.decimal('delta', 12, 2).notNullable();
      table.decimal('balance_after', 12, 2).notNullable();
      table.string('source').notNullable();
      table.uuid('invoice_id');
      table.uuid('referral_id');
      table.text('note');
      table.string('created_by');
      table.timestamp('created_at').defaultTo(app.fn.now());
    });
  });

  beforeEach(async () => {
    await app('customer_credit_ledger').del();
    await app('stripe_invoice_charge_attempts').del();
    await app('payment_plans').del();
    await app('stripe_orphan_charges').del();
    await app('payments').del();
    await app('invoices').del();
    await app('customers').del();
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  test('the locked draw skips a newly committed authentication hold, then applies once after exact cancellation', async () => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const attemptId = randomUUID();
    const paymentMethodId = randomUUID();
    const intentId = `pi_${attemptId}`;
    const stripeMethodId = 'pm_synthetic_auth_hold';

    await app('customers').insert({
      id: customerId,
      account_credits: 100,
      auto_apply_account_credit: true,
    });
    await app('invoices').insert({
      id: invoiceId,
      customer_id: customerId,
      invoice_number: `SYN-${invoiceId.slice(0, 8)}`,
      status: 'sent',
      total: 100,
      subtotal: 100,
      credit_applied: 0,
      amount_paid: 0,
    });
    await app('stripe_invoice_charge_attempts').insert({
      id: attemptId,
      invoice_id: invoiceId,
      payment_method_id: paymentMethodId,
      stripe_payment_method_id: stripeMethodId,
      status: 'claimed',
      created_at: new Date(),
    });

    const challengeWriter = await app.transaction();
    try {
      const { rows: [writerConnection] } = await challengeWriter.raw('SELECT pg_backend_pid() AS pid');
      await challengeWriter('invoices').where({ id: invoiceId }).forUpdate().first();
      await challengeWriter('stripe_invoice_charge_attempts').where({ id: attemptId }).update({
        status: 'failed',
        decline_code: 'authentication_required',
        stripe_payment_intent_id: intentId,
        resolved_at: new Date(),
      });

      let identifyCreditConnection;
      const connectionReady = new Promise((resolve) => { identifyCreditConnection = resolve; });
      const draw = app.transaction(async (trx) => {
        const { rows: [creditConnection] } = await trx.raw('SELECT pg_backend_pid() AS pid');
        identifyCreditConnection(creditConnection.pid);
        return CustomerCredit.applyAccountCreditToInvoice({ invoiceId, createdBy: 'system:test' }, trx);
      });
      const creditPid = await connectionReady;
      const deadline = Date.now() + 5000;
      while (true) {
        const { rows: [lock] } = await challengeWriter.raw(
          'SELECT ?::int = ANY(pg_blocking_pids(?::int)) AS blocked',
          [writerConnection.pid, creditPid],
        );
        if (lock.blocked) break;
        if (Date.now() >= deadline) throw new Error('Credit draw did not wait for the invoice lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await challengeWriter.commit();
      await expect(draw).resolves.toEqual({ applied: 0, skipped: 'card_payment_may_settle' });
    } finally {
      if (!challengeWriter.isCompleted()) await challengeWriter.rollback();
    }

    expect(await app('customers').where({ id: customerId }).first('account_credits'))
      .toMatchObject({ account_credits: '100.00' });
    expect(await app('invoices').where({ id: invoiceId }).first('status', 'credit_applied'))
      .toMatchObject({ status: 'sent', credit_applied: '0.00' });
    expect(await app('customer_credit_ledger').where({ invoice_id: invoiceId })).toHaveLength(0);

    await recordAuthenticationCancellation({
      id: intentId,
      status: 'canceled',
      payment_method: stripeMethodId,
      metadata: {
        source: 'admin_card_on_file',
        saved_card_attempt_id: attemptId,
        waves_invoice_id: invoiceId,
        waves_customer_id: customerId,
      },
    }, app);

    // A process that died after submitting an older charge is a separate
    // checkout-fence state. It remains held even after the authentication PI
    // above is canceled; resolving that attempt deterministically re-enables
    // the ordinary credit draw.
    const ambiguousAttemptId = randomUUID();
    await app('stripe_invoice_charge_attempts').insert({
      id: ambiguousAttemptId,
      invoice_id: invoiceId,
      payment_method_id: randomUUID(),
      stripe_payment_method_id: 'pm_synthetic_ambiguous',
      stripe_payment_intent_id: 'pi_synthetic_ambiguous',
      status: 'ambiguous',
      created_at: new Date(),
    });
    await expect(CustomerCredit.applyAccountCreditToInvoice({ invoiceId, createdBy: 'system:test' }, app))
      .resolves.toEqual({ applied: 0, skipped: 'card_payment_may_settle' });
    await app('stripe_invoice_charge_attempts').where({ id: ambiguousAttemptId }).update({
      status: 'failed',
      decline_code: 'card_declined',
      resolved_at: new Date(),
    });

    const currentAttemptId = randomUUID();
    await app('stripe_invoice_charge_attempts').insert({
      id: currentAttemptId,
      invoice_id: invoiceId,
      payment_method_id: randomUUID(),
      stripe_payment_method_id: 'pm_current_saved_card_charge',
      status: 'claimed',
      created_at: new Date(),
    });

    await expect(CustomerCredit.applyAccountCreditToInvoice({ invoiceId, createdBy: 'system:test' }, app))
      .resolves.toEqual({ applied: 0, skipped: 'card_payment_may_settle' });

    await expect(CustomerCredit.applyAccountCreditToInvoice({
      invoiceId,
      createdBy: 'system:test',
      currentChargeAttemptId: currentAttemptId,
    }, app))
      .resolves.toMatchObject({ applied: 100, fullyCovered: true, balanceAfter: 0 });

    const StripeService = require('../services/stripe');
    await expect(StripeService.assertNoInvoiceChargeReconciliationPending(invoiceId, app, {
      readOnly: true,
      checkout: true,
      excludeChargeAttemptId: currentAttemptId,
    })).resolves.toBeUndefined();
    await app('stripe_invoice_charge_attempts').where({ id: currentAttemptId }).update({
      stripe_payment_intent_id: 'pi_current_saved_card_charge',
    });
    await expect(StripeService.assertNoInvoiceChargeReconciliationPending(invoiceId, app, {
      readOnly: true,
      checkout: true,
      excludeChargeAttemptId: currentAttemptId,
    })).rejects.toMatchObject({ code: 'STRIPE_CHARGE_IN_PROGRESS', chargeAttemptId: currentAttemptId });
    await app('stripe_invoice_charge_attempts').where({ id: currentAttemptId }).update({
      stripe_payment_intent_id: null,
      submitted_at: new Date(),
    });
    await expect(StripeService.assertNoInvoiceChargeReconciliationPending(invoiceId, app, {
      readOnly: true,
      checkout: true,
      excludeChargeAttemptId: currentAttemptId,
    })).rejects.toMatchObject({ code: 'STRIPE_CHARGE_IN_PROGRESS', chargeAttemptId: currentAttemptId });

    await expect(CustomerCredit.applyAccountCreditToInvoice({
      invoiceId,
      createdBy: 'system:test',
      currentChargeAttemptId: currentAttemptId,
    }, app))
      .resolves.toEqual({ applied: 0, skipped: 'uncollectible' });

    expect(await app('customer_credit_ledger').where({ invoice_id: invoiceId }))
      .toHaveLength(1);
    expect(await app('customers').where({ id: customerId }).first('account_credits'))
      .toMatchObject({ account_credits: '0.00' });
    expect(await app('invoices').where({ id: invoiceId }).first('status', 'credit_applied'))
      .toMatchObject({ status: 'prepaid', credit_applied: '100.00' });
  });

  test('another invoice can spend only excess credit across submission, authentication transition and cancellation', async () => {
    const customerId = randomUUID();
    const heldInvoiceId = randomUUID();
    const otherInvoiceId = randomUUID();
    const attemptId = randomUUID();
    const paymentMethodId = randomUUID();
    const stripePaymentMethodId = 'pm_cross_invoice_auth_hold';
    const intentId = `pi_${attemptId.replaceAll('-', '')}`;

    await app('customers').insert({
      id: customerId,
      account_credits: 100,
      auto_apply_account_credit: true,
    });
    await app('invoices').insert([
      {
        id: heldInvoiceId,
        customer_id: customerId,
        invoice_number: `HELD-${heldInvoiceId.slice(0, 8)}`,
        status: 'sent',
        total: 100,
        subtotal: 100,
        credit_applied: 0,
        amount_paid: 0,
      },
      {
        id: otherInvoiceId,
        customer_id: customerId,
        invoice_number: `OTHER-${otherInvoiceId.slice(0, 8)}`,
        status: 'sent',
        total: 100,
        subtotal: 100,
        credit_applied: 0,
        amount_paid: 0,
      },
    ]);
    await app('stripe_invoice_charge_attempts').insert({
      id: attemptId,
      invoice_id: heldInvoiceId,
      payment_method_id: paymentMethodId,
      stripe_payment_method_id: stripePaymentMethodId,
      idempotency_key: `cross-invoice-${attemptId}`,
      status: 'claimed',
      amount: 75,
      credit_applied_delta: 25,
      credit_applied_total: 25,
      submitted_at: new Date(),
      created_at: new Date(),
    });

    const reservedForOther = () => app.transaction(async (trx) => {
      await trx('customers').where({ id: customerId }).forUpdate().first('id');
      return CustomerCredit.unpostedSavedCardCreditForOtherInvoices({
        customerId,
        invoiceId: otherInvoiceId,
      }, trx);
    });

    await expect(reservedForOther()).resolves.toBe(25);
    await expect(CustomerCredit.applyAccountCreditToInvoice({
      invoiceId: otherInvoiceId,
      createdBy: 'system:test',
    }, app)).resolves.toMatchObject({
      applied: 75,
      fullyCovered: false,
      balanceAfter: 25,
    });
    expect(await app('invoices').where({ id: otherInvoiceId }).first('status', 'credit_applied'))
      .toMatchObject({ status: 'sent', credit_applied: '75.00' });

    // The request transaction rolled back. Whether recovery first labels the
    // submitted claim ambiguous or resolves it as an authentication hold, its
    // reservation stays continuous.
    await app('stripe_invoice_charge_attempts').where({ id: attemptId }).update({
      status: 'ambiguous',
    });
    await expect(reservedForOther()).resolves.toBe(25);
    await expect(CustomerCredit.applyAccountCreditToInvoice({
      invoiceId: otherInvoiceId,
      createdBy: 'system:test',
    }, app)).resolves.toEqual({ applied: 0, skipped: 'no_balance' });

    await app('stripe_invoice_charge_attempts').where({ id: attemptId }).update({
      status: 'failed',
      decline_code: 'authentication_required',
      stripe_payment_intent_id: intentId,
      resolved_at: new Date(),
    });
    await expect(reservedForOther()).resolves.toBe(25);

    await recordAuthenticationCancellation({
      id: intentId,
      status: 'canceled',
      payment_method: stripePaymentMethodId,
      metadata: {
        source: 'admin_card_on_file',
        saved_card_attempt_id: attemptId,
        waves_invoice_id: heldInvoiceId,
        waves_customer_id: customerId,
      },
    }, app);

    await expect(reservedForOther()).resolves.toBe(0);
    await expect(CustomerCredit.applyAccountCreditToInvoice({
      invoiceId: otherInvoiceId,
      createdBy: 'system:test',
    }, app)).resolves.toMatchObject({
      applied: 25,
      fullyCovered: true,
      balanceAfter: 0,
    });
    expect(await app('invoices').where({ id: otherInvoiceId }).first('status', 'credit_applied'))
      .toMatchObject({ status: 'prepaid', credit_applied: '100.00' });
  });

  test('the sibling reservation counts only the submitted delta not already posted', async () => {
    const customerId = randomUUID();
    const heldInvoiceId = randomUUID();
    const otherInvoiceId = randomUUID();
    const attemptId = randomUUID();
    await app('customers').insert({
      id: customerId,
      account_credits: 90,
      auto_apply_account_credit: true,
    });
    await app('invoices').insert([
      {
        id: heldInvoiceId,
        customer_id: customerId,
        status: 'sent',
        total: 100,
        credit_applied: 10,
        amount_paid: 0,
      },
      {
        id: otherInvoiceId,
        customer_id: customerId,
        status: 'sent',
        total: 75,
        credit_applied: 0,
        amount_paid: 0,
      },
    ]);
    await app('stripe_invoice_charge_attempts').insert({
      id: attemptId,
      invoice_id: heldInvoiceId,
      payment_method_id: randomUUID(),
      stripe_payment_method_id: 'pm_partly_posted_auth_hold',
      status: 'claimed',
      amount: 75,
      credit_applied_delta: 25,
      credit_applied_total: 25,
      submitted_at: new Date(),
      created_at: new Date(),
    });

    await expect(app.transaction(async (trx) => {
      await trx('customers').where({ id: customerId }).forUpdate().first('id');
      return CustomerCredit.unpostedSavedCardCreditForOtherInvoices({
        customerId,
        invoiceId: otherInvoiceId,
      }, trx);
    })).resolves.toBe(15);

    await expect(CustomerCredit.applyAccountCreditToInvoice({
      invoiceId: otherInvoiceId,
      createdBy: 'system:test',
    }, app)).resolves.toMatchObject({
      applied: 75,
      fullyCovered: true,
      balanceAfter: 15,
    });
  });

  test('checkout snapshot sees one side of a concurrent sibling settlement, never a doubled credit', async () => {
    const customerId = randomUUID();
    const heldInvoiceId = randomUUID();
    const checkoutInvoiceId = randomUUID();
    const attemptId = randomUUID();
    await app('customers').insert({
      id: customerId,
      account_credits: 100,
      auto_apply_account_credit: true,
    });
    await app('invoices').insert([
      {
        id: heldInvoiceId,
        customer_id: customerId,
        status: 'sent',
        total: 100,
        credit_applied: 0,
        amount_paid: 0,
      },
      {
        id: checkoutInvoiceId,
        customer_id: customerId,
        status: 'sent',
        total: 100,
        credit_applied: 0,
        amount_paid: 0,
      },
    ]);
    await app('stripe_invoice_charge_attempts').insert({
      id: attemptId,
      invoice_id: heldInvoiceId,
      payment_method_id: randomUUID(),
      stripe_payment_method_id: 'pm_snapshot_settlement',
      idempotency_key: `snapshot-${attemptId}`,
      status: 'claimed',
      amount: 75,
      credit_applied_delta: 25,
      credit_applied_total: 25,
      submitted_at: new Date(),
      created_at: new Date(),
    });

    const settlement = await app.transaction();
    try {
      await settlement('customers').where({ id: customerId }).update({ account_credits: 75 });
      await settlement('invoices').where({ id: heldInvoiceId }).update({ credit_applied: 25 });
      await settlement('stripe_invoice_charge_attempts').where({ id: attemptId }).update({
        status: 'succeeded',
        resolved_at: settlement.fn.now(),
      });

      await expect(CustomerCredit.accountCreditSnapshotForInvoice({
        customerId,
        invoiceId: checkoutInvoiceId,
      }, app)).resolves.toMatchObject({
        balance: 100,
        reserved: 25,
        spendable: 75,
        autoApplyEnabled: true,
      });
      await settlement.commit();
    } catch (err) {
      await settlement.rollback();
      throw err;
    }

    await expect(CustomerCredit.accountCreditSnapshotForInvoice({
      customerId,
      invoiceId: checkoutInvoiceId,
    }, app)).resolves.toMatchObject({
      balance: 75,
      reserved: 0,
      spendable: 75,
      autoApplyEnabled: true,
    });
  });

  test('checkout projection and invoice lock complete while Terminal holds invoice then customer', async () => {
    const customerId = randomUUID();
    const terminalInvoiceId = randomUUID();
    const checkoutInvoiceId = randomUUID();
    const heldInvoiceId = randomUUID();
    await app('customers').insert({
      id: customerId,
      account_credits: 100,
      auto_apply_account_credit: true,
    });
    await app('invoices').insert([
      { id: terminalInvoiceId, customer_id: customerId, status: 'sent', total: 25, credit_applied: 0, amount_paid: 0 },
      { id: checkoutInvoiceId, customer_id: customerId, status: 'sent', total: 100, credit_applied: 0, amount_paid: 0 },
      { id: heldInvoiceId, customer_id: customerId, status: 'sent', total: 25, credit_applied: 0, amount_paid: 0 },
    ]);
    await app('stripe_invoice_charge_attempts').insert({
      id: randomUUID(),
      invoice_id: heldInvoiceId,
      payment_method_id: randomUUID(),
      stripe_payment_method_id: 'pm_terminal_lock_order',
      status: 'claimed',
      amount: 0,
      credit_applied_delta: 25,
      credit_applied_total: 25,
      submitted_at: new Date(),
      created_at: new Date(),
    });

    const terminal = await app.transaction();
    try {
      await terminal('invoices').where({ id: terminalInvoiceId }).forUpdate().first('id');
      await terminal('customers').where({ id: customerId }).forUpdate().first('id');

      await expect(app.transaction(async (checkout) => {
        await checkout.raw("SET LOCAL lock_timeout = '250ms'");
        const snapshot = await CustomerCredit.accountCreditSnapshotForInvoice({
          customerId,
          invoiceId: checkoutInvoiceId,
        }, checkout);
        await checkout('invoices').where({ id: checkoutInvoiceId }).forUpdate().first('id');
        return snapshot;
      })).resolves.toMatchObject({
        balance: 100,
        reserved: 25,
        spendable: 75,
      });
    } finally {
      await terminal.rollback();
    }
  });
});
