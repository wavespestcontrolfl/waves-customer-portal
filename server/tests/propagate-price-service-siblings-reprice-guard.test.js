/**
 * propagatePriceServiceToFollowingSiblings (server/routes/admin-schedule.js)
 * — the sibling side of the re-price block (owner ruling 2026-09-28, B.3/C):
 *   - B.3: its findBillingCoveredVisits call now passes `{ openBalance: true }`,
 *     so a sibling sitting on an unpaid draft/sent invoice refuses the
 *     'following' propagation, not just one already holding taken money.
 *   - C: a sibling whose price this loop is about to rewrite takes that
 *     sibling's invoice-mint lock BEFORE the targetQuery's own row lock
 *     (`.forUpdate()`), in a stable (sorted) id order.
 *
 * Direct unit tests against the exported function with a minimal fake
 * knex-shaped `conn` — no HTTP route, no transaction.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (req, _res, next) => next(), requireAdmin: (req, _res, next) => next() };
});
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/scheduled-invoice-mint', () => {
  const actual = jest.requireActual('../services/scheduled-invoice-mint');
  return {
    ...actual,
    acquireScheduledInvoiceMintLock: jest.fn((...a) => actual.acquireScheduledInvoiceMintLock(...a)),
  };
});

// Only reachable via router._test — this helper has no top-level
// module.exports.<name> line of its own (unlike findBillingCoveredVisits).
const { propagatePriceServiceToFollowingSiblings } = require('../routes/admin-schedule')._test;
const { acquireScheduledInvoiceMintLock } = require('../services/scheduled-invoice-mint');

// The single `scheduled_services` `.forUpdate()` spy — shared across every
// chain the fake `conn` hands out for that table, so its invocationCallOrder
// is comparable against the mint-lock mock's (jest's invocationCallOrder is
// one counter shared by every mock function in the environment).
const rowForUpdateSpy = jest.fn();

// `byTable` gives a fixed result set per exact table string (aliases
// included, matching propagatePriceServiceToFollowingSiblings' own call
// sites). `scheduled_services` needs two different shapes from two
// different call sites in the SAME function (an unlocked `.pluck('id')`
// candidate read, then the locked `.forUpdate()` targets read) — both ride
// the one `candidateIds`/`targets` pair below since every real call in this
// function targets the same sibling population.
function makeConn({ candidateIds = [], targets = [], hasTables = {}, byTable = {} } = {}) {
  const conn = (table) => {
    if (table === 'scheduled_services') {
      const c = {};
      for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNot', 'orderBy']) c[m] = jest.fn(() => c);
      c.modify = jest.fn((cb) => { cb(c); return c; });
      c.forUpdate = jest.fn((...a) => { rowForUpdateSpy(...a); return c; });
      c.pluck = jest.fn(async () => candidateIds);
      c.update = jest.fn(async () => 1);
      c.then = (resolve, reject) => Promise.resolve(targets).then(resolve, reject);
      c.catch = (fn) => Promise.resolve(targets).catch(fn);
      return c;
    }
    // Generic per-table fixture (invoices / invoices as inv / visit_completion_packet_items as p / scheduled_service_addons / …).
    const rows = byTable[table] || [];
    const c = {};
    let lastEqWhere = null;
    for (const m of ['whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'join', 'orderBy', 'select']) c[m] = jest.fn(() => c);
    c.where = jest.fn((w) => { if (w && typeof w === 'object') lastEqWhere = w; return c; });
    c.first = jest.fn(async () => {
      if (!lastEqWhere) return rows[0] || null;
      return rows.find((r) => Object.entries(lastEqWhere).every(([k, v]) => r[k] === v)) || null;
    });
    c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    c.catch = (fn) => Promise.resolve(rows).catch(fn);
    return c;
  };
  conn.schema = {
    hasTable: jest.fn(async (name) => hasTables[name] !== false),
    hasColumn: jest.fn(async () => true),
  };
  conn.raw = jest.fn(async () => {});
  return conn;
}

const ALL_TABLES = {
  invoices: true, service_records: true, visit_completion_packet_items: true,
  estimate_card_holds: true, appointment_card_requests: true, scheduled_service_addons: true,
};

beforeEach(() => {
  rowForUpdateSpy.mockClear();
  acquireScheduledInvoiceMintLock.mockClear();
});

test('a sibling with an OPEN (draft) invoice linked only via its service record refuses the propagation (B.3 — openBalance)', async () => {
  const conn = makeConn({
    candidateIds: ['sib-1'],
    targets: [{ id: 'sib-1', scheduled_date: '2099-02-01', pre_service_brief_type: null }],
    hasTables: ALL_TABLES,
    byTable: {
      invoices: [], // no DIRECT link — the pre-existing "already has an invoice" probe (scheduled_service_id) sees nothing either
      'invoices as inv': [{ scheduled_service_id: 'sib-1', status: 'draft', credit_applied: 0, line_items: '[]', stripe_payment_intent_id: null, total: 80 }],
      'visit_completion_packet_items as p': [],
      estimate_card_holds: [], appointment_card_requests: [],
    },
  });
  await expect(propagatePriceServiceToFollowingSiblings(conn, {
    editedId: 'edited-1', editedRow: { id: 'edited-1' }, parentId: 'parent-1', fromDateStr: null,
    fields: { estimated_price: 200 }, serviceChanged: false, priceChanged: true, cols: { estimated_price: {} },
  })).rejects.toMatchObject({ statusCode: 409 });
});

test('sibling mint locks are acquired BEFORE the targetQuery row lock, sorted by id', async () => {
  const conn = makeConn({
    candidateIds: ['sib-b', 'sib-a'],
    targets: [
      { id: 'sib-a', scheduled_date: '2099-02-01', pre_service_brief_type: null },
      { id: 'sib-b', scheduled_date: '2099-03-01', pre_service_brief_type: null },
    ],
    hasTables: ALL_TABLES,
    byTable: {
      invoices: [], 'invoices as inv': [], 'visit_completion_packet_items as p': [],
      estimate_card_holds: [], appointment_card_requests: [], scheduled_service_addons: [],
    },
  });
  const ids = await propagatePriceServiceToFollowingSiblings(conn, {
    editedId: 'edited-1', editedRow: { id: 'edited-1' }, parentId: 'parent-1', fromDateStr: null,
    fields: { estimated_price: 200 }, serviceChanged: false, priceChanged: true, cols: { estimated_price: {} },
  });
  expect(ids.sort()).toEqual(['sib-a', 'sib-b']);
  expect(acquireScheduledInvoiceMintLock).toHaveBeenCalledTimes(2);
  // Sorted order: sib-a before sib-b.
  expect(acquireScheduledInvoiceMintLock.mock.calls[0][1]).toBe('sib-a');
  expect(acquireScheduledInvoiceMintLock.mock.calls[1][1]).toBe('sib-b');
  // Every mint-lock call precedes the (single, shared) row-lock spy's call.
  const lastMintOrder = acquireScheduledInvoiceMintLock.mock.invocationCallOrder[1];
  const rowLockOrder = rowForUpdateSpy.mock.invocationCallOrder[0];
  expect(lastMintOrder).toBeLessThan(rowLockOrder);
});

test('a schedule-only propagation (no price/service change) never touches the mint lock', async () => {
  const conn = makeConn({
    candidateIds: [],
    targets: [{ id: 'sib-1', scheduled_date: '2099-02-01', pre_service_brief_type: null }],
    hasTables: ALL_TABLES,
    byTable: { invoices: [], 'invoices as inv': [], 'visit_completion_packet_items as p': [] },
  });
  await propagatePriceServiceToFollowingSiblings(conn, {
    editedId: 'edited-1', editedRow: null, parentId: 'parent-1', fromDateStr: null,
    fields: { technician_id: 'tech-2' }, serviceChanged: false, priceChanged: false, cols: { technician_id: {} },
  });
  expect(acquireScheduledInvoiceMintLock).not.toHaveBeenCalled();
});
