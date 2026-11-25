/**
 * Unit tests for the invoice-less payment_failed month rule
 * (services/payment-failed-month-settled.js). The Postgres twin
 * (payment-failed-month-close-postgres.test.js) runs the same rule on real rows.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const {
  isInvoicelessMonthSettled, isInvoicelessMonthUncollected, isInvoicelessPayload, obligationMonthOf, monthWindow,
} = require('../services/payment-failed-month-settled');

const CUSTOMER = '33333333-3333-4333-8333-333333333333';
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
  const MONTHLY = 'Gold WaveGuard Monthly — X';
  test('prefers a valid billed_month stamp, whatever the description or date', () => {
    expect(obligationMonthOf({ metadata: { billed_month: '2026-10' }, description: 'Manual charge — WaveGuard Gold', payment_date: '2026-11-20' })).toBe('2026-10');
    expect(obligationMonthOf({ metadata: JSON.stringify({ billed_month: '2026-11' }), description: null, payment_date: null })).toBe('2026-11');
  });

  test.each(['garbage', '2026-13', '2026-00', '2026-1', '2026-11-01', 20261, ['2026-11'], ''])('an invalid stamp %p gives no month, never the date fallback', (stamped) => {
    expect(obligationMonthOf({ metadata: { billed_month: stamped }, description: MONTHLY, payment_date: '2026-11-01' })).toBeNull();
  });

  test('an unstamped legacy row uses the monthly marker and the payment_date month', () => {
    expect(obligationMonthOf({ metadata: null, description: MONTHLY, payment_date: '2026-11-01' })).toBe('2026-11');
    expect(obligationMonthOf({ metadata: {}, description: MONTHLY, payment_date: new Date(Date.UTC(2026, 10, 1)) })).toBe('2026-11');
  });

  test('an unstamped row without the marker, or without a date, has no month', () => {
    expect(obligationMonthOf({ metadata: null, description: 'Manual charge — WaveGuard Gold', payment_date: '2026-11-01' })).toBeNull();
    expect(obligationMonthOf({ metadata: null, description: MONTHLY, payment_date: null })).toBeNull();
  });
});

test('monthWindow spans the whole calendar month', () => {
  expect(monthWindow('2026-11')).toEqual({ monthKey: '2026-11', monthStart: '2026-11-01', monthEnd: '2026-11-30' });
  expect(monthWindow('2028-02').monthEnd).toBe('2028-02-29');
  expect(monthWindow('2026-12').monthEnd).toBe('2026-12-31');
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
    expect(await isInvoicelessMonthSettled(conn, { ...PAYLOAD, invoiceId: 'x' })).toBe(false);
    expect(await isInvoicelessMonthUncollected(conn, { ...PAYLOAD, allocationUnreadable: true })).toBe(false);
    expect(reads).toEqual([]);
  });

  test('no ledger row, or two rows on one PaymentIntent, is open', async () => {
    expect(await isInvoicelessMonthSettled(fakeConn({ payments: [] }).conn, PAYLOAD)).toBe(false);
    const row = { id: 1, customer_id: CUSTOMER, status: 'failed', description: 'WaveGuard Monthly', payment_date: '2026-11-01', metadata: { billed_month: '2026-11' } };
    expect(await isInvoicelessMonthSettled(fakeConn({ payments: [row, { ...row, id: 2 }] }).conn, PAYLOAD)).toBe(false);
  });

  test('a row of another customer, a non-failed row, or one that names an invoice is open', async () => {
    const row = { id: 1, customer_id: CUSTOMER, status: 'failed', description: 'WaveGuard Monthly', payment_date: '2026-11-01', metadata: { billed_month: '2026-11' } };
    for (const bad of [
      { ...row, customer_id: '44444444-4444-4444-8444-444444444444' },
      { ...row, status: 'paid' },
      { ...row, metadata: { billed_month: '2026-11', invoice_id: 'legacy' } },
      { ...row, metadata: { billed_month: 'garbage' } },
    ]) {
      const { conn, reads } = fakeConn({ payments: [bad] });
      expect(await isInvoicelessMonthSettled(conn, PAYLOAD)).toBe(false);
      expect(await isInvoicelessMonthUncollected(conn, PAYLOAD)).toBe(false);
      expect(reads).toEqual(['payments', 'payments']);
    }
  });

  test('a failing read is logged and leaves the bell open, never thrown', async () => {
    const { conn } = fakeConn({ failWith: new Error('db down') });
    expect(await isInvoicelessMonthSettled(conn, PAYLOAD)).toBe(false);
    expect(await isInvoicelessMonthUncollected(conn, PAYLOAD)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});
