/**
 * The shared cancellation follow-through must actually LOAD (PR #3337
 * shipped it importing '../utils/logger', which does not exist — the
 * require threw from 2026-08-10 until this fix, and callers that wrapped
 * it in try/catch silently skipped every cancellation money obligation).
 * Source-text checks cannot catch a broken import; this exercises the real
 * require and the empty-target fast path.
 */

jest.mock('../models/db', () => {
  const mock = jest.fn(() => { throw new Error('db should not be touched on the empty-target path'); });
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
  beforeEach(() => { jest.clearAllMocks(); });

  it('requires cleanly (no phantom imports) and no-ops on empty targets', async () => {
    const { runVisitCancellationFollowThrough } = require('../services/visit-cancellation-followthrough');
    await expect(runVisitCancellationFollowThrough({ targetIds: [] })).resolves.toEqual({ settled: 0 });
  });

  it('a NON-CLEAN hold outcome (charge_failed) raises the unresolved-fee alert with the normalized released:false shape', async () => {
    mockHoldCancel.mockResolvedValueOnce({ charged: false, reason: 'charge_failed' });
    const { runVisitCancellationFollowThrough } = require('../services/visit-cancellation-followthrough');
    await runVisitCancellationFollowThrough({ targetIds: ['svc-1'] });
    expect(mockAlertUnresolved).toHaveBeenCalledWith({
      scheduledServiceId: 'svc-1',
      outcome: { released: false, reason: 'charge_failed' },
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
