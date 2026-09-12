/**
 * The promised window an APPLIED call reschedule communicates is derived, not
 * captured: call-reschedule-apply.js writes an activity_log row
 * (`call_reschedule_applied`) in the SAME transaction as the move, carrying
 * the call id, the visit id and the applied window, and
 * no-show-detector.js's loadPromiseEvents reads it.
 *
 * That replaced a best-effort recordAgreedWindow call in this step: the call
 * is already finalized by the time it runs, nothing re-runs it, and a
 * transient failure lost the promise permanently — after which the detector
 * kept evaluating against the stale pre-move window (codex P1, PR #4403
 * rounds 8 and 10). This file holds the wiring to that contract: the step
 * still returns the applied result, and no promise write happens here.
 */
process.env.GATE_CALL_RESCHEDULE_APPLY = 'true';
process.env.GATE_NOSHOW_DETECTOR = 'true';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-reschedule-apply', () => ({ applyCallReschedule: jest.fn() }));
jest.mock('../services/no-show-detector', () => ({}));

const fs = require('fs');
const path = require('path');
const CallRecordingProcessor = require('../services/call-recording-processor');
const { applyCallReschedule } = require('../services/call-reschedule-apply');

describe('applyCallRescheduleStep leaves promise evidence to the derivation', () => {
  const { applyCallRescheduleStep } = CallRecordingProcessor._test;
  const call = { id: 'call-1', customer_id: 'cust-1' };
  const v2Result = { status: 'valid', extraction: {} };
  const extracted = { is_spam: false };

  beforeEach(() => jest.clearAllMocks());

  test('an applied move returns its result and writes no promise evidence from this step', async () => {
    applyCallReschedule.mockResolvedValue({
      outcome: 'applied', visitId: 'visit-123',
      newDate: '2026-09-15', newWindow: { start: '09:00', end: '11:00' },
    });

    const result = await applyCallRescheduleStep({
      call, callSid: 'CA_applied', customerId: 'cust-1', extracted, v2Result, appointmentResult: {}, procGeneration: 1,
    });

    expect(result).toMatchObject({ outcome: 'applied', visitId: 'visit-123', newDate: '2026-09-15' });
  });

  test('the step no longer calls any promise-capture writer', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'call-recording-processor.js'), 'utf8');
    expect(source).not.toContain('recordAgreedWindow');
    expect(source).not.toContain('noShowPromiseCapture');
  });

  // The apply path is what the derivation reads, so the row it writes is the
  // contract: same transaction as the move, carrying call, visit and window.
  test('call-reschedule-apply writes the activity row the detector derives from', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'call-reschedule-apply.js'), 'utf8');
    expect(source).toContain("const ACTIVITY_ACTION = 'call_reschedule_applied';");
    expect(source).toContain("await trx('activity_log').insert({ customer_id: settled.customer_id, action: ACTIVITY_ACTION");
    expect(source).toContain("metadata: JSON.stringify({ call_log_id: String(call.id), scheduled_service_id: String(visit.id),");
  });

  test('a skipped outcome still returns without touching the visit', async () => {
    applyCallReschedule.mockResolvedValue({ outcome: 'skipped', reason: 'no_matching_visit' });
    await expect(applyCallRescheduleStep({
      call, callSid: 'CA_skipped', customerId: 'cust-1', extracted, v2Result, appointmentResult: {}, procGeneration: 1,
    })).resolves.toMatchObject({ outcome: 'skipped' });
  });
});
