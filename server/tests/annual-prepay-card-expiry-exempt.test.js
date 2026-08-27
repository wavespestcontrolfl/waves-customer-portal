// getCardExpiryExemptCustomerIds: covered-at-horizon MINUS customers with a
// still-collectible pre-term retry; any lookup failure exempts nobody.
jest.mock('../models/db', () => { const db = jest.fn(); db.schema = { hasTable: jest.fn(async () => true) }; db.raw = jest.fn((x) => x); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn() }));

const db = require('../models/db');
const { getCardExpiryExemptCustomerIds } = require('../services/annual-prepay-renewals');

function chain(rows, calls) {
  const q = {};
  ['whereIn', 'where', 'whereNull', 'whereNotNull', 'leftJoin', 'whereRaw', 'select', 'orderBy', 'orWhere', 'andWhere']
    .forEach((m) => { q[m] = jest.fn((...a) => { calls.push([m, ...a]); return q; }); });
  q.distinct = jest.fn(async () => rows);
  q.first = jest.fn(async () => rows[0] || null);
  q.then = (res, rej) => Promise.resolve(rows).then(res, rej);
  return q;
}

function route({ terms = [], payments = [], paymentsThrow = false }) {
  const calls = { terms: [], payments: [] };
  db.mockImplementation((table) => {
    if (String(table).startsWith('annual_prepay_terms')) return chain(terms, calls.terms);
    if (table === 'payments') { if (paymentsThrow) throw new Error('payments down'); return chain(payments, calls.payments); }
    throw new Error(`unexpected table ${table}`);
  });
  return calls;
}

beforeEach(() => jest.clearAllMocks());

describe('getCardExpiryExemptCustomerIds', () => {
  test('covered customers are exempt unless they still owe a collectible retry', async () => {
    const calls = route({
      terms: [{ customer_id: 'c-prepaid' }, { customer_id: 'c-retrying' }],
      payments: [{ customer_id: 'c-retrying' }],
    });
    const ids = await getCardExpiryExemptCustomerIds('2026-09-03');
    expect([...ids]).toEqual(['c-prepaid']);
    // coverage is asked AT THE HORIZON
    expect(calls.terms).toEqual(expect.arrayContaining([['where', 't.term_end', '>=', '2026-09-03']]));
    // the retry predicate mirrors billing-cron retryFailedPayments
    expect(calls.payments).toEqual(expect.arrayContaining([
      ['whereIn', 'customer_id', ['c-prepaid', 'c-retrying']],
      ['where', { status: 'failed' }],
      ['whereNull', 'superseded_by_payment_id'],
      ['where', 'retry_count', '<', 3],
      ['whereNotNull', 'next_retry_at'],
    ]));
  });

  test('nobody covered → empty set without touching payments', async () => {
    const calls = route({ terms: [] });
    expect((await getCardExpiryExemptCustomerIds('2026-09-03')).size).toBe(0);
    expect(calls.payments).toEqual([]);
  });

  test('a retry lookup failure exempts nobody (fail toward the warning)', async () => {
    route({ terms: [{ customer_id: 'c-prepaid' }], paymentsThrow: true });
    expect((await getCardExpiryExemptCustomerIds('2026-09-03')).size).toBe(0);
  });
});
