/**
 * The shared cancellation follow-through must actually LOAD (PR #3337
 * shipped it importing '../utils/logger', which does not exist — the
 * require threw from 2026-08-10 until this fix, and callers that wrapped
 * it in try/catch silently skipped every cancellation money obligation).
 * Source-text checks cannot catch a broken import; this exercises the real
 * require and the empty-target fast path.
 */

let mockCancellationTime = '2030-01-09T18:00:00Z';
let mockInvoices = [];
let mockInvoiceReadFails = false;
jest.mock('../models/db', () => {
  const mock = jest.fn((table) => {
    let where = {};
    let excluded = [];
    const chain = {
      where: jest.fn((value) => { where = value; return chain; }),
      whereNot: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn((column, values) => { excluded = values; return chain; }),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn(async () => {
        if (table !== 'invoices') return { transitioned_at: mockCancellationTime };
        if (mockInvoiceReadFails) throw new Error('invoice lookup unavailable');
        return mockInvoices.find(row => row.scheduled_service_id === where.scheduled_service_id && !excluded.includes(row.status));
      }),
    };
    return chain;
  });
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn();
  mock.transaction = jest.fn();
  return mock;
});
beforeEach(() => { mockInvoices = []; mockInvoiceReadFails = false; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockHoldCancel = jest.fn();
const mockApptCancel = jest.fn(async () => ({ released: true }));
const mockAlertUnresolved = jest.fn(async () => {});
jest.mock('../services/estimate-card-holds', () => ({
  NO_SHOW_FEE_MAX_AGE_MS: 48 * 3600000,
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
jest.mock('../services/invoice', () => ({
  CANCELLED_SERVICE_RESOLVED_STATUSES: ['void', 'refunded', 'canceled', 'cancelled'],
  voidOpenInvoicesForCancelledService: jest.fn(async () => {}),
}));

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
    expect(mockAlertUnresolved).not.toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({ released: false }),
    }));
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
    expect(require('../models/db')).not.toHaveBeenCalledWith('job_status_history');
    expect(mockHoldCancel).toHaveBeenCalledWith(expect.objectContaining({ now }));
  });
});


describe('review regressions: freshness and invoice collection', () => {
  const { runVisitCancellationFollowThrough } = require('../services/visit-cancellation-followthrough');
  const InvoiceService = require('../services/invoice');
  beforeEach(() => {
    jest.clearAllMocks();
    mockCancellationTime = '2030-01-09T18:00:00Z';
    mockHoldCancel.mockResolvedValue({ reason: 'no_hold' });
    jest.useFakeTimers().setSystemTime(new Date('2030-01-10T18:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it.each([false, true])('waives a weeks-old retry with explicit time=%s on both rails', async (explicit) => {
    jest.setSystemTime(new Date('2030-02-01T18:00:00Z'));
    const now = new Date(mockCancellationTime);
    await runVisitCancellationFollowThrough({ targetIds: ['svc-1'], ...(explicit ? { now } : {}) });
    expect(mockHoldCancel).toHaveBeenCalledWith({ scheduledServiceId: 'svc-1', waiveFee: true, now });
    expect(mockApptCancel).toHaveBeenCalledWith({ scheduledServiceId: 'svc-1', waiveFee: true, now });
  });

  it.each([
    ['2030-01-11T18:00:00Z', false],
    ['2030-01-11T18:00:00.001Z', true],
  ])('applies the existing 48-hour freshness boundary at %s', async (realNow, waived) => {
    jest.setSystemTime(new Date(realNow));
    await runVisitCancellationFollowThrough({ targetIds: ['svc-1'] });
    expect(mockHoldCancel).toHaveBeenCalledWith(expect.objectContaining({ waiveFee: waived }));
  });

  it('keeps an explicit waiver available when history is missing', async () => {
    mockCancellationTime = null;
    await runVisitCancellationFollowThrough({ targetIds: ['svc-1'], waiveFee: true });
    expect(mockHoldCancel).toHaveBeenCalledWith(expect.objectContaining({ waiveFee: true }));
    expect(require('../models/db')).not.toHaveBeenCalledWith('job_status_history');
  });

  it('waits for invoice cleanup before invoking either fee rail', async () => {
    let finishVoid;
    InvoiceService.voidOpenInvoicesForCancelledService.mockImplementationOnce(() => new Promise(resolve => { finishVoid = resolve; }));
    const pending = runVisitCancellationFollowThrough({ targetIds: ['svc-1'] });
    expect(mockHoldCancel).not.toHaveBeenCalled();
    expect(mockApptCancel).not.toHaveBeenCalled();
    finishVoid();
    await pending;
    expect(mockHoldCancel).toHaveBeenCalled();
    expect(mockApptCancel).toHaveBeenCalled();
  });

  it('a failed invoice cleanup skips fees and alerts without stranding other visits or tracking', async () => {
    InvoiceService.voidOpenInvoicesForCancelledService.mockRejectedValueOnce(new Error('invoice cleanup failed'));
    await runVisitCancellationFollowThrough({ targetIds: ['svc-1', 'svc-2'] });
    expect(mockHoldCancel).toHaveBeenCalledTimes(1);
    expect(mockHoldCancel).toHaveBeenCalledWith(expect.objectContaining({ scheduledServiceId: 'svc-2' }));
    expect(mockAlertUnresolved).toHaveBeenCalledWith({ scheduledServiceId: 'svc-1', outcome: { released: false, reason: 'fee_step_error' } });
    expect(require('../services/track-transitions').cancel).toHaveBeenCalledTimes(2);
  });
});


describe('silent invoice cleanup skips', () => {
  const { runVisitCancellationFollowThrough } = require('../services/visit-cancellation-followthrough');
  beforeEach(() => {
    jest.clearAllMocks();
    mockCancellationTime = new Date().toISOString();
    mockHoldCancel.mockResolvedValue({ reason: 'no_hold' });
  });

  it.each(['draft', 'sent', 'sending', 'paid', 'processing', 'partially_paid'])('blocks both fee rails when a %s invoice survives the sweep', async (status) => {
    mockInvoices = [{ id: 'inv-1', scheduled_service_id: 'svc-1', status }];
    await runVisitCancellationFollowThrough({ targetIds: ['svc-1', 'svc-2'] });
    expect(mockHoldCancel).toHaveBeenCalledTimes(1);
    expect(mockHoldCancel).toHaveBeenCalledWith(expect.objectContaining({ scheduledServiceId: 'svc-2' }));
    expect(mockApptCancel).toHaveBeenCalledTimes(1);
    expect(mockApptCancel).toHaveBeenCalledWith(expect.objectContaining({ scheduledServiceId: 'svc-2' }));
    expect(mockAlertUnresolved).toHaveBeenCalledWith({ scheduledServiceId: 'svc-1', outcome: { released: false, reason: 'fee_step_error' } });
    expect(require('../services/track-transitions').cancel).toHaveBeenCalledTimes(2);
  });

  it('allows resolved invoices and ignores invoices belonging to other visits', async () => {
    mockInvoices = [
      ...['void', 'refunded', 'canceled', 'cancelled'].map(status => ({ id: status, scheduled_service_id: 'svc-1', status })),
      { id: 'other', scheduled_service_id: 'svc-2', status: 'processing' },
    ];
    await runVisitCancellationFollowThrough({ targetIds: ['svc-1'] });
    expect(mockHoldCancel).toHaveBeenCalledTimes(1);
    expect(mockApptCancel).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the post-cleanup invoice lookup fails', async () => {
    mockInvoiceReadFails = true;
    await runVisitCancellationFollowThrough({ targetIds: ['svc-1'] });
    expect(mockHoldCancel).not.toHaveBeenCalled();
    expect(mockApptCancel).not.toHaveBeenCalled();
    expect(mockAlertUnresolved).toHaveBeenCalledWith({ scheduledServiceId: 'svc-1', outcome: { released: false, reason: 'fee_step_error' } });
    expect(require('../services/track-transitions').cancel).toHaveBeenCalled();
  });
});
