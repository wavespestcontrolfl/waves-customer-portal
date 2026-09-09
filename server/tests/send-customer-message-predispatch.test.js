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

jest.mock('../models/db', () => jest.fn());
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

test('lead handoff closure reaches only the provider hook, never message or audit state', async () => {
  const withSmsHandoff = jest.fn();
  expect((await sendCustomerMessage({ ...BASE_INPUT, entryPoint: 'lead_response_auto_reply', withSmsHandoff })).sent).toBe(true);
  expect(sendViaTwilio.mock.calls[0][1].withSmsHandoff).toEqual(expect.any(Function));
  expect(sendViaTwilio.mock.calls[0][0]).not.toHaveProperty('withSmsHandoff');
  expect(persistAudit.mock.calls[0][0].input).not.toHaveProperty('withSmsHandoff');
});

test.each([
  [{ prefs: { sms_enabled: false }, suppressionLoaded: true }, 'SMS_OPTED_OUT'],
  [{ prefs: { sms_enabled: true }, suppressionLoaded: true, suppression: { reason: 'opt_out_keyword' } }, 'SUPPRESSED_OPT_OUT'],
  [{ prefs: { sms_enabled: true } }, 'SUPPRESSION_LOOKUP_FAILED'],
])('the locked handoff refuses newly blocked or unknown contact state: %s', async (currentState, code) => {
  const consent = require('../services/messaging/validators/consent');
  const suppression = require('../services/messaging/validators/suppression');
  const trx = jest.fn();
  const dispatch = jest.fn();
  await sendCustomerMessage({ ...BASE_INPUT, entryPoint: 'lead_response_auto_reply', withSmsHandoff: locked => locked(trx) });
  // The initial pipeline passed; the lock wait then changes its snapshot.
  consent.loadContactState.mockResolvedValueOnce(currentState);
  suppression.loadSuppressionState.mockImplementationOnce(async (_input, state) => state);
  consent.checkConsentForPurpose.mockImplementationOnce(jest.requireActual('../services/messaging/validators/consent').checkConsentForPurpose);
  suppression.checkSuppression.mockImplementationOnce(jest.requireActual('../services/messaging/validators/suppression').checkSuppression);
  expect(await sendViaTwilio.mock.calls[0][1].withSmsHandoff(dispatch)).toMatchObject({ ok: false, code });
  expect(dispatch).not.toHaveBeenCalled();
  expect(consent.loadContactState).toHaveBeenLastCalledWith(expect.objectContaining({ to: BASE_INPUT.to }), trx);
  expect(suppression.loadSuppressionState).toHaveBeenLastCalledWith(expect.any(Object), currentState, trx);
  // A suppression block short-circuits consent; discard unused one-shot mocks.
  consent.checkConsentForPurpose.mockReset().mockReturnValue({ ok: true });
  suppression.checkSuppression.mockReset().mockReturnValue({ ok: true });
});

test.each([{ channel: 'push' }, { audience: 'customer' }, { purpose: 'appointment' }, { entryPoint: 'other' }])(
  'a handoff guard cannot silently cross another routing contract: %j', async fields => {
    const result = await sendCustomerMessage({ ...BASE_INPUT, entryPoint: 'lead_response_auto_reply', ...fields, withSmsHandoff: jest.fn() });
    // The existing channel contract rejects lead push before hook validation.
    expect(result).toMatchObject({ sent: false, blocked: true,
      code: fields.channel === 'push' ? 'CONTRACT_VIOLATION' : 'UNSUPPORTED_SMS_HANDOFF' });
    expect(sendViaTwilio).not.toHaveBeenCalled();
  },
);

describe('invoice-specific receipt SMS evidence', () => {
  const db = require('../models/db');
  const input = { ...BASE_INPUT, audience: 'customer', customerId: 'c1', invoiceId: 'invoice-1', purpose: 'payment_receipt', metadata: { original_message_type: 'receipt' }, operatorInitiated: true };
  const accepted = { sent: true, provider: 'twilio', providerMessageId: `SM${'a'.repeat(32)}`, sentAt: '2026-08-30T15:00:00Z' };
  let query;
  beforeEach(() => {
    query = { where: jest.fn().mockReturnThis(), whereIn: jest.fn().mockReturnThis(), whereNull: jest.fn().mockReturnThis(), update: jest.fn(async () => 1) };
    db.mockImplementation(() => query);
    sendViaTwilio.mockResolvedValue(accepted);
  });

  test.each([
    {},
    { purpose: 'appointment', metadata: { original_message_type: 'service_complete_paid_receipt' } },
    { purpose: 'appointment', metadata: { original_message_type: 'service_complete_paid_receipt', scheduled_sms_log_id: 'queue-1' } },
  ])('records a canonical receipt after acceptance: %j', async (fields) => {
    expect((await sendCustomerMessage({ ...input, ...fields })).sent).toBe(true);
    expect(query.where).toHaveBeenCalledWith({ id: 'invoice-1', customer_id: 'c1' });
    expect(query.whereNull).toHaveBeenCalledWith('receipt_sms_sent_at');
    expect(query.update).toHaveBeenCalledWith({ receipt_sms_sent_at: new Date(accepted.sentAt) });
    expect(query.update.mock.invocationCallOrder[0]).toBeLessThan(persistAudit.mock.invocationCallOrder[0]);
  });

  test.each([
    { sent: false, error: 'declined' },
    { sent: true, providerMessageId: 'owner-silence' },
    { sent: true, provider: 'push', providerMessageId: 'push:delivered' },
    { sent: true, providerMessageId: null },
    { sent: true, providerMessageId: 'SM-invalid' },
  ])('a non-text outcome never proves a texted receipt: %j', async (outcome) => {
    sendViaTwilio.mockResolvedValue(outcome);
    await sendCustomerMessage(input);
    expect(query.update).not.toHaveBeenCalled();
  });

  test.each([
    { invoiceId: undefined },
    { purpose: 'conversational' },
    { metadata: { original_message_type: 'invoice_thank_you' } },
    { purpose: 'appointment', metadata: { original_message_type: 'service_complete' } },
  ])('cannot infer receipt delivery from a generic or unlinked send: %j', async (fields) => {
    await sendCustomerMessage({ ...input, ...fields });
    expect(query.update).not.toHaveBeenCalled();
  });

  test('a policy hold never stamps; an evidence write failure cannot retry an accepted text', async () => {
    sendViaTwilio.mockResolvedValueOnce({ sent: false, blocked: true, code: 'QUIET_HOURS_HOLD' });
    await sendCustomerMessage(input);
    expect(query.update).not.toHaveBeenCalled();
    query.update.mockRejectedValueOnce(new Error('evidence write unavailable'));
    expect((await sendCustomerMessage(input)).sent).toBe(true);
  });

  test('an audit failure after acceptance leaves the independent delivery fact', async () => {
    persistAudit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(sendCustomerMessage(input)).rejects.toMatchObject({ providerOutcome: accepted });
    expect(query.update).toHaveBeenCalledTimes(1);
  });
});

describe('grouped unit-move hold (MOVE_HOLD) at the canonical chokepoint (codex #3609 r30)', () => {
  const db = require('../models/db');
  const APPT_INPUT = {
    ...BASE_INPUT,
    audience: 'customer',
    customerId: 'c1',
    purpose: 'appointment_confirmation',
    appointmentId: 'svc-1',
  };
  const wireHold = (value) => {
    db.mockImplementation(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn(async () => value),
    }));
  };

  test('a live move_hold_until blocks the send — no provider call, audited as move_hold', async () => {
    wireHold({ move_hold_until: new Date(Date.now() + 3600000) });
    const result = await sendCustomerMessage(APPT_INPUT);
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'MOVE_HOLD' });
    expect(sendViaTwilio).not.toHaveBeenCalled();
    expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({ validatorsFailed: ['move_hold'] }));
  });

  test('an unreadable hold fails CLOSED — the notice is held, never sent on a blip', async () => {
    db.mockImplementation(() => { throw new Error('ledger down'); });
    const result = await sendCustomerMessage(APPT_INPUT);
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'MOVE_HOLD' });
    expect(sendViaTwilio).not.toHaveBeenCalled();
  });

  test('no hold / expired hold / non-appointment purpose all dispatch normally', async () => {
    wireHold({ move_hold_until: new Date(Date.now() - 1000) });
    expect((await sendCustomerMessage(APPT_INPUT)).sent).toBe(true);
    wireHold(undefined);
    expect((await sendCustomerMessage(APPT_INPUT)).sent).toBe(true);
    db.mockImplementation(() => { throw new Error('never read'); });
    expect((await sendCustomerMessage({ ...BASE_INPUT })).sent).toBe(true);
    expect((await sendCustomerMessage({ ...APPT_INPUT, appointmentId: undefined })).sent).toBe(true);
  });
});
