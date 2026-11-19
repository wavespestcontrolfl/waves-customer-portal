const { randomUUID } = require('node:crypto');
const knex = require('knex');

let mockDatabase;
jest.mock('../models/db', () => {
  const table = (...args) => mockDatabase(...args);
  table.raw = (...args) => mockDatabase.raw(...args);
  table.transaction = (...args) => mockDatabase.transaction(...args);
  return table;
});
jest.mock('../config/stripe-config', () => ({ secretKey: null }));
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn() }));
jest.mock('../services/receipt-delivery-queue', () => ({ enqueueReceiptDelivery: jest.fn(), scheduleReceiptDeliveryDrain: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn() }));
jest.mock('../services/invoice-followups', () => ({ stopOnPayment: jest.fn(async () => {}) }));

const { _handlePaymentIntentSucceeded: settle } = require('../routes/stripe-webhook');
const connection = process.env.APP_TEST_DATABASE_URL;
const schema = `auth_settlement_${randomUUID().replaceAll('-', '')}`;
jest.setTimeout(20000);

(connection ? describe : describe.skip)('authenticated saved-card settlement with account credit', () => {
  const tables = ['customers', 'invoices', 'payments', 'stripe_invoice_charge_attempts', 'stripe_orphan_charges',
    'customer_credit_ledger', 'payment_plans', 'stripe_payment_notification_log', 'invoice_followup_sequences', 'notifications'];
  let customerId;
  let invoiceId;
  let attemptId;
  let intent;

  beforeAll(async () => {
    const { hostname, pathname } = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(hostname)
      || !(/^\/waves_qa_[a-f0-9]{32}$/.test(pathname) || (process.env.CI === 'true' && pathname === '/waves_test'))) {
      throw new Error('Use a local private QA or isolated CI test database');
    }
    mockDatabase = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 8 } });
    await mockDatabase.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await mockDatabase.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
  });

  afterAll(async () => {
    if (!mockDatabase) return;
    await mockDatabase.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await mockDatabase.destroy();
  });

  beforeEach(async () => {
    customerId = randomUUID();
    invoiceId = randomUUID();
    attemptId = randomUUID();
    const intentId = `pi_${randomUUID().replaceAll('-', '')}`;
    await mockDatabase('customers').insert({ id: customerId, first_name: 'Card', last_name: 'Challenge',
      phone: '+12025550100', email: `${customerId}@example.invalid`, account_credits: 40 });
    await mockDatabase('invoices').insert({ id: invoiceId, customer_id: customerId, invoice_number: `AUTH-${invoiceId.slice(0, 12)}`,
      token: randomUUID(), status: 'sent', subtotal: 100, total: 100, line_items: '[]' });
    await mockDatabase('stripe_invoice_charge_attempts').insert({ id: attemptId, invoice_id: invoiceId,
      stripe_payment_method_id: 'pm_saved', idempotency_key: attemptId, status: 'failed', decline_code: 'authentication_required',
      amount: 75, credit_applied_delta: 25, credit_applied_total: 25, submitted_at: new Date(), resolved_at: new Date() });
    intent = { id: intentId, status: 'succeeded', amount: 7500, amount_received: 7500,
      payment_method: 'pm_saved', payment_method_types: ['card'],
      metadata: { source: 'admin_card_on_file', waves_invoice_id: invoiceId, waves_customer_id: customerId,
        saved_card_attempt_id: attemptId, base_amount: '75', card_surcharge: '0', surcharge_policy_version: 'test' } };
  });

  async function expectSettled(balance, creditDebit) {
    expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({
      status: 'paid', total: '100.00', credit_applied: '25.00', stripe_payment_intent_id: intent.id,
    });
    expect(await mockDatabase('customers').where({ id: customerId }).first()).toMatchObject({ account_credits: balance });
    const debits = await mockDatabase('customer_credit_ledger').where({ invoice_id: invoiceId });
    expect(debits.map((row) => row.delta)).toEqual([creditDebit]);
    const payments = await mockDatabase('payments').where({ stripe_payment_intent_id: intent.id });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'paid', customer_id: customerId, amount: '75.00' });
    expect(await mockDatabase('stripe_invoice_charge_attempts').where({ id: attemptId }).first()).toMatchObject({
      status: 'succeeded', stripe_payment_intent_id: intent.id, decline_code: null,
    });
    expect(await mockDatabase('stripe_orphan_charges').where({ stripe_payment_intent_id: intent.id })).toHaveLength(0);
  }

  test('two deliveries settle $75 cash and $25 credit once on a $100 invoice', async () => {
    await Promise.all([settle(intent), settle(intent)]);
    await expectSettled('15.00', '-25.00');
  });

  test('a delayed authenticated success records Stripe settlement time and its Eastern cash-basis day', async () => {
    // 2026-10-01 02:30 UTC was still September 30 in New York (EDT).
    const eventCreated = Date.parse('2026-10-01T02:30:00.000Z') / 1000;

    await settle(intent, eventCreated);

    await expectSettled('15.00', '-25.00');
    const payment = await mockDatabase('payments').where({ stripe_payment_intent_id: intent.id }).first();
    expect(payment).toMatchObject({
      metadata: expect.objectContaining({ settled_event_at: '2026-10-01T02:30:00.000Z' }),
    });
    expect(payment.payment_date.toISOString().slice(0, 10)).toBe('2026-09-30');
  });

  test('settlement replaces the checkout this attempt retired, including its sibling stamps', async () => {
    const retired = `pi_old_${attemptId}`;
    const sibling = randomUUID();
    await mockDatabase('invoices').where({ id: invoiceId }).update({ stripe_payment_intent_id: retired });
    await mockDatabase('invoices').insert({ id: sibling, customer_id: customerId, invoice_number: `SIB-${sibling.slice(0, 12)}`,
      token: randomUUID(), status: 'sent', total: 15, subtotal: 15, line_items: '[]', stripe_payment_intent_id: retired });
    await mockDatabase('stripe_invoice_charge_attempts').where({ id: attemptId }).update({ canceled_checkout_payment_intent_id: retired });
    await settle(intent);
    await expectSettled('15.00', '-25.00');
    expect(await mockDatabase('invoices').where({ id: sibling }).first()).toMatchObject({
      status: 'sent', total: '15.00', stripe_payment_intent_id: null,
    });
  });

  async function waitForBlockedSettlement(holderPid) {
    const deadline = Date.now() + 10000;
    for (;;) {
      const { rows: [wait] } = await mockDatabase.raw(
        'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ?::int = ANY(pg_blocking_pids(pid))) AS blocked', [holderPid],
      );
      if (wait.blocked) return;
      if (Date.now() >= deadline) throw new Error('Settlement did not reach the held row lock');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  test('an exact ambiguous attempt becoming authentication-required is retried, then settles on fresh classification', async () => {
    await mockDatabase('stripe_invoice_charge_attempts').where({ id: attemptId }).update({
      status: 'ambiguous',
      decline_code: null,
      resolved_at: null,
    });
    const holder = await mockDatabase.transaction();
    let outcome;
    try {
      const { rows: [session] } = await holder.raw('SELECT pg_backend_pid() AS pid');
      await holder('invoices').where({ id: invoiceId }).forUpdate().first('id');
      outcome = settle(intent);
      await waitForBlockedSettlement(session.pid);
      await holder('stripe_invoice_charge_attempts').where({ id: attemptId }).update({
        status: 'failed',
        decline_code: 'authentication_required',
        resolved_at: new Date(),
      });
      await holder.commit();

      await expect(outcome).rejects.toMatchObject({ code: 'SAVED_CARD_SETTLEMENT_STATE_CHANGED' });
      expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({
        status: 'sent', credit_applied: '0.00', stripe_payment_intent_id: null,
      });
      expect(await mockDatabase('payments').where({ stripe_payment_intent_id: intent.id })).toHaveLength(0);
      expect(await mockDatabase('stripe_orphan_charges').where({ stripe_payment_intent_id: intent.id })).toHaveLength(0);

      await settle(intent);
      await expectSettled('15.00', '-25.00');
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
      if (outcome) await outcome.catch(() => {});
    }
  });

  test('an unrelated checkout attached after the preliminary lookup is preserved', async () => {
    const retired = `pi_old_${attemptId}`;
    const newer = `pi_new_${attemptId}`;
    await mockDatabase('invoices').where({ id: invoiceId }).update({ stripe_payment_intent_id: retired });
    await mockDatabase('stripe_invoice_charge_attempts').where({ id: attemptId }).update({ canceled_checkout_payment_intent_id: retired });
    const holder = await mockDatabase.transaction();
    let outcome;
    try {
      const { rows: [session] } = await holder.raw('SELECT pg_backend_pid() AS pid');
      await holder('customers').where({ id: customerId }).forUpdate().first('id');
      outcome = settle(intent);
      await waitForBlockedSettlement(session.pid);
      await holder('invoices').where({ id: invoiceId }).update({ stripe_payment_intent_id: newer });
      await holder.commit();
      await outcome;
      expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({
        status: 'sent', credit_applied: '0.00', stripe_payment_intent_id: newer,
      });
      expect(await mockDatabase('stripe_orphan_charges').where({ stripe_payment_intent_id: intent.id }).first())
        .toMatchObject({ amount: '75.00', resolved: false });
      expect(await mockDatabase('customer_credit_ledger').where({ invoice_id: invoiceId })).toHaveLength(0);
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
      await outcome;
    }
  });

  test.each([
    ['the invoice gained one cent', 100.01, '75', '0'],
    ['the submitted base lost one cent', 100, '74.99', '0.01'],
    ['the submitted surcharge exceeds the capture by one cent', 100, '75', '0.01'],
  ])('quarantines a one-cent disagreement when %s', async (_description, total, base, surcharge) => {
    await mockDatabase('invoices').where({ id: invoiceId }).update({ total });
    Object.assign(intent.metadata, { base_amount: base, card_surcharge: surcharge });
    await settle(intent);
    expect(await mockDatabase('stripe_orphan_charges').where({ stripe_payment_intent_id: intent.id }).first())
      .toMatchObject({ amount: '75.00', resolved: false });
    expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({
      status: 'sent', total: total.toFixed(2), credit_applied: '0.00',
    });
    expect(await mockDatabase('customer_credit_ledger').where({ invoice_id: invoiceId })).toHaveLength(0);
  });

  test('a submitted $1.88 surcharge reconciles with $75 principal and $25 account credit', async () => {
    Object.assign(intent, { amount: 7688, amount_received: 7688 });
    intent.metadata.card_surcharge = '1.88';
    await mockDatabase('stripe_invoice_charge_attempts').where({ id: attemptId }).update({ amount: 76.88 });
    await settle(intent);
    expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({
      status: 'paid', total: '101.88', credit_applied: '25.00',
    });
    expect(await mockDatabase('payments').where({ stripe_payment_intent_id: intent.id }).first()).toMatchObject({
      status: 'paid', amount: '76.88', base_amount_cents: 7500, surcharge_amount_cents: 188,
    });
  });

  test.each(['processing', 'failed', 'paid'])('stores the verified surcharge breakdown on an existing %s payment', async (status) => {
    Object.assign(intent, { amount: 7688, amount_received: 7688 });
    Object.assign(intent.metadata, { card_surcharge: '1.88', surcharge_rate_bps: '250', card_funding: 'credit' });
    await mockDatabase('stripe_invoice_charge_attempts').where({ id: attemptId }).update({ amount: 76.88 });
    await mockDatabase('payments').insert({ customer_id: customerId, stripe_payment_intent_id: intent.id, amount: 76.88,
      payment_date: '2026-11-19', status, processor: 'stripe', base_amount_cents: 7688, surcharge_amount_cents: 0,
      metadata: { invoice_id: invoiceId, prior_note: 'keep', base_amount: 76.88, card_surcharge: 0 } });
    await settle(intent);
    const rows = await mockDatabase('payments').where({ stripe_payment_intent_id: intent.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'paid', amount: '76.88', base_amount_cents: 7500, surcharge_amount_cents: 188,
      surcharge_rate_bps: 250, surcharge_policy_version: 'test', card_funding: 'credit',
      metadata: { invoice_id: invoiceId, prior_note: 'keep', base_amount: 75, card_surcharge: 1.88, charged_amount: 76.88 },
    });
  });

  test.each(['different card', 'different saved-card attempt', 'different bound PI', 'method from a prior failure', 'independent checkout'])(
    'quarantines an exact $100 capture from a %s while the original challenge can still settle', async (kind) => {
      await mockDatabase('stripe_invoice_charge_attempts').where({ id: attemptId }).update({
        amount: 100, credit_applied_delta: 0, credit_applied_total: 0,
        stripe_payment_intent_id: kind === 'different bound PI' ? 'pi_original_challenge' : null,
      });
      intent.amount = intent.amount_received = 10000;
      intent.metadata.base_amount = '100';
      if (kind === 'different card') intent.payment_method = 'pm_other';
      if (kind === 'different saved-card attempt') intent.metadata.saved_card_attempt_id = randomUUID();
      if (kind === 'method from a prior failure') {
        delete intent.payment_method;
        intent.last_payment_error = { payment_method: { id: 'pm_saved' } };
      }
      if (kind === 'independent checkout') delete intent.metadata.source;
      await settle(intent);
      expect(await mockDatabase('stripe_orphan_charges').where({ stripe_payment_intent_id: intent.id }).first()).toMatchObject({
        invoice_id: invoiceId, customer_id: customerId, amount: '100.00', resolved: false,
        original_db_error: expect.stringContaining(attemptId),
      });
      expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'sent', total: '100.00' });
      expect(await mockDatabase('payments').where({ stripe_payment_intent_id: intent.id })).toHaveLength(0);
      expect(await mockDatabase('stripe_invoice_charge_attempts').where({ id: attemptId }).first()).toMatchObject({ status: 'failed' });
    },
  );

  test.each(['processing', 'failed'])('a challenge committed after the lookup preserves a %s payment and records the conflicting capture', async (status) => {
    await mockDatabase('stripe_invoice_charge_attempts').where({ id: attemptId }).update({
      decline_code: 'card_declined', amount: 100, credit_applied_delta: 0, credit_applied_total: 0,
    });
    intent.amount = intent.amount_received = 10000;
    intent.metadata.base_amount = '100';
    delete intent.metadata.source;
    await mockDatabase('payments').insert({ customer_id: customerId, stripe_payment_intent_id: intent.id,
      amount: 100, payment_date: '2026-11-19', status, processor: 'stripe', metadata: { invoice_id: invoiceId } });
    const holder = await mockDatabase.transaction();
    let outcome;
    try {
      const { rows: [session] } = await holder.raw('SELECT pg_backend_pid() AS pid');
      await holder('invoices').where({ id: invoiceId }).forUpdate().first('id');
      outcome = settle(intent);
      await waitForBlockedSettlement(session.pid);
      await holder('stripe_invoice_charge_attempts').where({ id: attemptId }).update({ decline_code: 'authentication_required' });
      await holder.commit();
      await outcome;
      expect(await mockDatabase('payments').where({ stripe_payment_intent_id: intent.id }).first()).toMatchObject({ status });
      expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'sent' });
      expect(await mockDatabase('stripe_orphan_charges').where({ stripe_payment_intent_id: intent.id }).first()).toMatchObject({
        invoice_id: invoiceId, customer_id: customerId, amount: '100.00', resolved: false,
        original_db_error: expect.stringContaining(attemptId),
      });
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
      await outcome;
    }
  });

  test('a pre-existing payment uses only the missing credit and finishes in the invoice transaction', async () => {
    await mockDatabase('invoices').where({ id: invoiceId }).update({ credit_applied: 10 });
    await mockDatabase('payments').insert({ customer_id: customerId, stripe_payment_intent_id: intent.id,
      amount: 75, payment_date: '2026-11-19', status: 'processing', processor: 'stripe', metadata: { invoice_id: invoiceId } });
    await settle(intent);
    await expectSettled('25.00', '-15.00');
  });

  test('a failure writing the payment rolls the credit and invoice back, and redelivery settles once', async () => {
    await mockDatabase.raw("ALTER TABLE payments ADD CONSTRAINT simulate_failed_insert CHECK (status <> 'paid') NOT VALID");
    try {
      await expect(settle(intent)).rejects.toMatchObject({ code: '23514' });
      expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'sent', credit_applied: '0.00' });
      expect(await mockDatabase('customers').where({ id: customerId }).first()).toMatchObject({ account_credits: '40.00' });
      expect(await mockDatabase('customer_credit_ledger').where({ invoice_id: invoiceId })).toHaveLength(0);
      expect(await mockDatabase('stripe_invoice_charge_attempts').where({ id: attemptId }).first()).toMatchObject({ status: 'failed' });
    } finally {
      await mockDatabase.raw('ALTER TABLE payments DROP CONSTRAINT simulate_failed_insert');
    }
    await settle(intent);
    await expectSettled('15.00', '-25.00');
  });

  test.each(['insufficient credit', 'invoice retotaled', 'another card', 'credit beyond submitted draw'])(
    'records captured money for reconciliation without debiting credit or closing the invoice for %s', async (reason) => {
      if (reason === 'insufficient credit') await mockDatabase('customers').where({ id: customerId }).update({ account_credits: 10 });
      if (reason === 'invoice retotaled') await mockDatabase('invoices').where({ id: invoiceId }).update({ total: 125 });
      if (reason === 'another card') intent.payment_method = 'pm_other';
      if (reason === 'credit beyond submitted draw') await mockDatabase('stripe_invoice_charge_attempts')
        .where({ id: attemptId }).update({ credit_applied_delta: 15 });
      await settle(intent);
      expect(await mockDatabase('stripe_orphan_charges').where({ stripe_payment_intent_id: intent.id }).first()).toMatchObject({
        amount: '75.00', invoice_id: invoiceId, resolved: false,
      });
      expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'sent', credit_applied: '0.00' });
      expect(await mockDatabase('customers').where({ id: customerId }).first()).toMatchObject({
        account_credits: reason === 'insufficient credit' ? '10.00' : '40.00',
      });
      expect(await mockDatabase('payments').where({ stripe_payment_intent_id: intent.id })).toHaveLength(0);
      expect(await mockDatabase('customer_credit_ledger').where({ invoice_id: invoiceId })).toHaveLength(0);
      expect(await mockDatabase('stripe_invoice_charge_attempts').where({ id: attemptId }).first()).toMatchObject({ status: 'failed' });
    },
  );
});
