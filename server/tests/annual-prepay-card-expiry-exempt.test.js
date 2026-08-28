// getCardExpiryExemptCustomerIds: covered across the window MINUS customers
// with a card charge still coming inside it — judged by the billing
// authorities (retry sweep guards, predictCompletionBilling); any lookup
// failure exempts nobody.
jest.mock('../models/db', () => { const db = jest.fn(); db.schema = { hasTable: jest.fn(async () => true) }; db.raw = jest.fn((x) => x); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: { completionAutopayCharge: true }, isEnabled: jest.fn(() => false) }));
jest.mock('../services/setup-fee-obligation', () => ({ findUnmintedSetupFeeObligation: jest.fn(async () => ({ owed: false })) }));
jest.mock('../services/estimate-card-holds', () => ({ isCardHoldEnabled: jest.fn(() => true) }));

const db = require('../models/db');
const { etDateString } = require('../utils/datetime-et');
const { getCardExpiryExemptCustomerIds, getCardExpiryExemptions, clearCardExpiryExemptCache } = require('../services/annual-prepay-renewals');
const { isCardExpiryExemptMethod } = require('../services/card-expiry-exemptions');

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
  ['whereIn', 'where', 'whereNull', 'whereNotNull', 'whereNot', 'whereNotIn', 'whereExists', 'whereNotExists', 'from', 'leftJoin', 'join', 'whereRaw', 'orderBy', 'orWhere', 'orWhereNull', 'orWhereNotNull', 'orWhereIn', 'orWhereRaw', 'andWhere', 'andWhereNot', 'modify']
    .forEach((m) => { q[m] = jest.fn((...a) => { own.push([m, ...a]); calls.push([m, ...a]); if (typeof a[0] === 'function') a[0].call(q, q); return q; }); });
  const resolve = async () => (typeof rowsFor === 'function' ? rowsFor(own) : rowsFor);
  // Thenable builder (not a bare promise): completion's cap block chains
  // `.select('id').where(...)` as a whereIn subquery.
  q.select = jest.fn((...a) => { own.push(['select', ...a]); calls.push(['select', ...a]); return q; });
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
function route({ terms = [], payments = [], visits = [], invoices = [], customers = [], paymentMethods = [CHARGEABLE_CARD], apptCardRequests = [], dunningSequences = [], setupFeeClaims = [], notifications = [], pendingTerms = [], cardHolds = [], serviceRecords = [], paymentPlans = [], completionAttempts = [], estimates = [], throwOn = null }) {
  const calls = { terms: [], payments: [], visits: [], invoices: [], customers: [], cardHolds: [] };
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
    // the cap verdict reads the linked estimate's frozen setup fee
    if (table === 'estimates') return chain(estimates, []);
    if (table === 'notifications') return chain(notifications, []);
    if (table === 'estimate_card_holds') return chain(cardHolds, calls.cardHolds);
    if (table === 'service_records') return chain(serviceRecords, []);
    if (table === 'payment_plans') return chain(paymentPlans, []);
    if (table === 'service_completion_attempts') return chain(completionAttempts, []);
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
  test('a consent / hold / setup-fee provenance lookup failure inside the shared verdict exempts nobody (strict mode)', async () => {
    // Each scenario is EXEMPT when its lookup succeeds (the bill is over the
    // cap → office review, no charge); the same lookup throwing must flip
    // the whole answer to "nobody" — the route swallows these failures
    // toward review, this surface must not swallow them toward silence.
    const overCap = (over) => [{ id: 'inv-open', status: 'sent', subtotal: '200.00', total: '200.00', discount_amount: 0, payer_id: null, scheduled_service_id: 'v1', service_record_id: null, notes: '', line_items: [], ...over }];
    const oneTime = () => [baseVisit({ status: 'en_route', billing_mode: 'per_visit', is_recurring: false, prepaid_method: null, annual_prepay_term_id: null })];
    const gatesMod = require('../config/feature-gates');
    gatesMod.isEnabled.mockReturnValue(true); // appointment-card lane gate ON → consent lookup runs
    try {
      route({ terms: coveredAlways(['c-prepaid']), visits: oneTime(), invoices: overCap() });
      expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
      route({ terms: coveredAlways(['c-prepaid']), visits: oneTime(), invoices: overCap(), throwOn: 'appointment_card_requests' });
      expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    } finally { gatesMod.isEnabled.mockReturnValue(false); }
    // extended-lane hold exclusion lookup
    route({ terms: coveredAlways(['c-prepaid']), visits: oneTime(), invoices: overCap(), throwOn: 'estimate_card_holds' });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    // setup-fee claim provenance lookup (a bill carrying a setup-fee line)
    const feeBill = () => overCap({ subtotal: '250.00', total: '250.00', notes: 'Auto-generated from accepted estimate #7', line_items: [{ description: 'One-time setup fee', amount: 99 }] });
    route({ terms: coveredAlways(['c-prepaid']), visits: oneTime(), invoices: feeBill() });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    route({ terms: coveredAlways(['c-prepaid']), visits: oneTime(), invoices: feeBill(), throwOn: 'setup_fee_claims' });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('cap anchor precedence is completion\'s own: a $120 visit price outranks a $300 rate, so a $200 reused bill routes to review → stays exempt (#3533 held thread closed)', async () => {
    // Before the shared verdict the exemption bounded the cap by the MAX of
    // every anchor ($300 rate) and kept the warning; completion actually
    // caps at estimated_price FIRST ($120) and sends the $200 invoice to
    // office review without touching the card.
    // (the suite's feature-gates mock has completionAutopayCharge ON)
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ status: 'en_route', billing_mode: 'per_visit', is_recurring: false, estimated_price: '120.00', monthly_rate: '300.00', prepaid_method: null, annual_prepay_term_id: null })],
      invoices: [{ id: 'inv-open', status: 'sent', subtotal: '200.00', total: '200.00', discount_amount: 0, payer_id: null, scheduled_service_id: 'v1', service_record_id: null, line_items: [], notes: '' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // …and a $120 bill inside that cap is a real auto-charge → warning
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ status: 'en_route', billing_mode: 'per_visit', is_recurring: false, estimated_price: '120.00', monthly_rate: '300.00', prepaid_method: null, annual_prepay_term_id: null })],
      invoices: [{ id: 'inv-open', status: 'sent', subtotal: '120.00', total: '120.00', discount_amount: 0, payer_id: null, scheduled_service_id: 'v1', service_record_id: null, line_items: [], notes: '' }],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

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
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], invoices: [{ id: 'inv-2', scheduled_service_id: 'v1', status: 'sent' }, { id: 'inv-1', scheduled_service_id: 'v1', status: 'refunded' }] });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // a voided invoice is ignored (completion cuts a new one); an open (sent) one is what completion charges → keep the warning
    for (const invoices of [[{ id: 'inv-1', scheduled_service_id: 'v1', status: 'void' }], [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent' }], [{ id: 'inv-2', scheduled_service_id: 'v1', status: 'sent' }, { id: 'inv-1', scheduled_service_id: 'v1', status: 'void' }]]) {
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
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '120.00' }],
      dunningSequences: [{ status: 'stopped' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // the per-application charge path does not pass the stop guard → warning stays
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ billing_mode: 'per_application', per_application_fee: '120.00' })],
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '120.00' }],
      dunningSequences: [{ status: 'stopped' }],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test("a dying or missing Auto Pay method never proves its own warning unnecessary — the visit stays chargeable", async () => {
    // eligibility is the enrollment flag + pause, NOT the candidate card's
    // chargeability: an expired card reading as "no chargeable method"
    // would suppress exactly the warning that prompts replacing it
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], paymentMethods: [] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('a competing appointment consent row blocks the hold rail too (requireNoAppointmentCardLane) → stays exempt', async () => {
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ is_recurring: false })],
      cardHolds: [{ id: 'hold-1', status: 'held', accepted_amount: '120.00' }],
      apptCardRequests: [{ id: 'acr-1', customer_id: 'c-other', status: 'pending' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('a mint-nothing prediction (covered visit) with a live hold charges only an EXISTING open invoice', async () => {
    const coveredStampedVisit = () => baseVisit({ is_recurring: false, prepaid_method: 'annual_prepay_invoice', prepaid_amount: '84.00', annual_prepay_term_id: 'term-1' });
    const liveTerm = [{ customer_id: 'c-prepaid', id: 'term-1', status: 'active', term_start: '2020-01-01', term_end: '2099-01-01' }];
    // an existing open bound invoice → completion reuses it and the hold
    // charges (the rail rejects neither callbacks nor covered kinds) → warning
    route({
      terms: liveTerm,
      visits: [coveredStampedVisit()],
      cardHolds: [{ id: 'hold-1', status: 'held', accepted_amount: '120.00' }],
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '120.00' }],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    // no existing invoice → nothing minted, nothing to charge → exempt
    route({
      terms: liveTerm,
      visits: [coveredStampedVisit()],
      cardHolds: [{ id: 'hold-1', status: 'held', accepted_amount: '120.00' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('a live estimate card hold charges the captured card regardless of Auto Pay → keeps the warning', async () => {
    // paused through the horizon would exempt, but the hold rail is never
    // Auto-Pay-gated and charges the collectible completion invoice
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ is_recurring: false, customer_autopay_paused_until: HORIZON })], cardHolds: [{ id: 'hold-1', status: 'held', accepted_amount: '120.00' }] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    // a validly covered visit mints no completion invoice — the hold has
    // nothing to charge → exempt
    route({
      terms: [{ customer_id: 'c-prepaid', id: 'term-1', status: 'active', term_start: '2020-01-01', term_end: '2099-01-01' }],
      visits: [baseVisit({ is_recurring: false, prepaid_method: 'annual_prepay_invoice', prepaid_amount: '84.00', annual_prepay_term_id: 'term-1' })],
      cardHolds: [{ id: 'hold-1', status: 'held', accepted_amount: '120.00' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test("the hold rail's frozen cap withholds: no accepted amount, or a bill above it → stays exempt", async () => {
    // no frozen accepted amount → the rail fails closed, nothing charged
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ is_recurring: false, customer_autopay_paused_until: HORIZON })], cardHolds: [{ id: 'hold-1', status: 'held' }] });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // reused invoice net-above the frozen amount → withheld for review
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ is_recurring: false, customer_autopay_paused_until: HORIZON })],
      cardHolds: [{ id: 'hold-1', status: 'held', accepted_amount: '100.00' }],
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '200.00' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // within the frozen amount → the hold charges → warning
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ is_recurring: false, customer_autopay_paused_until: HORIZON })],
      cardHolds: [{ id: 'hold-1', status: 'held', accepted_amount: '120.00' }],
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '120.00' }],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('a completed visit whose RESUMED attempt froze backfill never auto-charges → stays exempt; a normal-record resume still charges', async () => {
    // every unfinished attempt resumes a backfill-frozen record → the
    // resume skips the whole auto-charge rail
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ status: 'completed' })],
      serviceRecords: [{ id: 'rec-1', structured_notes: JSON.stringify({ backfill: true }) }],
      completionAttempts: [{ service_record_id: 'rec-1' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // the unfinished attempt resumes a NORMAL record — an older backfill
    // record on the same visit proves nothing → warning
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ status: 'completed' })],
      serviceRecords: [
        { id: 'rec-old', structured_notes: JSON.stringify({ backfill: true }) },
        { id: 'rec-normal', structured_notes: null },
      ],
      completionAttempts: [{ service_record_id: 'rec-normal' }],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('record-linked settled invoices still suppress, but an OPEN record-only invoice cannot be card-charged (invoice_unbound) → exempt', async () => {
    // record-linked PAID beats a newer open scheduled-linked row: the
    // suppressor chain checks the record first → already settled → exempt
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ status: 'completed' })],
      serviceRecords: [{ id: 'rec-1', structured_notes: null }],
      completionAttempts: [{ service_record_id: 'rec-1' }],
      invoices: [
        { id: 'inv-open', scheduled_service_id: 'v1', status: 'sent', subtotal: '120.00' },
        { id: 'inv-paid', status: 'paid', service_record_id: 'rec-1' },
      ],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // an OPEN record-only invoice is reused as a pay-link, never charged —
    // the extended money boundary requires the visit binding
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ status: 'completed' })],
      serviceRecords: [{ id: 'rec-1', structured_notes: null }],
      completionAttempts: [{ service_record_id: 'rec-1' }],
      invoices: [{ id: 'inv-old', status: 'sent', subtotal: '120.00', service_record_id: 'rec-1' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('an active payment plan owns the reused invoice → the anchor verdict refuses the charge → stays exempt', async () => {
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({})],
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '120.00' }],
      paymentPlans: [{ id: 'plan-1', status: 'active' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('a stale/mismatched appointment consent blocks the extended charge and the lane cannot charge either → stays exempt', async () => {
    // consent row for a DIFFERENT customer: extended refuses ANY consent
    // row (requireNoAppointmentCardLane), the lane rejects the mismatch
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({})],
      apptCardRequests: [{ id: 'acr-1', customer_id: 'c-other', status: 'completed' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // a matching consent with the lane gate ON on a ONE-TIME customer → the
    // lane itself charges → warning
    const gatesMod = require('../config/feature-gates');
    gatesMod.isEnabled.mockReturnValue(true);
    try {
      route({
        terms: coveredAlways(['c-prepaid']),
        visits: [baseVisit({ is_recurring: false, billing_mode: 'per_visit' })],
        apptCardRequests: [{ id: 'acr-1', customer_id: 'c-prepaid', status: 'completed', accepted_amount: '120.00' }],
      });
      expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
      // …but the route admits the appointment-card lane ONLY outside the
      // explicit per-application / annual-prepay / membership lanes
      // (resolveAppointmentCardLane) — an annual_prepay customer's matching
      // consent cannot charge, so the exemption stands.
      route({
        terms: coveredAlways(['c-prepaid']),
        visits: [baseVisit({ is_recurring: false, billing_mode: 'annual_prepay' })],
        apptCardRequests: [{ id: 'acr-1', customer_id: 'c-prepaid', status: 'completed', accepted_amount: '120.00' }],
      });
      expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    } finally { gatesMod.isEnabled.mockReturnValue(false); }
  });

  test('a PARKED or gate-off hold is untouchable by the charge rail → stays exempt', async () => {
    const { isCardHoldEnabled } = require('../services/estimate-card-holds');
    // feature gate off → chargeCardHoldOnCompletion refuses before
    // touching the hold
    isCardHoldEnabled.mockReturnValueOnce(false);
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ is_recurring: false, customer_autopay_paused_until: HORIZON })], cardHolds: [{ id: 'hold-1', status: 'held' }] });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // the resolver mirrors heldCardForScheduledService: NEWEST held row
    // first (held_at DESC), THEN the parked refusal — a parked newest row
    // means the rail charges nothing, whatever older rows exist
    const calls = route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ is_recurring: false, customer_autopay_paused_until: HORIZON })],
      cardHolds: [{ id: 'hold-new', status: 'held', parked_at: '2026-08-01T00:00:00Z', accepted_amount: '120.00' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    expect(calls.cardHolds).toEqual(expect.arrayContaining([['orderBy', 'held_at', 'desc']]));
  });

  test('the appointment-card completion lane charges a consented one-time visit even with the generic gate off → keeps the warning', async () => {
    const gatesMod = require('../config/feature-gates');
    gatesMod.gates.completionAutopayCharge = false;
    gatesMod.isEnabled.mockReturnValue(true);
    try {
      route({
        terms: coveredAlways(['c-prepaid']),
        visits: [baseVisit({ is_recurring: false, billing_mode: null, waveguard_tier: null, monthly_rate: null })],
        apptCardRequests: [{ id: 'acr-1', customer_id: 'c-prepaid', status: 'completed', accepted_amount: '120.00' }],
      });
      expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
      // no consent row → the completion goes out as a pay-link → exempt
      route({
        terms: coveredAlways(['c-prepaid']),
        visits: [baseVisit({ is_recurring: false, billing_mode: null, waveguard_tier: null, monthly_rate: null })],
      });
      expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    } finally {
      gatesMod.gates.completionAutopayCharge = true;
      gatesMod.isEnabled.mockReturnValue(false);
    }
  });

  test("the visit invoice lookup adds the RESUMED attempt's record link beside scheduled_service_id", async () => {
    const calls = route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ status: 'completed' })],
      serviceRecords: [{ id: 'rec-1', structured_notes: null }, { id: 'rec-historical', structured_notes: null }],
      completionAttempts: [{ service_record_id: 'rec-1' }],
    });
    await getCardExpiryExemptCustomerIds(HORIZON);
    // ONLY the attempt-owned record — a historical record's invoices must
    // not stand in for the one the resume will actually use
    expect(calls.invoices).toEqual(expect.arrayContaining([
      ['orWhereIn', 'service_record_id', ['rec-1']],
    ]));
  });

  test("an open reused invoice OVER completion's charge cap routes to office review, not the card → stays exempt", async () => {
    // net subtotal far above every anchor (price 120 / monthly 28), no setup line
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '500.00' }] });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // within the accepted amount → completion charges → warning
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '120.00' }] });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('the setup-fee allowance follows completion AUTHORIZATION, never the line text alone', async () => {
    const setupLine = JSON.stringify([{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }]);
    // per-application + accept-minted provenance → completion widens the
    // cap and charges → warning
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ billing_mode: 'per_application', per_application_fee: '120.00' })],
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '219.00', line_items: setupLine, notes: 'Auto-generated from accepted estimate #123' }],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    // per-application but NO provenance (stale/office-added line) →
    // completion caps at the fee and routes to review → exempt
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ billing_mode: 'per_application', per_application_fee: '120.00' })],
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '219.00', line_items: setupLine }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // an immutable setup_fee_claims record matching the line to the cent
    // restores the allowance → warning
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ billing_mode: 'per_application', per_application_fee: '120.00' })],
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '219.00', line_items: setupLine }],
      setupFeeClaims: [{ amount: '99.00' }],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    // NON-per-application lanes get no setup allowance at all → the same
    // over-fee invoice routes to review → exempt
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({})],
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '219.00', line_items: setupLine }],
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
    // an OPEN live sibling bound to THIS visit is reused and completion
    // can still auto-charge it → warning
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ source_estimate_id: 'est-1' })],
      invoices: (own) => (isSiblingInvoiceLookup(own) ? [siblingInvoice('sent', { scheduled_service_id: 'v1' })] : []),
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
    // an OPEN sibling bound to a DIFFERENT visit cannot be charged for
    // this one (invoice_unbound) → pay-link only → exempt
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ source_estimate_id: 'est-1' })],
      invoices: (own) => (isSiblingInvoiceLookup(own) ? [siblingInvoice('sent', { scheduled_service_id: 'v-sibling' })] : []),
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });

  test('a hold row closes the EXTENDED lane even under auto_charge — the hold rail alone decides', async () => {
    // live hold, Auto Pay active (auto_charge prediction), bill above the
    // frozen amount → the extended lane is hold-excluded and the rail
    // withholds → exempt
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ is_recurring: false })],
      cardHolds: [{ id: 'hold-1', status: 'held', accepted_amount: '100.00' }],
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '200.00' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // a PARKED hold row still closes the extended lane and the rail
    // refuses it → nothing can charge → exempt
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ is_recurring: false })],
      cardHolds: [{ id: 'hold-1', status: 'held', parked_at: '2026-08-01T00:00:00Z', accepted_amount: '120.00' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    // within the frozen amount the hold charges → warning
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [baseVisit({ is_recurring: false })],
      cardHolds: [{ id: 'hold-1', status: 'held', accepted_amount: '120.00' }],
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '120.00' }],
    });
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test("the appointment lane's frozen cap: missing or exceeded accepted_amount routes to review → exempt", async () => {
    const gatesMod = require('../config/feature-gates');
    gatesMod.isEnabled.mockReturnValue(true);
    try {
      // consent with NO accepted amount → lane unchargeable, extended
      // excluded by the consent row → exempt
      route({
        terms: coveredAlways(['c-prepaid']),
        visits: [baseVisit({ is_recurring: false })],
        apptCardRequests: [{ id: 'acr-1', customer_id: 'c-prepaid', status: 'completed' }],
      });
      expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
      // bill above the frozen amount → office review → exempt
      route({
        terms: coveredAlways(['c-prepaid']),
        visits: [baseVisit({ is_recurring: false })],
        apptCardRequests: [{ id: 'acr-1', customer_id: 'c-prepaid', status: 'completed', accepted_amount: '100.00' }],
        invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '200.00' }],
      });
      expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
    } finally { gatesMod.isEnabled.mockReturnValue(false); }
  });

  test('a reused invoice with FROZEN payer ownership cannot be card-charged → stays exempt', async () => {
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '120.00', payer_id: 7 }] });
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

// PER-METHOD charge vectors + account-credit coverage (#3533 follow-up: the
// last two held threads). A covered customer with a charge coming is no
// longer a blanket "warn on every card": getCardExpiryExemptions maps them
// to the payment_methods.id each forthcoming charge will use, and the three
// surfaces warn only about THOSE. A fully credit-covered invoice is not a
// charge at all.
describe('getCardExpiryExemptions — per-method charge vectors', () => {
  const isHoldCardLookup = (own) => own.some((c) => c[0] === 'where' && c[1] && typeof c[1] === 'object' && 'stripe_payment_method_id' in c[1]);
  const armed = (over) => [{ id: 'p-fail', customer_id: 'c-prepaid', description: 'Invoice WPC-1', payment_date: '2026-04-03', metadata: null, ...over }];
  const isSiblingLookup = (own) => own.some((c) => c[0] === 'whereIn' && c[1] === 'status');
  const liveHold = (over) => [{ id: 'hold-1', status: 'held', accepted_amount: '120.00', stripe_payment_method_id: 'pm_hold', ...over }];
  const pausedOneTime = () => baseVisit({ is_recurring: false, customer_autopay_paused_until: HORIZON });
  const HOLD_CARD = { id: 'pm-hold', method_type: 'card', exp_month: '12', exp_year: '2099' };

  test('an Auto Pay lane charge records the walk\'s method (pointer-first, expiring card included) — the customer is no longer customer-level exempt', async () => {
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})] });
    const ex = await getCardExpiryExemptions(HORIZON);
    expect([...ex.customerIds]).toEqual([]);
    expect(ex.chargeMethodIdsByCustomer.get('c-prepaid')).toEqual(new Set(['pm-1']));
    // the surfaces' verdict: the charged card warns, any other card of this customer does not
    expect(isCardExpiryExemptMethod(ex, 'c-prepaid', 'pm-1')).toBe(false);
    expect(isCardExpiryExemptMethod(ex, 'c-prepaid', 'pm-other')).toBe(true);
    expect(isCardExpiryExemptMethod(ex, 'c-prepaid', null)).toBe(false);
    // the customer-level view still says "not exempt" (unchanged contract)
    expect((await getCardExpiryExemptCustomerIds(HORIZON)).size).toBe(0);
  });

  test('the walk lands on the EXPIRING card itself (ignoreCardExpiry) — an expired Auto Pay card is the charge vector, not "no method"', async () => {
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], paymentMethods: [{ ...CHARGEABLE_CARD, id: 'pm-expired', exp_month: '1', exp_year: '2020' }] });
    const ex = await getCardExpiryExemptions(HORIZON);
    expect(ex.chargeMethodIdsByCustomer.get('c-prepaid')).toEqual(new Set(['pm-expired']));
  });

  test('a pointer valid TODAY but expiring inside the window hands the charge to the next default — every eligible fallback is a vector (GitHub P1)', async () => {
    const [ty, tm] = TODAY.split('-');
    route({
      terms: coveredAlways(['c-prepaid']), visits: [baseVisit({ customer_autopay_payment_method_id: 'pm-ptr' })],
      paymentMethods: [
        { ...CHARGEABLE_CARD, id: 'pm-ptr', exp_month: String(Number(tm)), exp_year: ty }, // valid through this month only
        { ...CHARGEABLE_CARD, id: 'pm-b' },
        { ...CHARGEABLE_CARD, id: 'pm-c' },
        { ...CHARGEABLE_CARD, id: 'pm-dead', exp_month: '1', exp_year: '2020' }, // never selectable
        { ...CHARGEABLE_CARD, id: 'pm-off', autopay_enabled: false },            // never selectable
      ],
    });
    const ex = await getCardExpiryExemptions(HORIZON);
    expect(ex.chargeMethodIdsByCustomer.get('c-prepaid')).toEqual(new Set(['pm-ptr', 'pm-b', 'pm-c']));
    expect(isCardExpiryExemptMethod(ex, 'c-prepaid', 'pm-dead')).toBe(true);
    expect(isCardExpiryExemptMethod(ex, 'c-prepaid', 'pm-off')).toBe(true);
  });

  test("an already-expired pointer/default AND the card charge() falls back to today are BOTH vectors (hook P1)", async () => {
    route({
      terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})],
      paymentMethods: [{ ...CHARGEABLE_CARD, id: 'pm-expired', exp_month: '1', exp_year: '2020' }, { ...CHARGEABLE_CARD, id: 'pm-valid' }],
    });
    const ex = await getCardExpiryExemptions(HORIZON);
    expect(ex.chargeMethodIdsByCustomer.get('c-prepaid')).toEqual(new Set(['pm-expired', 'pm-valid']));
    expect(isCardExpiryExemptMethod(ex, 'c-prepaid', 'pm-valid')).toBe(false);
    expect(isCardExpiryExemptMethod(ex, 'c-prepaid', 'pm-third')).toBe(true);
  });

  test('no chargeable method at all → the charge is unresolved (null): every card warns', async () => {
    route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})], paymentMethods: [] });
    const ex = await getCardExpiryExemptions(HORIZON);
    expect([...ex.customerIds]).toEqual([]);
    expect(ex.chargeMethodIdsByCustomer.get('c-prepaid')).toBeNull();
    expect(isCardExpiryExemptMethod(ex, 'c-prepaid', 'pm-anything')).toBe(false);
  });

  test("a live hold charges the card FROZEN on the hold — the Auto Pay card it never touches is exempt", async () => {
    route({
      terms: coveredAlways(['c-prepaid']),
      visits: [pausedOneTime()],
      cardHolds: liveHold(),
      paymentMethods: (own) => (isHoldCardLookup(own) ? [HOLD_CARD] : [CHARGEABLE_CARD]),
    });
    const ex = await getCardExpiryExemptions(HORIZON);
    expect([...ex.customerIds]).toEqual([]);
    expect(ex.chargeMethodIdsByCustomer.get('c-prepaid')).toEqual(new Set(['pm-hold']));
    expect(isCardExpiryExemptMethod(ex, 'c-prepaid', 'pm-1')).toBe(true);
    expect(isCardExpiryExemptMethod(ex, 'c-prepaid', 'pm-hold')).toBe(false);
  });

  test("a hold whose frozen card has no payment_methods row (or no frozen card) is unresolved → every card warns", async () => {
    route({
      terms: coveredAlways(['c-prepaid']), visits: [pausedOneTime()], cardHolds: liveHold(),
      paymentMethods: (own) => (isHoldCardLookup(own) ? [] : [CHARGEABLE_CARD]),
    });
    expect((await getCardExpiryExemptions(HORIZON)).chargeMethodIdsByCustomer.get('c-prepaid')).toBeNull();
    route({ terms: coveredAlways(['c-prepaid']), visits: [pausedOneTime()], cardHolds: liveHold({ stripe_payment_method_id: null }) });
    expect((await getCardExpiryExemptions(HORIZON)).chargeMethodIdsByCustomer.get('c-prepaid')).toBeNull();
  });

  test("a hold card that will NOT be valid through the horizon is a charge that fails — unresolved, the Auto Pay card keeps its warning (hook P1)", async () => {
    // expired before the horizon month
    route({
      terms: coveredAlways(['c-prepaid']), visits: [pausedOneTime()], cardHolds: liveHold(),
      paymentMethods: (own) => (isHoldCardLookup(own) ? [{ ...HOLD_CARD, exp_month: '1', exp_year: '2020' }] : [CHARGEABLE_CARD]),
    });
    expect((await getCardExpiryExemptions(HORIZON)).chargeMethodIdsByCustomer.get('c-prepaid')).toBeNull();
    // malformed expiry reads as expired too
    route({
      terms: coveredAlways(['c-prepaid']), visits: [pausedOneTime()], cardHolds: liveHold(),
      paymentMethods: (own) => (isHoldCardLookup(own) ? [{ ...HOLD_CARD, exp_month: null, exp_year: null }] : [CHARGEABLE_CARD]),
    });
    expect((await getCardExpiryExemptions(HORIZON)).chargeMethodIdsByCustomer.get('c-prepaid')).toBeNull();
    // valid through the horizon's month → resolved
    const [hy, hm] = HORIZON.split('-');
    route({
      terms: coveredAlways(['c-prepaid']), visits: [pausedOneTime()], cardHolds: liveHold(),
      paymentMethods: (own) => (isHoldCardLookup(own) ? [{ ...HOLD_CARD, exp_month: String(Number(hm)), exp_year: hy }] : [CHARGEABLE_CARD]),
    });
    expect((await getCardExpiryExemptions(HORIZON)).chargeMethodIdsByCustomer.get('c-prepaid')).toEqual(new Set(['pm-hold']));
  });

  test('a collectible retry records the Auto Pay walk (the sweep charges through StripeService.charge)', async () => {
    route({ terms: coveredAlways(['c-prepaid', 'c-other']), payments: (own) => (isSiblingLookup(own) ? [] : armed()) });
    const ex = await getCardExpiryExemptions(HORIZON);
    expect([...ex.customerIds]).toEqual(['c-other']);
    expect(ex.chargeMethodIdsByCustomer.get('c-prepaid')).toEqual(new Set(['pm-1']));
  });

  test('every vector is collected — a retry AND a hold on different cards both warn, nothing else does', async () => {
    route({
      terms: coveredAlways(['c-prepaid']),
      payments: (own) => (isSiblingLookup(own) ? [] : armed()),
      visits: [pausedOneTime()], cardHolds: liveHold(),
      paymentMethods: (own) => (isHoldCardLookup(own) ? [HOLD_CARD] : [CHARGEABLE_CARD]),
    });
    expect((await getCardExpiryExemptions(HORIZON)).chargeMethodIdsByCustomer.get('c-prepaid')).toEqual(new Set(['pm-1', 'pm-hold']));
  });

  test('a lookup failure fails toward the warning for the per-method view too, and the memo serves copies', async () => {
    route({ terms: coveredAlways(['c-prepaid']), throwOn: 'payments' });
    const failed = await getCardExpiryExemptions(HORIZON);
    expect(failed.customerIds.size).toBe(0);
    expect(failed.chargeMethodIdsByCustomer.size).toBe(0);
    expect(failed.lookupFailed).toBeUndefined();
    const calls = route({ terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})] });
    const first = await getCardExpiryExemptions(HORIZON);
    first.chargeMethodIdsByCustomer.get('c-prepaid').add('tampered');
    const termsAfterFirst = calls.terms.length;
    const second = await getCardExpiryExemptions(HORIZON);
    expect(calls.terms.length).toBe(termsAfterFirst); // memo hit
    expect(second.chargeMethodIdsByCustomer.get('c-prepaid')).toEqual(new Set(['pm-1']));
  });
});

describe('getCardExpiryExemptions — an account-credit BALANCE is not coverage', () => {
  const gates = require('../config/feature-gates').gates;
  beforeEach(() => { gates.autoApplyAccountCredit = true; });
  afterEach(() => { delete gates.autoApplyAccountCredit; });

  test('a balance that would settle the reused invoice at completion still leaves the card a charge vector (unreserved credit — hook + GitHub P1s)', async () => {
    route({
      terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})],
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'sent', subtotal: '120.00', total: '120.00', credit_applied: 0 }],
      customers: [{ id: 'c-prepaid', account_credits: '9999.00' }],
    });
    const ex = await getCardExpiryExemptions(HORIZON);
    expect([...ex.customerIds]).toEqual([]);
    expect(ex.chargeMethodIdsByCustomer.get('c-prepaid')).toEqual(new Set(['pm-1']));
  });

  test('credit that HAS been applied is modeled through the invoice status: a prepaid invoice is no charge', async () => {
    route({
      terms: coveredAlways(['c-prepaid']), visits: [baseVisit({})],
      invoices: [{ id: 'inv-1', scheduled_service_id: 'v1', status: 'prepaid', subtotal: '120.00', total: '120.00', credit_applied: '120.00' }],
    });
    expect([...(await getCardExpiryExemptCustomerIds(HORIZON))]).toEqual(['c-prepaid']);
  });
});
