/**
 * sendCustomerMessage — preDispatchCheck hook.
 *
 * Pins the contract the clarify dispatch decision relies on: the
 * caller-supplied check runs AFTER every validator as the last await before
 * the provider handoff; a false/throwing verdict blocks the send (audited as
 * 'pre_dispatch_check', fail closed) with no provider call; the callback is
 * never forwarded into provider/audit input; and an absent hook leaves the
 * legacy pipeline untouched.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/validators/consent', () => ({
  loadContactState: jest.fn(async () => ({})),
  checkConsentForPurpose: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: jest.fn(async (_input, contactState) => contactState),
  checkSuppression: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  checkLineType: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/identity', () => ({
  validateRequiredIds: jest.fn(() => ({ ok: true })),
  validateIdentityTrust: jest.fn(() => ({ ok: true })),
  resolveTrustLevel: jest.fn(() => 'phone_provided_unverified'),
}));
jest.mock('../services/messaging/validators/voice', () => ({
  validateNoCustomerEmoji: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/compliance-contact-checks', () => ({
  checkContactCompliance: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/audit', () => ({
  persistAudit: jest.fn(async () => ({ id: 'audit-1' })),
}));
jest.mock('../services/messaging/providers/twilio-sms', () => ({
  sendViaTwilio: jest.fn(async () => ({ sent: true, providerMessageId: 'SM-real' })),
}));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { persistAudit } = require('../services/messaging/audit');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');

const BASE_INPUT = {
  to: '+19415550142',
  body: 'What is the service address?',
  channel: 'sms',
  audience: 'lead',
  purpose: 'conversational',
};

beforeEach(() => {
  jest.clearAllMocks();
  sendViaTwilio.mockResolvedValue({ sent: true, providerMessageId: 'SM-real' });
  persistAudit.mockResolvedValue({ id: 'audit-1' });
});

test('a failing check blocks the send after all validators — no provider call, audited', async () => {
  const result = await sendCustomerMessage({
    ...BASE_INPUT,
    preDispatchCheck: async () => ({ ok: false, code: 'CLARIFY_SUPERSEDED', reason: 'answered mid-send' }),
  });
  expect(result).toMatchObject({ sent: false, blocked: true, code: 'CLARIFY_SUPERSEDED' });
  expect(sendViaTwilio).not.toHaveBeenCalled();
  expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({
    validatorsFailed: ['pre_dispatch_check'],
    blockedBy: { code: 'CLARIFY_SUPERSEDED', reason: 'answered mid-send' },
  }));
});

test('a throwing check fails CLOSED — an unverifiable send never dispatches', async () => {
  const result = await sendCustomerMessage({
    ...BASE_INPUT,
    preDispatchCheck: async () => { throw new Error('lock unavailable'); },
  });
  expect(result).toMatchObject({ sent: false, blocked: true, code: 'PRE_DISPATCH_CHECK_FAILED' });
  expect(sendViaTwilio).not.toHaveBeenCalled();
});

test('a passing check dispatches, and the callback never reaches the provider input', async () => {
  const check = jest.fn(async () => ({ ok: true }));
  const result = await sendCustomerMessage({ ...BASE_INPUT, preDispatchCheck: check });
  expect(result.sent).toBe(true);
  expect(check).toHaveBeenCalledTimes(1);
  const providerInput = sendViaTwilio.mock.calls[0][0];
  expect(providerInput.preDispatchCheck).toBeUndefined();
  const auditInput = persistAudit.mock.calls[0][0].input;
  expect(auditInput.preDispatchCheck).toBeUndefined();
});

test('no hook — the legacy pipeline is untouched', async () => {
  const result = await sendCustomerMessage(BASE_INPUT);
  expect(result.sent).toBe(true);
  expect(sendViaTwilio).toHaveBeenCalledTimes(1);
});
