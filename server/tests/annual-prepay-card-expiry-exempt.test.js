// getCardExpiryExemptCustomerIds: covered-at-horizon MINUS customers with a
// card charge still coming inside the window (collectible retry, uncovered
// priced visit); any lookup failure exempts nobody.
jest.mock('../models/db', () => { const db = jest.fn(); db.schema = { hasTable: jest.fn(async () => true) }; db.raw = jest.fn((x) => x); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn() }));

const db = require('../models/db');
const { getCardExpiryExemptCustomerIds } = require('../services/annual-prepay-renewals');

function chain(rowsFor, calls) {
  const q = {};
  const own = []; // this query's calls only — coverage is asked per date
  ['whereIn', 'where', 'whereNull', 'whereNotNull', 'leftJoin', 'whereRaw', 'orderBy', 'orWhere', 'andWhere']
    .forEach((m) => { q[m] = jest.fn((...a) => { own.push([m, ...a]); calls.push([m, ...a]); return q; }); });
  const resolve = async () => (typeof rowsFor === 'function' ? rowsFor(own) : rowsFor);
  q.select = jest.fn(async () => resolve());
  q.distinct = jest.fn(async () => resolve());
  q.first = jest.fn(async () => (await resolve())[0] || null);
  q.then = (res, rej) => resolve().then(res, rej);
  return q;
}

// annual_prepay_terms rows may depend on the coverage date asked (calls carry
// ['where','t.term_end','>=',date]) so obligation-date lookups can differ.
function route({ terms = [], payments = [], visits = [], throwOn = null }) {
  const calls = { terms: [], payments: [], visits: [] };
  db.mockImplementation((table) => {
    if (throwOn && table === throwOn) throw new Error(`${table} down`);
    if (String(table).startsWith('annual_prepay_terms')) return chain(terms, calls.terms);
    if (table === 'payments') return chain(payments, calls.payments);
    if (table === 'scheduled_services') return chain(visits, calls.visits);
    throw new Error(`unexpected table ${table}`);
  });
  return calls;
}
const askedDate = (calls) => (calls.find((c) => c[0] === 'where' && c[1] === 't.term_end') || [])[3];

beforeEach(() => jest.clearAllMocks());

describe('getCardExpiryExemptCustomerIds', () => {
  test('covered customers are exempt; a one-time collectible retry keeps the warning', async () => {
    const calls = route({
      terms: [{ customer_id: 'c-prepaid' }, { customer_id: 'c-retrying' }],
      payments: [{ customer_id: 'c-retrying', description: 'Invoice WPC-1', payment_date: '2026-08-01', metadata: null }],
    });
    const ids = await getCardExpiryExemptCustomerIds('2026-09-03');
    expect([...ids]).toEqual(['c-prepaid']);
    expect(calls.terms).toEqual(expect.arrayContaining([['where', 't.term_end', '>=', '2026-09-03']]));
    expect(calls.payments).toEqual(expect.arrayContaining([
      ['whereIn', 'customer_id', ['c-prepaid', 'c-retrying']],
      ['where', { status: 'failed' }],
      ['whereNull', 'superseded_by_payment_id'],
      ['where', 'retry_count', '<', 3],
      ['whereNotNull', 'next_retry_at'],
    ]));
    expect(calls.visits).toEqual(expect.arrayContaining([
      ['whereIn', 'status', ['pending', 'confirmed']],
      ['whereNull', 'annual_prepay_term_id'],
      ['where', 'scheduled_date', '<=', '2026-09-03'],
      ['whereRaw', 'COALESCE(estimated_price, 0) > COALESCE(prepaid_amount, 0)'],
    ]));
  });

  test('a WaveGuard Monthly retry whose obligation date is itself covered is absorbed — customer stays exempt', async () => {
    route({
      // covered both at the horizon and on the June obligation date
      terms: [{ customer_id: 'c-absorbed' }],
      payments: [{ customer_id: 'c-absorbed', description: 'Bronze WaveGuard Monthly — Pat', payment_date: '2026-06-03', metadata: { billed_month: '2026-06' } }],
    });
    expect([...(await getCardExpiryExemptCustomerIds('2026-09-03'))]).toEqual(['c-absorbed']);
  });

  test('a WaveGuard Monthly retry from BEFORE the term (obligation date not covered) keeps the warning', async () => {
    route({
      terms: (calls) => (askedDate(calls) === '2026-09-03' ? [{ customer_id: 'c-preterm' }] : []),
      payments: [{ customer_id: 'c-preterm', description: 'Bronze WaveGuard Monthly — Pat', payment_date: '2026-04-03', metadata: null }],
    });
    expect((await getCardExpiryExemptCustomerIds('2026-09-03')).size).toBe(0);
  });

  test('an uncovered, priced visit inside the window keeps the warning', async () => {
    route({ terms: [{ customer_id: 'c-extra' }], visits: [{ customer_id: 'c-extra' }] });
    expect((await getCardExpiryExemptCustomerIds('2026-09-03')).size).toBe(0);
  });

  test('a paid term that starts AFTER today (covered at the horizon only) is not exempt', async () => {
    const { etDateString } = require('../utils/datetime-et');
    const today = etDateString();
    const calls = route({
      terms: (own) => (askedDate(own) === '2026-12-01' ? [{ customer_id: 'c-future' }] : []),
    });
    expect((await getCardExpiryExemptCustomerIds('2026-12-01')).size).toBe(0);
    // both ends of the window were asked
    expect(calls.terms).toEqual(expect.arrayContaining([
      ['where', 't.term_end', '>=', '2026-12-01'],
      ['where', 't.term_end', '>=', today],
    ]));
    expect(calls.payments).toEqual([]);
  });

  test('nobody covered → empty set without touching payments', async () => {
    const calls = route({ terms: [] });
    expect((await getCardExpiryExemptCustomerIds('2026-09-03')).size).toBe(0);
    expect(calls.payments).toEqual([]);
  });

  test('lookup failures exempt nobody (fail toward the warning)', async () => {
    route({ terms: [{ customer_id: 'c-prepaid' }], throwOn: 'payments' });
    expect((await getCardExpiryExemptCustomerIds('2026-09-03')).size).toBe(0);
    route({ terms: [{ customer_id: 'c-prepaid' }], throwOn: 'scheduled_services' });
    expect((await getCardExpiryExemptCustomerIds('2026-09-03')).size).toBe(0);
  });
});
