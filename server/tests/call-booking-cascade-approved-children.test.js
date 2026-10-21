/**
 * cancelCallFollowUpsForParentCancel with `approvedChildren` (opt-in; the Intelligence Bar cancel card,
 * GATE_IB_CANCEL_WITH_EFFECTS). The cascade cancels ONLY the linked visits the card approved, each one after it is
 * re-read under its OWN row lock and still matches the card (live linked follow-up, same status, date and service, no
 * invoice of its own). Anything else is NOT cancelled and is reported in report.skipped. Synthetic ids only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn().mockResolvedValue(undefined) }));
const mockAnyInvoice = jest.fn();
jest.mock('../services/invoice', () => ({ anyInvoiceLinkedToVisit: (...a) => mockAnyInvoice(...a) }));
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
  mockAnyInvoice.mockReturnValue({ first: async () => null });
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

  test('an approved child that gained an invoice since the card is NOT cancelled', async () => {
    mockAnyInvoice.mockReturnValue({ first: async () => ({ id: 'inv-new' }) });
    const { cancelled, report } = await run();
    expect(cancelled).toBe(0);
    expect(report.skipped).toEqual([{ id: 'child-1', reason: 'invoice_added' }]);
    expect(transitionJobStatus).not.toHaveBeenCalled();
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
    expect(mockAnyInvoice).not.toHaveBeenCalled();
  });
});
