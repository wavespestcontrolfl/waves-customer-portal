/**
 * IB resolve_dispatch_alert (IB gap #4): the Dispatch board's single-card Resolve run in process behind a card, dark
 * behind GATE_IB_RESOLVE_DISPATCH_ALERT (needs GATE_IB_PLATFORM). What the card shows (type, text, raised time, visit,
 * customer, technician, every effect of the Resolve), the refusals (resolved, gone, decision-only, ambiguous or missing
 * selector), pin drift (including drift between the pre-check and the row lock), gate off, admin only, and that the
 * confirmed run calls the SAME shared function the board's route calls (resolveAlertAsDispatcher) once, inside a
 * transaction that holds the alert FOR UPDATE, broadcasting only after commit. The shared function's own outcomes are
 * covered at the bottom. A tiny in-memory knex stand-in is used; the lock/drift path against real Postgres is
 * intelligence-bar-dispatch-alert-postgres.test.js. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockEmit = jest.fn();
jest.mock('../sockets', () => ({ getIo: () => ({ to: () => ({ emit: (...a) => mockEmit(...a) }) }) }));
const mockOpenToCloser = jest.fn();
jest.mock('../services/notification-service', () => ({
  _private: {
    openToCloser: (...a) => { mockOpenToCloser(...a); return { update: async () => 1 }; },
    doneColumns: () => ({}),
  },
}));

const db = require('../models/db');
const { executeDispatchAlertTool, DISPATCH_ALERT_TOOLS, cardLines } = require('../services/intelligence-bar/dispatch-alert-tools');
const dispatchAlerts = require('../services/dispatch-alerts');
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const ALERT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ALERT = '00000000-0000-4000-8000-0000000000a2';
const VISIT = '00000000-0000-4000-8000-0000000000b1';
const TECH = '00000000-0000-4000-8000-0000000000c1';
const CUST = '00000000-0000-4000-8000-0000000000d1';
const ADMIN = { isAdmin: true, technicianId: TECH };

// ── a tiny in-memory knex ─────────────────────────────────────────
let S;
function freshState() {
  return {
    tables: {
      dispatch_alerts: [{
        id: ALERT, type: 'tech_late', severity: 'warn', tech_id: TECH, job_id: VISIT,
        payload: { delay_minutes: 25, message: 'Running 25 minutes behind' }, created_at: new Date('2026-10-28T14:05:00Z'), resolved_at: null, resolved_by: null,
      }],
      technicians: [{ id: TECH, name: 'Synthetic Tech' }],
      scheduled_services: [{ id: VISIT, customer_id: CUST, service_type: 'Pest Control', scheduled_date: '2026-10-28', window_start: '09:00:00', window_end: '11:00:00', status: 'scheduled' }],
      customers: [{ id: CUST, first_name: 'Robin', last_name: 'Sample', company_name: null }],
    },
    candidates: [],
    updates: [],
    locks: [],
    beforeTx: null,
  };
}

function makeTable(name) {
  const base = name.split(' as ')[0];
  const q = { filters: [], ins: [], isNull: [], notNull: [], single: false, patch: null, raw: false };
  const matched = () => (S.tables[base] || []).filter((r) => q.filters.every(([k, v]) => r[k] === v) && q.ins.every(([k, vs]) => vs.includes(r[k]))
    && q.isNull.every((k) => r[k] == null) && q.notNull.every((k) => r[k] != null));
  const run = () => {
    if (S.failReads) throw new Error('read failed');
    if (q.patch) {
      if (q.raw) return [];
      const rows = matched();
      for (const r of rows) Object.assign(r, q.patch);
      S.updates.push({ table: base, patch: q.patch, count: rows.length });
      return rows.map((r) => ({ ...r }));
    }
    if (name.includes(' as ')) return S.candidates;
    const rows = matched();
    return q.single ? rows[0] : rows;
  };
  const b = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve().then(run).then(res, rej);
      if (prop === 'first') return () => { q.single = true; return b; };
      if (prop === 'where') return (k, v) => { if (k && typeof k === 'object') Object.entries(k).forEach((e) => q.filters.push(e)); else q.filters.push([k, v]); return b; };
      if (prop === 'whereIn') return (k, vs) => { q.ins.push([k, vs]); return b; };
      if (prop === 'whereNull') return (k) => { q.isNull.push(k); return b; };
      if (prop === 'whereNotNull') return (k) => { q.notNull.push(k); return b; };
      if (prop === 'whereRaw') return () => { q.raw = true; return b; };
      if (prop === 'forUpdate') return () => { S.locks.push(base); return b; };
      if (prop === 'update') return (patch) => { q.patch = patch; return b; };
      if (['insert', 'del', 'delete', 'upsert'].includes(prop)) throw new Error(`unexpected ${String(prop)} on ${base}`);
      return () => b;
    },
  });
  return b;
}

function makeDb() {
  const fn = (name) => makeTable(name);
  fn.fn = { now: () => 'NOW' };
  fn.raw = () => 'RAW';
  fn.transaction = async (cb) => {
    const snapshot = JSON.parse(JSON.stringify(S.tables));
    if (S.beforeTx) { const hook = S.beforeTx; S.beforeTx = null; hook(); }
    let commit; let rollback;
    const trx = (name) => makeTable(name);
    trx.fn = fn.fn; trx.raw = fn.raw;
    trx.executionPromise = new Promise((res, rej) => { commit = res; rollback = rej; });
    trx.executionPromise.catch(() => {});
    try {
      const out = await cb(trx);
      commit();
      await Promise.resolve();
      return out;
    } catch (err) {
      S.tables = JSON.parse(JSON.stringify(snapshot));
      if (S.afterRollback) S.afterRollback();
      rollback(err);
      throw err;
    }
  };
  return fn;
}

function envGate(on) {
  if (on) { process.env.GATE_IB_RESOLVE_DISPATCH_ALERT = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_RESOLVE_DISPATCH_ALERT; delete process.env.GATE_IB_PLATFORM; }
}

const alert = () => S.tables.dispatch_alerts[0];
const preview = (input = { alert_id: ALERT }, ctx = ADMIN) => executeDispatchAlertTool('resolve_dispatch_alert', input, ctx);
const confirm = (card, input = { alert_id: ALERT }, ctx = ADMIN) => executeDispatchAlertTool('resolve_dispatch_alert',
  { ...input, confirmed: true, _verified_dispatch_alert_version: card._version }, ctx);
const writes = () => S.updates.filter((u) => u.table === 'dispatch_alerts');

beforeEach(() => {
  jest.clearAllMocks();
  S = freshState();
  db.mockImplementation(makeDb());
  db.transaction = makeDb().transaction;
  db.raw = () => 'RAW';
  envGate(true);
});
afterEach(() => envGate(false));

describe('registration', () => {
  test('a two-step write, admin only, on the schedule/dispatch pages, never owner-direct', () => {
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('resolve_dispatch_alert')).toBe(true);
    expect(gates.UI_GATED_WRITE_TOOL_NAMES.has('resolve_dispatch_alert')).toBe(true);
    expect(registry.actions.get('resolve_dispatch_alert')).toMatchObject({ domain: 'schedule', role: 'admin', approval: 'ui_confirm', scope: 'record', module: 'dispatch-alert-tools.js' });
    expect(registry.policyErrors).not.toContain('resolve_dispatch_alert');
    expect(DISPATCH_ALERT_TOOLS[0]._sideEffects).toBe(true);
  });

  test('offered on the dispatch page while on; gone with either gate off; never for a technician', () => {
    const offered = (context) => registry.initialTools(context, { role: 'admin', fullAccess: false }).map((d) => d.name);
    expect(offered('dispatch')).toContain('resolve_dispatch_alert');
    expect(offered('schedule')).toContain('resolve_dispatch_alert');
    delete process.env.GATE_IB_RESOLVE_DISPATCH_ALERT;
    expect(offered('dispatch')).not.toContain('resolve_dispatch_alert');
    envGate(true);
    delete process.env.GATE_IB_PLATFORM;
    expect(registry.allowed(registry.actions.get('resolve_dispatch_alert'), { role: 'admin', context: 'dispatch' })).toBe(false);
    envGate(true);
    expect(registry.allowed(registry.actions.get('resolve_dispatch_alert'), { role: 'technician', context: 'tech' })).toBe(false);
  });

  test('the description tells the model the bar resolves one alert at a time and where Clear all lives', () => {
    expect(DISPATCH_ALERT_TOOLS[0].description).toMatch(/resolves one alert at a time/i);
    expect(DISPATCH_ALERT_TOOLS[0].description).toMatch(/Clear all button on the Dispatch board/);
  });
});

describe('gate and login', () => {
  test('gate off: every call refuses and nothing is written', async () => {
    envGate(false);
    expect(await preview()).toMatchObject({ code: 'gate_off' });
    expect(await executeDispatchAlertTool('resolve_dispatch_alert', { alert_id: ALERT, confirmed: true, _verified_dispatch_alert_version: {} }, ADMIN)).toMatchObject({ code: 'gate_off' });
    expect(S.updates).toEqual([]);
  });

  test('a non-admin is refused, and a confirmed run needs a positive admin flag', async () => {
    expect(await preview(undefined, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    const card = await preview();
    expect(await confirm(card, undefined, {})).toMatchObject({ code: 'permission_denied' });
    expect(S.updates).toEqual([]);
  });

  test('any admin may resolve, not only the owner login (fullAccess is not required)', async () => {
    const card = await preview(undefined, { isAdmin: true, fullAccess: false, technicianId: TECH });
    expect(card).toMatchObject({ preview: true });
    expect(await confirm(card, undefined, { isAdmin: true, fullAccess: false, technicianId: TECH })).toMatchObject({ success: true });
  });
});

describe('the preview', () => {
  test('shows the alert, when it was raised, the visit, customer and technician, and every effect; writes nothing', async () => {
    const card = await preview();
    expect(card).toMatchObject({
      preview: true, tool: 'resolve_dispatch_alert', alert_id: ALERT, alert_type: 'tech_late', alert_label: 'Tech late', severity: 'warn',
      message: 'Running 25 minutes behind', customer_name: 'Robin Sample', technician_name: 'Synthetic Tech', sends_to_customer: false,
      visit: { id: VISIT, service_type: 'Pest Control', date: '2026-10-28', window: '09:00-11:00', status: 'scheduled' },
    });
    expect(card.raised_at_et).toBe('October 28, 10:05 AM ET');
    const text = card.effects.map((e) => e.text).join('\n');
    expect(text).toMatch(/marked resolved by you and stays in the alert history/);
    expect(text).toMatch(/Every open Dispatch board drops the card/);
    expect(text).toMatch(/no Reopen/);
    expect(text).toMatch(/Nothing is sent: no text, email or call goes to the customer or the technician/);
    expect(text).not.toMatch(/tracking/i);
    expect(S.updates).toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(cardLines('resolve_dispatch_alert', card).map((l) => l.text)).toEqual(expect.arrayContaining([
      'Tech late alert (warn): Running 25 minutes behind', 'Raised October 28, 10:05 AM ET', 'Visit: Pest Control, 2026-10-28 09:00-11:00', 'Customer: Robin Sample', 'Technician: Synthetic Tech',
    ]));
    const contract = buildContract({ toolName: 'resolve_dispatch_alert', params: { alert_id: ALERT }, displayParams: {}, preview: card, summary: 'x' });
    expect(JSON.stringify(contract)).toMatch(/Nothing is sent/);
    expect(contract.irreversible).toBe(true);
  });

  test('a tracking alert also names the bell it closes and that it is not raised again', async () => {
    alert().payload = { source: 'no_show_detector', tracking_key: 'tracking:x', message: 'No arrival yet' };
    const card = await preview();
    expect(card.effects.map((e) => e.text).join('\n')).toMatch(/tracking alert: its linked admin bell is marked done, and the tracking check does not raise the same alert again/);
  });

  test('an alert with no text falls back to its type and delay; an alert with no visit says so', async () => {
    alert().payload = { delay_minutes: 40 };
    expect((await preview()).message).toBe('Tech late: 40 min');
    alert().payload = null;
    alert().job_id = null;
    alert().tech_id = null;
    const card = await preview();
    expect(card).toMatchObject({ visit: null, customer_name: null, technician_name: null });
    expect(cardLines('resolve_dispatch_alert', card).map((l) => l.text)).toContain('Not tied to a visit');
  });

  test('the route builds the confirmation card from this preview', async () => {
    const { confirmationDisplayParams } = jest.requireActual('../routes/admin-intelligence-bar');
    expect(confirmationDisplayParams('resolve_dispatch_alert', { alert_id: ALERT }, await preview())).toEqual({
      alert: 'Tech late (warn)', message: 'Running 25 minutes behind', customer: 'Robin Sample', technician: 'Synthetic Tech', sends_to_customer: 'nothing',
    });
  });

  test('refusals: bad id, both selectors, resolved, gone, decision-only', async () => {
    expect(await preview({ alert_id: 'nope' })).toMatchObject({ code: 'invalid_target' });
    expect(await preview({ alert_id: ALERT, job_id: VISIT })).toMatchObject({ code: 'invalid_target' });
    expect(await preview({ alert_id: OTHER_ALERT })).toMatchObject({ code: 'alert_not_found' });
    alert().resolved_at = new Date('2026-10-28T15:00:00Z');
    expect(await preview()).toMatchObject({ code: 'already_resolved' });
    alert().resolved_at = null;
    alert().type = 'visit_not_closed_out';
    const refused = await preview();
    expect(refused).toMatchObject({ code: 'needs_decision' });
    expect(refused.error).toMatch(/"This was a miss" or "Not a miss"/);
    expect(S.updates).toEqual([]);
  });

  test('selecting by visit: one open alert resolves to it; none or several ask which', async () => {
    expect(await preview({ job_id: VISIT })).toMatchObject({ preview: true, alert_id: ALERT });
    expect(await preview({ job_id: OTHER_ALERT })).toMatchObject({ code: 'alert_not_found' });
    S.tables.dispatch_alerts.push({ ...alert(), id: OTHER_ALERT });
    S.candidates = [{ id: ALERT, type: 'tech_late', severity: 'warn', created_at: new Date('2026-10-28T14:05:00Z'), first_name: 'Robin', last_name: 'Sample' }];
    const many = await preview({ job_id: VISIT });
    expect(many).toMatchObject({ code: 'alert_required' });
    expect(many.candidates).toEqual([{ alert_id: ALERT, type: 'tech_late', severity: 'warn', raised_at: 'October 28, 10:05 AM ET', customer: 'Robin S.' }]);
  });

  test('no selector lists the open cards (names as first name and initial); an empty queue says so', async () => {
    S.candidates = [{ id: ALERT, type: 'tech_late', severity: 'warn', created_at: new Date('2026-10-28T14:05:00Z'), first_name: 'Robin', last_name: 'Sample' }];
    const listed = await preview({});
    expect(listed).toMatchObject({ code: 'alert_required' });
    expect(listed.error).toMatch(/resolves one alert at a time/);
    expect(listed.candidates[0].customer).toBe('Robin S.');
    S.candidates = [];
    expect(await preview({})).toMatchObject({ code: 'alert_not_found', candidates: [] });
  });
});

describe('the confirmed run', () => {
  test('resolves the pinned alert once through the shared function, under a row lock, and broadcasts after commit', async () => {
    const card = await preview();
    S.updates = [];
    S.locks = [];
    const done = await confirm(card, { job_id: VISIT });
    expect(done).toMatchObject({ success: true, sent_to_customer: false, alert_id: ALERT });
    expect(done.note).toMatch(/Nothing was sent to anyone/);
    expect(S.locks).toContain('dispatch_alerts');
    expect(writes()).toEqual([{ table: 'dispatch_alerts', patch: { resolved_at: 'NOW', resolved_by: TECH }, count: 1 }]);
    expect(alert()).toMatchObject({ resolved_at: 'NOW', resolved_by: TECH });
    await new Promise((r) => setImmediate(r));
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(dispatchAlerts.EVENT_RESOLVED, { id: ALERT, resolved_at: 'NOW', resolved_by: TECH });
    expect(mockOpenToCloser).not.toHaveBeenCalled();
  });

  test('a tracking alert also closes its linked admin bell', async () => {
    alert().payload = { source: 'no_show_detector', tracking_key: 'tracking:x' };
    const card = await preview();
    expect(await confirm(card)).toMatchObject({ success: true });
    expect(mockOpenToCloser).toHaveBeenCalledTimes(1);
    expect(mockOpenToCloser.mock.calls[0][1]).toBe('dispatch');
  });

  test('no pin refuses; a model-supplied pin cannot widen what is resolved', async () => {
    expect(await executeDispatchAlertTool('resolve_dispatch_alert', { alert_id: ALERT, confirmed: true }, ADMIN)).toMatchObject({ code: 'approval_required' });
    const card = await preview();
    // The card pinned ALERT; a confirm naming a different alert re-derives a different card and is refused.
    S.tables.dispatch_alerts.push({ ...alert(), id: OTHER_ALERT });
    expect(await confirm(card, { alert_id: OTHER_ALERT })).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(writes()).toEqual([]);
  });

  test.each([
    ['the payload changed (a detector updated the card)', () => { alert().payload = { delay_minutes: 55, message: 'Running 55 minutes behind' }; }],
    ['the severity changed', () => { alert().severity = 'critical'; }],
    ['the technician was reassigned', () => { alert().tech_id = null; }],
    ['the technician was renamed', () => { S.tables.technicians[0].name = 'Renamed Tech'; }],
    ['the customer was renamed', () => { S.tables.customers[0].first_name = 'Robyn'; }],
    ['the visit moved', () => { S.tables.scheduled_services[0].scheduled_date = '2026-10-29'; }],
  ])('%s after the card: refused, nothing written', async (_label, change) => {
    const card = await preview();
    change();
    expect(await confirm(card)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(S.updates).toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('already resolved by someone else, or gone: refused with preview_changed, no second broadcast', async () => {
    const card = await preview();
    alert().resolved_at = new Date('2026-10-28T15:00:00Z');
    expect(await confirm(card)).toMatchObject({ code: 'already_resolved', preview_changed: true });
    alert().resolved_at = null;
    S.tables.dispatch_alerts = [];
    expect(await confirm(card)).toMatchObject({ code: 'alert_not_found', preview_changed: true });
    expect(S.updates).toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('a change that lands between the pre-check and the row lock is refused inside the transaction, nothing written', async () => {
    const card = await preview();
    S.beforeTx = () => { alert().resolved_at = new Date('2026-10-28T15:00:00Z'); };
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
    expect(S.updates).toEqual([]);
    expect(mockEmit).not.toHaveBeenCalled();
    S.tables.dispatch_alerts[0].resolved_at = null;
    S.beforeTx = () => { alert().payload = { delay_minutes: 99 }; };
    expect(await confirm(card)).toMatchObject({ failed: true, code: 'preview_changed' });
    expect(S.updates).toEqual([]);
  });

  test('an unknown failure is outcome_unknown unless the alert reads back resolved', async () => {
    const card = await preview();
    const spy = jest.spyOn(dispatchAlerts, 'resolveAlertAsDispatcher').mockRejectedValueOnce(new Error('boom'));
    expect(await confirm(card)).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    // The failure lands after the card's write was already visible (here: another dispatcher resolved it meanwhile).
    S.afterRollback = () => { alert().resolved_at = 'NOW'; };
    spy.mockRejectedValueOnce(new Error('late failure'));
    expect(await confirm(card)).toMatchObject({ success: true, warning: true });
    spy.mockRestore();
  });

  test('the resolve fails AND the read-back fails: outcome_unknown, never "resolved"', async () => {
    const card = await preview();
    const spy = jest.spyOn(dispatchAlerts, 'resolveAlertAsDispatcher').mockImplementationOnce(async () => { S.failReads = true; throw new Error('connection lost'); });
    const out = await confirm(card);
    expect(out).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    expect(out.success).toBeUndefined();
    expect(out.note).toBeUndefined();
    S.failReads = false;
    spy.mockRestore();
  });
});

describe('a request about one customer binds the alert to that customer (validateRecordTarget)', () => {
  const TaskContext = jest.requireActual('../services/intelligence-bar/task-context');
  const OTHER_CUST = '00000000-0000-4000-8000-0000000000d2';
  const OTHER_VISIT = '00000000-0000-4000-8000-0000000000b2';
  const check = (params, context, opts = {}) => TaskContext.validateRecordTarget(params, context, { toolName: 'resolve_dispatch_alert', ...opts });
  const forCustomer = { targets: [{ customer_id: CUST }] };

  beforeEach(() => {
    S.tables.customers.push({ id: OTHER_CUST, first_name: 'Sam', last_name: 'Other', company_name: null });
    S.tables.scheduled_services.push({ id: OTHER_VISIT, customer_id: OTHER_CUST, service_type: 'Lawn', scheduled_date: '2026-10-28', window_start: '09:00:00', window_end: '11:00:00', status: 'scheduled' });
    S.tables.dispatch_alerts.push({ id: OTHER_ALERT, type: 'missed_photo', severity: 'warn', tech_id: null, job_id: OTHER_VISIT, payload: null, created_at: new Date(), resolved_at: null, resolved_by: null });
  });

  test('"resolve the late alert for the Smith visit": an alert on the task customer\'s own visit is admitted, by alert_id or job_id', async () => {
    expect(await check({ alert_id: ALERT }, forCustomer)).toBeNull();
    expect(await check({ job_id: VISIT }, forCustomer)).toBeNull();
    const approval = await check({ alert_id: ALERT }, forCustomer, { forApproval: true });
    expect(approval.references).toEqual([{ kind: 'appointment_id', id: VISIT }]);
  });

  test('an alert on ANOTHER customer\'s visit is refused inside the task, by alert_id or job_id', async () => {
    expect(await check({ alert_id: OTHER_ALERT }, forCustomer)).toMatchObject({ code: 'target_clarification_required' });
    expect(await check({ job_id: OTHER_VISIT }, forCustomer)).toMatchObject({ code: 'target_clarification_required' });
  });

  test('an alert with no visit (no customer) is refused inside a customer task; a call with no selector is too (it would list every card)', async () => {
    alert().job_id = null;
    expect(await check({ alert_id: ALERT }, forCustomer)).toMatchObject({ code: 'customer_scope_required' });
    expect(await check({}, forCustomer)).toMatchObject({ code: 'customer_scope_required' });
    expect(await check({ alert_id: '00000000-0000-4000-8000-0000000000ff' }, forCustomer)).toMatchObject({ code: 'record_unavailable' });
    expect(await check({ alert_id: 'nope' }, forCustomer)).toMatchObject({ code: 'invalid_target' });
  });

  test('a named customer who did not resolve keeps the request customer-scoped: nothing is admitted', async () => {
    expect(await check({ alert_id: ALERT }, { namesRequested: true, targets: [] })).toMatchObject({ code: 'target_clarification_required' });
  });

  test('outside a customer-specific request any card passes, including one with no visit; the owner-direct login too', async () => {
    expect(await check({ alert_id: OTHER_ALERT }, {})).toBeNull();
    expect(await check({}, {})).toBeNull();
    alert().job_id = null;
    expect(await check({ alert_id: ALERT }, {})).toBeNull();
    expect(await check({ alert_id: OTHER_ALERT }, { ...forCustomer, ownerDirect: true })).toBeNull();
  });
});

describe('resolveAlertAsDispatcher (the function the board route and the bar share)', () => {
  test('resolves an open card: row, broadcast', async () => {
    const out = await dispatchAlerts.resolveAlertAsDispatcher({ id: ALERT, resolvedBy: TECH });
    expect(out).toMatchObject({ outcome: 'resolved', alert: { id: ALERT, resolved_by: TECH } });
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  test('a decision-only card is refused before anything is written', async () => {
    alert().type = 'visit_not_closed_out';
    expect(await dispatchAlerts.resolveAlertAsDispatcher({ id: ALERT, resolvedBy: TECH })).toEqual({ outcome: 'decision_required' });
    expect(S.updates).toEqual([]);
  });

  test('an already-resolved card returns its row, writes and broadcasts nothing; a missing one is not_found', async () => {
    alert().resolved_at = new Date('2026-10-28T15:00:00Z');
    const out = await dispatchAlerts.resolveAlertAsDispatcher({ id: ALERT, resolvedBy: TECH });
    expect(out).toMatchObject({ outcome: 'already_resolved', alert: { id: ALERT } });
    expect(mockEmit).not.toHaveBeenCalled();
    expect(await dispatchAlerts.resolveAlertAsDispatcher({ id: OTHER_ALERT, resolvedBy: TECH })).toEqual({ outcome: 'not_found' });
  });
});

describe('the board route runs the shared function and keeps its replies', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
  const start = source.indexOf("router.patch('/alerts/:id/resolve'");
  const route = source.slice(start, source.indexOf('\n});\n', start));

  test('PATCH /alerts/:id/resolve maps each outcome to its original reply', () => {
    expect(route).toContain('requireAdmin');
    expect(route).toContain('resolveAlertAsDispatcher({');
    expect(route).toContain("resolvedBy: req.technicianId");
    expect(route).toContain("res.status(409).json({ error: 'This card needs a decision. Use \"This was a miss\" or \"Not a miss\".', code: 'DECISION_REQUIRED' })");
    expect(route).toContain("res.status(404).json({ error: 'alert not found' })");
    expect(route).toContain('res.json({ alert: result.alert })');
  });

  test('the bulk Clear all route is untouched and the bar has no bulk tool', () => {
    expect(source).toContain("router.post('/alerts/resolve-all', requireAdmin");
    expect(DISPATCH_ALERT_TOOLS.map((t) => t.name)).toEqual(['resolve_dispatch_alert']);
    expect(Object.keys(DISPATCH_ALERT_TOOLS[0].input_schema.properties)).toEqual(['alert_id', 'job_id']);
  });
});
