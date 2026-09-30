/**
 * propagatePriceServiceToFollowingSiblings (server/routes/admin-schedule.js)
 * — the sibling side of the re-price block (owner ruling 2026-09-28, B.3/C):
 *   - B.3: its findBillingCoveredVisits call now passes `{ liveInvoice: true }`,
 *     so a sibling sitting on an unpaid draft/sent invoice refuses the
 *     'following' propagation, not just one already holding taken money.
 *   - C: a sibling whose price this loop is about to rewrite takes that
 *     sibling's invoice-mint lock — NON-BLOCKING (pre-push audit P1: the
 *     edited visit's own mint lock is already held when this runs, so a
 *     blocking wait here risks a real ABBA deadlock against a second
 *     overlapping 'following' save) — on the rows targetQuery's own locked read returns
 *     (`.forUpdate()`), in a stable (sorted) id order; any sibling whose
 *     try-lock fails refuses the whole save (409 VISIT_BUSY_RETRY).
 *
 * Direct unit tests against the exported function with a minimal fake
 * knex-shaped `conn` — no HTTP route, no transaction. `tryAcquireScheduledInvoiceMintLock`
 * runs for REAL (through `conn.raw`, faked below to answer like Postgres'
 * `pg_try_advisory_xact_lock`) rather than being replaced by a mock, so
 * these tests also exercise its actual boolean-parsing contract.
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
    tryAcquireScheduledInvoiceMintLock: jest.fn((...a) => actual.tryAcquireScheduledInvoiceMintLock(...a)),
  };
});

// Only reachable via router._test — this helper has no top-level
// module.exports.<name> line of its own (unlike findBillingCoveredVisits).
const { propagatePriceServiceToFollowingSiblings } = require('../routes/admin-schedule')._test;
const { tryAcquireScheduledInvoiceMintLock } = require('../services/scheduled-invoice-mint');

// The single `scheduled_services` `.forUpdate()` spy — shared across every
// chain the fake `conn` hands out for that table, so its invocationCallOrder
// is comparable against the mint-lock mock's (jest's invocationCallOrder is
// one counter shared by every mock function in the environment).
const rowForUpdateSpy = jest.fn();
const siblingUpdateSpy = jest.fn();

// `byTable` gives a fixed result set per exact table string (aliases
// included, matching propagatePriceServiceToFollowingSiblings' own call
// sites). `scheduled_services` needs two different shapes from two
// different call sites in the SAME function (an unlocked `.pluck('id')`
// candidate read, then the locked `.forUpdate()` targets read) — both ride
// the one `candidateIds`/`targets` pair below since every real call in this
// function targets the same sibling population. `denyTryLockFor` names ids
// whose `conn.raw` try-lock answers `acquired: false` (Postgres semantics:
// the lock is already held by another session/transaction).
function makeConn({
  candidateIds = [], targets = [], hasTables = {}, byTable = {}, denyTryLockFor = new Set(),
} = {}) {
  const conn = (table) => {
    if (table === 'scheduled_services') {
      const c = {};
      for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNot', 'orderBy']) c[m] = jest.fn(() => c);
      c.modify = jest.fn((cb) => { cb(c); return c; });
      c.forUpdate = jest.fn((...a) => { rowForUpdateSpy(...a); return c; });
      c.noWait = jest.fn(() => c);
      c.pluck = jest.fn(async () => candidateIds);
      c.update = jest.fn(async (...a) => { siblingUpdateSpy(...a); return 1; });
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
  // Mirrors `pg_try_advisory_xact_lock(...) AS acquired` — the bound id is
  // the second parameter (tryAcquireScheduledInvoiceMintLock's own call
  // shape: [namespace, String(scheduledServiceId)]).
  conn.raw = jest.fn(async (_sql, params) => {
    const id = params?.[1];
    return { rows: [{ acquired: !denyTryLockFor.has(id) }] };
  });
  return conn;
}

const ALL_TABLES = {
  invoices: true, service_records: true, visit_completion_packet_items: true,
  estimate_card_holds: true, appointment_card_requests: true, scheduled_service_addons: true,
};

beforeEach(() => {
  rowForUpdateSpy.mockClear();
  siblingUpdateSpy.mockClear();
  tryAcquireScheduledInvoiceMintLock.mockClear();
});

test('a sibling with an OPEN (draft) invoice linked only via its service record refuses the propagation (B.3 — liveInvoice)', async () => {
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

test('sibling mint locks are tried on the rows the locked targetQuery returns, sorted by id', async () => {
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
  expect(tryAcquireScheduledInvoiceMintLock).toHaveBeenCalledTimes(2);
  // Sorted order: sib-a before sib-b.
  expect(tryAcquireScheduledInvoiceMintLock.mock.calls[0][1]).toBe('sib-a');
  expect(tryAcquireScheduledInvoiceMintLock.mock.calls[1][1]).toBe('sib-b');
  // The tries follow the locked read (a try never waits, so this order
  // cannot deadlock) and come from its rows, not an unlocked pre-read.
  const firstMintOrder = tryAcquireScheduledInvoiceMintLock.mock.invocationCallOrder[0];
  const rowLockOrder = rowForUpdateSpy.mock.invocationCallOrder[0];
  expect(firstMintOrder).toBeGreaterThan(rowLockOrder);
});

test('a sibling that appears only in the locked read is still try-locked (pre-push audit P1)', async () => {
  const conn = makeConn({
    candidateIds: [],
    targets: [{ id: 'sib-new', scheduled_date: '2099-02-01', pre_service_brief_type: null }],
    hasTables: ALL_TABLES,
    byTable: {
      invoices: [], 'invoices as inv': [], 'visit_completion_packet_items as p': [],
      estimate_card_holds: [], appointment_card_requests: [], scheduled_service_addons: [],
    },
  });
  await propagatePriceServiceToFollowingSiblings(conn, {
    editedId: 'edited-1', editedRow: { id: 'edited-1' }, parentId: 'parent-1', fromDateStr: null,
    fields: { estimated_price: 200 }, serviceChanged: false, priceChanged: true, cols: { estimated_price: {} },
  });
  expect(tryAcquireScheduledInvoiceMintLock.mock.calls.map((c) => c[1])).toEqual(['sib-new']);
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
  expect(tryAcquireScheduledInvoiceMintLock).not.toHaveBeenCalled();
});

test('ABBA-safe refusal (pre-push audit P1): a sibling whose mint lock is already held elsewhere refuses the whole save, no sibling write', async () => {
  const conn = makeConn({
    candidateIds: ['sib-a', 'sib-b'],
    targets: [
      { id: 'sib-a', scheduled_date: '2099-02-01', pre_service_brief_type: null },
      { id: 'sib-b', scheduled_date: '2099-03-01', pre_service_brief_type: null },
    ],
    hasTables: ALL_TABLES,
    byTable: {
      invoices: [], 'invoices as inv': [], 'visit_completion_packet_items as p': [],
      estimate_card_holds: [], appointment_card_requests: [], scheduled_service_addons: [],
    },
    // sib-b's lock is already held by a concurrent transaction (e.g. a
    // second overlapping 'following' save, or a live invoice mint).
    denyTryLockFor: new Set(['sib-b']),
  });
  await expect(propagatePriceServiceToFollowingSiblings(conn, {
    editedId: 'edited-1', editedRow: { id: 'edited-1' }, parentId: 'parent-1', fromDateStr: null,
    fields: { estimated_price: 200 }, serviceChanged: false, priceChanged: true, cols: { estimated_price: {} },
  })).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_BUSY_RETRY' });
  // The try-lock never blocks — sib-a (tried first, sorted) succeeded,
  // sib-b refused, and no sibling UPDATE ran.
  expect(tryAcquireScheduledInvoiceMintLock).toHaveBeenCalledTimes(2);
  expect(siblingUpdateSpy).not.toHaveBeenCalled();
});

// A /secure card confirmation mid-finish ('completing') on a sibling is not
// durable yet — no money rail sees it — so the guard refuses with the same
// transient VISIT_BUSY_RETRY contract as the single-visit re-price guard
// (findCompletingCardRequestVisitId). Refused BEFORE any sibling write.
describe("'completing' card confirmation refusal", () => {
  const baseByTable = {
    invoices: [], 'invoices as inv': [], 'visit_completion_packet_items as p': [],
    estimate_card_holds: [], scheduled_service_addons: [],
  };
  const args = {
    editedId: 'edited-1', editedRow: { id: 'edited-1' }, parentId: 'parent-1', fromDateStr: null,
    fields: { estimated_price: 200 }, serviceChanged: false, priceChanged: true, cols: { estimated_price: {} },
  };
  // makeConn's generic table fake ignores where clauses, so the money-rail
  // read (status 'completed', frozen fee terms) would see these fixture rows
  // too. Route appointment_card_requests through a status-aware chain: the
  // rail's .select() gets nothing (no completed/charge-ready row exists),
  // the completing probe's .first() gets the rows matching its own
  // where({ status: 'completing' }) and whereIn(scheduled_service_id, ids).
  function withCardRequests(conn, rows) {
    const wrapped = (table) => {
      if (table !== 'appointment_card_requests') return conn(table);
      let status = null;
      let ids = null;
      const c = {};
      for (const m of ['whereNull', 'whereNotNull', 'whereNotIn', 'orderBy']) c[m] = jest.fn(() => c);
      c.whereIn = jest.fn((col, v) => { if (col === 'scheduled_service_id') ids = v; return c; });
      c.where = jest.fn((w, op, val) => { if (w && typeof w === 'object') status = w.status ?? status; else if (w === 'status') status = val ?? op; return c; });
      c.first = jest.fn(async () => rows.find((r) => r.status === status && (!ids || ids.includes(r.scheduled_service_id))) || null);
      c.select = jest.fn(async () => []);
      return c;
    };
    Object.assign(wrapped, conn);
    return wrapped;
  }
  const targets = [
    { id: 'sib-a', scheduled_date: '2099-02-01', pre_service_brief_type: null },
    { id: 'sib-b', scheduled_date: '2099-03-01', pre_service_brief_type: null },
  ];

  test('a sibling with a completing card request refuses the whole propagation with VISIT_BUSY_RETRY, no sibling write', async () => {
    const conn = withCardRequests(makeConn({
      candidateIds: ['sib-a', 'sib-b'],
      targets,
      hasTables: ALL_TABLES,
      byTable: baseByTable,
    }), [{ scheduled_service_id: 'sib-b', status: 'completing' }]);
    await expect(propagatePriceServiceToFollowingSiblings(conn, args))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_BUSY_RETRY' });
    expect(siblingUpdateSpy).not.toHaveBeenCalled();
  });

  test('the EDITED visit\'s own completing card request refuses too', async () => {
    const conn = withCardRequests(makeConn({
      candidateIds: ['sib-a', 'sib-b'],
      targets,
      hasTables: ALL_TABLES,
      byTable: baseByTable,
    }), [{ scheduled_service_id: 'edited-1', status: 'completing' }]);
    await expect(propagatePriceServiceToFollowingSiblings(conn, args))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_BUSY_RETRY' });
    expect(siblingUpdateSpy).not.toHaveBeenCalled();
  });

  test('a pending/completed (not completing) card request does not block the propagation', async () => {
    const conn = withCardRequests(makeConn({
      candidateIds: ['sib-a', 'sib-b'],
      targets,
      hasTables: ALL_TABLES,
      byTable: baseByTable,
    }), [{ scheduled_service_id: 'sib-a', status: 'pending' }]);
    const ids = await propagatePriceServiceToFollowingSiblings(conn, args);
    expect(ids.sort()).toEqual(['sib-a', 'sib-b']);
  });

  test('a schedule-only propagation never checks for a completing request', async () => {
    const conn = withCardRequests(makeConn({
      candidateIds: [],
      targets: [targets[0]],
      hasTables: ALL_TABLES,
      byTable: baseByTable,
    }), [{ scheduled_service_id: 'sib-a', status: 'completing' }]);
    await expect(propagatePriceServiceToFollowingSiblings(conn, {
      editedId: 'edited-1', editedRow: null, parentId: 'parent-1', fromDateStr: null,
      fields: { technician_id: 'tech-2' }, serviceChanged: false, priceChanged: false, cols: { technician_id: {} },
    })).resolves.toBeDefined();
  });
});
