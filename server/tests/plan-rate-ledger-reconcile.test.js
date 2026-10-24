/**
 * Nightly plan-rate ledger invariant reconcile (services/plan-rate-ledger-reconcile.js).
 *
 * Pins what the run may and may not do with a customer whose customer_plan_rates
 * lines no longer add up to the billed customers.monthly_rate:
 *   - gate off: nothing is read, written or raised (the database handle throws on any use);
 *   - a shortfall is parked in the 'unattributed' line (fresh insert, or ADDED to an existing
 *     line whose source and stamps stay as they were);
 *   - an overshoot only alerts: no line is deleted, shrunk or written;
 *   - one alert per distinct gap: a second run on the same gap raises no second alert;
 *   - every customer is judged again under rung 6 (customer-comms) taken BEFORE the customers row
 *     lock, and a gap that closed (or a customer that left the live stages) before the lock is left alone;
 *   - customers.monthly_rate is never written (the fake refuses any write to customers);
 *   - an alert that cannot be written rolls its repair back, other customers still run, the run fails;
 *   - at most MAX_NEW_ALERTS_PER_RUN new alerts a run, the rest untouched until the next run.
 * The real SQL (the candidate HAVING, the ON CONFLICT merge, the lock wait) runs against Postgres
 * in plan-rate-ledger-reconcile-postgres.test.js. All fixture identities are synthetic.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockGate = { on: true };
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  planRateLedgerReconcileLive: jest.fn(() => mockGate.on),
}));
// The module-level handle must never be used: every test injects its own.
jest.mock('../models/db', () => {
  const handle = jest.fn(() => { throw new Error('module db handle used'); });
  handle.raw = jest.fn(() => { throw new Error('module db handle used'); });
  return handle;
});
// Everything the fake database does, and every alert, in one ordered log.
const mockLog = [];
// notifyAdmin as its contract runs on a CALLER's transaction: dedupe on the key against
// committed rows and this transaction's own, insert into the transaction (committed with it,
// discarded on rollback), errors propagate.
const mockAlerts = { rows: [], nextId: 1, failFor: null };
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async (category, title, body, opts = {}) => {
    mockLog.push({ op: 'alert', key: opts.dedupeKey });
    if (!opts.trx || !opts.trx.__pendingAlerts) throw new Error('fake: the alert must ride the repair transaction');
    if (mockAlerts.failFor && String(opts.dedupeKey).includes(mockAlerts.failFor)) throw new Error('admin notification insert failed');
    const existing = [...mockAlerts.rows, ...opts.trx.__pendingAlerts].find((row) => row.dedupeKey === opts.dedupeKey);
    if (existing) return { ...existing, deduped: true };
    const { trx: _trx, ...rest } = opts;
    const row = { id: mockAlerts.nextId++, category, title, body, ...rest };
    opts.trx.__pendingAlerts.push(row);
    return { ...row, deduped: false };
  }),
}));

const NotificationService = require('../services/notification-service');
const { planRateLedgerReconcileLive } = require('../config/feature-gates');
const { runPlanRateLedgerReconcile, MAX_NEW_ALERTS_PER_RUN, REPAIR_SOURCE } = require('../services/plan-rate-ledger-reconcile');

const LIVE = ['active_customer', 'won', 'at_risk'];
const STAMP = '2026-09-01T12:00:00.000Z';
const cents = (v) => Math.round(Number(v || 0) * 100);
const asMoney = (c) => (c / 100).toFixed(2);
const clone = (rows) => rows.map((row) => ({ ...row }));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

// A stateful fake knex covering exactly what the reconcile touches: the candidate scan, and
// per-customer transactions with the advisory lock, the locked customers read, the ledger read and
// the ledger upsert. The customers builder records and APPLIES every where/whereNull/whereIn it is
// given (so the real whereLiveCustomer filters the fake rows), and evaluates the scan's gap predicate
// itself. Writes to customers, deletes and updates anywhere, and any other table throw.
// `snapshot` stands in for a scan taken BEFORE a concurrent writer committed.
function makeDb({ customers = [], lines = [], snapshot = null } = {}) {
  const state = { customers: clone(customers), lines: clone(lines) };
  const initialCustomers = clone(customers);
  const hasGap = (c) => {
    const own = state.lines.filter((l) => l.customer_id === c.id);
    return own.length > 0 && own.reduce((sum, l) => sum + cents(l.monthly_rate), 0) !== cents(c.monthly_rate);
  };
  const refuse = (what) => () => { mockLog.push({ op: 'refused', what }); throw new Error(`fake: ${what}`); };

  const builder = (view, table) => {
    if (table === 'customers') {
      const scope = [];
      const preds = [];
      let locked = false;
      let gapPredicate = false;
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
        select: () => b,
        forUpdate: () => { locked = true; return b; },
        first: async () => {
          mockLog.push({ op: 'customer-read', locked, scope });
          const row = view.customers.find((c) => preds.every((p) => p(c)));
          return row ? { ...row } : undefined;
        },
        then: (resolve, reject) => {
          mockLog.push({ op: 'scan', scope });
          if (!gapPredicate) return Promise.reject(new Error('fake: scan without the gap predicate')).then(resolve, reject);
          const rows = snapshot
            ? snapshot.map((id) => ({ id }))
            : view.customers.filter((c) => preds.every((p) => p(c)) && hasGap(c)).map((c) => c.id).sort().map((id) => ({ id }));
          return Promise.resolve(rows).then(resolve, reject);
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
  database.raw = refuse('raw outside a transaction');
  database.__state = state;
  database.__initialCustomers = initialCustomers;
  return database;
}

const linesOf = (db, n) => db.__state.lines.filter((l) => l.customer_id === uuid(n))
  .sort((a, z) => a.family_key.localeCompare(z.family_key));
const ops = (name) => mockLog.filter((entry) => entry.op === name);
// The bill is the business fact: whatever happened, the customers rows are exactly as they were.
const expectBillsUntouched = (db) => {
  expect(db.__state.customers).toEqual(db.__initialCustomers);
  expect(ops('refused')).toEqual([]);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockLog.length = 0;
  mockAlerts.rows = [];
  mockAlerts.nextId = 1;
  mockAlerts.failFor = null;
  mockGate.on = true;
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
    skipped: false, checked: 1, parked: 1, overshoots: 0, converged: 0, notLive: 0, alerted: 1, alreadyAlerted: 0, deferred: 0, failed: 0,
  });
  expect(linesOf(db, 1)).toEqual([
    expect.objectContaining({ family_key: 'pest_control', monthly_rate: '45.00', source: 'backfill', updated_at: STAMP }),
    expect.objectContaining({ family_key: 'unattributed', monthly_rate: '41.60', source: REPAIR_SOURCE }),
  ]);
  expect(linesOf(db, 1).reduce((sum, l) => sum + cents(l.monthly_rate), 0)).toBe(8660);
  expectBillsUntouched(db);

  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
  expect(category).toBe('billing');
  expect(title).toBe("Billing — check Pat Example1's monthly bill by service");
  expect(body).toBe('Billed $86.60 a month but the service lines added up to $45.00; the gap is now an unsplit line.');
  expect(opts.detail).toContain('Pest control $45.00');
  expect(opts.detail).toContain('$41.60 difference');
  expect(opts.detail).toContain('The bill was not changed, nothing was charged, and the customer was not contacted.');
  expect(opts).toMatchObject({
    bell: true,
    dedupeKey: `plan-rate-invariant:${uuid(1)}:8660:4500`,
    link: `/admin/customers?customerId=${uuid(1)}`,
    metadata: {
      dedupeKey: `plan-rate-invariant:${uuid(1)}:8660:4500`,
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
  expect(result).toMatchObject({ checked: 1, parked: 0, overshoots: 1, alerted: 1 });
  expect(ops('upsert')).toEqual([]);
  expect(linesOf(db, 1)).toEqual(lines);
  expectBillsUntouched(db);
  const [, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
  expect(title).toBe("Billing — fix Pat Example1's monthly bill by service");
  expect(body).toBe('The service lines add up to $90.00 but the bill is $50.00 a month; nothing was deleted.');
  expect(opts.detail).toContain('Lawn care $45.00, Pest control $45.00');
  expect(opts.metadata).toMatchObject({ gap: 'overshoot', billedCents: 5000, lineSumCents: 9000, parkedCents: 0, doneWhen: 'plan_lines_match_bill' });
});

test('a NULL bill with lines is an overshoot against zero, alerted and left alone', async () => {
  const db = makeDb({ customers: [customer(1, null)], lines: [line(1, 'pest_control', '45.00')] });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ overshoots: 1, parked: 0, alerted: 1 });
  expect(ops('upsert')).toEqual([]);
  const [, , body, opts] = NotificationService.notifyAdmin.mock.calls[0];
  expect(opts.dedupeKey).toBe(`plan-rate-invariant:${uuid(1)}:0:4500`);
  // Compared as $0, but never described as a $0.00 bill.
  expect(body).toBe('The service lines add up to $45.00 but there is no monthly rate on the account; nothing was deleted.');
  expect(opts.detail).toContain('but there is no monthly rate on the account.');
  expectBillsUntouched(db);
});

test('dedupe: a second run on the same gap raises no second alert', async () => {
  const db = makeDb({ customers: [customer(1, '50.00')], lines: [line(1, 'pest_control', '90.00')] });
  const first = await runPlanRateLedgerReconcile({ database: db });
  const second = await runPlanRateLedgerReconcile({ database: db });
  expect(first).toMatchObject({ overshoots: 1, alerted: 1, alreadyAlerted: 0 });
  expect(second).toMatchObject({ overshoots: 1, alerted: 0, alreadyAlerted: 1 });
  const keys = NotificationService.notifyAdmin.mock.calls.map(([, , , opts]) => opts.dedupeKey);
  expect(keys).toEqual([`plan-rate-invariant:${uuid(1)}:5000:9000`, `plan-rate-invariant:${uuid(1)}:5000:9000`]);
  expect(mockAlerts.rows).toHaveLength(1);
});

test('dedupe: a shortfall whose gap was already alerted is still parked, without a new alert', async () => {
  mockAlerts.rows.push({ id: 41, dedupeKey: `plan-rate-invariant:${uuid(1)}:8660:4500` });
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
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
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
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
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
  mockAlerts.rows.push({ id: 7, dedupeKey: `plan-rate-invariant:${uuid(1)}:5000:9000` });
  const db = makeDb({
    customers: [customer(1, '50.00'), ...ids.slice(1).map((n) => customer(n, '60.00'))],
    lines: [line(1, 'pest_control', '90.00'), ...ids.slice(1).map((n) => line(n, 'pest_control', '50.00'))],
  });
  const result = await runPlanRateLedgerReconcile({ database: db });
  expect(result).toMatchObject({ overshoots: 1, alreadyAlerted: 1, parked: MAX_NEW_ALERTS_PER_RUN, alerted: MAX_NEW_ALERTS_PER_RUN, deferred: 0 });
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
