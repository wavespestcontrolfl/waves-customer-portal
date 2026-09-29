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

const { findBillingCoveredVisits } = require('../routes/admin-schedule');

// A chainable fake query builder that resolves (thenable) to `rows` — every
// filter/join method returns itself so any call shape findBillingCoveredVisits
// issues (whereIn/whereNotIn/select/join) is accepted, and `first`/`pluck`
// resolve straight from `rows`.
function fakeQuery(rows) {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull', 'join', 'leftJoin', 'joinRaw', 'orderBy', 'forUpdate', 'noWait', 'select']) {
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
// `hasColumns` keys are `table.column` — default present (matches
// `hasTables`' default-true shape) so existing fixtures that never mention
// the new prepay/first-application columns keep reading them as available.
function makeConn({ hasTables = {}, hasColumns = {}, byTable = {} } = {}) {
  const conn = (table) => fakeQuery(byTable[table] || []);
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

// /secure annual-prepay pick and the combined first-application invoice
// (owner-ordered follow-up to #5253, Codex round 9): two more indirect
// links, read only under liveInvoice, same shape as the SR/packet reads.
describe('liveInvoice reaches the /secure annual-prepay invoice link', () => {
  const fixture = (rows) => makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      invoices: [],
      'invoices as inv': [],
      'visit_completion_packet_items as p': [],
      'appointment_card_requests as acr': rows,
      'scheduled_services as ss': [],
    },
  });

  test('an open /secure prepay invoice blocks with the prepay-specific reason', async () => {
    const conn = fixture([{ scheduled_service_id: 'v1', status: 'sent', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 900 }]);
    const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
    expect(covered.get('v1')).toMatch(/annual prepay invoice from the card-confirmation page/);
  });

  test('a PAID /secure prepay invoice blocks with the generic "money on it" reason', async () => {
    const conn = fixture([{ scheduled_service_id: 'v1', status: 'paid', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 900 }]);
    const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
    expect(covered.get('v1')).toMatch(/money on it/);
  });

  test('a void /secure prepay invoice does not block (the query itself excludes it)', async () => {
    const conn = fixture([]);
    const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }], { liveInvoice: true });
    expect(covered.size).toBe(0);
  });

  test('without liveInvoice the /secure prepay link is not read', async () => {
    const conn = fixture([{ scheduled_service_id: 'v1', status: 'sent', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 900 }]);
    const covered = await findBillingCoveredVisits(conn, [{ id: 'v1' }]);
    expect(covered.size).toBe(0);
  });

  // The series match and the payment_pending filter live in SQL (the fake
  // builder can't evaluate a join), so they're pinned against the source.
  test('the prepay read matches the whole series in SQL and only a payment_pending term (Codex r1 P1 on #5301)', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/admin-schedule.js'), 'utf8');
    expect(src).toContain("JOIN scheduled_services AS tv ON COALESCE(tv.recurring_parent_id, tv.id) = COALESCE(rs.recurring_parent_id, rs.id) AND tv.scheduled_date BETWEEN apt.term_start AND apt.term_end");
    expect(src).toMatch(/\.join\('annual_prepay_terms as apt', 'apt\.id', 'acr\.annual_prepay_term_id'\)/);
    expect(src).toMatch(/\.where\('apt\.status', 'payment_pending'\)/);
  });
});

describe('liveInvoice reaches the combined first-application invoice link', () => {
  // `anchorInvoices` feeds the plain 'invoices' key, which loadGoverningInvoice
  // reads for a replacement when the stamp is terminal (the direct
  // scheduled_service_id read sees them too, but on the ANCHOR's id).
  const fixture = (rows, anchorInvoices = []) => makeConn({
    hasTables: ALL_TABLES_PRESENT,
    byTable: {
      estimate_card_holds: [],
      appointment_card_requests: [],
      invoices: anchorInvoices,
      'invoices as inv': [],
      'visit_completion_packet_items as p': [],
      'appointment_card_requests as acr': [],
      'scheduled_services as ss': rows,
    },
  });
  const stamp = (status) => ({
    member_id: 'v2', id: 'inv1', status, scheduled_service_id: 'anchor',
    credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 400,
  });
  const replacement = {
    id: 'inv2', status: 'draft', scheduled_service_id: 'anchor', total: 400, created_at: '2026-09-20T00:00:00Z',
    line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 400, amount: 400 }]),
  };

  test('an open combined first-application invoice blocks the member visit', async () => {
    const covered = await findBillingCoveredVisits(fixture([stamp('draft')]), [{ id: 'v2' }], { liveInvoice: true });
    expect(covered.get('v2')).toMatch(/combined first-application invoice/);
  });

  test('a PAID combined first-application invoice blocks with the generic "money on it" reason', async () => {
    const covered = await findBillingCoveredVisits(fixture([stamp('paid')]), [{ id: 'v2' }], { liveInvoice: true });
    expect(covered.get('v2')).toMatch(/money on it/);
  });

  test('a void stamp with no replacement on the anchor does not block', async () => {
    const covered = await findBillingCoveredVisits(fixture([stamp('void')]), [{ id: 'v2' }], { liveInvoice: true });
    expect(covered.has('v2')).toBe(false);
  });

  // Codex r2 P1 on #5301: void-and-reissue on the anchor.
  test('a void stamp REISSUED on the anchor blocks through the live replacement', async () => {
    const covered = await findBillingCoveredVisits(fixture([stamp('void')], [replacement]), [{ id: 'v2' }], { liveInvoice: true });
    expect(covered.get('v2')).toMatch(/combined first-application invoice/);
  });

  test('a locked stamped invoice (55P03) maps to VISIT_BUSY_RETRY, never a raw lock error', async () => {
    const conn = fixture([stamp('draft')]);
    const base = conn;
    const wrapped = (table) => {
      const q = base(table);
      if (table === 'invoices') q.noWait = jest.fn(() => { const e = new Error('lock'); e.code = '55P03'; q.then = (res, rej) => Promise.reject(e).then(res, rej); return q; });
      return q;
    };
    wrapped.schema = base.schema;
    await expect(findBillingCoveredVisits(wrapped, [{ id: 'v2' }], { liveInvoice: true }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_BUSY_RETRY' });
  });

  test('without liveInvoice the combined first-application link is not read', async () => {
    const covered = await findBillingCoveredVisits(fixture([stamp('draft')]), [{ id: 'v2' }]);
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
