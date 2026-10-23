/**
 * cancelServiceFromBar (admin-dispatch.js): the Intelligence Bar replays the Dispatch screen's own
 * PUT /:serviceId/status handler in-process (GATE_IB_CANCEL_WITH_EFFECTS, owner decision 2026-10-12). This suite runs
 * the REAL handler with its collaborators mocked and proves the replay sends the carded body only: this visit only,
 * the carded notifyCustomer (the cancellation text seam, handleCancellation, is told to send or to stay silent),
 * no fee waiver, and a before-commit check that runs under the visit lock and can stop the cancel.
 * Synthetic ids only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockTransitionJobStatus = jest.fn().mockResolvedValue({ ok: true, adminPayload: null });
jest.mock('../services/job-status', () => {
  const actual = jest.requireActual('../services/job-status');
  return { ...actual, transitionJobStatus: (...a) => mockTransitionJobStatus(...a) };
});
const mockHandleSeriesCancellation = jest.fn().mockResolvedValue(undefined);
// The cancellation text seam: handleCancellation sends only when sendNotification is not false.
const mockHandleCancellation = jest.fn(async (_id, opts) => { if (opts.outcome && opts.sendNotification !== false) opts.outcome.notificationSent = true; });
jest.mock('../services/appointment-reminders', () => ({
  handleSeriesCancellation: (...a) => mockHandleSeriesCancellation(...a),
  handleCancellation: (...a) => mockHandleCancellation(...a),
}));
const mockRunFollowThrough = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/visit-cancellation-followthrough', () => ({
  runVisitCancellationFollowThrough: (...a) => mockRunFollowThrough(...a),
}));
const mockReseed = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/recurring-series-cancel-reseed', () => ({
  runPostCancelSeriesReseed: (...a) => mockReseed(...a),
  cancelMayReseedPlan: () => false,
}));

jest.mock('../models/db', () => {
  const state = { rows: [], invoices: [], terms: [], pendingTerms: [], writes: [], reads: [] };
  const makeBuilder = (table) => {
    const b = {
      _where: {},
      where(w, op, val) {
        if (typeof w === 'function') { w.call(b); return b; }
        if (w && typeof w === 'object') Object.assign(b._where, w);
        else if (val === undefined) b._where[String(w).replace(/^scheduled_services\./, '')] = op;
        else (b._cmp ||= []).push([String(w).replace(/^scheduled_services\./, ''), op, val]);
        return b;
      },
      andWhere(...a) { return b.where(...a); },
      orWhere() { return b; },
      whereIn() { return b; },
      whereNotIn(col, vals) { if (String(col).replace(/^scheduled_services\./, '') === 'status') b._statusNotIn = vals; return b; },
      orWhereNotIn(col, vals) { if (col === 'status') b._statusNotIn = vals; return b; },
      whereNot() { return b; },
      whereNull(col) { (b._nullCols ||= []).push(String(col).replace(/^scheduled_services\./, '')); return b; },
      whereNotNull() { return b; },
      leftJoin() { return b; },
      count() { return b; },
      whereRaw() { return b; },
      whereNotExists() { return b; },
      orderBy() { return b; },
      forUpdate() { return b; },
      modify(cb) { cb(b); return b; },
      select() { return b; },
      async first() {
        // The recovery record (read by the request's cancel fence): no status, so liveFinish still sees "no open text".
        if (table === 'ib_cancel_effect_bundles') return { scheduled_service_id: 'svc-bar-1', restorations_seen: 0 };
        const rows = table === 'scheduled_services' ? state.rows : table === 'invoices' ? state.invoices : [];
        const cmp = (a, op, v) => (op === '>=' ? a >= v : op === '>' ? a > v : op === '<=' ? a <= v : op === '<' ? a < v : a === v);
        const found = rows.find((r) => Object.entries(b._where).every(([k, v]) => r[k] === v)
          && (b._cmp || []).every(([c, op, v]) => cmp(r[c], op, v))
          && !(b._statusNotIn && b._statusNotIn.includes(r.status)));
        state.reads.push({ table, where: { ...b._where }, cmp: b._cmp || [], notIn: b._statusNotIn || null });
        return found ? { ...found } : undefined;
      },
      async columnInfo() { return { recurring_ongoing: {} }; },
      update(u) {
        state.writes.push({ table, op: 'update', u });
        if (table === 'ib_cancel_effect_bundles') state.bundleUpdates += 1;
        const lost = table === 'ib_cancel_effect_bundles' && (state.bundleChangesNoRow || state.bundleLostAtUpdate === state.bundleUpdates);
        return { returning: async () => [], then: (res, rej) => Promise.resolve(lost ? 0 : 1).then(res, rej) };
      },
      insert(r) {
        state.writes.push({ table, op: 'insert', r });
        if (state.failInsert === table) return { returning: async () => { throw new Error('connection terminated'); }, then: (res, rej) => Promise.reject(new Error('connection terminated')).then(res, rej) };
        return { returning: async () => [{ id: 'x' }], then: (res, rej) => Promise.resolve([1]).then(res, rej) };
      },
      then(resolve, reject) {
        const rows = table === 'scheduled_services' ? state.rows.map((r) => ({ ...r }))
          : table === 'invoices' ? state.invoices.map((r) => ({ ...r }))
          : table === 'annual_prepay_terms as t' ? []
          : table === 'annual_prepay_terms' ? [] : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return b;
  };
  const dbFn = (table) => makeBuilder(table);
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = async () => ({});
  dbFn.schema = { hasTable: async () => true };
  dbFn.transaction = async (cb) => {
    state.writes.push({ table: '<trx>', op: 'begin' });
    const trx = (table) => makeBuilder(table);
    trx.fn = dbFn.fn; trx.raw = async () => ({}); trx.schema = dbFn.schema;
    try { const out = await cb(trx); state.writes.push({ table: '<trx>', op: 'commit' }); return out; }
    catch (e) { state.writes.push({ table: '<trx>', op: 'rollback' }); throw e; }
  };
  dbFn.__state = state;
  return dbFn;
});

const db = require('../models/db');
const { cancelServiceFromBar } = require('../routes/admin-dispatch');

const future = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

beforeEach(() => {
  db.__state.rows = [
    { id: 'svc-bar-1', technician_id: 'tech-2', customer_id: 'cust-bar', status: 'confirmed', scheduled_date: future(3), service_type: 'Pest Control', is_recurring: true, recurring_pattern: 'quarterly', recurring_parent_id: null, recurring_ongoing: true, annual_prepay_term_id: null, prepaid_amount: null, source_action: null, customer_confirmed: true },
  ];
  db.__state.writes = []; db.__state.reads = []; db.__state.failInsert = null; db.__state.bundleChangesNoRow = false; db.__state.bundleLostAtUpdate = null; db.__state.bundleUpdates = 0;
  jest.clearAllMocks();
});

const ACTOR = { technicianId: 'admin-1' };

describe('cancelServiceFromBar hands the card\'s approvals to the handler', () => {
  test('the approved text goes to handleCancellation and the approved linked visits to the follow-through, with an empty skip report', async () => {
    const approvedNotice = [{ recipient_key: 'abc123abc123abc1', body: 'Hi Synthia, your visit is cancelled.' }];
    const linkedChildren = [{ id: 'child-1', status: 'confirmed', scheduled_date: '2026-11-02', service_type: 'pest_control' }];
    const { status, json } = await cancelServiceFromBar({ serviceId: 'svc-bar-1', notifyCustomer: true, actor: ACTOR, approvedNotice, linkedChildren });
    expect(status).toBe(200);
    expect(mockHandleCancellation.mock.calls[0][1].approvedNotice).toBe(approvedNotice);
    // The cancel transaction mints the claim as pending_approved, a state no sweep adopts.
    expect(mockTransitionJobStatus.mock.calls[0][0].cancelNoticeApproved).toBe(true);
    expect(mockRunFollowThrough.mock.calls[0][0].linkedChildren).toBe(linkedChildren);
    expect(mockRunFollowThrough.mock.calls[0][0].linkedChildReport).toEqual({ skipped: [] });
    expect(json.linkedVisitsSkipped).toEqual([]);
  });

  test('a linked visit the cascade skipped comes back in the reply', async () => {
    mockRunFollowThrough.mockImplementationOnce(async ({ linkedChildReport }) => { linkedChildReport.skipped.push({ id: 'child-1', reason: 'date_changed' }); });
    const { json } = await cancelServiceFromBar({ serviceId: 'svc-bar-1', notifyCustomer: true, actor: ACTOR, linkedChildren: [{ id: 'child-1' }] });
    expect(json.linkedVisitsSkipped).toEqual([{ id: 'child-1', reason: 'date_changed' }]);
  });

  test('the card\'s money effects reach the follow-through as pinnedEffects with a report; skipped effects come back in the reply', async () => {
    const approvedMoney = { invoices: [{ id: 'inv-1', total: 120, credit_applied: 0, deposit_credit: 0 }], creditReversalOfferIds: ['offer-1'] };
    mockRunFollowThrough.mockImplementationOnce(async ({ moneyReport }) => { moneyReport.skipped.push({ kind: 'invoice', id: 'inv-1', reason: 'not_voided_changed_since_card' }); });
    const { json } = await cancelServiceFromBar({ serviceId: 'svc-bar-1', notifyCustomer: true, actor: ACTOR, approvedMoney });
    const call = mockRunFollowThrough.mock.calls[0][0];
    expect(call.pinnedEffects).toEqual({ 'svc-bar-1': approvedMoney });
    // The shared status writer's UNPINNED invoice void / credit reversal stands down, so nothing runs on live state
    // before the pinned follow-through (and approved effects are not double-counted as skipped).
    expect(mockTransitionJobStatus.mock.calls[0][0].moneySeam).toBe('caller');
    expect(call.waiveFee).toBe(false);
    expect(json.moneySkipped).toEqual([{ kind: 'invoice', id: 'inv-1', reason: 'not_voided_changed_since_card' }]);
  });

  test('with no approvals the handler\'s calls carry none of the opt-in keys (a Dispatch cancel is unchanged)', async () => {
    const { json } = await cancelServiceFromBar({ serviceId: 'svc-bar-1', notifyCustomer: true, actor: ACTOR });
    expect(Object.keys(mockHandleCancellation.mock.calls[0][1])).not.toContain('approvedNotice');
    expect(Object.keys(mockTransitionJobStatus.mock.calls[0][0])).not.toContain('cancelNoticeApproved');
    expect(Object.keys(mockRunFollowThrough.mock.calls[0][0])).not.toContain('linkedChildren');
    expect(Object.keys(mockRunFollowThrough.mock.calls[0][0])).not.toContain('pinnedEffects');
    expect(Object.keys(mockRunFollowThrough.mock.calls[0][0])).not.toContain('moneyReport');
    expect(json.moneySkipped).toBeUndefined();
    expect(json.linkedVisitsSkipped).toBeUndefined();
  });
});

describe('a failure AFTER the cancel committed does not reject the replay', () => {
  test('the activity log insert failing resolves a committed success with the text outcome and the reports, flagged postCommitFailure', async () => {
    db.__state.failInsert = 'activity_log';
    const linkedChildren = [{ id: 'child-1', status: 'confirmed', scheduled_date: '2026-11-02', service_type: 'pest_control' }];
    mockRunFollowThrough.mockImplementationOnce(async ({ linkedChildReport }) => { linkedChildReport.skipped.push({ id: 'child-1', reason: 'date_changed' }); });
    const { status, json } = await cancelServiceFromBar({ serviceId: 'svc-bar-1', notifyCustomer: true, actor: ACTOR, linkedChildren });
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, notificationSent: true, postCommitFailure: 'connection terminated' });
    expect(json.linkedVisitsSkipped).toEqual([{ id: 'child-1', reason: 'date_changed' }]);
    // The cancel, the text and the follow-through all ran before the failing step.
    expect(mockTransitionJobStatus).toHaveBeenCalledTimes(1);
    expect(mockHandleCancellation).toHaveBeenCalledTimes(1);
    expect(mockRunFollowThrough).toHaveBeenCalledTimes(1);
  });

  test('a failure BEFORE the commit still rejects (nothing was cancelled)', async () => {
    mockTransitionJobStatus.mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(cancelServiceFromBar({ serviceId: 'svc-bar-1', notifyCustomer: true, actor: ACTOR })).rejects.toThrow('deadlock detected');
    expect(mockHandleCancellation).not.toHaveBeenCalled();
  });
});

describe('cancelServiceFromBar replays the Dispatch cancel handler with the carded body only', () => {
  test('with a text: this visit only, the text seam told to send, no fee waiver, follow-through on this visit', async () => {
    const { status, json } = await cancelServiceFromBar({ serviceId: 'svc-bar-1', notifyCustomer: true, notes: 'Cancelled via Intelligence Bar: rain', actor: ACTOR });
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, notificationSent: true });
    expect(mockTransitionJobStatus).toHaveBeenCalledTimes(1);
    expect(mockTransitionJobStatus.mock.calls[0][0]).toMatchObject({
      jobId: 'svc-bar-1', fromStatus: 'confirmed', toStatus: 'cancelled', transitionedBy: 'admin-1',
      notes: 'Cancelled via Intelligence Bar: rain', notifyCustomer: 'caller',
    });
    expect(mockHandleCancellation).toHaveBeenCalledTimes(1);
    expect(mockHandleCancellation.mock.calls[0][0]).toBe('svc-bar-1');
    expect(mockHandleCancellation.mock.calls[0][1].sendNotification).toBe(true);
    expect(mockRunFollowThrough).toHaveBeenCalledTimes(1);
    expect(mockRunFollowThrough.mock.calls[0][0]).toMatchObject({ targetIds: ['svc-bar-1'], actorId: 'admin-1', waiveFee: false, source: 'admin-dispatch' });
    // Never the series: the series branch (and its plan stop) is not entered.
    expect(mockHandleSeriesCancellation).not.toHaveBeenCalled();
    expect(db.__state.writes.some((w) => w.u && 'recurring_ongoing' in w.u)).toBe(false);
    expect(mockReseed).toHaveBeenCalledTimes(1);
  });

  test('without a text: the shared notice hook stands down silently and the text seam is told NOT to send', async () => {
    const { status, json } = await cancelServiceFromBar({ serviceId: 'svc-bar-1', notifyCustomer: false, actor: ACTOR });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.notificationSent).toBeUndefined();
    expect(mockTransitionJobStatus.mock.calls[0][0].notifyCustomer).toBe('caller_suppress');
    expect(mockHandleCancellation).toHaveBeenCalledTimes(1);
    expect(mockHandleCancellation.mock.calls[0][1].sendNotification).toBe(false);
    expect(mockHandleCancellation.mock.calls[0][1].outcome).toBeUndefined();
  });

  test('a card that chose NO text persists its disposition: the writer is told cancelNoticeApproved with caller_suppress (terminal suppressed marker, whatever the hook gate says)', async () => {
    await cancelServiceFromBar({ serviceId: 'svc-bar-1', notifyCustomer: false, actor: ACTOR });
    expect(mockTransitionJobStatus.mock.calls[0][0]).toMatchObject({ notifyCustomer: 'caller_suppress', cancelNoticeApproved: true });
  });

  test('beforeCommit runs under the visit lock, before the status transition', async () => {
    const order = [];
    mockTransitionJobStatus.mockImplementationOnce(async () => { order.push('transition'); return { ok: true, adminPayload: null }; });
    await cancelServiceFromBar({
      serviceId: 'svc-bar-1', notifyCustomer: true, actor: ACTOR,
      beforeCommit: async (trx) => { order.push(typeof trx === 'function' ? 'hook-in-trx' : 'hook-no-trx'); },
    });
    expect(order).toEqual(['hook-in-trx', 'transition']);
  });

  test('a beforeCommit that throws preview_changed stops the cancel: 409, nothing transitioned, no text, no follow-through', async () => {
    const { status, json } = await cancelServiceFromBar({
      serviceId: 'svc-bar-1', notifyCustomer: true, actor: ACTOR,
      beforeCommit: async () => { throw Object.assign(new Error('changed since the card'), { status: 409, code: 'preview_changed' }); },
    });
    expect(status).toBe(409);
    expect(json).toEqual({ error: 'changed since the card', code: 'preview_changed' });
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockRunFollowThrough).not.toHaveBeenCalled();
    expect(db.__state.writes.at(-1)).toEqual({ table: '<trx>', op: 'rollback' });
  });

  test('a completed visit is refused by the handler itself (already_terminal), never turned into a series cancel', async () => {
    db.__state.rows[0].status = 'completed';
    const { status, json } = await cancelServiceFromBar({ serviceId: 'svc-bar-1', notifyCustomer: true, actor: ACTOR });
    expect(status).toBe(409);
    expect(json.code).toBe('already_terminal');
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  });

  test('an unknown visit is the handler\'s own 404', async () => {
    const { status, json } = await cancelServiceFromBar({ serviceId: 'svc-missing', notifyCustomer: true, actor: ACTOR });
    expect(status).toBe(404);
    expect(json.error).toBe('Service not found');
  });
});

// The recovery record (ib_cancel_effect_bundles, services/ib-cancel-effect-bundles.js): with `recovery` the cancel
// transaction also saves what the card approved, and the request marks it complete when its follow-through returns.
describe('the recovery bundle rides the cancel transaction', () => {
  const BUNDLE = 'ib_cancel_effect_bundles';
  const bundleWrites = () => db.__state.writes.filter((w) => w.table === BUNDLE);
  const approvedMoney = { invoices: [{ id: 'inv-1', total: 120 }], creditReversalOfferIds: ['offer-1'] };
  const approvedNotice = [{ recipient_key: 'abc123abc123abc1', body: 'Hi Synthia, your visit is cancelled.' }];
  const linkedChildren = [{ id: 'child-1', status: 'confirmed', scheduled_date: '2026-11-02', service_type: 'pest_control' }];
  const run = (extra = {}) => cancelServiceFromBar({
    serviceId: 'svc-bar-1', notifyCustomer: true, notes: 'Cancelled via Intelligence Bar: rain', actor: ACTOR,
    approvedNotice, linkedChildren, approvedMoney, recovery: { pendingActionId: 'action-1' }, ...extra,
  });

  test('the bundle holds exactly the card\'s approvals and is written inside the transaction, after the re-check and before the status change', async () => {
    const order = [];
    mockTransitionJobStatus.mockImplementationOnce(async () => {
      order.push(bundleWrites().some((w) => w.op === 'insert') ? 'bundle-then-transition' : 'transition-first');
      return { ok: true, adminPayload: null };
    });
    await run({ beforeCommit: async () => { order.push(bundleWrites().length === 0 ? 'recheck-first' : 'recheck-late'); } });
    expect(order).toEqual(['recheck-first', 'bundle-then-transition']);
    const insert = bundleWrites().find((w) => w.op === 'insert');
    expect(insert.r).toMatchObject({
      pending_action_id: 'action-1', scheduled_service_id: 'svc-bar-1', actor_id: 'admin-1', notify_customer: true,
      notes: 'Cancelled via Intelligence Bar: rain', lease_owner: 'request', restorations_seen: 0,
    });
    expect(JSON.parse(insert.r.approved_notice)).toEqual(approvedNotice);
    // Each child also pins its own restoration count (none here).
    expect(JSON.parse(insert.r.linked_children)).toEqual(linkedChildren.map((child) => ({ ...child, restorations_seen: 0 })));
    expect(JSON.parse(insert.r.approved_money)).toEqual(approvedMoney);
    const begin = db.__state.writes.findIndex((w) => w.op === 'begin');
    const commit = db.__state.writes.findIndex((w) => w.op === 'commit');
    const at = db.__state.writes.indexOf(insert);
    expect(begin).toBeLessThan(at);
    expect(at).toBeLessThan(commit);
  });

  test('a card that chose no text saves that choice (no approved bodies)', async () => {
    await run({ notifyCustomer: false, approvedNotice: null });
    const insert = bundleWrites().find((w) => w.op === 'insert');
    expect(insert.r.notify_customer).toBe(false);
    expect(insert.r.approved_notice).toBeNull();
  });

  test('the request keeps its lease, notes the text outcome, and marks the bundle complete only AFTER the follow-through returns', async () => {
    let writesAtFollowThrough = null;
    mockRunFollowThrough.mockImplementationOnce(async ({ moneyReport }) => {
      writesAtFollowThrough = db.__state.writes.length;
      moneyReport.skipped.push({ kind: 'invoice', id: 'inv-1', reason: 'not_voided_changed_since_card' });
    });
    await run();
    const updates = bundleWrites().filter((w) => w.op === 'update').map((w) => w.u);
    expect(updates[0]).toMatchObject({ lease_owner: 'request' });
    expect(updates[1].notice_outcome).toBe(JSON.stringify({ state: 'sent', by: 'request' }));
    const done = updates.find((u) => u.status === 'complete');
    expect(done).toBeTruthy();
    expect(JSON.parse(done.followthrough_outcome)).toEqual({ money_skipped: [{ kind: 'invoice', id: 'inv-1', reason: 'not_voided_changed_since_card' }], linked_skipped: [] });
    const doneAt = db.__state.writes.findIndex((w) => w.table === BUNDLE && w.u && w.u.status === 'complete');
    expect(doneAt).toBeGreaterThanOrEqual(writesAtFollowThrough);
  });

  test('a request the sweep overtook (its bundle writes change no row) tells the caller the recovery owns the outcome', async () => {
    db.__state.bundleChangesNoRow = true;
    const { json } = await run();
    expect(json.success).toBe(true);
    expect(json.recoveryOwnsOutcome).toBe(true);
    // The sweep owns the effects now: a paused request that resumes sends no text and moves no money.
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockRunFollowThrough).not.toHaveBeenCalled();
  });

  test('a request that loses the bundle during the text step runs no money, linked-visit or tracker step', async () => {
    // Update 1 is the heartbeat; update 2 is the text outcome, which changes no row (the sweep took the bundle meanwhile).
    db.__state.bundleLostAtUpdate = 2;
    const { json } = await run();
    expect(json.success).toBe(true);
    expect(json.recoveryOwnsOutcome).toBe(true);
    expect(mockHandleCancellation).toHaveBeenCalledTimes(1);
    expect(mockRunFollowThrough).not.toHaveBeenCalled();
    expect(bundleWrites().some((w) => w.op === 'update' && w.u.status === 'complete')).toBe(false);
  });

  test('a lease that cannot be renewed after the text step stops the follow-through too', async () => {
    db.__state.bundleLostAtUpdate = 3;
    const { json } = await run();
    expect(json.recoveryOwnsOutcome).toBe(true);
    expect(mockRunFollowThrough).not.toHaveBeenCalled();
  });

  test('the follow-through runs under the cancel fence carrying the bundle and the request lease', async () => {
    await run();
    const args = mockRunFollowThrough.mock.calls[0][0];
    expect(args.cancelFence).toMatchObject({ visitId: 'svc-bar-1', restorations: 0, bundleId: 'x', leaseToken: 'request', hits: [] });
  });

  test.each([
    ['the lease was taken over', 'lease_lost', false],
    ['the visit was restored meanwhile', 'visit_restored_since', true],
  ])('a fence refusal in the follow-through (%s) stands the request down: the sweep owns the outcome', async (_label, hit, released) => {
    mockRunFollowThrough.mockImplementationOnce(async ({ cancelFence }) => { cancelFence.hits.push(hit); });
    const { json } = await run();
    expect(json.recoveryOwnsOutcome).toBe(true);
    const updates = bundleWrites().filter((w) => w.op === 'update').map((w) => w.u);
    expect(updates.some((u) => u.status === 'complete')).toBe(false);
    // The request lease is released unless another owner already holds the bundle.
    expect(updates.some((u) => u.lease_owner === null && u.lease_until === null)).toBe(released);
  });

  test('an approved text with no terminal outcome: the reply carries textRetryScheduled (the sweep sends it)', async () => {
    const bundles = require('../services/ib-cancel-effect-bundles');
    const spy = jest.spyOn(bundles, 'liveFinish').mockImplementationOnce(async (req) => { req.ibCancelTextPending = true; });
    const { json } = await run();
    spy.mockRestore();
    expect(json.success).toBe(true);
    expect(json.textRetryScheduled).toBe(true);
    expect((await run()).json.textRetryScheduled).toBeUndefined();
  });

  test('the normal path (the request still owns its bundle) carries no such flag', async () => {
    const { json } = await run();
    expect(json.recoveryOwnsOutcome).toBeUndefined();
  });

  test('a follow-through that throws leaves the bundle PENDING for the recovery sweep, and the reply says a step failed', async () => {
    mockRunFollowThrough.mockRejectedValueOnce(new Error('connection terminated'));
    const { status, json } = await run();
    expect(status).toBe(200);
    expect(json.postCommitFailure).toBe('connection terminated');
    expect(bundleWrites().some((w) => w.u && w.u.status === 'complete')).toBe(false);
  });

  test('a bundle that cannot be written aborts the cancel: nothing transitions, no text, no follow-through', async () => {
    db.__state.failInsert = BUNDLE;
    await expect(run()).rejects.toThrow('connection terminated');
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(mockRunFollowThrough).not.toHaveBeenCalled();
    expect(db.__state.writes.at(-1)).toEqual({ table: '<trx>', op: 'rollback' });
  });

  test('a re-check refusal (preview_changed) writes no bundle', async () => {
    const { status } = await run({ beforeCommit: async () => { throw Object.assign(new Error('changed'), { status: 409, code: 'preview_changed' }); } });
    expect(status).toBe(409);
    expect(bundleWrites()).toEqual([]);
  });

  test('a transition that fails after the bundle insert rolls back with the transaction (the insert is inside it)', async () => {
    mockTransitionJobStatus.mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(run()).rejects.toThrow('deadlock detected');
    expect(db.__state.writes.at(-1)).toEqual({ table: '<trx>', op: 'rollback' });
    expect(bundleWrites().some((w) => w.u && w.u.status === 'complete')).toBe(false);
  });

  test('without `recovery` no bundle is written (older callers and the Dispatch screen are unchanged)', async () => {
    await run({ recovery: undefined });
    expect(bundleWrites()).toEqual([]);
  });
});
