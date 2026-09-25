const {
  BILLING_DELIVERY_FIELDS,
  explicitBillingChannels,
  billingChannelAllowed,
  billingChannelsPayload,
} = require('../services/billing-delivery-channels');

describe('billing delivery channel contract', () => {
  test('maps the four API fields to additive nullable array columns', () => {
    expect(BILLING_DELIVERY_FIELDS).toEqual({
      invoiceChannels: 'invoice_channels',
      paymentIssueChannels: 'payment_issue_channels',
      billingReminderChannels: 'billing_channels',
      paymentConfirmationChannels: 'payment_receipt_channels',
    });
  });

  test.each([
    ['invoice', 'invoice_channels'],
    ['payment_issue', 'payment_issue_channels'],
    ['billing', 'billing_channels'],
    ['payment_receipt', 'payment_receipt_channels'],
  ])('%s distinguishes a legacy NULL from an explicit choice', (category, column) => {
    expect(explicitBillingChannels({}, category)).toBeNull();
    expect(explicitBillingChannels(null, category)).toBeNull();
    expect(billingChannelAllowed({}, category, 'sms')).toBeNull();
    const prefs = { [column]: ['push', 'email'] };
    expect(explicitBillingChannels(prefs, category)).toEqual(['email', 'push']);
    expect(billingChannelAllowed(prefs, category, 'push')).toBe(true);
    expect(billingChannelAllowed(prefs, category, 'sms')).toBe(false);
  });

  test.each([
    [['email'], ['email']],
    [['sms'], ['sms']],
    [['push'], ['push']],
    [['sms', 'email'], ['email', 'sms']],
    [['push', 'email'], ['email', 'push']],
    [['push', 'sms'], ['sms', 'push']],
    [['push', 'email', 'sms'], ['email', 'sms', 'push']],
  ])('canonicalizes accepted nonempty combinations: %j', (input, expected) => {
    expect(explicitBillingChannels({ invoice_channels: input }, 'invoice')).toEqual(expected);
  });

  test('legacy invoice, payment issue, and receipt payloads retain their sms/App leg plus independent email', () => {
    expect(billingChannelsPayload({
      invoice_channel: 'sms',
      payment_issue_channel: 'push',
      payment_receipt_channel: 'sms',
      billing_channel: 'both',
    })).toEqual({
      invoiceChannels: ['email', 'sms'],
      paymentIssueChannels: ['email', 'push'],
      billingReminderChannels: ['email', 'sms'],
      paymentConfirmationChannels: ['email', 'sms'],
      billingChannelsAvailable: true,
    });
  });

  test('legacy independent email copies follow address availability and the existing email flag', () => {
    const prefs = { payment_issue_channel: 'push', email_enabled: false };
    expect(billingChannelsPayload(prefs).paymentIssueChannels).toEqual(['push']);
    expect(billingChannelsPayload({ ...prefs, email_enabled: true }, { emailAvailable: false }).paymentIssueChannels)
      .toEqual(['push']);
  });

  test('legacy email-only payment receipts stay email-only when deliverable and fall back to sms otherwise', () => {
    const prefs = { payment_receipt_channel: 'email' };
    expect(billingChannelsPayload(prefs).paymentConfirmationChannels).toEqual(['email']);
    expect(billingChannelsPayload(prefs, { emailAvailable: false }).paymentConfirmationChannels).toEqual(['sms']);
    expect(billingChannelsPayload({ ...prefs, email_enabled: false }).paymentConfirmationChannels).toEqual(['sms']);
    expect(billingChannelsPayload({ payment_receipt_channel: 'both' }).paymentConfirmationChannels)
      .toEqual(['email', 'sms']);
  });

  test('explicit arrays survive channel outages and override legacy scalar flags', () => {
    const payload = billingChannelsPayload({
      invoice_channels: ['push', 'email'],
      invoice_channel: 'sms',
      email_enabled: false,
    }, { emailAvailable: false });
    expect(payload.invoiceChannels).toEqual(['email', 'push']);
  });
});
