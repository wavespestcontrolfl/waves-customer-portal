/**
 * C3 end-of-coverage confirmations: an end_at_term cancel KEEPS paid visits
 * through term_end, so the generic whole-account copy ("upcoming visits are
 * off the calendar") would be materially false. The sender must pick the
 * end-of-term SMS template and hand the email the effective date + the
 * kept-through fact.
 */
const mockSend = jest.fn().mockResolvedValue({ sent: true });
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSend(...a) }));
const mockRender = jest.fn().mockResolvedValue('rendered body');
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: (...a) => mockRender(...a) }));
const mockEmail = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../services/account-membership-email', () => ({ sendCancellationReceived: (...a) => mockEmail(...a) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Send-once probe (messaging_audit_log): default = no prior accepted send.
let mockPriorSmsRow = null;
jest.mock('../models/db', () => jest.fn(() => ({
  where() { return this; },
  whereNotNull() { return this; },
  whereRaw() { return this; },
  first: async () => mockPriorSmsRow,
})));

const { sendCancellationConfirmations } = require('../services/cancellation-confirmations');

const customer = { id: 'cust-1', first_name: 'Pat', phone: '+15550000000' };
const request = { id: 'req-1', created_at: new Date('2026-08-31T14:00:00Z') };

beforeEach(() => { mockSend.mockClear(); mockRender.mockClear(); mockEmail.mockClear(); mockPriorSmsRow = null; });

test('keptThrough whole-account: end-of-term template, email told the date and that visits stay', async () => {
  const out = await sendCancellationConfirmations({
    customer, request, result: { scope: [] }, processed: true,
    effectiveAt: '2027-02-28T12:00:00-05:00', keptThrough: true,
  });
  expect(out.smsTemplateKey).toBe('service_cancellation_end_of_term_confirmation');
  expect(mockRender.mock.calls[0][1].effective_date).toBe('February 28, 2027');
  expect(mockEmail).toHaveBeenCalledWith(expect.objectContaining({
    keptThrough: true, effectiveAt: '2027-02-28T12:00:00-05:00', processed: true,
  }));
});

test('immediate whole-account keeps the existing template', async () => {
  const out = await sendCancellationConfirmations({ customer, request, result: { scope: [] }, processed: true });
  expect(out.smsTemplateKey).toBe('service_cancellation_confirmation');
  expect(mockEmail).toHaveBeenCalledWith(expect.objectContaining({ keptThrough: false }));
});

test('scoped processed wins over keptThrough (a scoped cancel never has a kept term)', async () => {
  const out = await sendCancellationConfirmations({
    customer, request, result: { scope: ['lawn_care'], remaining: ['pest_control'] }, processed: true, keptThrough: true,
  });
  expect(out.smsTemplateKey).toBe('service_cancellation_scoped_confirmation');
});

test('the processor-verified fee waiver reaches the email (never warn about a waived fee)', async () => {
  await sendCancellationConfirmations({
    customer, request, result: { scope: [], lateFeeWaived: true }, processed: true,
  });
  expect(mockEmail).toHaveBeenCalledWith(expect.objectContaining({ feeWaived: true }));
  mockEmail.mockClear();
  await sendCancellationConfirmations({ customer, request, result: { scope: [] }, processed: true });
  expect(mockEmail).toHaveBeenCalledWith(expect.objectContaining({ feeWaived: false }));
});

test('unprocessed stays on the received (by-hand) template even with keptThrough', async () => {
  const out = await sendCancellationConfirmations({ customer, request, result: null, processed: false, keptThrough: true });
  expect(out.smsTemplateKey).toBe('service_cancellation_received');
});

test('a retry whose SMS already accepted for this request+template skips the resend and still reports the channel', async () => {
  // The audit log shows a provider-accepted send of this exact template for
  // this request — a retry driven by the OTHER channel's failure must not
  // text the same copy twice.
  mockPriorSmsRow = { id: 'audit-1' };
  const out = await sendCancellationConfirmations({ customer, request, result: { scope: [] }, processed: true });
  expect(out.smsSent).toBe(true);
  expect(mockSend).not.toHaveBeenCalled();
  // The email leg still runs (its own class-keyed idempotency dedupes it).
  expect(mockEmail).toHaveBeenCalled();
});
