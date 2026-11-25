/**
 * Unit tests for the invoice-less payment_failed month rule
 * (services/payment-failed-month-settled.js). The Postgres twin
 * (payment-failed-month-close-postgres.test.js) runs the same rule on real rows.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const {
  closeIfMonthCollected, isInvoicelessMonthUncollected, isInvoicelessPayload, obligationMonthOf,
} = require('../services/payment-failed-month-settled');

const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const close = jest.fn(async () => 1);
const PAYLOAD = { invoiceId: null, customerId: CUSTOMER, paymentIntentId: 'pi_x', attemptId: 'ch_x' };

describe('isInvoicelessPayload', () => {
  test('accepts the dues-failure shape', () => {
    expect(isInvoicelessPayload(PAYLOAD)).toBe(true);
    expect(isInvoicelessPayload({ ...PAYLOAD, invoiceId: undefined, allocationInvoiceIds: [] })).toBe(true);
  });

  test.each([
    ['no payload', undefined],
    ['an invoice id', { ...PAYLOAD, invoiceId: '11111111-1111-4111-8111-111111111111' }],
    ['a malformed invoice id', { ...PAYLOAD, invoiceId: 'junk' }],
    ['a non-empty allocation', { ...PAYLOAD, allocationInvoiceIds: ['11111111-1111-4111-8111-111111111111'] }],
    ['a malformed allocation', { ...PAYLOAD, allocationInvoiceIds: 'junk' }],
    ['an unreadable allocation', { ...PAYLOAD, allocationUnreadable: true }],
    ['no PaymentIntent', { ...PAYLOAD, paymentIntentId: null }],
    ['an empty PaymentIntent', { ...PAYLOAD, paymentIntentId: '' }],
    ['a non-UUID customer', { ...PAYLOAD, customerId: 'not-a-uuid' }],
    ['no customer', { ...PAYLOAD, customerId: undefined }],
  ])('rejects %s', (_label, payload) => {
    expect(isInvoicelessPayload(payload)).toBe(false);
  });
});

describe('obligationMonthOf', () => {
  test('a valid billed_month stamp names the month, whatever the description or date', () => {
    expect(obligationMonthOf({ metadata: { billed_month: '2026-10' }, description: 'Manual charge — WaveGuard Gold', payment_date: '2026-11-20' })).toBe('2026-10');
    expect(obligationMonthOf({ metadata: JSON.stringify({ billed_month: '2026-11' }), description: null, payment_date: null })).toBe('2026-11');
  });

  test.each(['garbage', '2026-13', '2026-00', '2026-1', '2026-11-01', 20261, ['2026-11'], ''])('an invalid stamp %p gives no month', (stamped) => {
    expect(obligationMonthOf({ metadata: { billed_month: stamped }, description: 'Gold WaveGuard Monthly — X', payment_date: '2026-11-01' })).toBeNull();
  });

  test('an unstamped row has NO month: the description marker and payment date are never used', () => {
    expect(obligationMonthOf({ metadata: null, description: 'Gold WaveGuard Monthly — X', payment_date: '2026-11-01' })).toBeNull();
    expect(obligationMonthOf({ metadata: {}, description: 'Gold WaveGuard Monthly — X', payment_date: new Date(Date.UTC(2026, 10, 1)) })).toBeNull();
  });
});

// A connection that records which tables are read and answers from queues.
function fakeConn({ payments = [], failWith = null } = {}) {
  const reads = [];
  const conn = (table) => {
    reads.push(table);
    const builder = {
      where: () => builder, whereNot: () => builder, whereIn: () => builder, whereRaw: () => builder, andWhere: () => builder, orWhere: () => builder,
      select: () => (failWith ? Promise.reject(failWith) : Promise.resolve(payments)),
      first: () => Promise.resolve(undefined),
    };
    return builder;
  };
  conn.transaction = async (fn) => fn(conn);
  return { conn, reads };
}

describe('doubt reads nothing or leaves the bell open', () => {
  test('a payload that is not the dues-failure shape runs no query', async () => {
    const { conn, reads } = fakeConn();
    expect(await closeIfMonthCollected(conn, { ...PAYLOAD, invoiceId: 'x' }, close)).toBe(0);
    expect(await isInvoicelessMonthUncollected(conn, { ...PAYLOAD, allocationUnreadable: true })).toBe(false);
    expect(reads).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  test('no ledger row, or two rows on one PaymentIntent, is open', async () => {
    expect(await closeIfMonthCollected(fakeConn({ payments: [] }).conn, PAYLOAD, close)).toBe(0);
    const row = { id: 1, customer_id: CUSTOMER, status: 'failed', description: 'WaveGuard Monthly', payment_date: '2026-11-01', metadata: { billed_month: '2026-11' } };
    expect(await closeIfMonthCollected(fakeConn({ payments: [row, { ...row, id: 2 }] }).conn, PAYLOAD, close)).toBe(0);
  });

  test('a row of another customer, a non-failed row, or one that names an invoice is open', async () => {
    const row = { id: 1, customer_id: CUSTOMER, status: 'failed', description: 'WaveGuard Monthly', payment_date: '2026-11-01', metadata: { billed_month: '2026-11' } };
    for (const bad of [
      { ...row, customer_id: '44444444-4444-4444-8444-444444444444' },
      { ...row, status: 'paid' },
      { ...row, metadata: { billed_month: '2026-11', invoice_id: 'legacy' } },
      { ...row, metadata: { billed_month: 'garbage' } },
      { ...row, metadata: null },
    ]) {
      const { conn, reads } = fakeConn({ payments: [bad] });
      expect(await closeIfMonthCollected(conn, PAYLOAD, close)).toBe(0);
      expect(await isInvoicelessMonthUncollected(conn, PAYLOAD)).toBe(false);
      expect(reads).toEqual(['payments', 'payments']);
    }
  });

  test('a failing read is logged and leaves the bell open, never thrown', async () => {
    const { conn } = fakeConn({ failWith: new Error('db down') });
    expect(await closeIfMonthCollected(conn, PAYLOAD, close)).toBe(0);
    expect(await isInvoicelessMonthUncollected(conn, PAYLOAD)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});

// The sweep must close under the same locks manual payment Undo takes, in Undo's order.
describe('lock order is pinned to Undo\'s', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'services', file), 'utf8');
  const order = (src, markers) => markers.map((m) => src.indexOf(m));
  const ascending = (positions) => positions.every((pos, i) => pos > -1 && (i === 0 || pos > positions[i - 1]));

  test('Undo takes the combined-customer lock, then the receipt-claim lock, then the invoice row', () => {
    const src = read('invoice-manual-payment-undo.js');
    expect(ascending(order(src, ['lockCombinedCustomerStable(trx', 'lockInvoiceReceiptClaim(trx, invoiceId)', ".forUpdate().first()"]))).toBe(true);
  });

  test('the sweep\'s settlement check takes the same three locks in the same order, then closes in the same transaction', () => {
    const src = read('payment-failed-month-settled.js');
    expect(ascending(order(src, ['lockCombinedCustomerStable(trx', 'lockInvoiceReceiptClaim(trx, id)', ".forUpdate().select('id')"]))).toBe(true);
    // the lock helper runs inside the same transaction callback that calls close(trx)
    const body = src.slice(src.indexOf('async function closeIfMonthCollected'));
    expect(ascending(order(body, ['conn.transaction(async (trx)', 'lockSettlingInvoices(trx, attempt)).length ? close(trx)']))).toBe(true);
  });
});
