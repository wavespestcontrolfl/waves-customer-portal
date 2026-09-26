const {
  BILLING_DELIVERY_FIELDS,
  explicitBillingChannels,
  billingChannelAllowed,
  billingChannelsPayload,
  mergedBillingChannelUpdates,
} = require('../services/billing-delivery-channels');

describe('billing delivery channel contract', () => {
  test.each(Object.values(BILLING_DELIVERY_FIELDS))('profile merges preserve native %s choices and their intersection', (column) => {
    expect(mergedBillingChannelUpdates({}, { [column]: ['push', 'email'] }))
      .toEqual({ [column]: ['email', 'push'] });
    expect(mergedBillingChannelUpdates({ [column]: ['email', 'sms'] }, { [column]: ['sms', 'push'] }))
      .toEqual({ [column]: ['sms'] });
    expect(() => mergedBillingChannelUpdates({ [column]: ['email'] }, { [column]: ['sms'] }))
      .toThrow('Billing notification choices conflict');
  });

  test('merges honor legacy Email/App restrictions without treating untouched Text defaults as consent', () => {
    expect(() => mergedBillingChannelUpdates({ payment_receipt_channel: 'email', email_enabled: false },
      { payment_receipt_channels: ['sms'] })).toThrow('Billing notification choices conflict');
    expect(mergedBillingChannelUpdates({ invoice_channel: 'push' }, { invoice_channels: ['email', 'sms'] }))
      .toEqual({ invoice_channels: ['email'] });
    expect(mergedBillingChannelUpdates({ invoice_channel: 'sms' }, { invoice_channels: ['push'] }))
      .toEqual({ invoice_channels: ['push'] });
    expect(mergedBillingChannelUpdates(null, null)).toEqual({});
  });

  test('merges preserve payment issues inherited from the legacy billing App choice', () => {
    const legacy = { payment_issue_channel: null, billing_channel: 'push', email_enabled: false };
    expect(mergedBillingChannelUpdates(legacy, { payment_issue_channels: ['sms', 'push'] }))
      .toMatchObject({ payment_issue_channels: ['push'] });
    expect(() => mergedBillingChannelUpdates(legacy, { payment_issue_channels: ['sms'] }))
      .toThrow('Billing notification choices conflict');
  });

  test.each([
    ['invoice', 'invoice_channel', 'invoice_channels'],
    ['payment issue', 'payment_issue_channel', 'payment_issue_channels'],
  ])('legacy %s scalar Email remains independent Email plus Text in merges', (_label, legacyColumn, arrayColumn) => {
    expect(mergedBillingChannelUpdates({ [legacyColumn]: 'email' }, { [arrayColumn]: ['sms'] }))
      .toEqual({ [arrayColumn]: ['sms'] });
    expect(mergedBillingChannelUpdates({ [legacyColumn]: 'email' }, { [arrayColumn]: ['email'] }))
      .toEqual({ [arrayColumn]: ['email'] });
    expect(mergedBillingChannelUpdates({ [legacyColumn]: 'email', email_enabled: false }, { [arrayColumn]: ['sms'] }))
      .toEqual({ [arrayColumn]: ['sms'] });
    expect(() => mergedBillingChannelUpdates({ [legacyColumn]: 'email' }, { [arrayColumn]: ['push'] }))
      .toThrow('Billing notification choices conflict');
  });

  test('legacy payment issues inherited from billing Email retain an independent Text leg', () => {
    expect(mergedBillingChannelUpdates({ payment_issue_channel: null, billing_channel: 'email' },
      { payment_issue_channels: ['sms'] })).toEqual({ payment_issue_channels: ['sms'] });
  });

  test.each(['email', 'push', 'sms'])('payment_receipt=false rejects merged %s receipts', (channel) => {
    expect(() => mergedBillingChannelUpdates(
      { payment_receipt: false, payment_receipt_channels: [channel] },
      { payment_receipt_channels: [channel] },
    )).toThrow('Billing notification choices conflict');
    expect(() => mergedBillingChannelUpdates(
      { payment_receipt_channels: [channel] },
      { payment_receipt: false, payment_receipt_channels: [channel] },
    )).toThrow('Billing notification choices conflict');
  });

  test('receipt Text opt-out still allows selected Email or App after merge', () => {
    expect(mergedBillingChannelUpdates(
      { payment_receipt_channels: ['email', 'sms', 'push'], payment_confirmation_sms: false },
      { payment_receipt_channels: ['email', 'sms', 'push'] },
    )).toEqual({});
  });

  test('merges preserve non-default legacy choices and refuse globally stranded selections', () => {
    expect(() => mergedBillingChannelUpdates({ billing_channel: 'both' }, { billing_channels: ['push'] }))
      .toThrow('Billing notification choices conflict');
    expect(mergedBillingChannelUpdates({ payment_issue_channel: 'sms' }, { payment_issue_channels: ['sms', 'push'] }))
      .toMatchObject({ payment_issue_channels: ['sms'] });
    expect(() => mergedBillingChannelUpdates(
      { invoice_channels: ['email', 'sms'], email_enabled: true, sms_enabled: false },
      { invoice_channels: ['email', 'sms'], email_enabled: false, sms_enabled: true },
    )).toThrow('Billing notification choices conflict');
    expect(() => mergedBillingChannelUpdates(
      { payment_receipt_channels: ['sms'], payment_confirmation_sms: true },
      { payment_receipt_channels: ['sms'], payment_confirmation_sms: false },
    )).toThrow('Billing notification choices conflict');
  });

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

  test('legacy payment issues inherit the billing scalar only while their dedicated scalar is NULL', () => {
    expect(billingChannelsPayload({
      payment_issue_channel: null, billing_channel: 'push', email_enabled: false,
    }).paymentIssueChannels).toEqual(['push']);
    expect(billingChannelsPayload({
      payment_issue_channel: 'sms', billing_channel: 'push', email_enabled: false,
    }).paymentIssueChannels).toEqual(['sms']);
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

  test.each(['email', 'both'])('legacy billing %s retains the existing SMS fallback when email is unavailable', (legacy) => {
    const prefs = { billing_channel: legacy };
    expect(billingChannelsPayload(prefs).billingReminderChannels).toEqual(legacy === 'email' ? ['email'] : ['email', 'sms']);
    expect(billingChannelsPayload(prefs, { emailAvailable: false }).billingReminderChannels).toEqual(['sms']);
    expect(billingChannelsPayload({ ...prefs, email_enabled: false }).billingReminderChannels).toEqual(['sms']);
    expect(billingChannelsPayload({ ...prefs, billing_channels: ['email'], email_enabled: false }, { emailAvailable: false }).billingReminderChannels).toEqual(['email']);
  });
});

describe('storedBillingChannels (the property row the send path reads)', () => {
  const { storedBillingChannels } = require('../services/billing-delivery-channels');
  const databaseWith = (row, fail = false) => jest.fn(() => {
    const q = { where: jest.fn(() => q), first: jest.fn(async () => { if (fail) throw new Error('prefs read failed'); return row; }) };
    return q;
  });
  test('reads the property\'s own explicit choice', async () => {
    await expect(storedBillingChannels('prop-1', 'billing', databaseWith({ billing_channels: ['email'] }))).resolves.toEqual(['email']);
  });
  test('no row or no choice is null (legacy routing)', async () => {
    await expect(storedBillingChannels('prop-1', 'billing', databaseWith(undefined))).resolves.toBeNull();
    await expect(storedBillingChannels('prop-1', 'billing', databaseWith({}))).resolves.toBeNull();
  });
  test('an unreadable row throws so the caller fails closed', async () => {
    await expect(storedBillingChannels('prop-1', 'billing', databaseWith(null, true))).rejects.toThrow('prefs read failed');
  });
});
