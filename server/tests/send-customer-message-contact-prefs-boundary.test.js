/**
 * On-location contact's own notification choices, re-checked at the provider
 * boundary (codex #6363 r24 P2).
 *
 * The fan-outs (appointment reminders, en-route, arrived, …) filter their
 * recipient lists through filterContactsByOwnPrefs before the body renders
 * and before the provider's own awaits. A contact who turns the purpose (or
 * texts altogether) off in that window must still be held, so the canonical
 * sender re-asks contactPhoneDeclinesText inside providerPreparationCheck —
 * the preSendCheck hook twilio.js awaits immediately before
 * messages.create() — for every service-contact SMS leg. The helper's own
 * row/gate/fail-closed behavior is covered by contact-notification-prefs.test.js;
 * this file tests the WIRING.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) }));
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
  resolveTrustLevel: jest.fn((input) => input.identityTrustLevel || 'phone_matches_customer'),
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
  sendViaTwilio: jest.fn(),
  mapPurposeToMessageType: jest.fn(() => 'manual'),
}));
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
  withheldLinkPolicyForSmsPurpose: jest.fn(() => 'refuse'),
}));
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
}));
jest.mock('../services/contact-notification-prefs', () => ({
  contactPhoneDeclinesText: jest.fn(async () => false),
}));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { persistAudit } = require('../services/messaging/audit');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');
const { contactPhoneDeclinesText } = require('../services/contact-notification-prefs');

const CONTACT_LEG = {
  to: '+19415550142',
  body: 'Your tech is on the way.',
  channel: 'sms',
  audience: 'customer',
  customerId: 'cust-1',
  purpose: 'tech_en_route',
  identityTrustLevel: 'service_contact_authorized',
};

// Real Twilio awaits the preSendCheck hook immediately before
// messages.create(); the mock does the same so the boundary runs.
const runViaProviderHook = () => sendViaTwilio.mockImplementation(async (_providerInput, hooks) => {
  const verdict = await hooks.preSendCheck();
  if (!verdict.ok) return { sent: false, provider: 'twilio', deliveryOutcome: 'not_sent' };
  return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-real' };
});

beforeEach(() => {
  jest.clearAllMocks();
  runViaProviderHook();
  persistAudit.mockResolvedValue({ id: 'audit-1' });
  contactPhoneDeclinesText.mockResolvedValue(false);
});

test('a contact who declines the purpose after the fan-out filter is held at the handoff: no provider call, audited, not retryable', async () => {
  contactPhoneDeclinesText.mockResolvedValueOnce(true);
  const result = await sendCustomerMessage(CONTACT_LEG);
  expect(result).toMatchObject({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'CONTACT_DECLINED' });
  expect(result.retryable).not.toBe(true);
  // The leg's own destination and the purpose's preference column; requireSlot
  // so a number the holder removed since the fan-out is held as a former contact.
  expect(contactPhoneDeclinesText).toHaveBeenCalledWith('cust-1', '+19415550142', 'tech_en_route', { requireSlot: true });
  expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({
    validatorsFailed: ['contact_prefs_boundary'],
    blockedBy: expect.objectContaining({ code: 'CONTACT_DECLINED' }),
  }));
});

test('a contact leg still allowed at the handoff goes out', async () => {
  const result = await sendCustomerMessage(CONTACT_LEG);
  expect(result.sent).toBe(true);
  expect(contactPhoneDeclinesText).toHaveBeenCalledTimes(1);
});

test('the holder\'s own leg never consults the contact table', async () => {
  const result = await sendCustomerMessage({ ...CONTACT_LEG, identityTrustLevel: 'phone_matches_customer' });
  expect(result.sent).toBe(true);
  expect(contactPhoneDeclinesText).not.toHaveBeenCalled();
});

test('an App-push leg never consults it either — only the holder can use the app, and no number is dialed', async () => {
  await sendCustomerMessage({ ...CONTACT_LEG, channel: 'push' });
  expect(contactPhoneDeclinesText).not.toHaveBeenCalled();
});

test('a thrown re-read defers the leg retryably instead of sending on an unknown choice', async () => {
  contactPhoneDeclinesText.mockRejectedValueOnce(new Error('relation unavailable'));
  const result = await sendCustomerMessage(CONTACT_LEG);
  expect(result).toMatchObject({ sent: false, blocked: true, code: 'CONTACT_PREFS_LOOKUP_FAILED', retryable: true });
  expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({ validatorsFailed: ['contact_prefs_lookup_boundary'] }));
});
