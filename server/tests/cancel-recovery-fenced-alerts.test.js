/**
 * The two office alerts the cancel recovery sweep can raise about a cancelled visit are written in the SAME transaction that
 * proves the cancellation generation (services/cancel-generation-fence.js), not after a point-in-time check:
 *  - appointment-card-request.js#alertUnresolvedCancellationFee ("Cancellation fee needs review"), via notifyAdmin({ trx }),
 *  - track-transition-alerts.js (the dispatch alert for a failed tracker cancel), via createAlert({ trx }).
 * Without a fence both behave exactly as before. Synthetic ids only.
 */
const mockOrder = [];
const mockTrx = { __trx: true };
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where: () => ({ first: async () => ({ customer_id: 'cust-1' }) }) }));
  db.transaction = jest.fn(async (cb) => { mockOrder.push('begin'); const out = await cb(mockTrx); mockOrder.push('commit'); return out; });
  return db;
});
const mockFence = jest.fn(async () => { mockOrder.push('fence'); });
jest.mock('../services/cancel-generation-fence', () => ({ assertCancelGeneration: (...a) => mockFence(...a) }));
const mockNotifyAdmin = jest.fn(async () => { mockOrder.push('notify'); return { id: 'n1' }; });
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));
const mockCreateAlert = jest.fn(async () => { mockOrder.push('createAlert'); return { id: 'a1' }; });
jest.mock('../services/dispatch-alerts', () => ({ createAlert: (...a) => mockCreateAlert(...a) }));

const refuse = (reason) => Object.assign(new Error(`cancellation fence: ${reason}`), { code: 'CANCEL_FENCE', fenceReason: reason });
const FENCE = { visitId: 'svc-1', restorations: 0, hits: [] };
const OUTCOME = { released: false, reason: 'fee_step_error' };

beforeEach(() => {
  jest.clearAllMocks();
  mockOrder.length = 0;
  mockFence.mockImplementation(async () => { mockOrder.push('fence'); });
});

describe('the unresolved-fee alert', () => {
  const { alertUnresolvedCancellationFee } = require('../services/appointment-card-request');

  test('with a fence: the generation is proven first, in the same transaction as the alert, with a per-visit dedupe key', async () => {
    await alertUnresolvedCancellationFee({ scheduledServiceId: 'svc-1', outcome: OUTCOME, cancelFence: FENCE });
    expect(mockOrder).toEqual(['begin', 'fence', 'notify', 'commit']);
    expect(mockFence).toHaveBeenCalledWith(mockTrx, FENCE);
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts.trx).toBe(mockTrx);
    expect(opts.dedupeKey).toBe('cancel-fee-review:svc-1:fee_step_error');
  });

  test('a restore after the sweep\'s earlier check: the fence refuses, no alert is written', async () => {
    mockFence.mockRejectedValueOnce(refuse('visit_restored_since'));
    await alertUnresolvedCancellationFee({ scheduledServiceId: 'svc-1', outcome: OUTCOME, cancelFence: FENCE });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('an alert that did not save rolls the transaction back (nothing half-recorded)', async () => {
    mockNotifyAdmin.mockResolvedValueOnce(null);
    await alertUnresolvedCancellationFee({ scheduledServiceId: 'svc-1', outcome: OUTCOME, cancelFence: FENCE });
    expect(mockOrder).not.toContain('commit');
  });

  test('without a fence: the plain alert as before (no transaction, no dedupe key, no fence)', async () => {
    await alertUnresolvedCancellationFee({ scheduledServiceId: 'svc-1', outcome: OUTCOME });
    expect(mockFence).not.toHaveBeenCalled();
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts.trx).toBeUndefined();
    expect(opts.dedupeKey).toBeUndefined();
    expect(mockOrder).toEqual(['notify']);
  });

  test('a released outcome raises nothing', async () => {
    await alertUnresolvedCancellationFee({ scheduledServiceId: 'svc-1', outcome: { released: true }, cancelFence: FENCE });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
});

describe('the tracker-failure alert', () => {
  const { recordTrackTransitionFailure, recordTrackTransitionResultFailure } = require('../services/track-transition-alerts');

  test('with a fence: proof then alert in one transaction; a refusal writes nothing', async () => {
    await recordTrackTransitionFailure({ jobId: 'svc-1', action: 'cancel', error: new Error('x'), cancelFence: FENCE });
    expect(mockOrder).toEqual(['begin', 'fence', 'createAlert', 'commit']);
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'svc-1', trx: mockTrx }));
    mockOrder.length = 0;
    mockCreateAlert.mockClear();
    mockFence.mockRejectedValueOnce(refuse('visit_is_confirmed'));
    await recordTrackTransitionResultFailure({ jobId: 'svc-1', action: 'cancel', result: { ok: false, reason: 'not_found' }, cancelFence: FENCE });
    expect(mockCreateAlert).not.toHaveBeenCalled();
  });

  test('without a fence: the plain alert as before', async () => {
    await recordTrackTransitionFailure({ jobId: 'svc-1', action: 'cancel', error: new Error('x') });
    expect(mockFence).not.toHaveBeenCalled();
    expect(mockCreateAlert).toHaveBeenCalledWith(expect.not.objectContaining({ trx: expect.anything() }));
    expect(mockOrder).toEqual(['createAlert']);
  });
});
