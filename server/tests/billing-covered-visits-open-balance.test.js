/**
 * findBillingCoveredVisits' `openBalance` option (owner ruling 2026-09-28,
 * "the re-price block" — server/routes/admin-schedule.js). Default false
 * keeps the 3 pre-existing callers (the plan-length trim, the dispatch
 * series-cancel fee rails, and the price/service sibling propagation before
 * this option was threaded onto it) byte-identical: a draft/sent invoice
 * with nobody having taken any money yet was never "money already taken"
 * for THOSE questions. `openBalance: true` (the repricing guard) answers a
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

const { findBillingCoveredVisits } = require('../routes/admin-schedule');

// A chainable fake query builder that resolves (thenable) to `rows` — every
// filter/join method returns itself so any call shape findBillingCoveredVisits
// issues (whereIn/whereNotIn/select/join) is accepted, and `first`/`pluck`
// resolve straight from `rows`.
function fakeQuery(rows) {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'join', 'leftJoin', 'orderBy', 'select']) {
    q[m] = jest.fn(() => q);
  }
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
function makeConn({ hasTables = {}, byTable = {} } = {}) {
  const conn = (table) => fakeQuery(byTable[table] || []);
  conn.schema = { hasTable: jest.fn(async (name) => hasTables[name] !== false) };
  return conn;
}

const ALL_TABLES_PRESENT = {
  estimate_card_holds: true,
  appointment_card_requests: true,
  invoices: true,
  service_records: true,
  visit_completion_packet_items: true,
};

test('openBalance default false: a draft invoice with a balance is NOT covered (existing callers unchanged)', async () => {
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

test('openBalance true: the SAME draft invoice with a balance IS covered', async () => {
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
  const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { openBalance: true });
  expect(covered.get('v1')).toMatch(/open invoice/);
});

test('openBalance true: a SENT invoice with a balance is covered too', async () => {
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
  const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { openBalance: true });
  expect(covered.size).toBe(1);
  expect(covered.get('v1')).toMatch(/balance/);
});

test('a $0 invoice (no balance due) is never covered, openBalance true or false', async () => {
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
  expect((await findBillingCoveredVisits(conn, [{ id: 'v1' }], { openBalance: true })).size).toBe(0);
});

test('an invoice fully paid by account credit (status prepaid, credit_applied) blocks REGARDLESS of openBalance — already existing behavior', async () => {
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
  const withOption = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { openBalance: true });
  expect(withOption.get('v1')).toMatch(/money on it/);
});

test('a PARTIALLY credit-applied sent invoice (credit_applied > 0, still owes the rest) blocks regardless of openBalance', async () => {
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

test('openBalance true: an invoice linked ONLY by service_record_id (no invoices.scheduled_service_id) is covered', async () => {
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
  const withOption = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { openBalance: true });
  expect(withOption.get('v1')).toMatch(/balance/);
  const withoutOption = await findBillingCoveredVisits(conn, [{ id: 'v1' }]);
  expect(withoutOption.size).toBe(0);
});

test('openBalance true: a combined-visit packet invoice (visit_completion_packet_items.invoice_id) covers its member visit', async () => {
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
  const withOption = await findBillingCoveredVisits(conn, [{ id: 'v2' }], { openBalance: true });
  expect(withOption.get('v2')).toMatch(/balance/);
  const withoutOption = await findBillingCoveredVisits(conn, [{ id: 'v2' }]);
  expect(withoutOption.size).toBe(0);
});

test('a live card hold blocks regardless of openBalance (feeRails unaffected)', async () => {
  const conn = makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [{ scheduled_service_id: 'v1' }],
      appointment_card_requests: [],
      invoices: [],
    },
  });
  const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { openBalance: true });
  expect(covered.get('v1')).toMatch(/card for a late-cancel fee/);
});

test('void/refunded/cancelled invoices never cover, even with openBalance true', async () => {
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
  const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { openBalance: true });
  expect(covered.size).toBe(0);
});

test('no invoices/holds at all: never covered', async () => {
  const conn = makeConn({ hasTables: ALL_TABLES_PRESENT, byTable: {} });
  const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { openBalance: true });
  expect(covered.size).toBe(0);
});
