/**
 * GATE_CALL_RESCHEDULE_APPLY off: the processor step returns before it reads
 * the call or touches any visit, so the accepted-slot rule
 * (call-reschedule-apply.js, owner 2026-10-27) cannot take effect.
 */
delete process.env.GATE_CALL_RESCHEDULE_APPLY;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-reschedule-apply', () => ({ applyCallReschedule: jest.fn() }));
jest.mock('../services/no-show-detector', () => ({}));

const CallRecordingProcessor = require('../services/call-recording-processor');
const { applyCallReschedule } = require('../services/call-reschedule-apply');

describe('applyCallRescheduleStep with GATE_CALL_RESCHEDULE_APPLY off', () => {
  const { applyCallRescheduleStep } = CallRecordingProcessor._test;

  test('does nothing: no move, no card change', async () => {
    const result = await applyCallRescheduleStep({
      call: { id: 'call-1', customer_id: 'cust-1' }, callSid: 'CA_gate_off', customerId: 'cust-1',
      extracted: { is_spam: false }, v2Result: { status: 'valid', extraction: {} }, appointmentResult: {}, procGeneration: 1,
    });
    expect(result).toBeUndefined();
    expect(applyCallReschedule).not.toHaveBeenCalled();
  });
});
