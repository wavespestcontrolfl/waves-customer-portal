// The no-phone pre-charge legs through the REAL canonical sender (codex
// #4833 r1): until the canonical Routing / Email dependencies named in
// #4803 deploy, a leg with no phone is refused before any provider is
// reached — push eligibility is phone-keyed (push-channel-routing.js
// pushEligibleRuntime) and the sender has no email provider. This pins that
// the refusal is a clean not_sent (no customer contact, no provider call),
// which the workflow treats as "no progress, retry next run".
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/messaging/audit', () => ({ persistAudit: jest.fn(async () => ({ id: 'audit-test' })) }));
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
  disclaimedNumberHeldForVisit: jest.fn(async () => false),
}));

const db = require('../models/db');
const Twilio = require('../services/twilio');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

const customerId = '11111111-1111-4111-8111-111111111111';

function preChargeLeg(channel) {
  return {
    to: null, body: 'Hello! Your auto-pay processes soon.', channel,
    audience: 'customer', purpose: 'autopay', customerId, entryPoint: 'autopay_pre_charge_reminder',
    metadata: {
      original_message_type: 'autopay_pre_charge', billing_mode_at_send: 'monthly_membership',
      billingDeliveryCategory: 'billing', notificationEventKey: `autopay-pre-charge:${customerId}:2026-10-01`,
      billingDeliveryLeg: channel, ...(channel === 'push' ? { appOnly: true } : {}),
    },
    preDispatchCheck: async () => ({ ok: true }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true';
  db.mockImplementation(() => {
    const q = { where: jest.fn(() => q), whereIn: jest.fn(() => q), first: jest.fn(async () => null) };
    return q;
  });
});
afterEach(() => { delete process.env.GATE_CUSTOMER_APP_NOTIFICATIONS; });

test.each(['push', 'email'])('a no-phone %s leg is refused as not_sent before any provider or customer contact', async (channel) => {
  const result = await sendCustomerMessage(preChargeLeg(channel));
  expect(result).toMatchObject({ sent: false, deliveryOutcome: 'not_sent' });
  expect(result.deliveryOutcome).not.toBe('accepted');
  expect(Twilio.sendSMS).not.toHaveBeenCalled();
});
