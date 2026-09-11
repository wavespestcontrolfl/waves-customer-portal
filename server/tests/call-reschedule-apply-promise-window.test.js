/**
 * applyCallRescheduleStep (call-recording-processor.js) — an applied call
 * reschedule must feed the no-show detector's promise evidence the same way
 * a freshly booked appointment does. Before this fix, applyCallReschedule's
 * result.visitId was discarded: a successfully communicated move updated
 * the visit but never called recordAgreedWindow, so the detector kept
 * evaluating against the stale pre-move window (codex P1, pre-push audit
 * on PR #4403's head).
 *
 * Both gates default on for this file (set before any require, since
 * feature-gates.js snapshots process.env once at module load) — the
 * branches under test are exercised by varying applyCallReschedule's
 * mocked result, not by toggling gates mid-file.
 */
process.env.GATE_CALL_RESCHEDULE_APPLY = 'true';
process.env.GATE_NOSHOW_DETECTOR = 'true';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-reschedule-apply', () => ({ applyCallReschedule: jest.fn() }));
jest.mock('../services/no-show-detector', () => ({ recordAgreedWindow: jest.fn().mockResolvedValue(true) }));

const CallRecordingProcessor = require('../services/call-recording-processor');
const { applyCallReschedule } = require('../services/call-reschedule-apply');
const { recordAgreedWindow } = require('../services/no-show-detector');

describe('applyCallRescheduleStep captures promise evidence for an applied move', () => {
  const { applyCallRescheduleStep } = CallRecordingProcessor._test;
  const call = { id: 'call-1', customer_id: 'cust-1' };
  const v2Result = { status: 'valid', extraction: {} };
  const extracted = { is_spam: false };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('applied reschedule → recordAgreedWindow called with the moved visit id', async () => {
    applyCallReschedule.mockResolvedValue({
      outcome: 'applied', visitId: 'visit-123',
      newDate: '2026-09-15', newWindow: { start: '09:00', end: '11:00' },
    });

    const result = await applyCallRescheduleStep({
      call, callSid: 'CA_applied', customerId: 'cust-1', extracted, v2Result, appointmentResult: {}, procGeneration: 1,
    });

    expect(recordAgreedWindow).toHaveBeenCalledTimes(1);
    expect(recordAgreedWindow).toHaveBeenCalledWith(expect.anything(), { callId: 'call-1', visitId: 'visit-123' });
    // The step returns the applied result — visitId/newDate/newWindow are
    // no longer silently discarded by the caller.
    expect(result).toMatchObject({ outcome: 'applied', visitId: 'visit-123', newDate: '2026-09-15' });
  });

  test('a skipped (non-applied) outcome never records a promise window', async () => {
    applyCallReschedule.mockResolvedValue({ outcome: 'skipped', reason: 'no_matching_visit' });

    await applyCallRescheduleStep({
      call, callSid: 'CA_skipped', customerId: 'cust-1', extracted, v2Result, appointmentResult: {}, procGeneration: 1,
    });

    expect(recordAgreedWindow).not.toHaveBeenCalled();
  });

  test('an applied outcome with no visitId (defensive) never records a promise window', async () => {
    applyCallReschedule.mockResolvedValue({ outcome: 'applied', visitId: null });

    await applyCallRescheduleStep({
      call, callSid: 'CA_no_visit', customerId: 'cust-1', extracted, v2Result, appointmentResult: {}, procGeneration: 1,
    });

    expect(recordAgreedWindow).not.toHaveBeenCalled();
  });

  test('a recordAgreedWindow failure is swallowed — the step stays non-blocking', async () => {
    applyCallReschedule.mockResolvedValue({ outcome: 'applied', visitId: 'visit-456' });
    recordAgreedWindow.mockRejectedValueOnce(new Error('boom'));

    await expect(applyCallRescheduleStep({
      call, callSid: 'CA_err', customerId: 'cust-1', extracted, v2Result, appointmentResult: {}, procGeneration: 1,
    })).resolves.toMatchObject({ outcome: 'applied', visitId: 'visit-456' });
  });
});
