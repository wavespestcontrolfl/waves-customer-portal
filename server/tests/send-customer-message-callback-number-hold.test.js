/**
 * callback_number_needed hold — the round-5 structural fix (PR #4807).
 *
 * Rounds 2 and 4 patched this per sender: safeSendAppointment's one-time
 * entry read (round 2), then safeSend's own provider-handoff recheck
 * composed into dispatchCheck (round 4, closing a race between that entry
 * read and the actual sendCustomerMessage call). Round 5 found the SAME
 * read-once-then-text-later shape in a sender that never went through
 * safeSend at all — twilio.js's en-route/arrival, which read the hold once
 * at the top of the function and never rechecked before dispatch.
 *
 * The fix moves the recheck into sendCustomerMessage itself — the one
 * place every appointment-linked SMS passes immediately before the
 * provider handoff — keyed on whichever shape the caller carries the visit
 * id in: input.appointmentId (en-route, arrival, safeSend) or
 * metadata.scheduled_service_id / metadata.visit_id
 * (appointment-card-request, which never sets a top-level appointmentId).
 * This file pins that boundary directly, with appointment-reminders.js's
 * own predicate mocked out (its exhaustive timestamp/fail-closed/grouped-
 * visitId behavior is already covered by callback-number-hold-boundary
 * .test.js) so this file only tests the WIRING: which inputs trigger the
 * check, with what key, and what the block looks like.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn(() => false) };
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
  resolveTrustLevel: jest.fn(() => 'phone_matches_customer'),
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
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
  withheldLinkPolicyForSmsPurpose: jest.fn(() => 'refuse'),
}));
jest.mock('../services/appointment-reminders', () => ({
  callbackNumberHoldActiveForVisit: jest.fn(async () => false),
}));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { persistAudit } = require('../services/messaging/audit');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');
const AppointmentReminders = require('../services/appointment-reminders');

const BASE_INPUT = {
  to: '+19415550142',
  body: 'Your tech is on the way.',
  channel: 'sms',
  audience: 'customer',
  customerId: 'cust-1',
  purpose: 'tech_en_route',
};

beforeEach(() => {
  jest.clearAllMocks();
  sendViaTwilio.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-real' });
  persistAudit.mockResolvedValue({ id: 'audit-1' });
  AppointmentReminders.callbackNumberHoldActiveForVisit.mockResolvedValue(false);
});

test('a held visit blocks the send via appointmentId (en-route/arrival/safeSend shape) — no provider call, audited, retryable', async () => {
  AppointmentReminders.callbackNumberHoldActiveForVisit.mockResolvedValueOnce(true);
  const result = await sendCustomerMessage({ ...BASE_INPUT, appointmentId: 'svc-1' });
  expect(result).toMatchObject({
    sent: false, blocked: true, deliveryOutcome: 'not_sent',
    code: 'CALLBACK_NUMBER_HOLD', retryable: true,
  });
  expect(sendViaTwilio).not.toHaveBeenCalled();
  expect(AppointmentReminders.callbackNumberHoldActiveForVisit).toHaveBeenCalledWith('svc-1');
  expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({
    validatorsFailed: ['callback_number_hold'],
    blockedBy: { code: 'CALLBACK_NUMBER_HOLD', reason: 'Caller disclaimed this number (callback_number_needed)' },
  }));
});

test('a held visit blocks the send via metadata.scheduled_service_id (appointment-card-request shape — no top-level appointmentId)', async () => {
  AppointmentReminders.callbackNumberHoldActiveForVisit.mockResolvedValueOnce(true);
  const result = await sendCustomerMessage({
    ...BASE_INPUT,
    purpose: 'card_request',
    metadata: { scheduled_service_id: 'svc-2', original_message_type: 'card_request_sms' },
  });
  expect(result).toMatchObject({ sent: false, blocked: true, code: 'CALLBACK_NUMBER_HOLD' });
  expect(AppointmentReminders.callbackNumberHoldActiveForVisit).toHaveBeenCalledWith('svc-2');
  expect(sendViaTwilio).not.toHaveBeenCalled();
});

test('a held GROUPED visit blocks via metadata.visit_id alongside metadata.scheduled_service_id (grouped reminder shape)', async () => {
  AppointmentReminders.callbackNumberHoldActiveForVisit.mockResolvedValueOnce(true);
  const result = await sendCustomerMessage({
    ...BASE_INPUT,
    appointmentId: 'svc-owner',
    metadata: { scheduled_service_id: 'svc-owner', visit_id: 'visit-group-9' },
  });
  expect(result).toMatchObject({ sent: false, blocked: true, code: 'CALLBACK_NUMBER_HOLD' });
  expect(AppointmentReminders.callbackNumberHoldActiveForVisit).toHaveBeenCalledWith({
    scheduledServiceId: 'svc-owner', visitId: 'visit-group-9',
  });
});

test('not held → dispatches normally to the provider', async () => {
  const result = await sendCustomerMessage({ ...BASE_INPUT, appointmentId: 'svc-clear' });
  expect(result.sent).toBe(true);
  expect(sendViaTwilio).toHaveBeenCalledTimes(1);
});

test('no appointmentId and no metadata visit key at all → the hold predicate is never consulted', async () => {
  const result = await sendCustomerMessage({ ...BASE_INPUT, purpose: 'conversational' });
  expect(result.sent).toBe(true);
  expect(AppointmentReminders.callbackNumberHoldActiveForVisit).not.toHaveBeenCalled();
});

test('push channel (App routing) never checks the hold — the disclaimed number is never dialed either way', async () => {
  // Only the hold predicate's non-involvement is under test here — push
  // delivery itself is a separate mechanism this file doesn't mock further.
  await sendCustomerMessage({ ...BASE_INPUT, channel: 'push', appointmentId: 'svc-1' });
  expect(AppointmentReminders.callbackNumberHoldActiveForVisit).not.toHaveBeenCalled();
});

// callbackNumberHoldActiveForVisit already fails CLOSED internally (a DB
// read error resolves `true`, never rejects — see
// callback-number-hold-boundary.test.js) — this chokepoint trusts that
// contract exactly like the MOVE_HOLD check beside it trusts
// visit-groups.appointmentSendHeld's own fail-closed return, so a "held"
// resolution (test #1 above) IS the read-error-fails-closed case.

test('a test double that mocks appointment-reminders without the function degrades to "not held"', async () => {
  const original = AppointmentReminders.callbackNumberHoldActiveForVisit;
  delete AppointmentReminders.callbackNumberHoldActiveForVisit;
  try {
    const result = await sendCustomerMessage({ ...BASE_INPUT, appointmentId: 'svc-1' });
    expect(result.sent).toBe(true);
  } finally {
    AppointmentReminders.callbackNumberHoldActiveForVisit = original;
  }
});
