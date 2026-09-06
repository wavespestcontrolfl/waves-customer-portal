/**
 * The shared cancellation follow-through must actually LOAD (PR #3337
 * shipped it importing '../utils/logger', which does not exist — the
 * require threw from 2026-08-10 until this fix, and callers that wrapped
 * it in try/catch silently skipped every cancellation money obligation).
 * Source-text checks cannot catch a broken import; this exercises the real
 * require and the empty-target fast path.
 */

let mockCancellationTime = '2030-01-09T18:00:00Z';
jest.mock('../models/db', () => {
  const mock = jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    whereNot: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    first: jest.fn(async () => ({ transitioned_at: mockCancellationTime })),
  }));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn();
  mock.transaction = jest.fn();
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockHoldCancel = jest.fn();
const mockApptCancel = jest.fn(async () => ({ released: true }));
const mockAlertUnresolved = jest.fn(async () => {});
jest.mock('../services/estimate-card-holds', () => ({
  handleCardHoldCancellation: (...a) => mockHoldCancel(...a),
}));
jest.mock('../services/appointment-card-request', () => ({
  handleAppointmentCardCancellation: (...a) => mockApptCancel(...a),
  alertUnresolvedCancellationFee: (...a) => mockAlertUnresolved(...a),
}));
jest.mock('../services/track-transitions', () => ({ cancel: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/track-transition-alerts', () => ({
  recordTrackTransitionFailure: jest.fn(async () => {}),
  recordTrackTransitionResultFailure: jest.fn(async () => {}),
}));
jest.mock('../services/invoice', () => ({ voidOpenInvoicesForCancelledService: jest.fn(async () => {}) }));

describe('visit-cancellation-followthrough', () => {
  beforeEach(() => { jest.clearAllMocks(); mockCancellationTime = '2030-01-09T18:00:00Z'; });

  it('requires cleanly (no phantom imports) and no-ops on empty targets', async () => {
    const { runVisitCancellationFollowThrough } = require('../services/visit-cancellation-followthrough');
    await expect(runVisitCancellationFollowThrough({ targetIds: [] })).resolves.toEqual({ settled: 0 });
  });

  it.each(['charge_failed', 'charge_review', 'lane_check_failed'])('a NON-CLEAN hold outcome (%s) raises the unresolved-fee alert', async (reason) => {
    mockHoldCancel.mockResolvedValueOnce({ charged: false, reason });
    const { runVisitCancellationFollowThrough } = require('../services/visit-cancellation-followthrough');
    await runVisitCancellationFollowThrough({ targetIds: ['svc-1'] });
    expect(mockAlertUnresolved).toHaveBeenCalledWith({
      scheduledServiceId: 'svc-1',
      outcome: { released: false, reason },
    });
  });

  it('clean outcomes (charged / released / parked / no_hold / park_gate_off) never alert', async () => {
    const { runVisitCancellationFollowThrough } = require('../services/visit-cancellation-followthrough');
    for (const outcome of [
      { charged: true }, { released: true }, { handled: true, parked: true, reason: 'waived_cancel_park' },
      { handled: false, reason: 'park_gate_off' },
    ]) {
      mockHoldCancel.mockResolvedValueOnce(outcome);
      await runVisitCancellationFollowThrough({ targetIds: ['svc-1'] });
    }
    expect(mockAlertUnresolved).not.toHaveBeenCalled();
    // no_hold falls through to the appointment-card rail instead
    mockHoldCancel.mockResolvedValueOnce({ handled: false, reason: 'no_hold' });
    await runVisitCancellationFollowThrough({ targetIds: ['svc-1'] });
    expect(mockApptCancel).toHaveBeenCalled();
  });
});


describe('cancellation fee clock', () => {
  beforeEach(() => { jest.clearAllMocks(); mockCancellationTime = '2030-01-09T18:00:00Z'; });
  afterEach(() => jest.useRealTimers());

  it('a retry keeps the original free-cancel instant for both fee rails', async () => {
    const { runVisitCancellationFollowThrough } = require('../services/visit-cancellation-followthrough');
    mockHoldCancel.mockResolvedValue({ reason: 'no_hold' });
    jest.useFakeTimers().setSystemTime(new Date('2030-01-10T18:00:00Z'));
    await runVisitCancellationFollowThrough({ targetIds: ['svc-1'] });
    const originalTime = new Date(mockCancellationTime);
    expect(mockHoldCancel).toHaveBeenCalledWith(expect.objectContaining({ now: originalTime }));
    expect(mockApptCancel).toHaveBeenCalledWith(expect.objectContaining({ now: originalTime }));
  });

  it('missing history alerts without charging and still cleans up the cancelled visit', async () => {
    mockCancellationTime = null;
    const { runVisitCancellationFollowThrough } = require('../services/visit-cancellation-followthrough');
    await runVisitCancellationFollowThrough({ targetIds: ['svc-1'] });
    expect(mockHoldCancel).not.toHaveBeenCalled();
    expect(mockApptCancel).not.toHaveBeenCalled();
    expect(mockAlertUnresolved).toHaveBeenCalledWith(expect.objectContaining({ outcome: { released: false, reason: 'fee_step_error' } }));
    expect(require('../services/invoice').voidOpenInvoicesForCancelledService).toHaveBeenCalledWith('svc-1');
    expect(require('../services/track-transitions').cancel).toHaveBeenCalled();
  });

  it('preserves an explicitly supplied cancellation instant', async () => {
    mockHoldCancel.mockResolvedValue({ released: true });
    const now = new Date('2030-01-08T18:00:00Z');
    await require('../services/visit-cancellation-followthrough').runVisitCancellationFollowThrough({ targetIds: ['svc-1'], now });
    expect(require('../models/db')).not.toHaveBeenCalled();
    expect(mockHoldCancel).toHaveBeenCalledWith(expect.objectContaining({ now }));
  });
});
