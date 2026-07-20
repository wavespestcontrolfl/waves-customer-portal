/**
 * Series-scope cancellation stops the parent plan (fix: recurring-series
 * integrity, round 3 codex P0-2).
 *
 * The bug: PUT /admin/dispatch/:serviceId/status with scope 'following' or
 * 'series' cancelled every remaining occurrence but left the parent flagged
 * recurring_ongoing. The completion hook added earlier in this lane
 * (runRecurringSeriesMaintenance) then re-extended that cadence the moment an
 * EARLIER retained visit was completed — minting, and billing, a fresh visit
 * on a customer who had just cancelled the plan.
 *
 * The fix has three parts, all pinned here:
 *   (a) the flag is cleared in the SAME transaction as the row cancels;
 *   (b) that transaction takes the per-parent maintenance advisory lock
 *       BEFORE it selects the cancel set, so a concurrent completion cannot
 *       interleave between the cancels and the flag clear;
 *   (c) the maintenance re-reads recurring_ongoing INSIDE that lock, so the
 *       blocked completion sees the stopped plan and no-ops.
 *
 * CRITICAL classification: 'following'/'series' stop the plan; a SINGLE
 * occurrence cancel ('this_only') must NOT — the auto-extend refilling a
 * one-off cancelled slot is this lane's intended live-refill behaviour.
 *
 * Route internals are inline in the cancel branch, so the transaction/lock
 * shape is pinned with source guards (house style — see
 * recurring-series-maintenance); the resulting no-op is proven behaviourally
 * against runRecurringSeriesMaintenance.
 */
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: jest.fn().mockResolvedValue(undefined),
  alertRegistrationFailure: jest.fn().mockResolvedValue(undefined),
}));

const fs = require('fs');
const path = require('path');

const { runRecurringSeriesMaintenance } = require('../routes/admin-schedule')._test;

const dispatchSrc = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
const scheduleSrc = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

// Bounds of the scoped-cancel branch, so "inside the branch" is assertable.
const BRANCH_START = dispatchSrc.indexOf(
  "if (toStatus === 'cancelled' && ['following', 'series'].includes(scope)) {",
);
const BRANCH_END = dispatchSrc.indexOf(
  "return res.json({ success: true, cancelledCount: targets.length, scope });",
);

describe('scoped cancel stops the plan atomically (P0-2)', () => {
  test('the branch bounds resolve (guards below are meaningful)', () => {
    expect(BRANCH_START).toBeGreaterThan(-1);
    expect(BRANCH_END).toBeGreaterThan(BRANCH_START);
  });

  test('recurring_ongoing is cleared on the SAME trx as the row cancels, not a separate write', () => {
    // `trx(...)`, not `db(...)`: a separate statement could commit the
    // cancels and then fail, leaving the plan running.
    const clear = dispatchSrc.indexOf("ongoingStopped = await trx('scheduled_services')");
    expect(clear).toBeGreaterThan(BRANCH_START);
    expect(clear).toBeLessThan(BRANCH_END);
    expect(dispatchSrc).toContain('.update({ recurring_ongoing: false, updated_at: new Date() });');
    // Cleared series-wide — parent AND children carry the flag, and it is the
    // parent's value the maintenance reads.
    expect(dispatchSrc.slice(clear, clear + 400))
      .toContain("this.where('id', parentId).orWhere('recurring_parent_id', parentId);");
    // Only rows still flagged are touched, so the count reports a real stop.
    expect(dispatchSrc.slice(clear, clear + 400)).toContain(".where('recurring_ongoing', true)");
  });

  test('the clear runs AFTER the cancels and BEFORE the transaction commits', () => {
    const cancels = dispatchSrc.indexOf('for (const target of targets) {', BRANCH_START);
    const clear = dispatchSrc.indexOf("ongoingStopped = await trx('scheduled_services')");
    const respond = dispatchSrc.indexOf('if (!targets.length) return res.status(409)', BRANCH_START);
    expect(cancels).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(cancels);
    // The 409 (and every post-commit side effect) sits outside the trx block.
    expect(respond).toBeGreaterThan(clear);
  });

  test('an empty cancel set writes nothing and still answers 409', () => {
    // Selecting inside the trx moved the emptiness check inside it too; it
    // must return before any write and surface the same 409 as before.
    const empty = dispatchSrc.indexOf('if (!targets.length) return;', BRANCH_START);
    expect(empty).toBeGreaterThan(-1);
    expect(empty).toBeLessThan(dispatchSrc.indexOf("ongoingStopped = await trx('scheduled_services')"));
    expect(dispatchSrc).toContain("return res.status(409).json({ error: 'No cancellable appointments found in this series' });");
  });
});

describe('cancellation is serialized with series maintenance (P0-2b)', () => {
  test('the cancel trx takes the per-parent maintenance lock BEFORE selecting the cancel set', () => {
    const lock = dispatchSrc.indexOf("['recurring-series-maintenance', String(parentId)],");
    const select = dispatchSrc.indexOf('targets = await targetQuery');
    expect(lock).toBeGreaterThan(BRANCH_START);
    expect(lock).toBeLessThan(BRANCH_END);
    // Locking after the select would let a completion's auto-extend commit a
    // fresh visit that this cancel never sees — a resurrected occurrence.
    expect(select).toBeGreaterThan(lock);
    expect(dispatchSrc).toContain('pg_advisory_xact_lock(hashtext(?), hashtext(?::text))');
  });

  test('cancel and maintenance derive the IDENTICAL lock key (else they never contend)', () => {
    const key = "['recurring-series-maintenance', String(parentId)],";
    expect(dispatchSrc).toContain(key);
    expect(scheduleSrc).toContain(key);
    // Same parent derivation on both sides.
    expect(dispatchSrc).toContain('const parentId = svc.recurring_parent_id || svc.id;');
    expect(scheduleSrc).toContain('const parentId = svc.recurring_parent_id || svc.id;');
  });

  test('the maintenance re-reads recurring_ongoing INSIDE the lock, both before and after its insert', () => {
    // Pre-insert re-check and post-insert compensating re-check both live in
    // runRecurringSeriesMaintenanceLocked, i.e. after the lock is taken.
    const locked = scheduleSrc.indexOf('async function runRecurringSeriesMaintenanceLocked');
    expect(locked).toBeGreaterThan(-1);
    const body = scheduleSrc.slice(locked);
    expect((body.match(/\.first\('recurring_ongoing'\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(body).toContain('stillOngoing = !!(freshParent && freshParent.recurring_ongoing);');
    expect(body).toContain('if (!parentNow || !parentNow.recurring_ongoing) {');
  });
});

describe('single-occurrence cancels leave the plan running (classification)', () => {
  test('the flag clear exists ONCE in admin-dispatch and only in the scoped branch', () => {
    const occurrences = (dispatchSrc.match(/recurring_ongoing: false/g) || []).length;
    expect(occurrences).toBe(1);
    const only = dispatchSrc.indexOf('recurring_ongoing: false');
    expect(only).toBeGreaterThan(BRANCH_START);
    expect(only).toBeLessThan(BRANCH_END);
  });

  test("the branch is unreachable for the default 'this_only' scope", () => {
    // Default scope is this_only; the branch demands following|series, so a
    // single cancel can never stop the plan — the live-refill hook still
    // refills that one slot.
    expect(dispatchSrc).toContain("scope = 'this_only' } = req.body;");
    expect(dispatchSrc).toContain("if (toStatus === 'cancelled' && ['following', 'series'].includes(scope)) {");
  });
});

// Minimal scriptable conn (same shape as recurring-series-maintenance's):
// resolves terminal ops through a handler and is callable AS a transaction.
function makeConn(handler) {
  const buildTable = (table) => {
    const calls = [];
    const b = {};
    const record = (name) => (...args) => {
      if (name === 'where' && typeof args[0] === 'function') {
        const nested = [];
        const sub = {
          where(...a) { nested.push(['where', ...a]); return sub; },
          orWhere(...a) { nested.push(['orWhere', ...a]); return sub; },
        };
        args[0].call(sub, sub);
        calls.push(['whereFn', nested]);
      } else {
        calls.push([name, ...args]);
      }
      return b;
    };
    for (const m of ['where', 'orWhere', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereNot', 'orderBy', 'count', 'select', 'del', 'update', 'limit']) {
      b[m] = record(m);
    }
    b.first = (...args) => {
      calls.push(['first', ...args]);
      return Promise.resolve(handler({ table, calls, op: 'first' }));
    };
    b.columnInfo = () => Promise.resolve(handler({ table, calls, op: 'columnInfo' }));
    b.insert = (data) => {
      calls.push(['insert', data]);
      return {
        returning: () => Promise.resolve(handler({ table, calls, op: 'insertReturning', data })),
        then: (res, rej) => Promise.resolve(handler({ table, calls, op: 'insert', data })).then(res, rej),
      };
    };
    b.then = (res, rej) => Promise.resolve(handler({ table, calls, op: 'await' })).then(res, rej);
    return b;
  };
  const build = (isTransaction) => {
    const fn = (table) => buildTable(table);
    fn.isTransaction = isTransaction;
    fn.raw = () => Promise.resolve();
    fn.transaction = (cb) => Promise.resolve().then(() => cb(build(true)));
    return fn;
  };
  return build(false);
}

const COLS = {
  recurring_ongoing: {}, skip_weekends: {}, weekend_shift: {}, service_id: {},
  create_invoice_on_complete: {}, estimated_price: {}, is_callback: {}, discount_dollars: {},
};

// The state a scope='series' cancel leaves behind: every remaining occurrence
// cancelled (upcoming = 0) and the parent no longer flagged ongoing.
function afterSeriesCancelScenario({ recurringOngoing }) {
  const parent = {
    id: 10, customer_id: 5, is_recurring: true, recurring_pattern: 'quarterly',
    recurring_ongoing: recurringOngoing, scheduled_date: '2026-01-15',
    window_start: '08:00', window_end: '10:00',
    service_type: 'Quarterly Pest Control', time_window: 'morning', zone: 'A',
    estimated_duration_minutes: 60, skip_weekends: false, technician_id: 'tech-1',
    create_invoice_on_complete: false,
  };
  const inserted = [];
  const handler = ({ table, calls, op, data }) => {
    if (table === 'scheduled_services') {
      if (op === 'columnInfo') return COLS;
      if (op === 'first') {
        const firstCall = calls.find((c) => c[0] === 'first');
        if (calls.some((c) => c[0] === 'count')) return { c: '0' }; // all cancelled
        if (firstCall[1] === 'recurring_ongoing') return { recurring_ongoing: recurringOngoing };
        if (firstCall[1] === 'create_invoice_on_complete') return undefined;
        // Latest LIVE visit = the earlier retained one being completed now.
        if (calls.some((c) => c[0] === 'orderBy')) return { scheduled_date: '2026-07-15' };
        return parent;
      }
      if (op === 'await') {
        if (calls.some((c) => c[0] === 'select' && c[1] === 'scheduled_date')) {
          return [{ scheduled_date: '2026-07-15' }];
        }
        return [];
      }
      if (op === 'insertReturning') { inserted.push(data); return [{ id: 903, ...data }]; }
      if (op === 'insert') { inserted.push(data); return [1]; }
    }
    if (table === 'scheduled_service_addons') { if (op === 'columnInfo') return {}; return []; }
    if (table === 'recurring_plan_alerts') { if (op === 'first') return null; return [1]; }
    return null;
  };
  return { conn: makeConn(handler), inserted };
}

describe('maintenance after a series-scope cancel (P0-2c, behavioural)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('completing an earlier RETAINED visit does NOT re-extend the stopped plan', async () => {
    const { conn, inserted } = afterSeriesCancelScenario({ recurringOngoing: false });
    await runRecurringSeriesMaintenance(conn, {
      id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2026-07-15',
    });
    // The re-bill: before the cancel cleared the flag, this completion minted
    // a fresh 2026-10-15 visit on a cancelled plan.
    expect(inserted).toHaveLength(0);
  });

  test('the same completion DOES extend while the plan is still running (the guard is the flag, not the count)', async () => {
    const { conn, inserted } = afterSeriesCancelScenario({ recurringOngoing: true });
    await runRecurringSeriesMaintenance(conn, {
      id: 22, recurring_parent_id: 10, customer_id: 5, scheduled_date: '2026-07-15',
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].scheduled_date).toBe('2026-10-15');
  });
});
