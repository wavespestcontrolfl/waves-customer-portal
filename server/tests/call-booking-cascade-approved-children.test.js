/**
 * cancelCallFollowUpsForParentCancel with `approvedChildren` (opt-in; the Intelligence Bar cancel card,
 * GATE_IB_CANCEL_WITH_EFFECTS). The cascade cancels ONLY the linked visits the card approved, each one after it is
 * re-read under its OWN row lock and still matches the card (live linked follow-up, same status, date and service, no
 * invoice of its own). Anything else is NOT cancelled and is reported in report.skipped. Synthetic ids only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn().mockResolvedValue(undefined) }));
const mockChildMoney = jest.fn();
jest.mock('../services/appointment-cancel-impact', () => ({ linkedChildMoneyReason: (...a) => mockChildMoney(...a) }));
const mockFence = jest.fn(async () => {});
const mockCount = jest.fn(async () => 0);
jest.mock('../services/cancel-generation-fence', () => ({ assertCancelGeneration: (...a) => mockFence(...a), countRestorations: (...a) => mockCount(...a) }));
const { transitionJobStatus } = require('../services/job-status');
const { cancelCallFollowUpsForParentCancel } = require('../services/call-booking-catalog');

// Fake knex: the child SELECT returns `children`; inside a transaction the locked re-read returns `locked[id]`.
function fakeConn({ children, locked }) {
  const log = { updates: [], lockedReads: [], forUpdate: 0 };
  const conn = () => {
    const chain = { where: () => chain, whereRaw: () => chain, select: () => Promise.resolve(children) };
    return chain;
  };
  conn.transaction = async (fn) => {
    const trx = (table) => {
      let childId = null;
      let forUpdate = false;
      const chain = {
        where: (a, b) => { if (a === 'id') childId = b; return chain; },
        whereRaw: () => chain,
        forUpdate: () => { forUpdate = true; log.forUpdate += 1; return chain; },
        first: async () => { log.lockedReads.push({ childId, forUpdate }); return locked[childId] || null; },
        update: (payload) => { log.updates.push({ table, childId, payload }); return Promise.resolve(1); },
      };
      return chain;
    };
    return fn(trx);
  };
  return { conn, log };
}

const CHILD = { id: 'child-1', status: 'confirmed', source_action: 'package_followup_auto', scheduled_date: '2026-11-02', service_type: 'pest_control', technician_id: 'tech-9' };
const APPROVED = { id: 'child-1', status: 'confirmed', scheduled_date: '2026-11-02', service_type: 'pest_control', technician_id: 'tech-9' };

beforeEach(() => {
  jest.clearAllMocks();
  transitionJobStatus.mockResolvedValue(undefined);
  mockChildMoney.mockResolvedValue(null);
  mockFence.mockResolvedValue(undefined);
  mockCount.mockReset();
  mockCount.mockResolvedValue(0);
});

const run = ({ children = [CHILD], locked = { 'child-1': { ...CHILD } }, approvedChildren = [APPROVED] } = {}) => {
  const { conn, log } = fakeConn({ children, locked });
  const report = { skipped: [] };
  return cancelCallFollowUpsForParentCancel({ conn, parentServiceId: 'svc-parent', approvedChildren, report }).then((cancelled) => ({ cancelled, report, log }));
};

describe('cancelCallFollowUpsForParentCancel with approvedChildren', () => {
  test('an approved child that still matches is cancelled after being read under its own FOR UPDATE lock', async () => {
    const { cancelled, report, log } = await run();
    expect(cancelled).toBe(1);
    expect(report.skipped).toEqual([]);
    expect(log.lockedReads).toEqual([{ childId: 'child-1', forUpdate: true }]);
    expect(transitionJobStatus).toHaveBeenCalledTimes(1);
    expect(log.updates).toHaveLength(1);
  });

  test('an approved cascade texts no child (call-booked or package), whatever the child\'s kind', async () => {
    const call = { id: 'child-1', status: 'pending', source_action: 'ai_call_pipeline_followup', scheduled_date: '2026-11-02', service_type: 'pest_control', technician_id: 'tech-9' };
    await run({ children: [call], locked: { 'child-1': { ...call } }, approvedChildren: [{ ...APPROVED, status: 'pending' }] });
    expect(transitionJobStatus.mock.calls[0][0].notifyCustomer).toBe(false);
  });

  test('an approved cascade hands the money seam to the caller, so money that lands after the lock check is never voided or reversed unpinned', async () => {
    await run();
    expect(transitionJobStatus.mock.calls[0][0].moneySeam).toBe('caller');
  });

  test('an approved child gets the durable no-text disposition (terminal suppressed marker) whatever the hook gate says', async () => {
    await run();
    const args = transitionJobStatus.mock.calls[0][0];
    expect(args.notifyCustomer).toBe(false);
    expect(args.cancelNoticeApproved).toBe(true);
  });

  test('an approved child whose marker could not be written (an older claim holds its reminder) is not cancelled and is reported', async () => {
    transitionJobStatus.mockRejectedValueOnce(new Error('approved cancellation text: an older notice claim holds this reminder, so the approved marker could not be written'));
    const { cancelled, report } = await run();
    expect(cancelled).toBe(0);
    expect(report.skipped).toEqual([{ id: 'child-1', reason: 'cancel_failed' }]);
  });

  test('without approvedChildren the child does not carry cancelNoticeApproved', async () => {
    const { conn } = fakeConn({ children: [CHILD], locked: {} });
    await cancelCallFollowUpsForParentCancel({ conn, parentServiceId: 'svc-parent' });
    expect(Object.keys(transitionJobStatus.mock.calls[0][0])).not.toContain('cancelNoticeApproved');
  });

  test('without approvedChildren the child keeps the ordinary money seam (no moneySeam key)', async () => {
    const { conn } = fakeConn({ children: [CHILD], locked: {} });
    await cancelCallFollowUpsForParentCancel({ conn, parentServiceId: 'svc-parent' });
    expect(Object.keys(transitionJobStatus.mock.calls[0][0])).not.toContain('moneySeam');
  });

  test('without approvedChildren a call-booked child keeps its own notice behavior (unchanged)', async () => {
    const call = { id: 'child-1', status: 'pending', source_action: 'ai_call_pipeline_followup' };
    const { conn } = fakeConn({ children: [call], locked: {} });
    await cancelCallFollowUpsForParentCancel({ conn, parentServiceId: 'svc-parent' });
    expect(Object.keys(transitionJobStatus.mock.calls[0][0])).not.toContain('notifyCustomer');
  });

  test('a linked visit that is NOT on the card is left alone and reported', async () => {
    const { cancelled, report } = await run({ approvedChildren: [] });
    expect(cancelled).toBe(0);
    expect(report.skipped).toEqual([{ id: 'child-1', reason: 'not_on_card' }]);
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test.each([
    ['moved to another date', { scheduled_date: '2026-11-09' }, 'date_changed'],
    ['status changed', { status: 'pending' }, 'status_changed'],
    ['service changed', { service_type: 'lawn_care' }, 'service_changed'],
    ['was reassigned to another technician (its own cancel notice would go to someone the card did not show)', { technician_id: 'tech-10' }, 'technician_changed'],
    ['lost its technician', { technician_id: null }, 'technician_changed'],
    ['was grouped (visit_id set; package follow-ups group automatically, and a grouped cancel runs the group hook)', { visit_id: 'visit-grp-1' }, 'grouped_changed'],
  ])('an approved child that %s since the card is NOT cancelled and is reported (%s)', async (_label, patch, reason) => {
    const { cancelled, report, log } = await run({ locked: { 'child-1': { ...CHILD, ...patch } } });
    expect(cancelled).toBe(0);
    expect(report.skipped).toEqual([{ id: 'child-1', reason }]);
    expect(transitionJobStatus).not.toHaveBeenCalled();
    expect(log.updates).toEqual([]);
  });

  test('a card from before technicians were pinned (no technician_id key) is not refused on that field', async () => {
    const { technician_id: _t, ...legacy } = APPROVED;
    const { cancelled, report } = await run({ approvedChildren: [legacy] });
    expect(cancelled).toBe(1);
    expect(report.skipped).toEqual([]);
  });

  test.each([
    ['an invoice', 'invoice'],
    ['prepaid coverage', 'prepaid_or_coverage'],
    ['a card hold or request', 'card_rail'],
    ['an inspection-credit offer', 'inspection_credit'],
    ['estimate money', 'estimate_money'],
  ])('an approved child that gained %s since the card is NOT cancelled, reaches no money seam, and is reported with the reason', async (_label, reason) => {
    mockChildMoney.mockResolvedValue(reason);
    const { cancelled, report, log } = await run();
    expect(cancelled).toBe(0);
    expect(report.skipped).toEqual([{ id: 'child-1', reason: `money_added_${reason}` }]);
    expect(transitionJobStatus).not.toHaveBeenCalled();
    expect(log.updates).toEqual([]);
  });

  test('the full money check runs on the child\'s own transaction (not the shared connection) for that child only', async () => {
    await run();
    expect(mockChildMoney).toHaveBeenCalledTimes(1);
    const [conn, kids] = mockChildMoney.mock.calls[0];
    expect(typeof conn).toBe('function');
    expect(kids).toEqual([{ id: 'child-1' }]);
  });

  test('an approved child that is no longer a live linked follow-up (gone under the lock) is reported', async () => {
    const { cancelled, report } = await run({ locked: {} });
    expect(cancelled).toBe(0);
    expect(report.skipped).toEqual([{ id: 'child-1', reason: 'no_longer_linked' }]);
  });

  test('an approved child that fails for a reason other than drift (a database or transition error) is reported, not just logged', async () => {
    transitionJobStatus.mockRejectedValueOnce(new Error('deadlock detected'));
    const { cancelled, report } = await run();
    expect(cancelled).toBe(0);
    expect(report.skipped).toEqual([{ id: 'child-1', reason: 'cancel_failed' }]);
  });

  test('an approved child that no longer appears in the live set at all is reported', async () => {
    const { cancelled, report } = await run({ children: [] });
    expect(cancelled).toBe(0);
    expect(report.skipped).toEqual([{ id: 'child-1', reason: 'no_longer_linked' }]);
  });

  test('one child changing does not stop the others: only the changed one is skipped', async () => {
    const two = { id: 'child-2', status: 'pending', source_action: 'ai_call_pipeline_followup', scheduled_date: '2026-11-03', service_type: 'pest_control' };
    const { cancelled, report } = await run({
      children: [CHILD, two],
      locked: { 'child-1': { ...CHILD }, 'child-2': { ...two, scheduled_date: '2026-11-10' } },
      approvedChildren: [APPROVED, { id: 'child-2', status: 'pending', scheduled_date: '2026-11-03', service_type: 'pest_control' }],
    });
    expect(cancelled).toBe(1);
    expect(report.skipped).toEqual([{ id: 'child-2', reason: 'date_changed' }]);
  });

  test('without approvedChildren nothing is locked or re-checked (every existing caller is unchanged)', async () => {
    const { conn, log } = fakeConn({ children: [CHILD], locked: {} });
    const cancelled = await cancelCallFollowUpsForParentCancel({ conn, parentServiceId: 'svc-parent' });
    expect(cancelled).toBe(1);
    expect(log.forUpdate).toBe(0);
    expect(mockChildMoney).not.toHaveBeenCalled();
  });
});

// Recovery sweep only (services/cancel-generation-fence.js): each child's cancel re-proves, in the child's own
// transaction and after the child's lock, that the PARENT is still the cancelled visit the card approved.
describe('cancelCallFollowUpsForParentCancel with parentFence', () => {
  const FENCE = { visitId: 'svc-parent', restorations: 0, hits: [] };
  const runFenced = ({ children = [CHILD], locked = { 'child-1': { ...CHILD } } } = {}) => {
    const { conn, log } = fakeConn({ children, locked });
    const report = { skipped: [] };
    return cancelCallFollowUpsForParentCancel({ conn, parentServiceId: 'svc-parent', approvedChildren: [APPROVED], report, parentFence: FENCE })
      .then((cancelled) => ({ cancelled, report, log }));
  };

  test('the fence runs inside the child transaction, after the child lock, before the child is cancelled', async () => {
    const order = [];
    mockFence.mockImplementationOnce(async (trx, fence) => { order.push(['fence', typeof trx, fence]); });
    transitionJobStatus.mockImplementationOnce(async () => { order.push(['transition']); });
    const { cancelled, log } = await runFenced();
    expect(cancelled).toBe(1);
    expect(log.lockedReads).toEqual([{ childId: 'child-1', forUpdate: true }]);
    expect(order).toEqual([['fence', 'function', FENCE], ['transition']]);
  });

  test('a parent that is busy (a restore in flight) or no longer the approved cancel leaves the child active and reported', async () => {
    for (const fenceReason of ['visit_busy', 'visit_is_confirmed', 'visit_restored_since']) {
      transitionJobStatus.mockClear();
      mockFence.mockRejectedValueOnce(Object.assign(new Error(`cancellation fence: ${fenceReason}`), { code: 'CANCEL_FENCE', fenceReason }));
      const { cancelled, report, log } = await runFenced();
      expect(cancelled).toBe(0);
      expect(report.skipped).toEqual([{ id: 'child-1', reason: `parent_${fenceReason}` }]);
      expect(transitionJobStatus).not.toHaveBeenCalled();
      expect(log.updates).toEqual([]);
    }
  });

  test('without a parentFence the fence is never consulted (the request path and every other caller are unchanged)', async () => {
    await run();
    expect(mockFence).not.toHaveBeenCalled();
  });
});

// The cancel recovery sweep pins each child's restoration count with the bundle. A child the dead request already cancelled and an
// operator then restored matches its card again; the pinned count, compared under the child's own lock, says it was restored.
describe('approved children with a pinned restoration count', () => {
  const pinned = (n) => [{ ...APPROVED, restorations_seen: n }];
  const runPinned = (n, locked = { 'child-1': { ...CHILD } }) => {
    const { conn, log } = fakeConn({ children: [CHILD], locked });
    const report = { skipped: [] };
    return cancelCallFollowUpsForParentCancel({ conn, parentServiceId: 'svc-parent', approvedChildren: pinned(n), report })
      .then((cancelled) => ({ cancelled, report, log }));
  };

  test('an unchanged generation is cancelled, with the count read under the child lock', async () => {
    mockCount.mockResolvedValue(1);
    const { cancelled, report } = await runPinned(1);
    expect(cancelled).toBe(1);
    expect(report.skipped).toEqual([]);
    expect(mockCount).toHaveBeenCalledWith(expect.anything(), 'child-1');
  });

  test('a child restored since (higher count) is NOT cancelled a second time and is reported', async () => {
    mockCount.mockResolvedValue(2);
    const { cancelled, report } = await runPinned(1);
    expect(cancelled).toBe(0);
    expect(report.skipped).toEqual([{ id: 'child-1', reason: 'child_restored_since' }]);
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('a card child with no pinned count (the request path) never reads the history', async () => {
    await run();
    expect(mockCount).not.toHaveBeenCalled();
  });
});

describe('a child cancel that fails for a reason other than a refusal (the cancel recovery sweep)', () => {
  test('with a parentFence it is a retryable hit and still listed as cancel_failed; a deliberate refusal records no such hit', async () => {
    const { conn } = fakeConn({ children: [{ id: 'child-1', status: 'confirmed' }], locked: { 'child-1': { id: 'child-1', status: 'confirmed' } } });
    transitionJobStatus.mockRejectedValueOnce(new Error('connection terminated'));
    const report = { skipped: [] };
    const fence = { visitId: 'svc-1', restorations: 0, hits: [] };
    await cancelCallFollowUpsForParentCancel({ conn, parentServiceId: 'svc-1', approvedChildren: [{ id: 'child-1', status: 'confirmed' }], report, parentFence: fence });
    expect(fence.hits).toEqual(['child_cancel_error']);
    expect(report.skipped).toEqual([{ id: 'child-1', reason: 'cancel_failed' }]);
    // Without a fence the report is the only effect (unchanged).
    transitionJobStatus.mockRejectedValueOnce(new Error('connection terminated'));
    const plain = { skipped: [] };
    await cancelCallFollowUpsForParentCancel({ conn, parentServiceId: 'svc-1', approvedChildren: [{ id: 'child-1', status: 'confirmed' }], report: plain });
    expect(plain.skipped).toEqual([{ id: 'child-1', reason: 'cancel_failed' }]);
  });
});
