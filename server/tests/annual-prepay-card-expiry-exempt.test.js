// getCardExpiryExemptCustomerIds: covered across the window MINUS customers
// with a card charge still coming inside it — judged by the billing
// authorities (retry sweep guards, predictCompletionBilling); any lookup
// failure exempts nobody.
jest.mock('../models/db', () => { const db = jest.fn(); db.schema = { hasTable: jest.fn(async () => true) }; db.raw = jest.fn((x) => x); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: { completionAutopayCharge: true } }));

const db = require('../models/db');
const { etDateString } = require('../utils/datetime-et');
const { getCardExpiryExemptCustomerIds } = require('../services/annual-prepay-renewals');

const TODAY = etDateString();
const HORIZON = '2026-12-01';

function chain(rowsFor, calls) {
  const q = {};
  const own = []; // this query's calls only — coverage is asked per date
  ['whereIn', 'where', 'whereNull', 'whereNotNull', 'whereNot', 'whereNotIn', 'leftJoin', 'join', 'whereRaw', 'orderBy', 'orWhere', 'orWhereNull', 'orWhereNotNull', 'orWhereIn', 'orWhereRaw', 'andWhere', 'andWhereNot', 'modify']
    .forEach((m) => { q[m] = jest.fn((...a) => { own.push([m, ...a]); calls.push([m, ...a]); if (typeof a[0] === 'function') a[0].call(q, q); return q; }); });
  const resolve = async () => (typeof rowsFor === 'function' ? rowsFor(own) : rowsFor);
  q.select = jest.fn(async (...a) => { own.push(['select', ...a]); calls.push(['select', ...a]); return resolve(); });
  q.distinct = jest.fn(async () => resolve());
  q.first = jest.fn(async () => (await resolve())[0] || null);
  q.then = (res, rej) => resolve().then(res, rej);
  return q;
}
const asked = (own, col) => (own.find((c) => c[0] === 'where' && c[1] === col) || [])[3];

// terms: rows or fn(own) — coverage may depend on the date asked; payments: fn(own)
// so the armed-retry select and the already-collected sibling lookup can differ.
// visits rows double as the payer resolver's scheduled_services.first(...)
// read (payer_id / po_number / self_pay_override come from the same row);
// customers.first(...) is the resolver's customer-level fallback; invoices
// is the completion-suppressor lookup.
function route({ terms = [], payments = [], visits = [], invoices = [], throwOn = null }) {
  const calls = { terms: [], payments: [], visits: [], invoices: [] };
  db.mockImplementation((table) => {
    if (throwOn && String(table).startsWith(throwOn)) throw new Error(`${table} down`);
    if (String(table).startsWith('annual_prepay_terms')) return chain(terms, calls.terms);
    if (table === 'payments') return chain(payments, calls.payments);
    if (String(table).startsWith('scheduled_services')) return chain(visits, calls.visits);
    if (table === 'customers') return chain([], []);
    if (table === 'payers') return chain([{ id: 7, active: true, payment_terms: 'net_30' }], []); // payer ids are integers
    if (table === 'invoices') return chain(invoices, calls.invoices);
    throw new Error(`unexpected table ${table}`);
  });
  return calls;
}
const coveredAlways = (ids) => ids.map((customer_id) => ({ customer_id }));
const baseVisit = (over) => ({
  id: 'v1', customer_id: 'c-prepaid', estimated_price: '120.00', is_callback: false, service_type: 'Quarterly Pest Control Service',
  payer_id: null, po_number: null, self_pay_override: false, customer_payer_id: null,
  prepaid_amount: null, prepaid_method: null, annual_prepay_term_id: null, per_application_fee: null,
  is_recurring: true, billing_mode: 'annual_prepay', waveguard_tier: 'Bronze', monthly_rate: '28.00', autopay_enabled: true, ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('getCardExpiryExemptCustomerIds — coverage window', () => {
  test('covered today AND at the horizon → exempt; both ends are asked', async () => {
    const calls = route({ terms: coveredAlways(['c-prepaid']) });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    expect(calls.terms).toEqual(expect.arrayContaining([
      ['where', 't.term_end', '>=', HORIZON], ['where', 't.term_end', '>=', TODAY],
    ]));
    expect(calls.visits).toEqual(expect.arrayContaining([
      ['whereNotIn', 'ss.status', ['completed', 'cancelled', 'canceled', 'skipped', 'no_show', 'rescheduled']],
      ['where', 'ss.scheduled_date', '>=', TODAY], ['where', 'ss.scheduled_date', '<=', HORIZON],
    ]));
  });

  test('a paid term that starts AFTER today (covered at the horizon only) is not exempt', async () => {
    const calls = route({ terms: (own) => (asked(own, 't.term_end') === HORIZON ? coveredAlways(['c-future']) : []) });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    expect(calls.payments).toEqual([]);
  });

  test('nobody covered → empty set without touching payments', async () => {
    const calls = route({ terms: [] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    expect(calls.payments).toEqual([]);
  });
});

describe('getCardExpiryExemptCustomerIds — collectible retries (sweep semantics)', () => {
  const armed = (over) => [{ id: 'p-fail', customer_id: 'c-prepaid', description: 'Bronze WaveGuard Monthly — Pat', payment_date: '2026-04-03', metadata: null, ...over }];
  const isSiblingLookup = (own) => own.some((c) => c[0] === 'whereIn' && c[1] === 'status');

  test('a one-time collectible retry keeps the warning', async () => {
    const calls = route({ terms: coveredAlways(['c-prepaid', 'c-other']), payments: (own) => (isSiblingLookup(own) ? [] : armed({ description: 'Invoice WPC-1' })) });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-other']);
    expect(calls.payments).toEqual(expect.arrayContaining([
      ['where', { status: 'failed' }], ['whereNull', 'superseded_by_payment_id'], ['where', 'retry_count', '<', 3], ['whereNotNull', 'next_retry_at'],
    ]));
  });

  test('a pre-term WaveGuard Monthly retry (obligation date not covered, not collected) keeps the warning', async () => {
    route({
      terms: (own) => (asked(own, 't.term_end') === '2026-04-03' ? [] : coveredAlways(['c-prepaid'])),
      payments: (own) => (isSiblingLookup(own) ? [] : armed()),
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('a WaveGuard Monthly retry whose obligation month is itself covered is absorbed → stays exempt', async () => {
    route({ terms: coveredAlways(['c-prepaid']), payments: (own) => (isSiblingLookup(own) ? [] : armed({ payment_date: '2026-06-03', metadata: { billed_month: '2026-06' } })) });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('a WaveGuard Monthly retry already collected by a paid sibling for that month → stays exempt', async () => {
    const calls = route({
      terms: (own) => (asked(own, 't.term_end') === '2026-04-03' ? [] : coveredAlways(['c-prepaid'])),
      payments: (own) => (isSiblingLookup(own) ? [{ id: 'p-paid' }] : armed()),
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    expect(calls.payments).toEqual(expect.arrayContaining([
      ['whereIn', 'status', ['paid', 'processing']],
      ['whereRaw', "metadata->>'billed_month' = ?", ['2026-04']],
      ['andWhere', 'description', 'like', '%WaveGuard Monthly%'],
    ]));
  });
});

describe('getCardExpiryExemptCustomerIds — visits judged by predictCompletionBilling', () => {
  test('an uncovered, priced, still-completable (en_route) visit keeps the warning', async () => {
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ status: 'en_route' })] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('selects only real columns (per_application_fee / payer_id from customers; no ss.billed_to_payer_id)', async () => {
    const calls = route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ status: 'confirmed' })] });
    await getCardExpiryExemptCustomerIds(HORIZON);
    const sel = calls.visits.find((c) => c[0] === 'select');
    expect(sel).toBeDefined();
    expect(sel).toEqual(expect.arrayContaining(['c.per_application_fee', 'c.payer_id as customer_payer_id']));
    expect(sel).not.toEqual(expect.arrayContaining(['ss.billed_to_payer_id']));
    expect(sel).not.toEqual(expect.arrayContaining(['ss.per_application_fee']));
  });

  test('a visit that cannot charge the card (payer-billed via visit or customer / callback / gate off → pay-link invoice) leaves the customer exempt', async () => {
    for (const over of [{ payer_id: 7 }, { customer_payer_id: 9 }, { is_callback: true }, { autopay_enabled: false }]) {
      route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit(over)] });
      expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    }
  });

  test('a validly stamped covered visit (annual_prepay_invoice + amount + live term) leaves the customer exempt', async () => {
    route({
      terms: [{ customer_id: 'c-prepaid', id: 'term-1', status: 'active' }],
      visits: [baseVisit({ prepaid_method: 'annual_prepay_invoice', prepaid_amount: '84.00', annual_prepay_term_id: 'term-1' })],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('an auto_charge visit whose existing invoice is already paid / prepaid / processing / refunded is settled — stays exempt', async () => {
    for (const status of ['paid', 'prepaid', 'processing', 'refunded']) {
      route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], invoices: [{ id: 'inv-1', status }] });
      expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    }
    // an open (sent) invoice is what completion will charge → keep the warning
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], invoices: [{ id: 'inv-1', status: 'sent' }] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('a malformed annual_prepay_invoice stamp (no amount / no term) fails toward the warning — nobody exempt', async () => {
    route({ terms: coveredAlways(['c-prepaid', 'c-other']), visits: [baseVisit({ prepaid_method: 'annual_prepay_invoice', prepaid_amount: null, annual_prepay_term_id: null })] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('a bare annual_prepay_term_id link without the completion stamp is NOT coverage — priced visit keeps the warning', async () => {
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ annual_prepay_term_id: 'term-1', prepaid_method: null })] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('lookup failures exempt nobody (fail toward the warning)', async () => {
    route({ terms: coveredAlways(['c-prepaid']), throwOn: 'payments' });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    route({ terms: coveredAlways(['c-prepaid']), throwOn: 'scheduled_services' });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });
});
