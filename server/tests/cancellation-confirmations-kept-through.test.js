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

const { sendCancellationConfirmations } = require('../services/cancellation-confirmations');

const customer = { id: 'cust-1', first_name: 'Pat', phone: '+15550000000' };
const request = { id: 'req-1', created_at: new Date('2026-08-31T14:00:00Z') };

beforeEach(() => { mockSend.mockClear(); mockRender.mockClear(); mockEmail.mockClear(); });

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

test('unprocessed stays on the received (by-hand) template even with keptThrough', async () => {
  const out = await sendCancellationConfirmations({ customer, request, result: null, processed: false, keptThrough: true });
  expect(out.smsTemplateKey).toBe('service_cancellation_received');
});
