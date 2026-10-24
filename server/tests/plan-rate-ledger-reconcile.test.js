/**
 * Nightly plan-rate ledger invariant reconcile (services/plan-rate-ledger-reconcile.js).
 *
 * Pins what the run may and may not do with a customer whose customer_plan_rates
 * lines no longer add up to the billed customers.monthly_rate:
 *   - gate off: nothing is read, written or raised (the database handle throws on any use);
 *   - only live customers (whereLiveCustomer: active, customer stage, not deleted) are scanned or touched;
 *   - a shortfall is parked in the 'unattributed' line (fresh insert, or ADDED to an existing
 *     line whose source and stamps stay as they were);
 *   - an overshoot only alerts: no line is deleted, shrunk or written;
 *   - one alert per distinct gap: a second run on the same gap raises no second alert;
 *   - every customer is judged again under rung 6 (customer-comms) taken BEFORE the customers row
 *     lock, and a gap that closed (or a customer that stopped being live) before the lock is left alone;
 *   - customers.monthly_rate is never written (the fake refuses any write to customers);
 *   - an alert that cannot be written rolls its repair back, other customers still run, the run fails;
 *   - at most MAX_NEW_ALERTS_PER_RUN new alerts a run, the rest untouched until the next run;
 *   - alert episodes: an overshoot alert closes itself once its gap no longer stands and rings
 *     again if the same gap comes back; a shortfall alert is never closed by the job;
 *     ALERT_EPISODES killed = the plain deduped alert, no close pass.
 * The real SQL (the scan, the ON CONFLICT merge, the lock wait, the episode helpers) runs against
 * Postgres in plan-rate-ledger-reconcile-postgres.test.js. All fixture identities are synthetic.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockGate = { on: true, episodes: true };
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  planRateLedgerReconcileLive: jest.fn(() => mockGate.on),
  alertEpisodesLive: jest.fn(() => mockGate.episodes),
}));
// The module-level handle must never be used: every test injects its own.
jest.mock('../models/db', () => {
  const handle = jest.fn(() => { throw new Error('module db handle used'); });
  handle.raw = jest.fn(() => { throw new Error('module db handle used'); });
  return handle;
});
// Everything the fake database does, and every alert, in one ordered log.
const mockLog = [];
// Both raise paths as their contracts run on a CALLER's transaction: dedupe on the key against
// committed rows and this transaction's own, insert into the transaction (committed with it,
// discarded on rollback), errors propagate. The reopen path (raiseAdminAlertWithReopen) also rings
// a row the job closed (autoCleared) again, and reports `rang`.
const mockAlerts = { rows: [], calls: [], nextId: 1, failFor: null };
function mockRaise(path, category, title, body, opts = {}) {
  mockLog.push({ op: 'alert', path, key: opts.dedupeKey });
  if (!opts.trx || !opts.trx.__pendingAlerts) throw new Error('fake: the alert must ride the repair transaction');
  if (mockAlerts.failFor && String(opts.dedupeKey).includes(mockAlerts.failFor)) throw new Error('admin notification insert failed');
  mockAlerts.calls.push({ path, category, title, body, opts });
  const latest = [...mockAlerts.rows, ...opts.trx.__pendingAlerts].filter((row) => row.dedupeKey === opts.dedupeKey).pop();
  if (latest && latest.autoCleared && path === 'reopen') {
    latest.autoCleared = false;
    latest.recurrenceGeneration = (latest.recurrenceGeneration || 0) + 1;
    return { ...latest, deduped: true, refreshed: true, rung: true, rang: true };
  }
  if (latest) return { ...latest, deduped: true, ...(path === 'reopen' ? { rang: false } : {}) };
  const { trx: _trx, ...rest } = opts;
  const row = { id: mockAlerts.nextId++, category, title, body, ...rest, autoCleared: false };
  opts.trx.__pendingAlerts.push(row);
  return { ...row, deduped: false, ...(path === 'reopen' ? { rang: true } : {}) };
}
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async (category, title, body, opts) => mockRaise('plain', category, title, body, opts)),
}));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async (category, title, body, opts) => mockRaise('reopen', category, title, body, opts)),
  openAdminAlertKeys: jest.fn(async (_conn, prefix) => [...new Set(mockAlerts.rows
    .filter((row) => String(row.dedupeKey).startsWith(prefix) && !row.autoCleared)
    .map((row) => row.dedupeKey))]),
  closeAdminAlertKeys: jest.fn(async (_conn, keys, reason, { resolution } = {}) => {
    mockLog.push({ op: 'close', keys: [...keys], reason });
    let closed = 0;
    for (const row of mockAlerts.rows) {
      if (keys.includes(row.dedupeKey) && !row.autoCleared) {
        row.autoCleared = true;
        row.resolution = resolution;
        closed += 1;
      }
    }
    return closed;
  }),
}));

const NotificationService = require('../services/notification-service');
const alertEpisodes = require('../services/admin-alert-episodes');
const { planRateLedgerReconcileLive } = require('../config/feature-gates');
const { runPlanRateLedgerReconcile, MAX_NEW_ALERTS_PER_RUN, REPAIR_SOURCE } = require('../services/plan-rate-ledger-reconcile');

const LIVE = ['active_customer', 'won', 'at_risk'];
const STAMP = '2026-09-01T12:00:00.000Z';
const cents = (v) => Math.round(Number(v || 0) * 100);
const asMoney = (c) => (c / 100).toFixed(2);
const clone = (rows) => rows.map((row) => ({ ...row }));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const shortfallKey = (n, bill, sum) => `plan-rate-invariant:shortfall:${uuid(n)}:${bill}:${sum}`;
const overshootKey = (n, bill, sum) => `plan-rate-invariant:overshoot:${uuid(n)}:${bill}:${sum}`;

function customer(n, monthlyRate, extra = {}) {
  return {
    id: uuid(n), first_name: 'Pat', last_name: `Example${n}`, monthly_rate: monthlyRate, active: true, pipeline_stage: 'active_customer', deleted_at: null, ...extra,
  };
}
function line(n, familyKey, monthlyRate, extra = {}) {
  return {
    customer_id: uuid(n), family_key: familyKey, monthly_rate: monthlyRate, source: 'backfill', source_estimate_id: null, effective_at: STAMP, updated_at: STAMP, ...extra,
  };
}

// A stateful fake knex covering exactly what the reconcile touches: the candidate scan, per-customer
// transactions (the advisory lock, the locked customers read, the ledger read and upsert), and the
// close pass's read of customers with open overshoot alerts. The customers builder records and
// APPLIES every where/whereNull/whereIn it is given (so the real whereLiveCustomer filters the fake
// rows) and evaluates the raw sum predicates itself. Writes to customers, deletes and updates
// anywhere, and any other table throw. `snapshot` stands in for a scan taken BEFORE a concurrent
// writer committed.
function makeDb({ customers = [], lines = [], snapshot = null } = {}) {
  const state = { customers: clone(customers), lines: clone(lines) };
  const initialCustomers = clone(customers);
  const lineSum = (c) => {
    const own = state.lines.filter((l) => l.customer_id === c.id);
    return own.length ? own.reduce((sum, l) => sum + cents(l.monthly_rate), 0) : null;
  };
  const hasGap = (c) => lineSum(c) !== null && lineSum(c) !== cents(c.monthly_rate);
  const refuse = (what) => () => { mockLog.push({ op: 'refused', what }); throw new Error(`fake: ${what}`); };

  const builder = (view, table) => {
    if (table === 'customers') {
      const scope = [];
      const preds = [];
      let locked = false;
      let gapPredicate = false;
      let columns = [];
      const b = {
        modify: (fn) => { fn(b); return b; },
        where: (criteria, value) => {
          const test = typeof criteria === 'object'
            ? (row) => Object.entries(criteria).every(([key, v]) => row[key] === v)
            : (row) => row[criteria] === value;
          scope.push(typeof criteria === 'object' ? ['where', criteria] : ['where', criteria, value]);
          preds.push(test);
          return b;
        },
        whereNull: (column) => { scope.push(['whereNull', column]); preds.push((row) => row[column] == null); return b; },
        whereIn: (column, values) => { scope.push(['whereIn', column, values]); preds.push((row) => values.includes(row[column])); return b; },
        whereRaw: (sql) => {
          if (!/\(SELECT ROUND\(SUM\(r\.monthly_rate\) \* 100\) FROM customer_plan_rates r WHERE r\.customer_id = customers\.id\) <> ROUND\(COALESCE\(customers\.monthly_rate, 0\) \* 100\)/.test(sql)) {
            throw new Error(`fake: unexpected scan predicate ${sql}`);
          }
          gapPredicate = true;
          return b;
        },
        orderBy: () => b,
        select: (...cols) => { columns = cols; return b; },
        forUpdate: () => { locked = true; return b; },
        first: async () => {
          mockLog.push({ op: 'customer-read', locked, scope });
          const row = view.customers.find((c) => preds.every((p) => p(c)));
          return row ? { ...row } : undefined;
        },
        then: (resolve, reject) => {
          if (gapPredicate) {
            mockLog.push({ op: 'scan', scope });
            const rows = snapshot
              ? snapshot.map((id) => ({ id }))
              : view.customers.filter((c) => preds.every((p) => p(c)) && hasGap(c)).map((c) => c.id).sort().map((id) => ({ id }));
            return Promise.resolve(rows).then(resolve, reject);
          }
          if (columns.some((col) => col && /AS line_sum_cents$/.test(String(col.__raw || '')))) {
            mockLog.push({ op: 'close-read', scope });
            const rows = view.customers.filter((c) => preds.every((p) => p(c))).map((c) => ({
              id: c.id, monthly_rate: c.monthly_rate, line_sum_cents: lineSum(c) == null ? null : String(lineSum(c)),
            }));
            return Promise.resolve(rows).then(resolve, reject);
          }
          return Promise.reject(new Error('fake: unexpected customers query')).then(resolve, reject);
        },
        update: refuse('customers write'),
        insert: refuse('customers write'),
        del: refuse('customers write'),
        increment: refuse('customers write'),
        decrement: refuse('customers write'),
      };
      return b;
    }
    if (table === 'customer_plan_rates') {
      let customerId;
      const b = {
        where: (w) => { customerId = w.customer_id; return b; },
        orderBy: () => b,
        select: () => b,
        then: (resolve, reject) => {
          mockLog.push({ op: 'lines-read', id: customerId });
          const rows = clone(view.lines.filter((l) => l.customer_id === customerId))
            .sort((a, z) => a.family_key.localeCompare(z.family_key));
          return Promise.resolve(rows).then(resolve, reject);
        },
        insert: (row) => ({
          onConflict: (conflict) => ({
            merge: async (mergeObj) => {
              mockLog.push({ op: 'upsert', id: row.customer_id, row: { ...row }, conflict, mergeKeys: Object.keys(mergeObj) });
              const existing = view.lines.find((l) => l.customer_id === row.customer_id && l.family_key === row.family_key);
              if (!existing) {
                view.lines.push({ source_estimate_id: null, ...row });
                return;
              }
              for (const [key, value] of Object.entries(mergeObj)) {
                if (value && value.__raw) {
                  if (!/customer_plan_rates\.monthly_rate \+ excluded\.monthly_rate/.test(value.__raw)) throw new Error(`fake: unexpected merge ${value.__raw}`);
                  existing[key] = asMoney(cents(existing.monthly_rate) + cents(row.monthly_rate));
                } else {
                  existing[key] = value;
                }
              }
            },
          }),
        }),
        update: refuse('ledger update'),
        del: refuse('ledger delete'),
      };
      return b;
    }
    throw new Error(`fake: unexpected table ${table}`);
  };

  const database = (table) => builder(state, table);
  database.transaction = async (fn) => {
    const work = { customers: clone(state.customers), lines: clone(state.lines) };
    const trx = (table) => builder(work, table);
    trx.isTransaction = true;
    trx.__pendingAlerts = [];
    trx.raw = (sql, bindings = []) => {
      if (/pg_advisory_xact_lock/.test(sql)) {
        mockLog.push({ op: 'lock', key: bindings[0] });
        return Promise.resolve({ rows: [] });
      }
      return { __raw: sql };
    };
    mockLog.push({ op: 'begin' });
    try {
      const result = await fn(trx);
      state.customers = work.customers;
      state.lines = work.lines;
      mockAlerts.rows.push(...trx.__pendingAlerts);
      mockLog.push({ op: 'commit' });
      return result;
    } catch (err) {
      mockLog.push({ op: 'rollback' });
      throw err;
    }
  };
  // Outside a transaction raw is only ever a select expression (the close pass's line sum).
  database.raw = (sql) => ({ __raw: sql });
  database.__state = state;
  database.__initialCustomers = initialCustomers;
  return database;
}

const linesOf = (db, n) => db.__state.lines.filter((l) => l.customer_id === uuid(n))
  .sort((a, z) => a.family_key.localeCompare(z.family_key));
const setLines = (db, n, rows) => {
  db.__state.lines = [...db.__state.lines.filter((l) => l.customer_id !== uuid(n)), ...rows];
};
const ops = (name) => mockLog.filter((entry) => entry.op === name);
const alertRow = (key) => mockAlerts.rows.filter((row) => row.dedupeKey === key);
// The bill is the business fact: whatever happened, the customers rows are exactly as they were.
const expectBillsUntouched = (db) => {
  expect(db.__state.customers).toEqual(db.__initialCustomers);
  expect(ops('refused')).toEqual([]);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockLog.length = 0;
  mockAlerts.rows = [];
  mockAlerts.calls = [];
  mockAlerts.nextId = 1;
  mockAlerts.failFor = null;
  mockGate.on = true;
  mockGate.episodes = true;
});

test('gate off: nothing is read, written or raised', async () => {
  mockGate.on = false;
  const database = jest.fn(() => { throw new Error('read while gated off'); });
  database.transaction = jest.fn(() => { throw new Error('transaction while gated off'); });
  database.raw = jest.fn(() => { throw new Error('raw while gated off'); });
  await expect(runPlanRateLedgerReconcile({ database })).resolves.toEqual({ skipped: true, reason: 'gated_off' });
  expect(planRateLedgerReconcileLive).toHaveBeenCalled();
  expect(database).not.toHaveBeenCalled();
  expect(database.transaction).not.toHaveBeenCalled();
  expect(database.raw).not.toHaveBeenCalled();
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  expect(alertEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  expect(alertEpisodes.openAdminAlertKeys).not.toHaveBeenCalled();
  expect(alertEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
});

test('the scan only meets live customers: active, a customer stage, not deleted (whereLiveCustomer)', async () => {
  // Every customer has the same $10 shortfall; only the live one may be read, repaired or alerted.
  const db = makeDb({
    customers: [
      customer(1, '60.00'),
      customer(2, '60.00', { active: false }),
      customer(3, '60.00', { pipeline_stage: 'churned' }),
      customer(4, '60.00', { pipeline_stage: 'new_lead' }),
      customer(5, '60.00', { deleted_at: STAMP }),
    ],
    lines: [1, 2, 3, 4, 5].map((n) => line(n, 'pest_control', '50.00')),
  });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ checked: 1, parked: 1, alerted: 1 });
  expect(ops('lines-read').map((entry) => entry.id)).toEqual([uuid(1)]);
  for (const n of [2, 3, 4, 5]) expect(linesOf(db, n).map((l) => l.monthly_rate)).toEqual(['50.00']);
  // Both the scan and the locked read carry the live rule's active = true.
  const [scan] = ops('scan');
  const [read] = ops('customer-read');
  for (const { scope } of [scan, read]) {
    expect(scope).toEqual(expect.arrayContaining([['where', 'active', true], ['whereNull', 'deleted_at'], ['whereIn', 'pipeline_stage', LIVE]]));
  }
  expectBillsUntouched(db);
});

test('shortfall: the gap is parked as a new unattributed line, the bill is untouched, the owner is alerted', async () => {
  const db = makeDb({
    customers: [customer(1, '86.60')],
    lines: [line(1, 'pest_control', '45.00')],
  });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toEqual({
    skipped: false, checked: 1, parked: 1, overshoots: 0, converged: 0, notLive: 0, alerted: 1, alreadyAlerted: 0, deferred: 0, closed: 0, failed: 0,
  });
  expect(linesOf(db, 1)).toEqual([
    expect.objectContaining({ family_key: 'pest_control', monthly_rate: '45.00', source: 'backfill', updated_at: STAMP }),
    expect.objectContaining({ family_key: 'unattributed', monthly_rate: '41.60', source: REPAIR_SOURCE }),
  ]);
  expect(linesOf(db, 1).reduce((sum, l) => sum + cents(l.monthly_rate), 0)).toBe(8660);
  expectBillsUntouched(db);

  expect(mockAlerts.calls).toHaveLength(1);
  const [{ path, category, title, body, opts }] = mockAlerts.calls;
  expect(path).toBe('reopen');
  expect(category).toBe('billing');
  expect(title).toBe("Billing — check Pat Example1's monthly bill by service");
  expect(body).toBe('Billed $86.60 a month but the service lines added up to $45.00; the gap is now an unsplit line.');
  expect(opts.detail).toContain('Pest control $45.00');
  expect(opts.detail).toContain('$41.60 difference');
  expect(opts.detail).toContain('The bill was not changed, nothing was charged, and the customer was not contacted.');
  expect(opts).toMatchObject({
    bell: true,
    dedupeKey: shortfallKey(1, 8660, 4500),
    link: `/admin/customers?customerId=${uuid(1)}`,
    metadata: {
      dedupeKey: shortfallKey(1, 8660, 4500),
      customerId: uuid(1),
      gap: 'shortfall',
      billedCents: 8660,
      lineSumCents: 4500,
      parkedCents: 4160,
      area: 'Billing',
      severity: 'needs-you',
      who: 'person',
      subject: { type: 'customer', id: uuid(1) },
      doneWhen: 'plan_lines_checked',
    },
  });
});

test('shortfall onto an existing unattributed line: the gap is ADDED and the line keeps its source and stamps', async () => {
  // An admin edit's whole-bill reset left a human-source line; its source and updated_at are the
  // cancellation engine's manual-override evidence and must survive the repair.
  const db = makeDb({
    customers: [customer(1, '75.00')],
    lines: [
      line(1, 'pest_control', '40.00', { source: 'estimate_accept' }),
      line(1, 'unattributed', '10.00', { source: 'admin_edit', source_estimate_id: uuid(99) }),
    ],
  });
  await runPlanRateLedgerReconcile({ database: db });
  expect(linesOf(db, 1)).toEqual([
    expect.objectContaining({ family_key: 'pest_control', monthly_rate: '40.00', source: 'estimate_accept' }),
    expect.objectContaining({
      family_key: 'unattributed', monthly_rate: '35.00', source: 'admin_edit', source_estimate_id: uuid(99), effective_at: STAMP, updated_at: STAMP,
    }),
  ]);
  const [upsert] = ops('upsert');
  expect(upsert.conflict).toEqual(['customer_id', 'family_key']);
  expect(upsert.mergeKeys).toEqual(['monthly_rate']);
  expect(upsert.row).toMatchObject({ family_key: 'unattributed', monthly_rate: '25.00', source: REPAIR_SOURCE });
  expectBillsUntouched(db);
});

test('overshoot: alert only, no line is written, deleted or shrunk', async () => {
  const lines = [line(1, 'lawn_care', '45.00'), line(1, 'pest_control', '45.00', { source: 'estimate_accept' })];
  const db = makeDb({ customers: [customer(1, '50.00')], lines });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ checked: 1, parked: 0, overshoots: 1, alerted: 1, closed: 0 });
  expect(ops('upsert')).toEqual([]);
  expect(linesOf(db, 1)).toEqual(lines);
  expectBillsUntouched(db);
  const [{ title, body, opts }] = mockAlerts.calls;
  expect(title).toBe("Billing — fix Pat Example1's monthly bill by service");
  expect(body).toBe('The service lines add up to $90.00 but the bill is $50.00 a month; nothing was deleted.');
  expect(opts.detail).toContain('Lawn care $45.00, Pest control $45.00');
  expect(opts.dedupeKey).toBe(overshootKey(1, 5000, 9000));
  expect(opts.metadata).toMatchObject({ gap: 'overshoot', billedCents: 5000, lineSumCents: 9000, parkedCents: 0, doneWhen: 'plan_lines_match_bill' });
});

test('a NULL bill with lines is an overshoot against zero, alerted and left alone', async () => {
  const db = makeDb({ customers: [customer(1, null)], lines: [line(1, 'pest_control', '45.00')] });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ overshoots: 1, parked: 0, alerted: 1, closed: 0 });
  expect(ops('upsert')).toEqual([]);
  const [{ body, opts }] = mockAlerts.calls;
  expect(opts.dedupeKey).toBe(overshootKey(1, 0, 4500));
  // Compared as $0, but never described as a $0.00 bill.
  expect(body).toBe('The service lines add up to $45.00 but there is no monthly rate on the account; nothing was deleted.');
  expect(opts.detail).toContain('but there is no monthly rate on the account.');
  expectBillsUntouched(db);
});

test('a customer name the alert rules refuse still rings, as "a customer", and the repair stands', async () => {
  const db = makeDb({ customers: [customer(1, '86.60', { first_name: 'Pat!', last_name: '[Example]' })], lines: [line(1, 'pest_control', '45.00')] });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ parked: 1, alerted: 1, failed: 0 });
  const [{ title, opts }] = mockAlerts.calls;
  expect(title).toBe("Billing — check a customer's monthly bill by service");
  expect(opts.detail).toContain('Pat! [Example] is billed $86.60 a month');
});

test('dedupe: a second run on the same gap raises no second alert', async () => {
  const db = makeDb({ customers: [customer(1, '50.00')], lines: [line(1, 'pest_control', '90.00')] });
  const first = await runPlanRateLedgerReconcile({ database: db });
  const second = await runPlanRateLedgerReconcile({ database: db });
  expect(first).toMatchObject({ overshoots: 1, alerted: 1, alreadyAlerted: 0 });
  expect(second).toMatchObject({ overshoots: 1, alerted: 0, alreadyAlerted: 1, closed: 0 });
  expect(mockAlerts.calls.map((call) => call.opts.dedupeKey)).toEqual([overshootKey(1, 5000, 9000), overshootKey(1, 5000, 9000)]);
  expect(mockAlerts.rows).toHaveLength(1);
  expect(mockAlerts.rows[0].autoCleared).toBe(false);
});

test('dedupe: a shortfall whose gap was already alerted is still parked, without a new alert', async () => {
  mockAlerts.rows.push({ id: 41, dedupeKey: shortfallKey(1, 8660, 4500), autoCleared: false });
  const db = makeDb({ customers: [customer(1, '86.60')], lines: [line(1, 'pest_control', '45.00')] });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ parked: 1, alerted: 0, alreadyAlerted: 1 });
  expect(linesOf(db, 1).map((l) => [l.family_key, l.monthly_rate])).toEqual([['pest_control', '45.00'], ['unattributed', '41.60']]);
  expect(mockAlerts.rows).toHaveLength(1);
});

test('locks: rung 6 (customer-comms) before the customers row lock, both before anything is read, written or raised', async () => {
  const db = makeDb({ customers: [customer(1, '86.60')], lines: [line(1, 'pest_control', '45.00')] });
  await runPlanRateLedgerReconcile({ database: db });
  const sequence = mockLog
    .filter((entry) => ['begin', 'lock', 'customer-read', 'lines-read', 'upsert', 'alert', 'commit'].includes(entry.op))
    .map((entry) => (entry.op === 'lock' ? `lock ${entry.key}` : entry.op === 'customer-read' ? `customer-read locked=${entry.locked}` : entry.op));
  expect(sequence).toEqual([
    'begin', `lock customer-comms:${uuid(1)}`, 'customer-read locked=true', 'lines-read', 'upsert', 'alert', 'commit',
  ]);
});

test('re-check under the lock: a gap a concurrent writer closed before the lock is left alone', async () => {
  // The scan saw the customer diverge; by the time the locks are held an accept had committed
  // lines that add up to the bill.
  const db = makeDb({
    customers: [customer(1, '86.60')],
    lines: [line(1, 'pest_control', '45.00'), line(1, 'lawn_care', '41.60', { source: 'estimate_accept' })],
    snapshot: [uuid(1)],
  });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ checked: 1, converged: 1, parked: 0, overshoots: 0, alerted: 0 });
  expect(ops('lock')).toHaveLength(1);
  expect(ops('upsert')).toEqual([]);
  expect(mockAlerts.calls).toEqual([]);
  expectBillsUntouched(db);
});

test('re-check under the lock: lines cleared, or the customer churned, deleted or deactivated, before the lock: left alone', async () => {
  const db = makeDb({
    customers: [
      customer(1, '86.60'),
      customer(2, '86.60', { pipeline_stage: 'churned' }),
      customer(3, '86.60', { deleted_at: STAMP }),
      customer(4, '86.60', { active: false }),
    ],
    lines: [line(2, 'pest_control', '45.00'), line(3, 'pest_control', '45.00'), line(4, 'pest_control', '45.00')],
    snapshot: [uuid(1), uuid(2), uuid(3), uuid(4)],
  });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ checked: 4, converged: 1, notLive: 3, parked: 0, overshoots: 0, alerted: 0 });
  // Not-live customers are refused before their lines are even read.
  expect(ops('lines-read').map((entry) => entry.id)).toEqual([uuid(1)]);
  expect(ops('upsert')).toEqual([]);
  expect(mockAlerts.calls).toEqual([]);
  expectBillsUntouched(db);
});

test('an alert that cannot be written rolls its repair back; the other customers still run and the run fails', async () => {
  mockAlerts.failFor = uuid(1);
  const db = makeDb({
    customers: [customer(1, '86.60'), customer(2, '60.00')],
    lines: [line(1, 'pest_control', '45.00'), line(2, 'pest_control', '50.00')],
  });
  const err = await runPlanRateLedgerReconcile({ database: db }).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toBe('plan-rate ledger reconcile: 1 customer(s) failed');
  expect(err.result).toMatchObject({ checked: 2, parked: 1, alerted: 1, failed: 1 });
  expect(linesOf(db, 1).map((l) => [l.family_key, l.monthly_rate])).toEqual([['pest_control', '45.00']]);
  expect(linesOf(db, 2).map((l) => [l.family_key, l.monthly_rate])).toEqual([['pest_control', '50.00'], ['unattributed', '10.00']]);
  expect(ops('rollback')).toHaveLength(1);
  expectBillsUntouched(db);
});

test('alert budget: once the new alerts are spent the remaining customers wait, untouched, for the next run', async () => {
  const count = MAX_NEW_ALERTS_PER_RUN + 2;
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  const db = makeDb({
    customers: ids.map((n) => customer(n, '60.00')),
    lines: ids.map((n) => line(n, 'pest_control', '50.00')),
  });
  const first = await runPlanRateLedgerReconcile({ database: db });
  expect(first).toMatchObject({ checked: count, parked: MAX_NEW_ALERTS_PER_RUN, alerted: MAX_NEW_ALERTS_PER_RUN, deferred: 2 });
  for (const n of ids.slice(MAX_NEW_ALERTS_PER_RUN)) {
    expect(linesOf(db, n).map((l) => [l.family_key, l.monthly_rate])).toEqual([['pest_control', '50.00']]);
  }
  const second = await runPlanRateLedgerReconcile({ database: db });
  expect(second).toMatchObject({ checked: 2, parked: 2, alerted: 2, deferred: 0 });
  expect(mockAlerts.rows).toHaveLength(count);
  expectBillsUntouched(db);
});

test('an already-alerted gap costs no budget', async () => {
  const ids = Array.from({ length: MAX_NEW_ALERTS_PER_RUN + 1 }, (_, i) => i + 1);
  // Customer 1 is a standing, already-alerted overshoot the run meets first every night.
  mockAlerts.rows.push({ id: 7, dedupeKey: overshootKey(1, 5000, 9000), autoCleared: false });
  const db = makeDb({
    customers: [customer(1, '50.00'), ...ids.slice(1).map((n) => customer(n, '60.00'))],
    lines: [line(1, 'pest_control', '90.00'), ...ids.slice(1).map((n) => line(n, 'pest_control', '50.00'))],
  });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ overshoots: 1, alreadyAlerted: 1, parked: MAX_NEW_ALERTS_PER_RUN, alerted: MAX_NEW_ALERTS_PER_RUN, deferred: 0, closed: 0 });
});

describe('alert episodes (ALERT_EPISODES live, the default)', () => {
  test('an overshoot alert closes itself once the lines add up to the bill, and rings again if the same gap comes back', async () => {
    const db = makeDb({ customers: [customer(1, '50.00')], lines: [line(1, 'pest_control', '90.00')] });
    expect(await runPlanRateLedgerReconcile({ database: db })).toMatchObject({ overshoots: 1, alerted: 1, closed: 0 });

    setLines(db, 1, [line(1, 'pest_control', '50.00')]);
    expect(await runPlanRateLedgerReconcile({ database: db })).toMatchObject({ checked: 0, alerted: 0, closed: 1 });
    expect(alertRow(overshootKey(1, 5000, 9000))).toEqual([
      expect.objectContaining({ autoCleared: true, resolution: 'Cleared: the plan lines add up to the bill' }),
    ]);
    expect(mockAlerts.calls).toHaveLength(1);

    setLines(db, 1, [line(1, 'pest_control', '90.00')]);
    expect(await runPlanRateLedgerReconcile({ database: db })).toMatchObject({ overshoots: 1, alerted: 1, alreadyAlerted: 0, closed: 0 });
    expect(alertRow(overshootKey(1, 5000, 9000))).toEqual([expect.objectContaining({ autoCleared: false, recurrenceGeneration: 1 })]);
    expectBillsUntouched(db);
  });

  test('a gap that changed closes the old alert and rings its own', async () => {
    const db = makeDb({ customers: [customer(1, '50.00')], lines: [line(1, 'pest_control', '90.00')] });
    await runPlanRateLedgerReconcile({ database: db });
    setLines(db, 1, [line(1, 'pest_control', '80.00')]);
    const result = await runPlanRateLedgerReconcile({ database: db });
    expect(result).toMatchObject({ overshoots: 1, alerted: 1, closed: 1 });
    expect(alertRow(overshootKey(1, 5000, 9000))).toEqual([expect.objectContaining({ autoCleared: true, resolution: 'Cleared: the gap changed' })]);
    expect(alertRow(overshootKey(1, 5000, 8000))).toEqual([expect.objectContaining({ autoCleared: false })]);
  });

  test('an overshoot alert closes when the account stops being live or its lines are cleared', async () => {
    const db = makeDb({
      customers: [customer(1, '50.00'), customer(2, '50.00')],
      lines: [line(1, 'pest_control', '90.00'), line(2, 'pest_control', '90.00')],
    });
    await runPlanRateLedgerReconcile({ database: db });
    db.__state.customers[0].active = false;
    db.__initialCustomers[0].active = false;
    setLines(db, 2, []);
    expect(await runPlanRateLedgerReconcile({ database: db })).toMatchObject({ checked: 0, closed: 2 });
    expect(alertRow(overshootKey(1, 5000, 9000))[0].resolution).toBe('Cleared: the account is no longer a live customer');
    expect(alertRow(overshootKey(2, 5000, 9000))[0].resolution).toBe('Cleared: the plan lines were cleared');
    // The close pass reads customers through the same live rule.
    expect(ops('close-read')[0].scope).toEqual(expect.arrayContaining([['where', 'active', true], ['whereNull', 'deleted_at'], ['whereIn', 'pipeline_stage', LIVE]]));
  });

  test('a standing overshoot the alert budget deferred keeps its alert open', async () => {
    // Customers 1-5 are new shortfalls that spend the budget; customer 6's overshoot is already
    // alerted, still stands, and is deferred this run: the close pass must not read deferral as a fix.
    const ids = Array.from({ length: MAX_NEW_ALERTS_PER_RUN }, (_, i) => i + 1);
    const standing = MAX_NEW_ALERTS_PER_RUN + 1;
    mockAlerts.rows.push({ id: 90, dedupeKey: overshootKey(standing, 5000, 9000), autoCleared: false });
    const db = makeDb({
      customers: [...ids.map((n) => customer(n, '60.00')), customer(standing, '50.00')],
      lines: [...ids.map((n) => line(n, 'pest_control', '50.00')), line(standing, 'pest_control', '90.00')],
    });
    const result = await runPlanRateLedgerReconcile({ database: db });
    expect(result).toMatchObject({ alerted: MAX_NEW_ALERTS_PER_RUN, deferred: 1, closed: 0 });
    expect(alertRow(overshootKey(standing, 5000, 9000))[0].autoCleared).toBe(false);
  });

  test('a shortfall alert is never closed by the job: a person checks the repair', async () => {
    const db = makeDb({ customers: [customer(1, '86.60')], lines: [line(1, 'pest_control', '45.00')] });
    await runPlanRateLedgerReconcile({ database: db });
    expect(await runPlanRateLedgerReconcile({ database: db })).toMatchObject({ checked: 0, closed: 0 });
    expect(alertEpisodes.openAdminAlertKeys.mock.calls.map(([, prefix]) => prefix)).toEqual(['plan-rate-invariant:overshoot:', 'plan-rate-invariant:overshoot:']);
    expect(alertRow(shortfallKey(1, 8660, 4500))[0].autoCleared).toBe(false);
  });
});

test('ALERT_EPISODES killed: the plain deduped alert, no close pass, a fixed-then-returned gap stays deduped', async () => {
  mockGate.episodes = false;
  const db = makeDb({ customers: [customer(1, '50.00')], lines: [line(1, 'pest_control', '90.00')] });
  expect(await runPlanRateLedgerReconcile({ database: db })).toMatchObject({ overshoots: 1, alerted: 1 });
  expect(mockAlerts.calls.map((call) => call.path)).toEqual(['plain']);
  setLines(db, 1, [line(1, 'pest_control', '50.00')]);
  expect(await runPlanRateLedgerReconcile({ database: db })).toMatchObject({ checked: 0, closed: 0 });
  setLines(db, 1, [line(1, 'pest_control', '90.00')]);
  expect(await runPlanRateLedgerReconcile({ database: db })).toMatchObject({ overshoots: 1, alerted: 0, alreadyAlerted: 1 });
  expect(alertEpisodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  expect(alertEpisodes.openAdminAlertKeys).not.toHaveBeenCalled();
  expect(alertEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
});

describe('planRateLedgerReconcileLive (the real reader)', () => {
  const read = (env) => {
    const names = ['GATE_PLAN_RATE_LEDGER_RECONCILE', 'GATE_PLAN_RATE_LEDGER'];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) {
        if (env[name] === undefined) delete process.env[name];
        else process.env[name] = env[name];
      }
      let live;
      jest.isolateModules(() => { live = jest.requireActual('../config/feature-gates').planRateLedgerReconcileLive(); });
      return live;
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  };

  test.each([
    [{ GATE_PLAN_RATE_LEDGER_RECONCILE: 'true', GATE_PLAN_RATE_LEDGER: 'true' }, true],
    [{ GATE_PLAN_RATE_LEDGER_RECONCILE: 'true' }, false],
    [{ GATE_PLAN_RATE_LEDGER: 'true' }, false],
    [{ GATE_PLAN_RATE_LEDGER_RECONCILE: '1', GATE_PLAN_RATE_LEDGER: 'true' }, false],
    [{}, false],
  ])('%j -> %s (strict true, and only with the ledger authoritative)', (env, expected) => {
    expect(read(env)).toBe(expected);
  });
});
