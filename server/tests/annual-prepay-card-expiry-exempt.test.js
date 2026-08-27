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
jest.mock('../services/setup-fee-obligation', () => ({ findUnmintedSetupFeeObligation: jest.fn(async () => ({ owed: false })) }));

const db = require('../models/db');
const { etDateString } = require('../utils/datetime-et');
const { getCardExpiryExemptCustomerIds, clearCardExpiryExemptCache } = require('../services/annual-prepay-renewals');

const TODAY = etDateString();
// Pure calendar math on date strings, mirroring the helper's dayAfter.
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
// Derived from TODAY so the future-window invariant holds whenever the
// suite runs — a fixed date flips the window once real time passes it.
const HORIZON = addDays(TODAY, 96);
const TOMORROW = addDays(TODAY, 1);

function chain(rowsFor, calls) {
  const q = {};
  const own = []; // this query's calls only — coverage is asked per date
  ['whereIn', 'where', 'whereNull', 'whereNotNull', 'whereNot', 'whereNotIn', 'whereExists', 'from', 'leftJoin', 'join', 'whereRaw', 'orderBy', 'orWhere', 'orWhereNull', 'orWhereNotNull', 'orWhereIn', 'orWhereRaw', 'andWhere', 'andWhereNot', 'modify']
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
// A chargeable default card, so customerOnAutopay's live method walk finds
// one unless a test overrides paymentMethods.
const CHARGEABLE_CARD = {
  id: 'pm-1', processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_x',
  is_default: true, autopay_enabled: true, exp_month: '12', exp_year: '2099', ach_status: null,
};
function route({ terms = [], payments = [], visits = [], invoices = [], customers = [], paymentMethods = [CHARGEABLE_CARD], apptCardRequests = [], dunningSequences = [], setupFeeClaims = [], notifications = [], pendingTerms = [], throwOn = null }) {
  const calls = { terms: [], payments: [], visits: [], invoices: [], customers: [] };
  // the payment-pending hold query (getPaymentPendingCustomerIds) is the
  // only annual_prepay_terms query that JOINs invoices — route it to its
  // own rows so coverage terms never read as pending commitments
  const termsRows = (own) => (own.some((c) => c[0] === 'join' && String(c[1]).startsWith('invoices'))
    ? pendingTerms
    : (typeof terms === 'function' ? terms(own) : terms));
  clearCardExpiryExemptCache(); // each route() is a fresh world — never serve the previous scenario's memo
  db.mockImplementation((table) => {
    if (throwOn && String(table).startsWith(throwOn)) throw new Error(`${table} down`);
    if (String(table).startsWith('annual_prepay_terms')) return chain(termsRows, calls.terms);
    if (table === 'payments') return chain(payments, calls.payments);
    if (String(table).startsWith('scheduled_services')) return chain(visits, calls.visits);
    if (table === 'customers') return chain(customers, calls.customers);
    if (table === 'payment_methods') return chain(paymentMethods, []);
    if (table === 'appointment_card_requests') return chain(apptCardRequests, []);
    if (table === 'invoice_followup_sequences') return chain(dunningSequences, []);
    if (table === 'setup_fee_claims') return chain(setupFeeClaims, []);
    if (table === 'notifications') return chain(notifications, []);
    if (table === 'payers') return chain([{ id: 7, active: true, payment_terms: 'net_30' }], []); // payer ids are integers
    // plain 'invoices' = the visit's own invoice lookup; 'invoices as i' =
    // the sibling first-application lookup (it joins scheduled_services)
    if (String(table).startsWith('invoices')) return chain(invoices, calls.invoices);
    throw new Error(`unexpected table ${table}`);
  });
  return calls;
}
// term rows now carry their date range (the helper merges them); a wide
// range spans any test window
const coveredAlways = (ids) => ids.map((customer_id) => ({ customer_id, term_start: '2020-01-01', term_end: '2099-01-01' }));
const baseVisit = (over) => ({
  id: 'v1', customer_id: 'c-prepaid', estimated_price: '120.00', is_callback: false, service_type: 'Quarterly Pest Control Service',
  payer_id: null, po_number: null, self_pay_override: false, customer_payer_id: null,
  prepaid_amount: null, prepaid_method: null, annual_prepay_term_id: null, per_application_fee: null,
  source_estimate_id: null, scheduled_date: TODAY,
  is_recurring: true, billing_mode: 'annual_prepay', waveguard_tier: 'Bronze', monthly_rate: '28.00', autopay_enabled: true,
  customer_autopay_paused_until: null, customer_autopay_payment_method_id: null, customer_ach_status: null, ...over,
});
// A sibling first-application invoice as the acceptance mint writes it
// (isAutoGeneratedPayPerApplicationInvoice matches on this title + notes).
const siblingInvoice = (status, over) => ({
  id: 'inv-sib', status, title: 'First Application',
  notes: 'Auto-generated from accepted estimate — customer selected pay per application',
  ...over,
});
const isSiblingInvoiceLookup = (own) => own.some((c) => c[0] === 'join');

beforeEach(() => jest.clearAllMocks());

describe('getCardExpiryExemptCustomerIds — coverage window', () => {
  test('ONE term spanning today..horizon → exempt (terms fetched with their ranges over the whole window)', async () => {
    const calls = route({ terms: coveredAlways(['c-prepaid']) });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // overlap-bounded fetch WITH the range columns — the span judgment is
    // the merge, not a single-row SQL predicate
    expect(calls.terms).toEqual(expect.arrayContaining([
      ['where', 't.term_start', '<=', HORIZON], ['where', 't.term_end', '>=', TODAY],
      ['select', 't.customer_id', 't.term_start', 't.term_end'],
    ]));
    expect(calls.visits).toEqual(expect.arrayContaining([
      ['whereNotIn', 'ss.status', ['completed', 'cancelled', 'canceled', 'skipped', 'no_show', 'rescheduled']],
      ['where', 'ss.scheduled_date', '<=', HORIZON],
    ]));
    // no lower date bound: overdue nonterminal visits stay in scope
    expect(calls.visits.find((c) => c[0] === 'where' && c[1] === 'ss.scheduled_date' && c[2] === '>=')).toBeUndefined();
    // a COMPLETED visit with an unfinished resumable completion attempt
    // (crash/503 between the durable commit and the charge) stays in scope
    expect(calls.visits).toEqual(expect.arrayContaining([
      ['from', 'service_completion_attempts as sca'],
      ['whereIn', 'sca.status', ['side_effects_pending', 'side_effects_running']],
    ]));
  });

  test('a term that does not span the window (starts after today, or ends before the horizon) is not exempt', async () => {
    let calls = route({ terms: [{ customer_id: 'c-future', term_start: TOMORROW, term_end: '2099-01-01' }] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    expect(calls.payments).toEqual([]);
    calls = route({ terms: [{ customer_id: 'c-ending', term_start: '2020-01-01', term_end: TODAY }] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    expect(calls.payments).toEqual([]);
  });

  test('adjacent paid terms (renewal starts the day after the prior term ends) are continuous coverage → exempt', async () => {
    route({
      terms: [
        { customer_id: 'c-renewed', term_start: '2020-01-01', term_end: TODAY },
        { customer_id: 'c-renewed', term_start: TOMORROW, term_end: '2099-01-01' },
      ],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-renewed']);
  });

  test('two paid terms with a one-day gap inside the window are NOT continuous coverage → not exempt', async () => {
    route({
      terms: [
        { customer_id: 'c-gap', term_start: '2020-01-01', term_end: TODAY },
        { customer_id: 'c-gap', term_start: addDays(TODAY, 2), term_end: '2099-01-01' },
      ],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
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
    // horizon-bounded: a retry armed for AFTER the window cannot charge
    // inside it (the sweep fires only next_retry_at <= now)
    const bound = calls.payments.find((c) => c[0] === 'where' && c[1] === 'next_retry_at');
    expect(bound[2]).toBe('<');
    expect(bound[3]).toBeInstanceOf(Date);
  });

  test('a pre-term WaveGuard Monthly retry (obligation date not covered, not collected) keeps the warning', async () => {
    route({
      terms: (own) => (asked(own, 't.term_end') === '2026-04-03' && asked(own, 't.term_start') === '2026-04-03' ? [] : coveredAlways(['c-prepaid'])),
      payments: (own) => (isSiblingLookup(own) ? [] : armed()),
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('a WaveGuard Monthly retry whose obligation month is itself covered is absorbed → stays exempt', async () => {
    route({ terms: coveredAlways(['c-prepaid']), payments: (own) => (isSiblingLookup(own) ? [] : armed({ payment_date: '2026-06-03', metadata: { billed_month: '2026-06' } })) });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('a parked retry (no PaymentIntent id + metadata.ambiguous_outcome) is never charged → stays exempt', async () => {
    const calls = route({
      terms: coveredAlways(['c-prepaid']),
      payments: (own) => (isSiblingLookup(own) ? [] : armed({ description: 'Invoice WPC-9', stripe_payment_intent_id: null, metadata: { ambiguous_outcome: true } })),
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    expect(calls.payments.find((c) => c[0] === 'select')).toEqual(expect.arrayContaining(['stripe_payment_intent_id']));
    // same row WITH a PaymentIntent id is a real retry → keeps the warning
    route({ terms: coveredAlways(['c-prepaid']), payments: (own) => (isSiblingLookup(own) ? [] : armed({ description: 'Invoice WPC-9', stripe_payment_intent_id: 'pi_1', metadata: { ambiguous_outcome: true } })) });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('a retry whose customer is autopay-paused through the horizon cannot fire inside the window → stays exempt', async () => {
    const calls = route({
      terms: coveredAlways(['c-prepaid']),
      payments: (own) => (isSiblingLookup(own) ? [] : armed({ description: 'Invoice WPC-1' })),
      customers: [{ id: 'c-prepaid', autopay_paused_until: new Date(`${HORIZON}T05:00:00Z`) }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    expect(calls.customers).toEqual(expect.arrayContaining([
      ['select', 'id', 'autopay_enabled', 'autopay_paused_until', 'billing_mode', 'waveguard_tier', 'monthly_rate'],
    ]));
    // a pause lapsing INSIDE the window resumes the retry before the
    // horizon (isPaused is date-inclusive; retries resume the day after)
    // → keeps the warning
    route({
      terms: coveredAlways(['c-prepaid']),
      payments: (own) => (isSiblingLookup(own) ? [] : armed({ description: 'Invoice WPC-1' })),
      customers: [{ id: 'c-prepaid', autopay_paused_until: TODAY }],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('a monthly retry held by a pending prepay commitment (sweep guard 5) → stays exempt', async () => {
    // without the hold this retry would keep the warning (obligation date
    // not covered, no sibling)
    route({
      terms: (own) => (asked(own, 't.term_end') === '2026-04-03' ? [] : coveredAlways(['c-prepaid'])),
      payments: (own) => (isSiblingLookup(own) ? [] : armed()),
      pendingTerms: [{ customer_id: 'c-prepaid' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('a monthly retry for a customer whose lane is no longer monthly (never paid monthly) is disarmed → stays exempt', async () => {
    const isPaidMonthlyLookup = (own) => own.some((c) => c[0] === 'where' && c[1] && typeof c[1] === 'object' && c[1].status === 'paid');
    route({
      terms: coveredAlways(['c-prepaid']),
      payments: (own) => (isSiblingLookup(own) || isPaidMonthlyLookup(own) ? [] : armed()),
      customers: [{ id: 'c-prepaid', autopay_enabled: true, billing_mode: 'per_application' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // a paid monthly charge on file means the row is real pre-conversion
    // debt — the sweep keeps retrying it → warning
    route({
      terms: (own) => (asked(own, 't.term_end') === '2026-04-03' ? [] : coveredAlways(['c-prepaid'])),
      payments: (own) => (isSiblingLookup(own) ? [] : armed()),
      customers: [{ id: 'c-prepaid', autopay_enabled: true, billing_mode: 'per_application' }],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('a retry whose customer disabled Auto Pay is disarmed by the sweep, never charged → stays exempt', async () => {
    route({
      terms: coveredAlways(['c-prepaid']),
      payments: (own) => (isSiblingLookup(own) ? [] : armed({ description: 'Invoice WPC-1' })),
      customers: [{ id: 'c-prepaid', autopay_enabled: false, autopay_paused_until: null }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('a WaveGuard Monthly retry already collected by a paid sibling for that month → stays exempt', async () => {
    const calls = route({
      terms: (own) => (asked(own, 't.term_end') === '2026-04-03' && asked(own, 't.term_start') === '2026-04-03' ? [] : coveredAlways(['c-prepaid'])),
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
    const sel = calls.visits.filter((c) => c[0] === 'select').find((c) => c.includes('ss.id'));
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
      terms: [{ customer_id: 'c-prepaid', id: 'term-1', status: 'active', term_start: '2020-01-01', term_end: '2099-01-01' }],
      visits: [baseVisit({ prepaid_method: 'annual_prepay_invoice', prepaid_amount: '84.00', annual_prepay_term_id: 'term-1' })],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('an auto_charge visit whose invoice is already settled (paid / prepaid / processing) or parked (refunded) stays exempt', async () => {
    for (const status of ['paid', 'prepaid', 'processing', 'refunded']) {
      route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], invoices: [{ id: 'inv-1', status }] });
      expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    }
    // refunded parks the visit even when a newer open invoice exists (terminal lookup wins)
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], invoices: [{ id: 'inv-2', status: 'sent' }, { id: 'inv-1', status: 'refunded' }] });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // a voided invoice is ignored (completion cuts a new one); an open (sent) one is what completion charges → keep the warning
    for (const invoices of [[{ id: 'inv-1', status: 'void' }], [{ id: 'inv-1', status: 'sent' }], [{ id: 'inv-2', status: 'sent' }, { id: 'inv-1', status: 'void' }]]) {
      route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], invoices });
      expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    }
  });

  test("a pause suppresses a visit's charge only when it covers the ENTIRE completion window (>= horizon)", async () => {
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ customer_autopay_paused_until: HORIZON })] });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // a pause covering only the visit's scheduled day is NOT enough — the
    // nonterminal visit can complete late, after the pause lapses but
    // still inside the window, and completion re-reads the then-current
    // pause and charges → warning
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ scheduled_date: TOMORROW, customer_autopay_paused_until: addDays(TODAY, 5) })] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('an OVERDUE nonterminal visit (past scheduled_date, en_route) is still judged', async () => {
    // priced, uncovered, still completable → warning
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ status: 'en_route', scheduled_date: addDays(TODAY, -5) })] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    // a pause through the horizon covers it like any other visit
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ status: 'en_route', scheduled_date: addDays(TODAY, -5), customer_autopay_paused_until: HORIZON })] });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('an open reused invoice with dunning STOPPED cannot be charged by the extended lane → stays exempt', async () => {
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({})],
      invoices: [{ id: 'inv-1', status: 'sent', subtotal: '120.00' }],
      dunningSequences: [{ status: 'stopped' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // the per-application charge path does not pass the stop guard → warning stays
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ billing_mode: 'per_application', per_application_fee: '120.00' })],
      invoices: [{ id: 'inv-1', status: 'sent', subtotal: '120.00' }],
      dunningSequences: [{ status: 'stopped' }],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('a covered customer with no chargeable Auto Pay method cannot be auto-charged at completion → stays exempt', async () => {
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], paymentMethods: [] });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test("an open reused invoice OVER completion's charge cap routes to office review, not the card → stays exempt", async () => {
    // net subtotal far above every anchor (price 120 / monthly 28), no setup line
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], invoices: [{ id: 'inv-1', status: 'sent', subtotal: '500.00' }] });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // within the accepted amount → completion charges → warning
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], invoices: [{ id: 'inv-1', status: 'sent', subtotal: '120.00' }] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('the setup-fee allowance follows completion AUTHORIZATION, never the line text alone', async () => {
    const setupLine = JSON.stringify([{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }]);
    // per-application + accept-minted provenance → completion widens the
    // cap and charges → warning
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ billing_mode: 'per_application', per_application_fee: '120.00' })],
      invoices: [{ id: 'inv-1', status: 'sent', subtotal: '219.00', line_items: setupLine, notes: 'Auto-generated from accepted estimate #123' }],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    // per-application but NO provenance (stale/office-added line) →
    // completion caps at the fee and routes to review → exempt
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ billing_mode: 'per_application', per_application_fee: '120.00' })],
      invoices: [{ id: 'inv-1', status: 'sent', subtotal: '219.00', line_items: setupLine }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // an immutable setup_fee_claims record matching the line to the cent
    // restores the allowance → warning
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ billing_mode: 'per_application', per_application_fee: '120.00' })],
      invoices: [{ id: 'inv-1', status: 'sent', subtotal: '219.00', line_items: setupLine }],
      setupFeeClaims: [{ amount: '99.00' }],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    // NON-per-application lanes get no setup allowance at all → the same
    // over-fee invoice routes to review → exempt
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({})],
      invoices: [{ id: 'inv-1', status: 'sent', subtotal: '219.00', line_items: setupLine }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('a sibling first-application invoice (same estimate/date) that suppresses or parks the completion charge → stays exempt', async () => {
    // settled (reused as already paid) or refunded (parks — manual billing)
    for (const status of ['paid', 'prepaid', 'processing', 'refunded']) {
      route({
        terms: coveredAlways(['c-prepaid']),
        visits: [baseVisit({ source_estimate_id: 'est-1' })],
        invoices: (own) => (isSiblingInvoiceLookup(own) ? [siblingInvoice(status)] : []),
      });
      expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    }
    // canceled acceptance invoice that carried the setup fee parks the
    // completion (bill both charges by hand) → no card charge
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ source_estimate_id: 'est-1' })],
      invoices: (own) => (isSiblingInvoiceLookup(own)
        ? [siblingInvoice('cancelled', { line_items: JSON.stringify([{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }]) })]
        : []),
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // an OPEN live sibling is reused and completion can still auto-charge it → warning
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ source_estimate_id: 'est-1' })],
      invoices: (own) => (isSiblingInvoiceLookup(own) ? [siblingInvoice('sent')] : []),
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('a reused invoice with FROZEN payer ownership cannot be card-charged → stays exempt', async () => {
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], invoices: [{ id: 'inv-1', status: 'sent', subtotal: '120.00', payer_id: 7 }] });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('the unminted setup-fee park (gate on) holds the completion → stays exempt; a different parked visit charges normally', async () => {
    const { findUnmintedSetupFeeObligation } = require('../services/setup-fee-obligation');
    process.env.GATE_UNMINTED_SETUP_FEE_PARK = 'true';
    try {
      findUnmintedSetupFeeObligation.mockResolvedValue({ owed: true, firstVisitAlreadyCompleted: false });
      route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ source_estimate_id: 'est-1' })] });
      expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
      // a DIFFERENT visit already holds the parked alert → this one mints
      // and charges normally → warning
      route({
        terms: coveredAlways(['c-prepaid']),
        visits: [baseVisit({ source_estimate_id: 'est-1' })],
        notifications: [{ id: 'n1', metadata: { dedupeKey: 'unminted_setup_fee_manual_billing:est-1', scheduledServiceId: 'v-other' } }],
      });
      expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
      // gate off → completion does not park → warning
      delete process.env.GATE_UNMINTED_SETUP_FEE_PARK;
      route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ source_estimate_id: 'est-1' })] });
      expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    } finally {
      delete process.env.GATE_UNMINTED_SETUP_FEE_PARK;
      findUnmintedSetupFeeObligation.mockImplementation(async () => ({ owed: false }));
    }
  });

  test('a malformed annual_prepay_invoice stamp (no amount / no term) fails toward the warning — nobody exempt', async () => {
    route({ terms: coveredAlways(['c-prepaid', 'c-other']), visits: [baseVisit({ prepaid_method: 'annual_prepay_invoice', prepaid_amount: null, annual_prepay_term_id: null })] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('a bare annual_prepay_term_id link without the completion stamp is NOT coverage — priced visit keeps the warning', async () => {
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ annual_prepay_term_id: 'term-1', prepaid_method: null })] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('the hot-path memo serves repeat calls for the same horizon without re-scanning, and never caches a failed lookup', async () => {
    const calls = route({ terms: coveredAlways(['c-prepaid']) });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    const termsQueriesAfterFirst = calls.terms.length;
    // second call (dashboard poll) → memo, no new terms query
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    expect(calls.terms.length).toBe(termsQueriesAfterFirst);
    // a fail-toward-warning result is NOT pinned: after an error the next
    // call recomputes and succeeds
    const failedCalls = route({ terms: coveredAlways(['c-prepaid']), throwOn: 'payments' });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    const afterFailure = failedCalls.terms.length;
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual([]);
    expect(failedCalls.terms.length).toBeGreaterThan(afterFailure);
  });

  test('lookup failures exempt nobody (fail toward the warning)', async () => {
    route({ terms: coveredAlways(['c-prepaid']), throwOn: 'payments' });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    route({ terms: coveredAlways(['c-prepaid']), throwOn: 'scheduled_services' });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });
});
