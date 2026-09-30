/**
 * findBillingCoveredVisits' `liveInvoice` option (owner ruling 2026-09-28,
 * "the re-price block" — server/routes/admin-schedule.js). Default false
 * keeps the 3 pre-existing callers (the plan-length trim, the dispatch
 * series-cancel fee rails, and the price/service sibling propagation before
 * this option was threaded onto it) byte-identical: a draft/sent invoice
 * with nobody having taken any money yet was never "money already taken"
 * for THOSE questions. `liveInvoice: true` (the repricing guard) answers a
 * different question — "would changing the price leave a stale bill in
 * front of the customer or the office" — so it also counts:
 *   - a draft/sent/scheduled/viewed/overdue invoice that still has a
 *     balance due (invoiceAmountDue > 0), matched directly by
 *     invoices.scheduled_service_id (the existing query) AND, gated behind
 *     this same option, the two indirect links the direct query misses:
 *   - an invoice linked only through its service record
 *     (service_records.scheduled_service_id)
 *   - a combined-visit packet invoice billing a member visit through
 *     visit_completion_packet_items (scheduled_service_id -> invoice_id)
 *
 * These are unit tests against the exported function directly, with a
 * minimal fake knex-shaped `conn` — no HTTP route, no transaction.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => next(),
    requireAdmin: (req, _res, next) => next(),
  };
});
jest.mock('../models/db', () => jest.fn());
// The real admin-customers.js route file is huge and pulls in a wide
// dependency graph unrelated to this suite; securePendingPrepayCoverageReasons
// only needs its ANNUAL_PREPAY_LOCK_NS namespace constant (the same value
// topUpRecurringSeriesLocked already borrows the same way — see its own
// comment in admin-schedule.js), so it's mocked down to that.
jest.mock('../routes/admin-customers', () => ({ _private: { ANNUAL_PREPAY_LOCK_NS: 0x4150 } }));

const { findBillingCoveredVisits } = require('../routes/admin-schedule');

// A chainable fake query builder that resolves (thenable) to `rows` — every
// filter/join method returns itself so any call shape findBillingCoveredVisits
// issues (whereIn/whereNotIn/select/join) is accepted, and `first`/`pluck`
// resolve straight from `rows`.
function fakeQuery(allRows) {
  const q = {};
  let rows = allRows;
  for (const m of ['where', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull', 'join', 'leftJoin', 'joinRaw', 'orderBy', 'forUpdate', 'noWait', 'select']) {
    q[m] = jest.fn(() => q);
  }
  // Only an `id` filter is honored (the first-application rail's locked
  // re-read of its stamped invoices); every other filter stays a no-op.
  q.whereIn = jest.fn((col, vals) => {
    if (col === 'id') rows = allRows.filter((r) => vals.map(String).includes(String(r.id)));
    return q;
  });
  // A real filter (unlike the rest of this fake): the secure-prepay
  // coverage rail's canonical coverageRowsForTerm (annual-prepay-renewals.js,
  // unmocked in this file) runs its own scheduled_date window query through
  // this, and a term-window exclusion test needs it to actually exclude —
  // every OTHER caller of coverageCandidateRows in the real module keys the
  // SAME column, so this stays a single, narrow real filter.
  q.whereBetween = jest.fn((col, range) => {
    if (col === 'scheduled_date' && Array.isArray(range)) {
      const [lo, hi] = range;
      rows = rows.filter((r) => {
        const d = String(r?.scheduled_date || '').slice(0, 10);
        return !!d && d >= lo && d <= hi;
      });
    }
    return q;
  });
  q.first = jest.fn(async () => rows[0] || null);
  q.pluck = jest.fn(async (col) => rows.map((r) => r[col]));
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  q.catch = (fn) => Promise.resolve(rows).catch(fn);
  return q;
}

// `byTable` keys are the EXACT string knex sees at the call site, including
// any `as` alias (e.g. 'invoices as inv') — findBillingCoveredVisits always
// aliases its two indirect-link queries the same way, so these keys pin that
// contract too (a query written against a different alias would silently
// stop matching this fixture and fall through as "not covered", the same
// gap this suite exists to catch).
// `hasColumns` keys are `table.column` — default present (matches
// `hasTables`' default-true shape) so existing fixtures that never mention
// the new prepay/first-application columns keep reading them as available.
function makeConn({
  hasTables = {}, hasColumns = {}, byTable = {}, tryLockAcquired = true, securePrepayLockAcquired = true,
} = {}) {
  const conn = (table) => fakeQuery(byTable[table] || []);
  // Two DISTINCT pg_try_advisory_xact_lock call sites share this one raw()
  // mock, told apart by their own SQL alias (never by call order): the
  // anchor mint try-lock (memberBillingInvoiceRows, `AS acquired`) and the
  // secure-prepay coverage rail's per-customer ANNUAL_PREPAY_LOCK_NS try-lock
  // (securePendingPrepayCoverageReasons, `AS locked` — the SAME alias every
  // other acquirer of that namespace uses, per advisoryTryLockAcquired).
  conn.raw = jest.fn(async (sql) => (/AS locked/.test(String(sql))
    ? { rows: [{ locked: securePrepayLockAcquired }] }
    : { rows: [{ acquired: tryLockAcquired }] }));
  conn.schema = {
    hasTable: jest.fn(async (name) => hasTables[name] !== false),
    hasColumn: jest.fn(async (table, column) => hasColumns[`${table}.${column}`] !== false),
  };
  return conn;
}

const ALL_TABLES_PRESENT = {
  estimate_card_holds: true,
  appointment_card_requests: true,
  invoices: true,
  service_records: true,
  visit_completion_packet_items: true,
};

test('liveInvoice default false: a draft invoice with a balance is NOT covered (existing callers unchanged)', async () => {
  const conn = makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      invoices: [{ scheduled_service_id: 'v1', status: 'draft', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 100 }],
    },
  });
  const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }]);
  expect(covered.size).toBe(0);
});

test('liveInvoice true: the SAME draft invoice with a balance IS covered', async () => {
  const conn = makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      invoices: [{ scheduled_service_id: 'v1', status: 'draft', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 100 }],
      'invoices as inv': [],
      'visit_completion_packet_items as p': [],
    },
  });
  const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
  expect(covered.get('v1')).toMatch(/still open at the old price/);
});

test('liveInvoice true: a SENT invoice with a balance is covered too', async () => {
  const conn = makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      invoices: [{ scheduled_service_id: 'v1', status: 'sent', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 250 }],
      'invoices as inv': [],
      'visit_completion_packet_items as p': [],
    },
  });
  const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
  expect(covered.size).toBe(1);
  expect(covered.get('v1')).toMatch(/still open at the old price/);
});

test('a live $0 invoice is covered with liveInvoice (completion would reuse it at the old price), never without', async () => {
  const conn = makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      invoices: [{ scheduled_service_id: 'v1', status: 'draft', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 0 }],
      'invoices as inv': [],
      'visit_completion_packet_items as p': [],
    },
  });
  expect((await findBillingCoveredVisits(conn, [{ id: 'v1' }])).size).toBe(0);
  const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
  expect(covered.get('v1')).toMatch(/still open at the old price/);
});

test('an invoice fully paid by account credit (status prepaid, credit_applied) blocks REGARDLESS of liveInvoice — already existing behavior', async () => {
  const conn = makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      invoices: [{ scheduled_service_id: 'v1', status: 'prepaid', credit_applied: 90, line_items: '[]', stripe_payment_intent_id: null, total: 90 }],
      'invoices as inv': [],
      'visit_completion_packet_items as p': [],
    },
  });
  const withoutOption = await findBillingCoveredVisits(conn, [{ id: 'v1' }]);
  expect(withoutOption.get('v1')).toMatch(/money on it/);
  const withOption = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
  expect(withOption.get('v1')).toMatch(/money on it/);
});

test('a PARTIALLY credit-applied sent invoice (credit_applied > 0, still owes the rest) blocks regardless of liveInvoice', async () => {
  const conn = makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      invoices: [{ scheduled_service_id: 'v1', status: 'sent', credit_applied: 20, line_items: '[]', stripe_payment_intent_id: null, total: 100 }],
    },
  });
  const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }]);
  expect(covered.get('v1')).toMatch(/credit already applied/);
});

test('liveInvoice true: an invoice linked ONLY by service_record_id (no invoices.scheduled_service_id) is covered', async () => {
  const conn = makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      invoices: [],
      'invoices as inv': [{ scheduled_service_id: 'v1', status: 'sent', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 180 }],
      'visit_completion_packet_items as p': [],
    },
  });
  const withOption = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
  expect(withOption.get('v1')).toMatch(/still open at the old price/);
  const withoutOption = await findBillingCoveredVisits(conn, [{ id: 'v1' }]);
  expect(withoutOption.size).toBe(0);
});

test('liveInvoice true: a combined-visit packet invoice (visit_completion_packet_items.invoice_id) covers its member visit', async () => {
  const conn = makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      invoices: [],
      'invoices as inv': [],
      'visit_completion_packet_items as p': [{ scheduled_service_id: 'v2', status: 'sent', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 300 }],
    },
  });
  const withOption = await findBillingCoveredVisits(conn, [{ id: 'v2' }], { liveInvoice: true });
  expect(withOption.get('v2')).toMatch(/still open at the old price/);
  const withoutOption = await findBillingCoveredVisits(conn, [{ id: 'v2' }]);
  expect(withoutOption.size).toBe(0);
});

test('a live card hold blocks regardless of liveInvoice (feeRails unaffected)', async () => {
  const conn = makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [{ scheduled_service_id: 'v1' }],
      appointment_card_requests: [],
      invoices: [],
    },
  });
  const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
  expect(covered.get('v1')).toMatch(/card for a late-cancel fee/);
});

test('void/refunded/cancelled invoices never cover, even with liveInvoice true', async () => {
  const conn = makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      // The direct query itself excludes these statuses outright — nothing
      // in NO_MONEY_HELD ever reaches the invoiced array to begin with.
      invoices: [],
      'invoices as inv': [],
      'visit_completion_packet_items as p': [],
    },
  });
  const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
  expect(covered.size).toBe(0);
});

test('no invoices/holds at all: never covered', async () => {
  const conn = makeConn({ hasTables: ALL_TABLES_PRESENT, byTable: {} });
  const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
  expect(covered.size).toBe(0);
});

// Indirect links (Codex r2 P1 on #5253) count under liveInvoice. A free
// re-service conversion uses the same option — no exemption for the direct
// invoice either (owner ruling 2026-09-28, #5253 r3).
describe('liveInvoice reaches direct and indirect invoices alike', () => {
  const fixture = (byInvoices) => makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      invoices: [],
      'invoices as inv': [],
      'visit_completion_packet_items as p': [],
      ...byInvoices,
    },
  });
  const unpaid = { status: 'draft', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 90 };

  test('a directly linked unpaid invoice blocks', async () => {
    const conn = fixture({ invoices: [{ scheduled_service_id: 'v1', ...unpaid }] });
    const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
    expect(covered.get('v1')).toMatch(/still open at the old price/);
  });

  test('an unpaid invoice linked only through the service record blocks', async () => {
    const conn = fixture({ 'invoices as inv': [{ scheduled_service_id: 'v1', ...unpaid }] });
    const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
    expect(covered.get('v1')).toMatch(/still open at the old price/);
  });

  test('a PAID invoice linked only through a combined packet blocks', async () => {
    const conn = fixture({ 'visit_completion_packet_items as p': [{ scheduled_service_id: 'v1', ...unpaid, status: 'paid' }] });
    const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
    expect(covered.get('v1')).toMatch(/money on it/);
  });

  test('without liveInvoice the indirect links are not read (pre-existing callers unchanged)', async () => {
    const conn = fixture({ 'invoices as inv': [{ scheduled_service_id: 'v1', ...unpaid, status: 'paid' }] });
    expect((await findBillingCoveredVisits(conn, [{ id: 'v1' }])).size).toBe(0);
  });
});

// The combined first-application invoice (owner-ordered follow-up to
// #5253, Codex round 9): one more indirect link, read only under
// liveInvoice, same shape as the SR/packet reads.
describe('liveInvoice reaches the combined first-application invoice link', () => {
  // Simple rule (owner ruling 2026-09-29 on #5301): any non-void invoice on
  // the anchor (or the stamp itself) that bills THIS member by its own lines.
  // 'invoices' is the locked candidate read (the fake ignores its filters —
  // the SQL excludes void rows — so fixtures list only non-void candidates).
  const fixture = (candidates, { tryLockAcquired = true } = {}) => makeConn({
    hasTables: ALL_TABLES_PRESENT,
    tryLockAcquired,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      invoices: candidates,
      'invoices as inv': [],
      'visit_completion_packet_items as p': [],
      'scheduled_services as ss': [{ member_id: 'v2', stamp_id: 'inv1', anchor_id: 'anchor' }],
    },
  });
  const inv = (id, lines, status = 'draft') => ({
    id, status, scheduled_service_id: 'anchor', credit_applied: 0, stripe_payment_intent_id: null, total: 400,
    line_items: JSON.stringify(lines),
  });
  const anchorLine = { client_id: 'scheduled_anchor_primary', description: 'Pest Control', quantity: 1, unit_price: 200, amount: 200 };
  const memberLine = { client_id: 'scheduled_v2_primary', description: 'Lawn Care', quantity: 1, unit_price: 200, amount: 200 };
  const aggregateLine = { description: 'First service application', quantity: 1, unit_price: 400, amount: 400 };

  test('the live stamp blocks its member', async () => {
    const covered = await findBillingCoveredVisits(fixture([inv('inv1', [aggregateLine])]), [{ id: 'v2' }], { liveInvoice: true });
    expect(covered.get('v2')).toMatch(/combined first-application invoice/);
  });

  test('a PAID stamp blocks with the generic "money on it" reason', async () => {
    const covered = await findBillingCoveredVisits(fixture([inv('inv1', [aggregateLine], 'paid')]), [{ id: 'v2' }], { liveInvoice: true });
    expect(covered.get('v2')).toMatch(/money on it/);
  });

  test('no non-void invoice on the anchor: nothing blocks', async () => {
    const covered = await findBillingCoveredVisits(fixture([]), [{ id: 'v2' }], { liveInvoice: true });
    expect(covered.has('v2')).toBe(false);
  });

  test("an anchor invoice billing only the anchor doesn't block the member", async () => {
    const covered = await findBillingCoveredVisits(fixture([inv('inv9', [anchorLine])]), [{ id: 'v2' }], { liveInvoice: true });
    expect(covered.has('v2')).toBe(false);
  });

  test("ANY anchor invoice carrying the member's own line blocks — even beside an anchor-only one", async () => {
    const covered = await findBillingCoveredVisits(fixture([inv('inv8', [anchorLine]), inv('inv9', [anchorLine, memberLine])]), [{ id: 'v2' }], { liveInvoice: true });
    expect(covered.get('v2')).toMatch(/combined first-application invoice/);
  });

  test('an unitemized first-application invoice on the anchor blocks every member', async () => {
    const covered = await findBillingCoveredVisits(fixture([inv('inv9', [aggregateLine])]), [{ id: 'v2' }], { liveInvoice: true });
    expect(covered.get('v2')).toMatch(/combined first-application invoice/);
  });

  test("an unrelated unitemized anchor invoice (a repair) doesn't block the member", async () => {
    const covered = await findBillingCoveredVisits(fixture([inv('inv9', [{ description: 'Door sweep repair', quantity: 1, unit_price: 40, amount: 40 }])]), [{ id: 'v2' }], { liveInvoice: true });
    expect(covered.has('v2')).toBe(false);
  });

  test("the anchor's mint lock held elsewhere maps to VISIT_BUSY_RETRY", async () => {
    await expect(findBillingCoveredVisits(fixture([], { tryLockAcquired: false }), [{ id: 'v2' }], { liveInvoice: true }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_BUSY_RETRY' });
  });

  test('a locked candidate invoice (55P03) maps to VISIT_BUSY_RETRY, never a raw lock error', async () => {
    const base = fixture([inv('inv1', [aggregateLine])]);
    const wrapped = (table) => {
      const q = base(table);
      if (table === 'invoices') q.noWait = jest.fn(() => { const e = new Error('lock'); e.code = '55P03'; q.then = (res, rej) => Promise.reject(e).then(res, rej); return q; });
      return q;
    };
    wrapped.schema = base.schema;
    wrapped.raw = base.raw;
    await expect(findBillingCoveredVisits(wrapped, [{ id: 'v2' }], { liveInvoice: true }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_BUSY_RETRY' });
  });

  test('without liveInvoice the combined first-application link is not read', async () => {
    const covered = await findBillingCoveredVisits(fixture([inv('inv1', [aggregateLine])]), [{ id: 'v2' }]);
    expect(covered.size).toBe(0);
  });
});

// The /secure card-confirmation page's unpaid annual-prepay pick (owner
// ruling 2026-09-29, "secure prepay coverage rail"): a payment_pending term
// with a still-open prepay invoice, decided through the SAME canonical
// predicates payment activation uses (annual-prepay-renewals.js's
// coverageRowsForTerm — genuinely exercised here, unmocked, against the fake
// conn's real `whereBetween` filter), never a hand-built date/service-type
// window of this route's own.
describe('findBillingCoveredVisits: the /secure payment_pending prepay rail', () => {
  const TERM_TABLE = 'annual_prepay_terms as t';
  // The rail projects first activation "as if paid today" (the late-payment
  // window slide), so the clock is pinned to the terms' start: no lag unless
  // a test moves it. Only Date is faked — timers/microtasks stay real.
  const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'];
  const pinToday = (iso) => jest.useFakeTimers({ now: new Date(iso), doNotFake: REAL_TIMERS });
  beforeEach(() => pinToday('2026-01-01T17:00:00Z'));
  afterEach(() => jest.useRealTimers());
  const term = (overrides = {}) => ({
    id: 't1',
    customer_id: 'c1',
    status: 'payment_pending',
    term_start: '2026-01-01',
    term_end: '2026-12-31',
    coverage_service_type: 'Quarterly Pest Control Service',
    coverage_visit_count: 1,
    renewed_from_term_id: null,
    ...overrides,
  });
  const visit = (overrides = {}) => ({
    id: 'v1',
    customer_id: 'c1',
    service_type: 'Quarterly Pest Control Service',
    status: 'pending',
    scheduled_date: '2026-03-15',
    is_recurring: false,
    recurring_pattern: null,
    recurring_parent_id: null,
    source_estimate_id: null,
    property_id: null,
    service_id: null,
    service_key_snapshot: null,
    annual_prepay_term_id: null,
    prepaid_amount: null,
    prepaid_method: null,
    is_callback: false,
    ...overrides,
  });
  const fixture = ({ visits = [], terms = [term()], ...connOpts } = {}) => makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      invoices: [],
      'invoices as inv': [],
      'visit_completion_packet_items as p': [],
      scheduled_services: visits,
      [TERM_TABLE]: terms,
    },
    ...connOpts,
  });

  // findBillingCoveredVisits reads this rail straight off the CALLER'S own
  // visit row (no query of its own — see securePendingPrepayCoverageReasons'
  // header comment), so every test below passes the same full `visit()` row
  // both as the fixture AND as the `visits` argument, exactly like each of
  // the three real callers (the price guard's priceGuardRow, the conversion
  // siblings, the 'following' guard rows) now does.
  test('a visit that matches the pending term\'s coverage blocks the reprice', async () => {
    const v1 = visit();
    const conn = fixture({ visits: [v1] });
    const covered = await findBillingCoveredVisits(conn, [v1], { liveInvoice: true });
    expect(covered.get('v1')).toMatch(/card-confirmation page/);
  });

  test('a different service type is outside canonical coverage and does not block', async () => {
    const v1 = visit({ service_type: 'Lawn Care' });
    const conn = fixture({ visits: [v1] });
    const covered = await findBillingCoveredVisits(conn, [v1], { liveInvoice: true });
    expect(covered.has('v1')).toBe(false);
  });

  test('a visit beyond the term\'s sold visit count does not block', async () => {
    // Two matching, in-window visits; the term sold only 1. coverageRowsForTerm
    // keeps the EARLIEST (v1) and drops the later one (v2) — same slicing the
    // canonical function applies for activation itself.
    const v1 = visit({ id: 'v1', scheduled_date: '2026-03-15' });
    const v2 = visit({ id: 'v2', scheduled_date: '2026-06-15' });
    const conn = fixture({ visits: [v1, v2] });
    const covered = await findBillingCoveredVisits(conn, [v2], { liveInvoice: true });
    expect(covered.has('v2')).toBe(false);
    // Sanity: the SAME term genuinely covers v1 (proves the slicing, rather
    // than a mismatch, is why v2 was excluded).
    const coveredV1 = await findBillingCoveredVisits(conn, [v1], { liveInvoice: true });
    expect(coveredV1.get('v1')).toMatch(/card-confirmation page/);
  });

  test('a visit outside the term\'s window does not block', async () => {
    const v1 = visit({ scheduled_date: '2027-06-01' });
    const conn = fixture({ visits: [v1] });
    const covered = await findBillingCoveredVisits(conn, [v1], { liveInvoice: true });
    expect(covered.has('v1')).toBe(false);
  });

  test('a term no longer payment_pending (paid) does not block through this rail', async () => {
    // Convention matches the invoice-status tests above: the fixture
    // represents what the real status filter (t.status = 'payment_pending')
    // already excludes, so a paid term simply never appears here.
    const v1 = visit();
    const conn = fixture({ visits: [v1], terms: [] });
    const covered = await findBillingCoveredVisits(conn, [v1], { liveInvoice: true });
    expect(covered.has('v1')).toBe(false);
  });

  test('a date moved INTO coverage in the same save blocks (the proposed, not the stored, date)', async () => {
    // Stored OUTSIDE the term window; the save proposes a date INSIDE it —
    // _proposed is how admin-schedule.js's update-details handler
    // threads the save's coverage columns through (Codex requirement 3).
    const v1 = visit({ scheduled_date: '2027-01-10' });
    const conn = fixture({ visits: [v1] });
    const storedOnly = await findBillingCoveredVisits(conn, [v1], { liveInvoice: true });
    expect(storedOnly.has('v1')).toBe(false);
    const covered = await findBillingCoveredVisits(
      conn,
      [{ ...v1, _proposed: { scheduled_date: '2026-03-15' } }],
      { liveInvoice: true },
    );
    expect(covered.get('v1')).toMatch(/card-confirmation page/);
  });

  test('a same-day start time moved EARLIER in the same save takes the sold slot (the proposed, not the stored, start)', async () => {
    // One sold slot, two same-day visits: v2 (09:00) stored ahead of v1
    // (10:00). The save moves v1 to 08:00 — _proposed carries
    // updates.window_start, so v1 competes at its final position.
    const v1 = visit({ id: 'v1', scheduled_date: '2026-03-15', window_start: '10:00:00' });
    const v2 = visit({ id: 'v2', scheduled_date: '2026-03-15', window_start: '09:00:00' });
    const conn = fixture({ visits: [v2, v1] });
    const storedOnly = await findBillingCoveredVisits(conn, [v1], { liveInvoice: true });
    expect(storedOnly.has('v1')).toBe(false);
    const covered = await findBillingCoveredVisits(
      conn,
      [{ ...v1, _proposed: { window_start: '08:00:00' } }],
      { liveInvoice: true },
    );
    expect(covered.get('v1')).toMatch(/card-confirmation page/);
  });

  test('a visit moved INTO the window keeps its start time when competing for a same-day slot', async () => {
    // v1 stored outside the window (so no DB row to recover window_start
    // from); moved onto v2's day at 08:00, ahead of v2's 09:00.
    const v1 = visit({ id: 'v1', scheduled_date: '2027-01-10', window_start: '08:00:00' });
    const v2 = visit({ id: 'v2', scheduled_date: '2026-03-15', window_start: '09:00:00' });
    const conn = fixture({ visits: [v2] });
    const covered = await findBillingCoveredVisits(
      conn,
      [{ ...v1, _proposed: { scheduled_date: '2026-03-15' } }],
      { liveInvoice: true },
    );
    expect(covered.get('v1')).toMatch(/card-confirmation page/);
  });

  test('a service change INTO the covered family in the same save blocks (the proposed, not the stored, service)', async () => {
    const v1 = visit({ service_type: 'Lawn Care' });
    const conn = fixture({ visits: [v1] });
    const storedOnly = await findBillingCoveredVisits(conn, [v1], { liveInvoice: true });
    expect(storedOnly.has('v1')).toBe(false);
    const covered = await findBillingCoveredVisits(
      conn,
      [{ ...v1, _proposed: { service_type: 'Quarterly Pest Control Service' } }],
      { liveInvoice: true },
    );
    expect(covered.get('v1')).toMatch(/card-confirmation page/);
  });

  test('a service change OUT of the covered family in the same save does not block', async () => {
    const v1 = visit();
    const conn = fixture({ visits: [v1] });
    const covered = await findBillingCoveredVisits(
      conn,
      [{ ...v1, _proposed: { service_type: 'Lawn Care' } }],
      { liveInvoice: true },
    );
    expect(covered.has('v1')).toBe(false);
  });

  test('a late payment\'s window slide is projected as if paid today (Fable P2 on #5387)', async () => {
    // Stored window ends 2026-12-31; paid "today" 2026-03-01 slides the end
    // by the same 59-day lag first activation applies → 2027-02-28.
    pinToday('2026-03-01T17:00:00Z');
    const v1 = visit({ scheduled_date: '2027-01-10' });
    const conn = fixture({ visits: [v1] });
    const covered = await findBillingCoveredVisits(conn, [v1], { liveInvoice: true });
    expect(covered.get('v1')).toMatch(/card-confirmation page/);
  });

  test('no slide on the stored window when paid on the start day', async () => {
    const v1 = visit({ scheduled_date: '2027-01-10' });
    const conn = fixture({ visits: [v1] });
    const covered = await findBillingCoveredVisits(conn, [v1], { liveInvoice: true });
    expect(covered.has('v1')).toBe(false);
  });

  test('an active term with no linked visit yet (mid- or failed activation) still blocks (Fable P2 on #5387)', async () => {
    // The fixture stands in for the SQL filter (pending OR active with no
    // linked row); this pins that the rail judges such a term the same way.
    const v1 = visit();
    const conn = fixture({ visits: [v1], terms: [term({ status: 'active' })] });
    const covered = await findBillingCoveredVisits(conn, [v1], { liveInvoice: true });
    expect(covered.get('v1')).toMatch(/annual prepay paid at the old price/);
  });

  test('every visit in one save is judged in ONE pass: a sibling entering coverage takes the slot the edited visit vacates (Codex r2 P1 on #5387)', async () => {
    // One sold slot. v1 (edited) is stored in-window and moves OUT; v2 is
    // stored as Lawn Care and is propagated INTO the covered service.
    const v1 = visit({ id: 'v1', scheduled_date: '2026-03-15' });
    const v2 = visit({ id: 'v2', scheduled_date: '2026-06-15', service_type: 'Lawn Care' });
    const conn = fixture({ visits: [v1, v2] });
    const covered = await findBillingCoveredVisits(conn, [
      { ...v1, _proposed: { scheduled_date: '2027-06-01' } },
      { ...v2, _proposed: { service_type: 'Quarterly Pest Control Service' } },
    ], { liveInvoice: true });
    expect(covered.has('v1')).toBe(false);
    expect(covered.get('v2')).toMatch(/card-confirmation page/);
  });

  test('an ACTIVE term that already has linked visits is judged on its stored window (no first-activation slide)', async () => {
    pinToday('2026-03-01T17:00:00Z');
    const v1 = visit({ scheduled_date: '2027-01-10' });
    const conn = fixture({ visits: [v1], terms: [term({ status: 'active', has_linked_visit: true })] });
    const covered = await findBillingCoveredVisits(conn, [v1], { liveInvoice: true });
    expect(covered.has('v1')).toBe(false);
  });

  test('an ACTIVE term with old links still blocks an unstamped visit in its current coverage (repaid dispute; Codex r2 P1 on #5387)', async () => {
    const v1 = visit();
    const conn = fixture({ visits: [v1], terms: [term({ status: 'active', has_linked_visit: true })] });
    const covered = await findBillingCoveredVisits(conn, [v1], { liveInvoice: true });
    expect(covered.get('v1')).toMatch(/annual prepay paid at the old price/);
  });

  test('contention on the customer\'s annual-prepay advisory namespace maps to VISIT_BUSY_RETRY', async () => {
    const v1 = visit();
    const conn = fixture({ visits: [v1], securePrepayLockAcquired: false });
    await expect(findBillingCoveredVisits(conn, [v1], { liveInvoice: true }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_BUSY_RETRY' });
  });

  test('without liveInvoice this rail is never read', async () => {
    const v1 = visit();
    const conn = fixture({ visits: [v1] });
    const covered = await findBillingCoveredVisits(conn, [v1]);
    expect(covered.size).toBe(0);
  });
});

// Estimate-scoped commitments (Codex r8 P1 on #5253): money keyed on the
// estimate, not the visit, still refuses a re-price.
describe('findEstimateScopedCommitment', () => {
  const { findEstimateScopedCommitment } = require('../routes/admin-schedule');
  const conn = (byTable) => {
    const c = makeConn({ byTable });
    c.raw = jest.fn(async () => ({ rows: [] }));
    return c;
  };

  test('no source estimate: nothing to check', async () => {
    expect(await findEstimateScopedCommitment(conn({}), null)).toBeNull();
  });

  test('a received, unapplied deposit refuses — read under the deposit-ledger lock', async () => {
    const c = conn({ estimate_deposits: [{ id: 'd1', amount: 49, credited_amount: 0, refunded_amount: 0 }] });
    expect(await findEstimateScopedCommitment(c, 'est-1')).toMatch(/estimate deposit/);
    expect(c.raw).toHaveBeenCalledWith(expect.stringMatching(/pg_advisory_xact_lock/), expect.arrayContaining(['est-1']));
  });

  test('a fully credited deposit does not refuse', async () => {
    const c = conn({ estimate_deposits: [{ id: 'd1', amount: 49, credited_amount: 49, refunded_amount: 0 }] });
    expect(await findEstimateScopedCommitment(c, 'est-1')).toBeNull();
  });

  test('a payment_pending annual-prepay term with a live invoice refuses', async () => {
    const c = conn({ 'annual_prepay_terms as t': [{ id: 't1' }] });
    expect(await findEstimateScopedCommitment(c, 'est-1')).toMatch(/annual prepay invoice/);
  });
});
