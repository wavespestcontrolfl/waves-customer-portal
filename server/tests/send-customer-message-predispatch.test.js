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
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn(actual.isEnabled) };
});
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
  sendViaTwilio: jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-real' })),
  mapPurposeToMessageType: jest.fn(() => 'manual'),
}));
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
  // Round 8 P1: default no-op (nothing rewritten) so every existing test
  // in this file is unaffected; the withheldLinkPolicy tests override it.
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
  // Round 11 structural fix (P1): default 'refuse' (like the real function
  // for any non-receipt purpose/message-type) so every existing test in
  // this file is unaffected — they all either pass an explicit
  // withheldLinkPolicy or exercise the default-refuse path directly; the
  // purpose-resolution mechanism itself is covered by
  // estimate-annual-guard.test.js and estimate-deposits.test.js's
  // scheduled-retry test.
  withheldLinkPolicyForSmsPurpose: jest.fn(() => 'refuse'),
}));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { persistAudit } = require('../services/messaging/audit');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');
const { annualHandoffGuard, rewriteWithheldEstimateLinks, withheldLinkPolicyForSmsPurpose } = require('../services/estimate-annual-guard');
const { isEnabled } = require('../config/feature-gates');

const BASE_INPUT = {
  to: '+19415550142',
  body: 'What is the service address?',
  channel: 'sms',
  audience: 'lead',
  purpose: 'conversational',
};

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation(jest.requireActual('../config/feature-gates').isEnabled);
  sendViaTwilio.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-real' });
  persistAudit.mockResolvedValue({ id: 'audit-1' });
});

test('a failing check blocks the send after all validators — no provider call, audited', async () => {
  const result = await sendCustomerMessage({
    ...BASE_INPUT,
    preDispatchCheck: async () => ({ ok: false, code: 'CLARIFY_SUPERSEDED', reason: 'answered mid-send' }),
  });
  expect(result).toMatchObject({ sent: false, blocked: true, code: 'CLARIFY_SUPERSEDED' });
  expect(result.deliveryOutcome).toBe('not_sent');
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
  const sentAt = '2026-08-30T15:00:00Z';
  sendViaTwilio.mockResolvedValueOnce({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-real', sentAt });
  const result = await sendCustomerMessage({ ...BASE_INPUT, preDispatchCheck: check });
  expect(result.sent).toBe(true);
  expect(result.sentAt).toBe(sentAt);
  expect(check).toHaveBeenCalledTimes(1);
  const providerInput = sendViaTwilio.mock.calls[0][0];
  expect(providerInput.preDispatchCheck).toBeUndefined();
  const auditInput = persistAudit.mock.calls[0][0].input;
  expect(auditInput.preDispatchCheck).toBeUndefined();
});

test.each([
  ['returned refusal', async () => ({ ok: false, code: 'PREPARATION_INVALIDATED', reason: 'copy changed', retryable: true })],
  ['coded throw', async () => { throw Object.assign(new Error('seal lost'), { code: 'COPY_SEAL_LOST', retryable: true }); }],
])('a provider-boundary %s is normalized, audited, and kept out of serialized input', async (_label, preSendCheck) => {
  sendViaTwilio.mockImplementationOnce(async (providerInput, hooks) => {
    const verdict = await hooks.preSendCheck();
    expect(verdict).toMatchObject({ ok: false, retryable: true });
    expect(providerInput.preSendCheck).toBeUndefined();
    return { sent: false, provider: 'push', deliveryOutcome: 'not_sent', appUnavailable: true, error: 'push stopped' };
  });

  const result = await sendCustomerMessage({ ...BASE_INPUT, preSendCheck });
  expect(result).toMatchObject({
    sent: false,
    blocked: true,
    deliveryOutcome: 'not_sent',
    retryable: true,
  });
  expect(result.code).toBe(_label === 'coded throw' ? 'COPY_SEAL_LOST' : 'PREPARATION_INVALIDATED');
  expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({
    input: expect.not.objectContaining({ preSendCheck: expect.anything() }),
    validatorsFailed: ['pre_send_check_boundary'],
  }));
});

test('a promised-link pre-provider check runs at handoff and stays out of serialized input', async () => {
  const check = jest.fn(async () => ({ ok: false, code: 'LINK_SOURCE_CHANGED', reason: 'visit changed' }));
  sendViaTwilio.mockImplementationOnce(async (providerInput, hooks) => {
    expect(await hooks.preSendCheck()).toMatchObject({ ok: false, code: 'LINK_SOURCE_CHANGED' });
    expect(providerInput.preProviderCheck).toBeUndefined();
    return { sent: false, provider: 'twilio', deliveryOutcome: 'not_sent' };
  });

  const result = await sendCustomerMessage({ ...BASE_INPUT, preProviderCheck: check });
  expect(check).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'LINK_SOURCE_CHANGED' });
  expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({
    input: expect.not.objectContaining({ preProviderCheck: expect.anything() }),
    validatorsFailed: ['pre_provider_check_boundary'],
  }));
});

test('a final provider predicate is forwarded without early invocation or serialization', async () => {
  const providerPreSendCheck = jest.fn(async () => ({ ok: true }));

  await sendCustomerMessage({ ...BASE_INPUT, providerPreSendCheck });

  const [providerInput, hooks] = sendViaTwilio.mock.calls[0];
  expect(providerPreSendCheck).not.toHaveBeenCalled();
  expect(hooks.providerPreSendCheck).toBe(providerPreSendCheck);
  expect(providerInput).not.toHaveProperty('providerPreSendCheck');
  expect(persistAudit.mock.calls[0][0].input).not.toHaveProperty('providerPreSendCheck');
});

test('the trusted gratitude executor may combine its claim handoff with the final provider predicate', async () => {
  const providerPreSendCheck = jest.fn(async () => ({ ok: true }));
  const withSmsHandoff = jest.fn(async (dispatch) => dispatch());

  await expect(sendCustomerMessage({
    ...BASE_INPUT,
    audience: 'customer',
    customerId: 'cust-1',
    entryPoint: 'sms_auto_send_executor',
    providerPreSendCheck,
    withSmsHandoff,
    metadata: { original_message_type: 'ai_gratitude', agentDecisionId: 'decision-1' },
  })).resolves.toMatchObject({ sent: true });

  expect(sendViaTwilio.mock.calls[0][1]).toMatchObject({ providerPreSendCheck, withSmsHandoff: expect.any(Function) });
});


test('canonical delivery borrows only a branded caller reservation and returns its actual provider context privately', async () => {
  const coordination = require('../services/messaging/provider-handoff-reservation');
  const TwilioService = require('../services/twilio');
  const providerAcceptedAt = new Date('2026-09-24T20:00:00.000Z');
  const handle = coordination.borrowProviderHandoffReservation({
    reservationId: '11111111-1111-4111-8111-111111111111',
    to: BASE_INPUT.to,
    fromNumber: '+19413529161',
    body: BASE_INPUT.body,
    messageType: 'manual',
    adminUserId: '22222222-2222-4222-8222-222222222222',
  });
  const prepare = jest.spyOn(coordination, 'prepareProviderHandoffReservation');
  const derive = jest.spyOn(TwilioService, 'deriveOutboundNumber');
  isEnabled.mockImplementation((gate) => gate === 'smsGratitudeReplies');
  sendViaTwilio.mockImplementationOnce(async (providerInput, hooks) => {
    expect(providerInput).not.toHaveProperty('providerHandoffReservation');
    expect(hooks.providerHandoffReservation).toBe(handle);
    coordination.captureProviderContext(handle, {
      to: '+19415550142',
      fromNumber: '+19413529161',
      body: 'Final normalized body',
      messageType: 'manual',
      providerAcceptedAt,
      channel: 'sms',
    });
    return {
      sent: true,
      provider: 'twilio',
      deliveryOutcome: 'accepted',
      providerMessageId: `SM${'1'.repeat(32)}`,
    };
  });

  const result = await sendCustomerMessage({
    ...BASE_INPUT,
    audience: 'customer',
    customerId: 'customer-1',
    identityTrustLevel: 'phone_matches_customer',
    providerHandoffReservation: handle,
  });

  expect(prepare).not.toHaveBeenCalled();
  expect(derive).not.toHaveBeenCalled();
  expect(result.reservationContext).toMatchObject({
    body: 'Final normalized body',
    fromNumber: '+19413529161',
    providerAcceptedAt,
    adminUserId: '22222222-2222-4222-8222-222222222222',
  });
  expect(Object.keys(result)).not.toContain('reservationContext');
  expect(JSON.stringify(result)).not.toContain('reservationContext');
  expect(persistAudit.mock.calls[0][0].input).not.toHaveProperty('providerHandoffReservation');
  prepare.mockRestore();
  derive.mockRestore();
});

test('canonical provider sender derivation failure is a retryable definite non-send', async () => {
  const TwilioService = require('../services/twilio');
  const derive = jest.spyOn(TwilioService, 'deriveOutboundNumber')
    .mockRejectedValueOnce(new Error('location lookup unavailable'));
  isEnabled.mockImplementation((gate) => gate === 'smsGratitudeReplies');
  try {
    const result = await sendCustomerMessage({
      ...BASE_INPUT,
      audience: 'customer',
      customerId: 'customer-1',
      identityTrustLevel: 'phone_matches_customer',
    });

    expect(result).toMatchObject({
      sent: false,
      blocked: true,
      deliveryOutcome: 'not_sent',
      retryable: true,
      code: 'PROVIDER_HANDOFF_PREPARATION_FAILED',
    });
    expect(sendViaTwilio).not.toHaveBeenCalled();
  } finally {
    derive.mockRestore();
  }
});

test('canonical coordination does not derive or prepare while its gate is off', async () => {
  const coordination = require('../services/messaging/provider-handoff-reservation');
  const TwilioService = require('../services/twilio');
  const derive = jest.spyOn(TwilioService, 'deriveOutboundNumber');
  const prepare = jest.spyOn(coordination, 'prepareProviderHandoffReservation');
  isEnabled.mockReturnValue(false);
  try {
    await expect(sendCustomerMessage({
      ...BASE_INPUT,
      audience: 'customer',
      customerId: 'customer-1',
      identityTrustLevel: 'phone_matches_customer',
    })).resolves.toMatchObject({ sent: true });
    expect(derive).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    derive.mockRestore();
    prepare.mockRestore();
  }
});

test('a successful caller boundary preserves its finite copy deadline', async () => {
  const validUntil = Date.now() + 60000;
  const preSendCheck = jest.fn(async () => ({ ok: true, validUntil, preparation: 'fresh' }));
  await sendCustomerMessage({ ...BASE_INPUT, preSendCheck });

  const providerGuard = sendViaTwilio.mock.calls[0][1].preSendCheck;
  await expect(providerGuard()).resolves.toEqual({
    ok: true, validUntil, preparation: 'fresh',
  });
  expect(providerGuard.isStillValid()).toBe(true);
});

test.each([NaN, Infinity, '123'])('an invalid caller copy deadline fails closed: %s', async (validUntil) => {
  sendViaTwilio.mockImplementationOnce(async (_providerInput, hooks) => {
    expect(await hooks.preSendCheck()).toMatchObject({ ok: false, code: 'PRE_SEND_CHECK_INVALID' });
    return { sent: false, provider: 'push', deliveryOutcome: 'not_sent' };
  });

  await expect(sendCustomerMessage({
    ...BASE_INPUT,
    preSendCheck: async () => ({ ok: true, validUntil }),
  })).resolves.toMatchObject({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'PRE_SEND_CHECK_INVALID' });
});

test('an expired caller copy deadline is a retryable definite non-send', async () => {
  sendViaTwilio.mockImplementationOnce(async (_providerInput, hooks) => {
    expect(await hooks.preSendCheck()).toMatchObject({ ok: false, code: 'PRE_SEND_CHECK_EXPIRED', retryable: true });
    return { sent: false, provider: 'push', deliveryOutcome: 'not_sent' };
  });

  await expect(sendCustomerMessage({
    ...BASE_INPUT,
    preSendCheck: async () => ({ ok: true, validUntil: Date.now() - 1 }),
  })).resolves.toMatchObject({
    sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'PRE_SEND_CHECK_EXPIRED', retryable: true,
  });
});

test('caller pre-send checks cannot run outside an SMS handoff lock', async () => {
  const result = await sendCustomerMessage({
    ...BASE_INPUT,
    entryPoint: 'lead_response_auto_reply',
    preSendCheck: async () => ({ ok: true }),
    withSmsHandoff: jest.fn(),
  });

  expect(result).toMatchObject({
    sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'UNSUPPORTED_SEND_GUARD_COMBINATION',
  });
  expect(sendViaTwilio).not.toHaveBeenCalled();
});

test.each([
  ['accepted', { sent: true, provider: 'push', deliveryOutcome: 'accepted', providerMessageId: 'push:accepted' }],
  ['uncertain', { sent: false, provider: 'push', deliveryOutcome: 'uncertain', retryable: true, error: 'provider unknown' }],
])('a captured guard refusal never overwrites a provider outcome that is %s', async (_label, outcome) => {
  sendViaTwilio.mockImplementationOnce(async (_providerInput, hooks) => {
    expect(await hooks.preSendCheck()).toMatchObject({ ok: false, code: 'PREPARATION_INVALIDATED' });
    return outcome;
  });
  const result = await sendCustomerMessage({
    ...BASE_INPUT,
    preSendCheck: async () => ({ ok: false, code: 'PREPARATION_INVALIDATED', retryable: true }),
  });
  expect(result.deliveryOutcome).toBe(outcome.deliveryOutcome);
  expect(result.code).not.toBe('PREPARATION_INVALIDATED');
  expect(result.blocked).toBe(false);
});

test('no hook — the legacy pipeline is untouched', async () => {
  const result = await sendCustomerMessage(BASE_INPUT);
  expect(result.sent).toBe(true);
  expect(sendViaTwilio).toHaveBeenCalledTimes(1);
});

test('invoice provider handoff wraps the unchanged dispatcher and preserves a push-routed outcome', async () => {
  const order = [];
  sendViaTwilio.mockImplementationOnce(async () => {
    order.push('provider');
    return { sent: true, provider: 'push', deliveryOutcome: 'accepted', providerMessageId: 'push:invoice' };
  });
  const withProviderHandoff = jest.fn(async (dispatch) => {
    order.push('lock');
    const outcome = await dispatch();
    order.push('unlock');
    return outcome;
  });
  const input = { ...BASE_INPUT, audience: 'customer', purpose: 'payment_link',
    entryPoint: 'invoice_send_via_sms', customerId: 'cust-1', invoiceId: 'inv-1', withProviderHandoff };

  await expect(sendCustomerMessage(input)).resolves.toMatchObject({
    sent: true, channel: 'push', providerMessageId: 'push:invoice',
  });
  expect(order).toEqual(['lock', 'provider', 'unlock']);
  expect(withProviderHandoff).toHaveBeenCalledTimes(1);
  expect(sendViaTwilio.mock.calls[0][0]).not.toHaveProperty('withProviderHandoff');
  expect(persistAudit.mock.calls[0][0].input).not.toHaveProperty('withProviderHandoff');
});

test('provider coordination publishes before an invoice wrapper and keeps its handle out of serialized input', async () => {
  const coordination = require('../services/messaging/provider-handoff-reservation');
  const TwilioService = require('../services/twilio');
  const handle = { internal: true };
  const order = [];
  const applies = jest.spyOn(coordination, 'canonicalCoordinationApplies').mockReturnValue(true);
  const prepare = jest.spyOn(coordination, 'prepareProviderHandoffReservation').mockImplementation(async () => {
    order.push('reserve');
    return { handle };
  });
  const record = jest.spyOn(coordination, 'recordProviderOutcome').mockImplementation(() => { order.push('record'); });
  const settle = jest.spyOn(coordination, 'settleProviderHandoffReservation').mockImplementation(async () => { order.push('settle'); return true; });
  const derive = jest.spyOn(TwilioService, 'deriveOutboundNumber').mockResolvedValue('+19413529161');
  sendViaTwilio.mockImplementationOnce(async (providerInput, hooks) => {
    order.push('provider');
    expect(providerInput).not.toHaveProperty('providerHandoffReservation');
    expect(hooks.providerHandoffReservation).toBe(handle);
    return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: `SM${'1'.repeat(32)}` };
  });
  const withProviderHandoff = jest.fn(async (dispatch) => {
    order.push('wrapper');
    const result = await dispatch();
    order.push('wrapper-done');
    return result;
  });
  try {
    await expect(sendCustomerMessage({
      ...BASE_INPUT,
      audience: 'customer',
      purpose: 'payment_link',
      entryPoint: 'invoice_send_via_sms',
      customerId: 'cust-1',
      invoiceId: 'inv-1',
      withProviderHandoff,
    })).resolves.toMatchObject({ sent: true, deliveryOutcome: 'accepted' });
    expect(order).toEqual(['reserve', 'wrapper', 'provider', 'wrapper-done', 'record', 'settle']);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550142', fromNumber: '+19413529161', messageType: 'manual',
    }));
    expect(persistAudit.mock.calls[0][0].input).not.toHaveProperty('providerHandoffReservation');
  } finally {
    applies.mockRestore(); prepare.mockRestore();
    record.mockRestore(); settle.mockRestore(); derive.mockRestore();
  }
});


test('provider coordination preparation failure is a retryable pre-provider block', async () => {
  const coordination = require('../services/messaging/provider-handoff-reservation');
  const TwilioService = require('../services/twilio');
  const applies = jest.spyOn(coordination, 'canonicalCoordinationApplies').mockReturnValue(true);
  const prepare = jest.spyOn(coordination, 'prepareProviderHandoffReservation')
    .mockRejectedValue(new Error('database unavailable'));
  const derive = jest.spyOn(TwilioService, 'deriveOutboundNumber').mockResolvedValue('+19413529161');
  const withProviderHandoff = jest.fn();
  try {
    await expect(sendCustomerMessage({
      ...BASE_INPUT,
      audience: 'customer', purpose: 'payment_link', entryPoint: 'invoice_send_via_sms',
      customerId: 'cust-1', invoiceId: 'inv-1', withProviderHandoff,
    })).resolves.toMatchObject({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true,
      code: 'PROVIDER_HANDOFF_PREPARATION_FAILED',
    });
    expect(withProviderHandoff).not.toHaveBeenCalled();
    expect(sendViaTwilio).not.toHaveBeenCalled();
  } finally {
    applies.mockRestore(); prepare.mockRestore(); derive.mockRestore();
  }
});


test.each([true, false])('invoice handoff retains the final provider check (allowed: %s)', async (allowed) => {
  const order = [];
  const preProviderCheck = jest.fn(async () => {
    order.push('check');
    return allowed ? { ok: true } : { ok: false, code: 'INVOICE_CHANGED', reason: 'invoice changed' };
  });
  const withProviderHandoff = async (dispatch) => {
    order.push('lock');
    const result = await dispatch();
    order.push('unlock');
    return result;
  };
  sendViaTwilio.mockImplementationOnce(async (providerInput, hooks) => {
    expect(providerInput).not.toHaveProperty('preProviderCheck');
    expect(providerInput).not.toHaveProperty('withProviderHandoff');
    const verdict = await hooks.preSendCheck();
    if (!verdict.ok) return { sent: false, deliveryOutcome: 'not_sent' };
    order.push('send');
    return { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-invoice' };
  });

  const result = await sendCustomerMessage({ ...BASE_INPUT, audience: 'customer', purpose: 'payment_link',
    entryPoint: 'invoice_send_via_sms', customerId: 'cust-1', invoiceId: 'inv-1',
    preProviderCheck, withProviderHandoff });

  expect(preProviderCheck).toHaveBeenCalledTimes(1);
  expect(order).toEqual(allowed ? ['lock', 'check', 'send', 'unlock'] : ['lock', 'check', 'unlock']);
  expect(result).toMatchObject(allowed
    ? { sent: true, deliveryOutcome: 'accepted' }
    : { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'INVOICE_CHANGED' });
  expect(persistAudit.mock.calls[0][0].input).not.toHaveProperty('preProviderCheck');
  expect(persistAudit.mock.calls[0][0].input).not.toHaveProperty('withProviderHandoff');
});

test.each([
  { entryPoint: 'other' },
  { purpose: 'payment_receipt', entryPoint: 'invoice_receipt_sms' },
  { audience: 'lead' },
  { channel: 'push' },
])('invoice provider handoff cannot cross another routing contract: %j', async (fields) => {
  const result = await sendCustomerMessage({ ...BASE_INPUT, audience: 'customer', purpose: 'payment_link',
    entryPoint: 'invoice_send_via_sms', customerId: 'cust-1', invoiceId: 'inv-1',
    ...fields, withProviderHandoff: jest.fn() });
  expect(result).toMatchObject({ sent: false, blocked: true });
  expect(result.code).toBe(fields.channel === 'push' ? 'CONTRACT_VIOLATION' : 'UNSUPPORTED_PROVIDER_HANDOFF');
  expect(sendViaTwilio).not.toHaveBeenCalled();
});

test('a pre-provider exception carries definitive non-delivery provenance', async () => {
  require('../services/messaging/validators/consent').loadContactState
    .mockRejectedValueOnce(Object.assign(new Error('contact lookup unavailable'), { status: 503 }));

  await expect(sendCustomerMessage(BASE_INPUT)).rejects.toMatchObject({
    providerOutcome: { sent: false, deliveryOutcome: 'not_sent' },
  });
  expect(sendViaTwilio).not.toHaveBeenCalled();
});

test('an uncertain provider result stays uncertain on return and audit failure', async () => {
  const uncertain = { sent: false, deliveryOutcome: 'uncertain', provider: 'twilio', retryable: true, error: 'socket hang up' };
  sendViaTwilio.mockResolvedValueOnce(uncertain);
  expect(await sendCustomerMessage(BASE_INPUT)).toMatchObject({
    sent: false,
    deliveryOutcome: 'uncertain',
    retryable: true,
  });

  sendViaTwilio.mockResolvedValueOnce(uncertain);
  persistAudit.mockRejectedValueOnce(new Error('audit unavailable'));
  await expect(sendCustomerMessage(BASE_INPUT)).rejects.toMatchObject({
    providerOutcome: uncertain,
  });
});

test('lead handoff closure reaches only the provider hook, never message or audit state', async () => {
  const withSmsHandoff = jest.fn();
  expect((await sendCustomerMessage({ ...BASE_INPUT, entryPoint: 'lead_response_auto_reply', withSmsHandoff })).sent).toBe(true);
  expect(sendViaTwilio.mock.calls[0][1].withSmsHandoff).toEqual(expect.any(Function));
  expect(sendViaTwilio.mock.calls[0][0]).not.toHaveProperty('withSmsHandoff');
  expect(persistAudit.mock.calls[0][0].input).not.toHaveProperty('withSmsHandoff');
});

test('promised reschedule link can use the locked SMS handoff only with its delivery identity', async () => {
  const valid = { ...BASE_INPUT, audience: 'customer', purpose: 'appointment', entryPoint: 'reschedule-link-promise',
    metadata: { original_message_type: 'reschedule_link_promise', followThroughCommitmentId: 'promise-1' },
    withSmsHandoff: jest.fn() };
  expect((await sendCustomerMessage(valid)).sent).toBe(true);
  expect(sendViaTwilio.mock.calls[0][1].withSmsHandoff).toEqual(expect.any(Function));
  sendViaTwilio.mockClear();
  expect(await sendCustomerMessage({ ...valid, metadata: { original_message_type: 'reschedule_link_promise' } }))
    .toMatchObject({ sent: false, blocked: true, code: 'UNSUPPORTED_SMS_HANDOFF' });
  expect(sendViaTwilio).not.toHaveBeenCalled();
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

test.each([{ channel: 'push' }, { audience: 'customer' }, { purpose: 'appointment' }, { entryPoint: 'other' }, { metadata: { appOnly: true } }])(
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
  const accepted = { sent: true, deliveryOutcome: 'accepted', provider: 'twilio', providerMessageId: `SM${'a'.repeat(32)}`, sentAt: '2026-08-30T15:00:00Z' };
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
    expect(await sendCustomerMessage(input)).toMatchObject({ sent: true, deliveryOutcome: 'accepted' });
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

describe('annual-offer delivery guard at the provider handoff (delivery-guards slice, re-cut of #4569)', () => {
  // The guard (like the move hold / caller preProviderCheck it sits beside)
  // only runs when the provider actually calls the preSendCheck hook it was
  // handed — real Twilio does this immediately before messages.create(); the
  // mock must do the same to exercise it.
  const runViaProviderHook = () => sendViaTwilio.mockImplementationOnce(async (_providerInput, hooks) => {
    const verdict = await hooks.preSendCheck();
    if (!verdict.ok) return { sent: false, provider: 'twilio', deliveryOutcome: 'not_sent' };
    return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-real' };
  });
  const ESTIMATE_INPUT = { ...BASE_INPUT, estimateId: 'est-1' };

  test('estimateId present + withheld verdict blocks — no provider call, blocked result', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => ({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-1' }));
    runViaProviderHook();
    const result = await sendCustomerMessage(ESTIMATE_INPUT);
    expect(result).toMatchObject({
      sent: false, blocked: true, deliveryOutcome: 'not_sent',
      code: 'ANNUAL_OFFER_WITHHELD', reason: 'annual_offer_withheld',
    });
    expect(annualHandoffGuard).toHaveBeenCalledWith({
      db: expect.anything(), estimateIds: ['est-1'], texts: ['What is the service address?'],
    });
    expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({ validatorsFailed: ['annual_offer_guard_boundary'] }));
  });

  test('estimateIds (plural, grouped) present + withheld verdict blocks the whole send', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => ({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-2' }));
    runViaProviderHook();
    const result = await sendCustomerMessage({ ...BASE_INPUT, estimateIds: ['est-1', 'est-2'] });
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'ANNUAL_OFFER_WITHHELD' });
    expect(annualHandoffGuard).toHaveBeenCalledWith({
      db: expect.anything(), estimateIds: ['est-1', 'est-2'], texts: ['What is the service address?'],
    });
  });

  test('estimateId present + delivered (not withheld) verdict dispatches to the provider', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => ({ blocked: false, reason: null, estimateId: null }));
    runViaProviderHook();
    const result = await sendCustomerMessage(ESTIMATE_INPUT);
    expect(result.sent).toBe(true);
    expect(sendViaTwilio).toHaveBeenCalledTimes(1);
  });

  test('no estimateId/estimateIds and a body with no estimate link — the guard still runs (content derivation) but stays a fast no-op', async () => {
    // Codex round 1 on #4608 (P1): the guard is ALWAYS consulted now — it
    // derives an estimate id from the body content, so a caller that omits
    // estimateId is no longer exempt. This body carries no estimate link, so
    // the (mocked) guard sees an empty explicit id list and gets the body as
    // texts, and the send proceeds exactly as before.
    runViaProviderHook();
    const result = await sendCustomerMessage(BASE_INPUT);
    expect(result.sent).toBe(true);
    expect(annualHandoffGuard).toHaveBeenCalledWith({
      db: expect.anything(), estimateIds: [], texts: ['What is the service address?'],
    });
    expect(sendViaTwilio).toHaveBeenCalledTimes(1);
  });

  test('a guard infrastructure error fails the send closed, retryable — never a silent allow', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => { throw new Error('estimates lookup unavailable'); });
    runViaProviderHook();
    const result = await sendCustomerMessage(ESTIMATE_INPUT);
    expect(result).toMatchObject({
      sent: false, blocked: true, deliveryOutcome: 'not_sent',
      code: 'ANNUAL_OFFER_GUARD_FAILED', retryable: true,
    });
  });

  test('composes with a caller preProviderCheck: caller check still runs, and its refusal short-circuits before the guard', async () => {
    const preProviderCheck = jest.fn(async () => ({ ok: false, code: 'LINK_SOURCE_CHANGED', reason: 'visit changed' }));
    sendViaTwilio.mockImplementationOnce(async (_providerInput, hooks) => {
      const verdict = await hooks.preSendCheck();
      expect(verdict).toMatchObject({ ok: false, code: 'LINK_SOURCE_CHANGED' });
      return { sent: false, provider: 'twilio', deliveryOutcome: 'not_sent' };
    });
    const result = await sendCustomerMessage({ ...ESTIMATE_INPUT, preProviderCheck });
    expect(preProviderCheck).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'LINK_SOURCE_CHANGED' });
    // The caller's own refusal wins first — the guard never gets a chance to run.
    expect(annualHandoffGuard).not.toHaveBeenCalled();
  });

  test('composes with a caller preProviderCheck that passes: the guard still runs after it and can block', async () => {
    const preProviderCheck = jest.fn(async () => ({ ok: true }));
    annualHandoffGuard.mockReturnValueOnce(async () => ({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-1' }));
    runViaProviderHook();
    const result = await sendCustomerMessage({ ...ESTIMATE_INPUT, preProviderCheck });
    expect(preProviderCheck).toHaveBeenCalledTimes(1);
    expect(annualHandoffGuard).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'ANNUAL_OFFER_WITHHELD' });
  });

  test('composes with a caller withProviderHandoff (invoice lock): the guard still runs inside the lock', async () => {
    const order = [];
    const withProviderHandoff = jest.fn(async (dispatch) => {
      order.push('lock');
      const outcome = await dispatch();
      order.push('unlock');
      return outcome;
    });
    annualHandoffGuard.mockReturnValueOnce(async () => {
      order.push('guard');
      return { blocked: false, reason: null, estimateId: null };
    });
    sendViaTwilio.mockImplementationOnce(async (_providerInput, hooks) => {
      const verdict = await hooks.preSendCheck();
      expect(verdict.ok).toBe(true);
      order.push('provider');
      return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-real' };
    });
    const result = await sendCustomerMessage({
      ...ESTIMATE_INPUT, audience: 'customer', purpose: 'payment_link',
      entryPoint: 'invoice_send_via_sms', customerId: 'cust-1', invoiceId: 'inv-1', withProviderHandoff,
    });
    expect(result.sent).toBe(true);
    expect(order).toEqual(['lock', 'guard', 'provider', 'unlock']);
  });

  test('round 8 P1: withheldLinkPolicy "rewrite" rewrites the body BEFORE segment counting and dispatch, and clears the explicit estimateId', async () => {
    const originalBody = 'Receipt: https://portal.wavespestcontrol.com/estimate/withheld-token-abc';
    const rewrittenBody = 'Receipt: https://portal.wavespestcontrol.com';
    rewriteWithheldEstimateLinks.mockResolvedValueOnce({ html: undefined, text: rewrittenBody, rewrittenIds: ['est-1'] });
    runViaProviderHook();

    const result = await sendCustomerMessage({
      ...BASE_INPUT,
      body: originalBody,
      estimateId: 'est-1',
      withheldLinkPolicy: 'rewrite',
    });

    // Runs AFTER stripSmsUrlScheme/normalizeGsmPunctuation, so the scheme
    // is already gone by the time the rewrite sees it — the estimate
    // path/token survives either way.
    expect(rewriteWithheldEstimateLinks).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('/estimate/withheld-token-abc'),
    }));
    // The provider (and, upstream of it, segment counting / the audit
    // snapshot) sees the REWRITTEN body — never the raw withheld link —
    // and the explicit id is cleared so it can't survive to refuse a body
    // that no longer carries the link at all.
    expect(sendViaTwilio.mock.calls[0][0]).toMatchObject({
      body: rewrittenBody, estimateId: null, estimateIds: [],
    });
    expect(result).toMatchObject({ sent: true, withheldLinksRewritten: ['est-1'] });
  });

  test('withheldLinkPolicy "rewrite" with nothing to rewrite leaves the body untouched but still drops the explicit id (a link-free receipt must send)', async () => {
    runViaProviderHook();
    const result = await sendCustomerMessage({
      ...BASE_INPUT,
      body: 'Reminder body',
      estimateId: 'est-1',
      withheldLinkPolicy: 'rewrite',
    });

    expect(rewriteWithheldEstimateLinks).toHaveBeenCalledTimes(1);
    expect(sendViaTwilio.mock.calls[0][0]).toMatchObject({
      body: 'Reminder body', estimateId: null, estimateIds: [],
    });
    expect(result.withheldLinksRewritten).toBeUndefined();
  });

  test('round 8 P1: default withheldLinkPolicy (refuse) never calls rewriteWithheldEstimateLinks — non-receipt sends are unaffected', async () => {
    runViaProviderHook();
    await sendCustomerMessage({ ...BASE_INPUT, body: 'Reminder body', estimateId: 'est-1' });
    expect(rewriteWithheldEstimateLinks).not.toHaveBeenCalled();
  });

  test('round 8 P1: a withheld estimate link with the default policy still reaches the guard unrewritten and can be refused at the boundary', async () => {
    // Mirrors the "non-receipt SMS with a withheld link -> still refused"
    // contract: no withheldLinkPolicy means no rewrite, so a blocked
    // verdict from the (mocked) guard still refuses exactly as before.
    annualHandoffGuard.mockReturnValueOnce(async () => ({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-1' }));
    runViaProviderHook();

    const result = await sendCustomerMessage({
      ...BASE_INPUT,
      body: 'https://portal.wavespestcontrol.com/estimate/withheld-token-xyz',
      estimateId: 'est-1',
    });

    expect(rewriteWithheldEstimateLinks).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'ANNUAL_OFFER_WITHHELD' });
  });

  // Round 11 structural fix (P1, pre-push audit on 029ae44d53): a scheduled
  // retry of the deposit receipt SMS (scheduler.js's replayInput) carries
  // NO explicit withheldLinkPolicy of its own — it forwards `purpose`
  // (payment_receipt, via purposeForScheduledMessageType) and
  // metadata.original_message_type (deposit_receipt, forwarded from the
  // queued sms_log row's own message_type), exactly like this input. This
  // pins that send-customer-message.js resolves the policy itself from
  // those two labels (withheldLinkPolicyForSmsPurpose) instead of needing
  // the retry path to pass one, so the retry is REWRITTEN, not refused.
  test('round 11 (P1): a scheduled retry of the deposit receipt SMS (no explicit withheldLinkPolicy, purpose+message-type shaped like scheduler.js\'s replayInput) resolves "rewrite" and is sent with the link stripped', async () => {
    const originalBody = 'Receipt: https://portal.wavespestcontrol.com/estimate/withheld-token-retry';
    const rewrittenBody = 'Receipt: https://portal.wavespestcontrol.com';
    withheldLinkPolicyForSmsPurpose.mockReturnValueOnce('rewrite');
    rewriteWithheldEstimateLinks.mockResolvedValueOnce({ html: undefined, text: rewrittenBody, rewrittenIds: ['est-1'] });
    runViaProviderHook();

    const result = await sendCustomerMessage({
      ...BASE_INPUT,
      audience: 'customer',
      purpose: 'payment_receipt',
      body: originalBody,
      estimateId: 'est-1',
      entryPoint: 'scheduled_sms_cron',
      metadata: { original_message_type: 'deposit_receipt', scheduled_sms_log_id: 'log-1' },
      // No withheldLinkPolicy — this is the whole point of the fix.
    });

    // The resolver is consulted with exactly the two labels a retry
    // carries — no explicit policy overrode it.
    expect(withheldLinkPolicyForSmsPurpose).toHaveBeenCalledWith('payment_receipt', 'deposit_receipt');
    expect(rewriteWithheldEstimateLinks).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('/estimate/withheld-token-retry'),
    }));
    expect(sendViaTwilio.mock.calls[0][0]).toMatchObject({
      body: rewrittenBody, estimateId: null, estimateIds: [],
    });
    expect(result).toMatchObject({ sent: true, withheldLinksRewritten: ['est-1'] });
  });
});
