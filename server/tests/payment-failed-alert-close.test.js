/**
 * A payment_failed admin bell closes when its invoice is paid, whichever
 * PaymentIntent paid it. The SQL below is compiled by a real knex pg builder
 * (no connection) so the match keys are asserted as emitted; the Postgres twin
 * (payment-failed-alert-close-postgres.test.js) runs them against real rows.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

jest.mock('../services/retry-collectibility', () => ({
  ...jest.requireActual('../services/retry-collectibility'),
  findCollectedMonthlyPayment: jest.fn(),
}));
const { findCollectedMonthlyPayment } = require('../services/retry-collectibility');
const knex = require('knex')({ client: 'pg' });
const logger = require('../services/logger');
const { closePaymentFailedAlertsForPaidInvoice, sweepSettledPaymentFailedAlerts, RESOLUTION } = require('../services/payment-failed-alert-close');
const PaymentPlans = require('../services/payment-plans');

const INV_A = '11111111-1111-4111-8111-111111111111';
const INV_B = '22222222-2222-4222-8222-222222222222';
const CUST = '33333333-3333-4333-8333-333333333333';
const bell = (id, payload, triggerKey = 'payment_failed') => ({ id, created_at: '2026-11-01T12:00:00Z', metadata: { triggerKey, payload } });

// A connection whose queries are compiled, never executed. `responses[table]`
// is a queue of results for the awaited queries on that table, in order.
function compilingConn({ failWith = null, responses = {} } = {}) {
  const captured = [];
  const queues = Object.fromEntries(Object.entries(responses).map(([t, r]) => [t, [...r]]));
  const conn = (table) => {
    const builder = knex(table);
    builder.then = (resolve, reject) => {
      captured.push({ table, ...builder.toSQL().toNative() });
      const queue = queues[table];
      const result = queue && queue.length ? queue.shift() : 1;
      return (failWith ? Promise.reject(failWith) : Promise.resolve(result)).then(resolve, reject);
    };
    return builder;
  };
  conn.raw = (...args) => knex.raw(...args);
  conn.fn = knex.fn;
  conn.isTransaction = true;
  conn.transaction = async (fn) => fn(conn);
  return { conn, captured };
}

// One bell about INV_A whose failed attempt covered only INV_A, INV_A paid.
const settledSingle = () => ({
  notifications: [[bell(7, { paymentIntentId: 'pi_x', invoiceId: null })], 1],
  payments: [[{ metadata: { invoice_id: INV_A } }]],
  invoices: [[{ id: INV_A }]],
});

test('selects bells by invoice id OR by the failed attempt ledger row, then closes as the payments closer', async () => {
  const { conn, captured } = compilingConn({ responses: settledSingle() });
  expect(await closePaymentFailedAlertsForPaidInvoice(INV_A, conn)).toBe(1);
  const select = captured.find((q) => q.table === 'notifications' && q.sql.startsWith('select'));
  expect(select.sql).toContain("metadata->>'triggerKey' IN ($");
  expect(select.bindings).toEqual(expect.arrayContaining(['payment_failed', 'bill_payment_error']));
  expect(select.sql).toContain('"recipient_type" = $');
  expect(select.sql).toContain("metadata->'payload'->>'invoiceId' = $");
  expect(select.sql).toContain("metadata->'payload'->>'paymentIntentId' IN (");
  expect(select.sql).toContain("p.metadata->>'invoice_id' = $");
  // text comparisons only: a malformed stored id cannot throw a uuid cast error
  expect(select.sql).not.toMatch(/::uuid/i);
  // a row already closed by a system component is left alone (openToCloser)
  expect(select.sql).toMatch(/"done_at" is null or COALESCE\(/);
  expect(select.bindings.filter((b) => b === INV_A)).toHaveLength(2);
  const update = captured.find((q) => q.sql.startsWith('update'));
  expect(update.sql).toContain('"done_by" = $');
  expect(update.sql).toContain('COALESCE(done_at');
  expect(update.sql).toContain('COALESCE(resolution');
  expect(update.sql).toContain('"id" in (');
  expect(update.bindings).toEqual(expect.arrayContaining([7, 'payments', RESOLUTION]));
});

test('a combined attempt stays open while another invoice in its allocation is unpaid, and closes once all are paid', async () => {
  const allocation = { payments: [[{ metadata: { invoice_id: INV_A } }, { metadata: JSON.stringify({ invoice_id: INV_B }) }]] };
  // INV_A just paid, INV_B not: the invoices read finds one of two
  const one = compilingConn({ responses: { ...allocation, notifications: [[bell(7, { paymentIntentId: 'pi_x' })]], invoices: [[{ id: INV_A }]] } });
  expect(await closePaymentFailedAlertsForPaidInvoice(INV_A, one.conn)).toBe(0);
  expect(one.captured.some((q) => q.sql.startsWith('update'))).toBe(false);
  // both paid
  const both = compilingConn({ responses: { ...allocation, notifications: [[bell(7, { paymentIntentId: 'pi_x' })], 1], invoices: [[{ id: INV_A }, { id: INV_B }]] } });
  expect(await closePaymentFailedAlertsForPaidInvoice(INV_B, both.conn)).toBe(1);
  const invoiceRead = both.captured.find((q) => q.table === 'invoices');
  expect(invoiceRead.bindings).toEqual(expect.arrayContaining([INV_A, INV_B, 'paid', 'prepaid']));
});

test('closes only the bells whose own allocation is settled; a stamped invoiceId joins the allocation', async () => {
  const { conn, captured } = compilingConn({ responses: {
    notifications: [[bell(1, { paymentIntentId: 'pi_a' }), bell(2, { paymentIntentId: 'pi_b', invoiceId: INV_B })], 1],
    payments: [[{ metadata: { invoice_id: INV_A } }], [{ metadata: { invoice_id: INV_A } }]],
    invoices: [[{ id: INV_A }], [{ id: INV_A }]],
  } });
  expect(await closePaymentFailedAlertsForPaidInvoice(INV_A, conn)).toBe(1);
  expect(captured.find((q) => q.sql.startsWith('update')).bindings).toEqual(expect.arrayContaining([1]));
  expect(captured.find((q) => q.sql.startsWith('update')).bindings).not.toContain(2);
});

test('a non-UUID ledger invoice id is ignored, never compared to invoices.id', async () => {
  const { conn, captured } = compilingConn({ responses: {
    notifications: [[bell(7, { paymentIntentId: 'pi_x' })]],
    payments: [[{ metadata: { invoice_id: 'legacy-123' } }]],
  } });
  expect(await closePaymentFailedAlertsForPaidInvoice(INV_A, conn)).toBe(0);
  expect(captured.some((q) => q.table === 'invoices')).toBe(false);
});

test('a missing invoice id writes nothing', async () => {
  const { conn, captured } = compilingConn();
  expect(await closePaymentFailedAlertsForPaidInvoice(null, conn)).toBe(0);
  expect(captured).toHaveLength(0);
});

test('a failure in the closer is logged and returns 0, never thrown', async () => {
  const { conn } = compilingConn({ failWith: new Error('boom') });
  await expect(closePaymentFailedAlertsForPaidInvoice(INV_A, conn)).resolves.toBe(0);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
});

describe('payment path (completeActivePlansForInvoice)', () => {
  // The paid check and plan writes are a minimal stand-in; the notification
  // select is the real compiled closer query (no open bells), optionally failing.
  function paymentConn({ status, failClose = false }) {
    const writes = [];
    const closer = compilingConn({ failWith: failClose ? new Error('closer down') : null, responses: { notifications: [[]] } });
    const conn = (table) => {
      if (table === 'notifications') return closer.conn(table);
      const chain = {
        where: () => chain, forUpdate: () => chain, whereExists: () => chain, whereIn: () => chain,
        first: async () => ({ status }),
        update: async (patch) => { writes.push([table, patch]); return 1; },
      };
      return chain;
    };
    conn.isTransaction = true;
    conn.raw = closer.conn.raw;
    conn.transaction = closer.conn.transaction;
    return { conn, writes, captured: closer.captured };
  }

  test.each(['paid', 'prepaid'])('runs for a %s invoice and the plan completion still happens', async (status) => {
    const { conn, writes, captured } = paymentConn({ status });
    await PaymentPlans.completeActivePlansForInvoice('inv-9', conn);
    expect(captured).toHaveLength(1);
    expect(writes.map(([table]) => table)).toEqual(['payment_plans', 'invoice_followup_sequences']);
  });

  test.each(['overdue', 'sent', 'processing', 'void'])('does not run while the invoice is %s', async (status) => {
    const { conn, writes, captured } = paymentConn({ status });
    expect(await PaymentPlans.completeActivePlansForInvoice('inv-9', conn)).toBe(0);
    expect(captured).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  test('a failing closer does not fail the payment path or skip the plan writes', async () => {
    const { conn, writes } = paymentConn({ status: 'paid', failClose: true });
    await expect(PaymentPlans.completeActivePlansForInvoice('inv-9', conn)).resolves.toBe(1);
    expect(writes.map(([table]) => table)).toEqual(['payment_plans', 'invoice_followup_sequences']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('closer down'));
  });

  test('a connection with no savepoint support cannot break the payment path', async () => {
    const { conn, writes } = paymentConn({ status: 'paid' });
    conn.transaction = undefined;
    await expect(PaymentPlans.completeActivePlansForInvoice('inv-9', conn)).resolves.toBe(1);
    expect(writes).toHaveLength(2);
  });
});

describe('repair sweep', () => {
  test('re-judges open payment_failed bells from committed state and closes the settled ones', async () => {
    const { conn, captured } = compilingConn({ responses: {
      notifications: [[bell(7, { paymentIntentId: 'pi_x', invoiceId: INV_A }), bell(8, { paymentIntentId: 'pi_y', invoiceId: INV_B })], 1],
      payments: [[], []],
      invoices: [[{ id: INV_A }], []],
    } });
    expect(await sweepSettledPaymentFailedAlerts({ conn })).toBe(1);
    const select = captured.find((q) => q.table === 'notifications' && q.sql.startsWith('select'));
    expect(select.sql).toContain("metadata->>'triggerKey' IN ($");
    expect(select.bindings).toEqual(expect.arrayContaining(['payment_failed', 'bill_payment_error']));
    expect(select.sql).toContain('"done_at" is null');
    expect(select.sql).toContain('limit $');
    const update = captured.find((q) => q.table === 'notifications' && q.sql.startsWith('update'));
    expect(update.bindings).toContain(7);
    expect(update.bindings).not.toContain(8);
    expect(update.bindings).toContain(RESOLUTION);
  });

  test('a bill_payment_error bell closes when its invoice is paid, judged on payload.invoiceId alone', async () => {
    const { conn, captured } = compilingConn({ responses: {
      notifications: [[bell(7, { invoiceId: INV_A, paymentIntentId: 'pi_combined' }, 'bill_payment_error'), bell(8, { invoiceId: INV_B }, 'bill_payment_error')], 1],
      invoices: [[{ id: INV_A }], []],
    } });
    expect(await sweepSettledPaymentFailedAlerts({ conn })).toBe(1);
    // the combined PaymentIntent's ledger is never read for this trigger
    expect(captured.some((q) => q.table === 'payments')).toBe(false);
    const invoiceReads = captured.filter((q) => q.table === 'invoices');
    expect(invoiceReads[0].bindings).toEqual(expect.arrayContaining([INV_A]));
    expect(captured.find((q) => q.table === 'notifications' && q.sql.startsWith('update')).bindings).toEqual(expect.arrayContaining([7]));
    expect(captured.find((q) => q.table === 'notifications' && q.sql.startsWith('update')).bindings).not.toContain(8);
  });

  describe('a payment_failed bell with no invoice (monthly dues)', () => {
    const noInvoice = (extra = {}) => bell(7, { amount: 113.6, customerId: CUST, invoiceId: null, paymentIntentId: 'pi_nov', ...extra });
    const failedRow = (extra = {}) => ({ id: 'pay-failed', description: 'WaveGuard Monthly - November', metadata: { billed_month: '2026-11' }, payment_date: '2026-11-01', ...extra });
    // payments queue: the allocation's ledger read twice (settled check, then the fallback's own), then the failed row by PaymentIntent.
    const run = async ({ collected = { id: 'pay-paid' }, failed = failedRow(), notification = noInvoice() } = {}) => {
      findCollectedMonthlyPayment.mockResolvedValue(collected);
      const { conn, captured } = compilingConn({ responses: { notifications: [[notification], 1], payments: [[{ metadata: {} }], [{ metadata: {} }], failed], invoices: [[]] } });
      return { closed: await sweepSettledPaymentFailedAlerts({ conn }), captured };
    };
    beforeEach(() => findCollectedMonthlyPayment.mockReset());

    test('closes when the failed attempt\'s own billed month was collected by another paid row', async () => {
      const { closed, captured } = await run();
      expect(closed).toBe(1);
      const [customerId, window, options] = findCollectedMonthlyPayment.mock.calls[0];
      expect(customerId).toBe(CUST);
      expect(window).toEqual({ monthKey: '2026-11', monthStart: '2026-11-01', monthEnd: '2026-11-30' });
      expect(options).toMatchObject({ statuses: ['paid'], withDuesInvoice: false, excludePaymentId: 'pay-failed' });
      const lookup = captured.find((q) => q.table === 'payments' && q.sql.includes('"stripe_payment_intent_id" = $') && q.sql.includes('"customer_id" = $') && q.sql.includes('limit'));
      expect(lookup.bindings).toEqual(expect.arrayContaining(['pi_nov', CUST]));
    });

    test('the month comes from the payment date when no billed_month is stamped', async () => {
      await run({ failed: failedRow({ metadata: {}, payment_date: new Date('2026-10-03T00:00:00Z') }) });
      expect(findCollectedMonthlyPayment.mock.calls[0][1].monthKey).toBe('2026-10');
    });

    test('stays open when that month was not collected (another month\'s payment of the same amount does not count)', async () => {
      expect((await run({ collected: null })).closed).toBe(0);
    });

    test.each([
      ['no PaymentIntent', { notification: noInvoice({ paymentIntentId: null }) }],
      ['no ledger row for the PaymentIntent', { failed: null }],
      ['a ledger row that is not monthly dues', { failed: failedRow({ description: 'Pest Control' }) }],
      ['no month on the ledger row', { failed: failedRow({ metadata: {}, payment_date: null }) }],
      ['a malformed billed month', { failed: failedRow({ metadata: { billed_month: '2026-13' } }) }],
      ['no customer id', { notification: noInvoice({ customerId: null }) }],
      ['a non-UUID customer id', { notification: noInvoice({ customerId: 'cus_123' }) }],
      ['an unreadable allocation', { notification: noInvoice({ allocationUnreadable: true }) }],
      ['a declared allocation of malformed ids', { notification: noInvoice({ allocationInvoiceIds: ['not-a-uuid'] }) }],
      ['a named invoice', { notification: noInvoice({ invoiceId: INV_B }) }],
    ])('never closes with %s', async (_label, args) => {
      expect((await run(args)).closed).toBe(0);
      expect(findCollectedMonthlyPayment).not.toHaveBeenCalled();
    });
  });

  test('a failure is logged and closes nothing', async () => {
    const { conn } = compilingConn({ failWith: new Error('db down') });
    expect(await sweepSettledPaymentFailedAlerts({ conn })).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('repair sweep failed'));
  });
});
