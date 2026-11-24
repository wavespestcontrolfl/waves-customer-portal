/**
 * The postcard reply (entry point mail_home_text_to_book) needs a SUCCESSFUL suppression lookup: its recipient may have no
 * notification_prefs row, so the phone-keyed STOP list is the only opt-out record, and SMS otherwise fails open on an unreadable
 * row (validators/suppression.js). The wiring (VERIFIED_SUPPRESSION_ENTRY_POINTS in send-customer-message.js) runs through the
 * real sendCustomerMessage pipeline and the real checkSuppression, with the same stubs payer-recipient-validator.test.js uses.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn(() => false) };
});
jest.mock('../services/messaging/validators/consent', () => ({
  ...jest.requireActual('../services/messaging/validators/consent'),
  loadContactState: jest.fn(async () => ({})),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  ...jest.requireActual('../services/messaging/validators/suppression'),
  loadSuppressionState: jest.fn(async (_input, contactState) => { contactState.suppressionLoaded = true; return contactState; }),
}));
jest.mock('../services/messaging/validators/line-type', () => ({ checkLineType: jest.fn(() => ({ ok: true })) }));
jest.mock('../services/messaging/validators/voice', () => ({ validateNoCustomerEmoji: jest.fn(() => ({ ok: true })) }));
jest.mock('../services/messaging/compliance-contact-checks', () => ({ checkContactCompliance: jest.fn(() => ({ ok: true })) }));
jest.mock('../services/messaging/audit', () => ({ persistAudit: jest.fn(async () => ({ id: 'audit-1' })) }));
jest.mock('../services/messaging/providers/twilio-sms', () => ({
  sendViaTwilio: jest.fn(),
  mapPurposeToMessageType: jest.fn(() => 'manual'),
}));
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
  withheldLinkPolicyForSmsPurpose: jest.fn(() => 'refuse'),
}));
jest.mock('../services/disclaimed-number-holds', () => ({ disclaimedNumberBlocksSend: jest.fn(async () => false) }));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { loadSuppressionState } = require('../services/messaging/validators/suppression');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');

const BASE = {
  to: '+12025550101',
  body: "Here's your Waves page for 101 Example Trl: portal.wavespestcontrol.com/nh/101-example\n\nReply STOP to opt out.",
  channel: 'sms',
  audience: 'lead',
  purpose: 'conversational',
  identityTrustLevel: 'phone_provided_unverified',
  consentBasis: { status: 'transactional_allowed', source: 'mail_home_text_to_book' },
  metadata: { original_message_type: 'mail_home_text_to_book' },
};
const POSTCARD = { ...BASE, entryPoint: 'mail_home_text_to_book' };
const OTHER = { ...BASE, entryPoint: 'lead_call_text_followup' };
const ACCEPTED = { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}` };

const unreadable = async (_input, contactState) => { contactState.suppressionLookupFailed = true; return contactState; };

beforeEach(() => {
  jest.clearAllMocks();
  loadSuppressionState.mockImplementation(async (_input, contactState) => { contactState.suppressionLoaded = true; return contactState; });
  sendViaTwilio.mockResolvedValue({ ...ACCEPTED });
});

test('an unreadable suppression row refuses the postcard reply (retryable) before the provider', async () => {
  loadSuppressionState.mockImplementation(unreadable);
  const result = await sendCustomerMessage(POSTCARD);
  expect(result).toMatchObject({ sent: false, blocked: true, code: 'SUPPRESSION_LOOKUP_FAILED', retryable: true });
  expect(sendViaTwilio).not.toHaveBeenCalled();
});

test('a STOP row refuses it, and a clean read sends it', async () => {
  loadSuppressionState.mockImplementation(async (_i, contactState) => {
    contactState.suppression = { reason: 'opt_out_keyword', created_at: '2026-11-03' };
    contactState.suppressionLoaded = true;
    return contactState;
  });
  expect(await sendCustomerMessage(POSTCARD)).toMatchObject({ sent: false, code: 'SUPPRESSED_OPT_OUT' });
  loadSuppressionState.mockImplementation(async (_i, contactState) => { contactState.suppressionLoaded = true; return contactState; });
  expect(await sendCustomerMessage(POSTCARD)).toMatchObject({ sent: true });
});

test('a STOP that lands while the send is prepared stops it at the provider handoff (the row is read again)', async () => {
  sendViaTwilio.mockImplementation(async (_input, hooks) => {
    loadSuppressionState.mockImplementation(async (_i, contactState) => {
      contactState.suppression = { reason: 'opt_out_keyword', created_at: '2026-11-03' };
      contactState.suppressionLoaded = true;
      return contactState;
    });
    const verdict = await hooks.preSendCheck();
    return verdict.ok ? { ...ACCEPTED } : { sent: false, provider: 'twilio', deliveryOutcome: 'not_sent' };
  });
  expect((await sendCustomerMessage(POSTCARD)).sent).toBe(false);
});

test('the requirement is this entry point\'s own: another conversational lead reply still fails open on an unreadable row', async () => {
  loadSuppressionState.mockImplementation(unreadable);
  expect(await sendCustomerMessage(OTHER)).toMatchObject({ sent: true });
});
