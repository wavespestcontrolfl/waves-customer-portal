/**
 * A payment_failed admin bell closes when its invoice is paid, whichever
 * PaymentIntent paid it. The SQL below is compiled by a real knex pg builder
 * (no connection) so the match keys are asserted as emitted; the Postgres twin
 * (payment-failed-alert-close-postgres.test.js) runs them against real rows.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex')({ client: 'pg' });
const logger = require('../services/logger');
const { closePaymentFailedAlertsForPaidInvoice, RESOLUTION } = require('../services/payment-failed-alert-close');
const PaymentPlans = require('../services/payment-plans');

// A connection whose queries are compiled, never executed.
function compilingConn({ failWith = null } = {}) {
  const captured = [];
  const conn = (table) => {
    const builder = knex(table);
    builder.then = (resolve, reject) => {
      captured.push(builder.toSQL().toNative());
      return (failWith ? Promise.reject(failWith) : Promise.resolve(1)).then(resolve, reject);
    };
    return builder;
  };
  conn.raw = (...args) => knex.raw(...args);
  conn.isTransaction = true;
  conn.transaction = async (fn) => fn(conn);
  return { conn, captured };
}

test('closes by invoice id OR by the failed attempt ledger row, as the payments closer', async () => {
  const { conn, captured } = compilingConn();
  expect(await closePaymentFailedAlertsForPaidInvoice('inv-1', conn)).toBe(1);
  const { sql, bindings } = captured[0];
  expect(sql).toMatch(/^update "notifications" set /);
  expect(sql).toContain("metadata->>'triggerKey' = 'payment_failed'");
  expect(sql).toContain('"recipient_type" = $');
  expect(sql).toContain("metadata->'payload'->>'invoiceId' = $");
  expect(sql).toContain("metadata->'payload'->>'paymentIntentId' IN (");
  expect(sql).toContain("p.metadata->>'invoice_id' = $");
  // done columns: latest closer is 'payments', existing done_at/resolution/read_at kept
  expect(sql).toContain('"done_by" = $');
  expect(sql).toContain('COALESCE(done_at');
  expect(sql).toContain('COALESCE(resolution');
  expect(bindings).toEqual(expect.arrayContaining(['admin', 'payment', 'inv-1', 'payments', RESOLUTION]));
  // both matching keys are bound to THIS invoice only
  expect(bindings.filter((b) => b === 'inv-1')).toHaveLength(2);
  // a row already closed by a system component is left alone (openToCloser)
  expect(sql).toMatch(/"done_at" is null or COALESCE\(/);
});

test('a missing invoice id writes nothing', async () => {
  const { conn, captured } = compilingConn();
  expect(await closePaymentFailedAlertsForPaidInvoice(null, conn)).toBe(0);
  expect(captured).toHaveLength(0);
});

test('a failure in the closer is logged and returns 0, never thrown', async () => {
  const { conn } = compilingConn({ failWith: new Error('boom') });
  await expect(closePaymentFailedAlertsForPaidInvoice('inv-1', conn)).resolves.toBe(0);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
});

describe('payment path (completeActivePlansForInvoice)', () => {
  // The paid check and plan writes are a minimal stand-in; the notification
  // update is the real compiled closer, optionally failing.
  function paymentConn({ status, failClose = false }) {
    const writes = [];
    const closer = compilingConn({ failWith: failClose ? new Error('closer down') : null });
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
