// The customer-dunning text leg against the REAL consent validator (not a mock). The engine test fakes the
// sender, which hid this: a leg marked `billingDeliveryLeg` on a default-channel customer, or on an operator
// send-now, is refused by the validator as BILLING_PREFERENCES_CHANGED and then retried forever.
//
// sendTextLeg builds the exact message input; it is fed to the real checkConsentForPurpose with a real policy.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(async (key) => `SMS[${key}] pay`) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async () => 'https://s.example.test/x'), invoiceShortCodePrefix: () => 'W-1' }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.example.test' }));
jest.mock('../services/email-template-library', () => ({}));
jest.mock('../services/billing-channel-email-authority', () => ({
  dispatchUnderBillingEmailAuthority: jest.fn(), blocked: jest.fn(), loadBillingEmailContext: jest.fn(),
}));
let mockSent;
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async (input) => { mockSent = input; return { sent: true, blocked: false, deliveryOutcome: 'accepted' }; }),
}));

const { checkConsentForPurpose } = require('../services/messaging/validators/consent');
const { resolvePolicy } = require('../services/messaging/policy');
const Send = require('../services/customer-dunning/send');
const config = require('../config/invoice-followups');

const CUSTOMER = { id: 'cust-1', phone: '+19415550100', first_name: 'Pat', email: 'pat@example.test' };
const ledger = { id: 'led-1' };
const set = {
  kind: 'multi', anchor: { id: 'inv-a', token: 't', title: 'x', invoice_number: 'W-1' },
  members: [{ invoice_id: 'inv-a', cents: 10000 }, { invoice_id: 'inv-b', cents: 10000 }], totalCents: 20000,
};
const baseCtx = () => ({
  schedule: { id: 's1', episode: 1, step_index: 4 }, step: config.stepsThrough90[4], customer: CUSTOMER, set, channels: ['email', 'sms'],
  eventKey: 'customer-dunning:s1:1:d60_reminder', claimStamp: new Date(), link: 'https://s.example.test/x',
  snapshot: { customerId: 'cust-1', kind: 'multi', digest: 'd', totalCents: 20000, anchorId: 'inv-a' },
});
const baseState = (prefs) => ({
  prefs: { sms_enabled: true, ...prefs }, customer: CUSTOMER, suppressionLoaded: true, hasInboundHistory: false,
});

// What the leg sends, judged by the real consent validator against the customer's CURRENT preferences.
async function consentFor(ctx, currentPrefs) {
  await Send.sendTextLeg(ctx, 'sms', ledger);
  return { input: mockSent, verdict: await checkConsentForPurpose(mockSent, resolvePolicy('customer', 'payment_link'), baseState(currentPrefs)) };
}

describe('customer-dunning text leg vs the real consent validator', () => {
  test('a DEFAULT-channel customer (no explicit selection): no delivery-leg marker, consent allows the text', async () => {
    const { input, verdict } = await consentFor({ ...baseCtx(), explicit: false }, {});
    expect(input.metadata.billingDeliveryLeg).toBeUndefined();
    expect(verdict).toEqual({ ok: true });
  });

  test('an EXPLICIT text preference: the leg is marked, and consent allows it while the preference stands', async () => {
    const { input, verdict } = await consentFor({ ...baseCtx(), explicit: true }, { invoice_channels: ['sms'] });
    expect(input.metadata.billingDeliveryLeg).toBe('sms');
    expect(verdict).toEqual({ ok: true });
  });

  test('an OPERATOR send-now (never marked, prefs ignored): consent allows the text even for an explicit email-only customer', async () => {
    const { input, verdict } = await consentFor({ ...baseCtx(), explicit: false, operatorInitiated: true }, { invoice_channels: ['email'] });
    expect(input.metadata.billingDeliveryLeg).toBeUndefined();
    expect(input.operatorInitiated).toBe(true);
    expect(verdict).toEqual({ ok: true });
    // and an operator context can never carry the marker, even if the run believed the preference explicit
    await Send.sendTextLeg({ ...baseCtx(), explicit: true, operatorInitiated: true }, 'sms', ledger);
    expect(mockSent.metadata.billingDeliveryLeg).toBeUndefined();
  });

  test('an explicit preference that CHANGED mid-dispatch is refused as BILLING_PREFERENCES_CHANGED (the schedulable hold)', async () => {
    const { input, verdict } = await consentFor({ ...baseCtx(), explicit: true }, { invoice_channels: ['email'] });
    expect(input.metadata.billingDeliveryLeg).toBe('sms');
    expect(verdict).toMatchObject({ ok: false, code: 'BILLING_PREFERENCES_CHANGED' });
  });

  test('regression: the old unconditional marker on a default-channel or operator send IS refused by the validator', async () => {
    const policy = resolvePolicy('customer', 'payment_link');
    const defaultLeg = await checkConsentForPurpose({ ...(await consentFor({ ...baseCtx(), explicit: false }, {})).input, metadata: { ...mockSent.metadata, billingDeliveryLeg: 'sms' } }, policy, baseState({}));
    expect(defaultLeg).toMatchObject({ ok: false, code: 'BILLING_PREFERENCES_CHANGED' });
    await Send.sendTextLeg({ ...baseCtx(), explicit: false, operatorInitiated: true }, 'sms', ledger);
    const operatorLeg = await checkConsentForPurpose({ ...mockSent, metadata: { ...mockSent.metadata, billingDeliveryLeg: 'sms' } }, policy, baseState({}));
    expect(operatorLeg).toMatchObject({ ok: false, code: 'BILLING_PREFERENCES_CHANGED' });
  });
});
