const BILLING_DELIVERY_FIELDS = Object.freeze({
  invoiceChannels: 'invoice_channels',
  paymentIssueChannels: 'payment_issue_channels',
  billingReminderChannels: 'billing_channels',
  paymentConfirmationChannels: 'payment_receipt_channels',
});

const CATEGORY_FIELDS = Object.freeze({
  invoice: 'invoiceChannels',
  payment_issue: 'paymentIssueChannels',
  billing: 'billingReminderChannels',
  payment_receipt: 'paymentConfirmationChannels',
});

const LEGACY_FIELDS = Object.freeze({
  invoice: 'invoice_channel',
  payment_issue: 'payment_issue_channel',
  billing: 'billing_channel',
  payment_receipt: 'payment_receipt_channel',
});

const CHANNEL_ORDER = Object.freeze(['email', 'sms', 'push']);

function canonicalChannels(channels = []) {
  return CHANNEL_ORDER.filter((channel) => channels.includes(channel));
}

function explicitBillingChannels(prefs = {}, category) {
  const apiField = CATEGORY_FIELDS[category];
  if (!apiField) return null;
  const value = prefs?.[BILLING_DELIVERY_FIELDS[apiField]];
  return Array.isArray(value) ? canonicalChannels(value) : null;
}

function billingChannelAllowed(prefs = {}, category, channel) {
  const explicit = explicitBillingChannels(prefs, category);
  return explicit === null ? null : explicit.includes(channel);
}

function legacyChannels(prefs = {}, category, emailAvailable) {
  const legacy = category === 'payment_issue' && prefs.payment_issue_channel == null
    ? prefs.billing_channel : prefs[LEGACY_FIELDS[category]];
  const independentEmail = emailAvailable && prefs.email_enabled !== false;
  if (category === 'billing') {
    if (legacy === 'email') return independentEmail ? ['email'] : ['sms'];
    if (legacy === 'both') return independentEmail ? ['email', 'sms'] : ['sms'];
    if (legacy === 'push') return ['push'];
    return ['sms'];
  }

  if (category === 'payment_receipt') {
    if (legacy === 'email') return independentEmail ? ['email'] : ['sms'];
    if (legacy === 'both') return independentEmail ? ['email', 'sms'] : ['sms'];
  }

  const channels = [legacy === 'push' ? 'push' : 'sms'];
  if (independentEmail) channels.push('email');
  return canonicalChannels(channels);
}

function billingChannelsPayload(prefs = {}, { emailAvailable = true } = {}) {
  prefs = prefs || {};
  const payload = { billingChannelsAvailable: true };
  for (const [category, apiField] of Object.entries(CATEGORY_FIELDS)) {
    payload[apiField] = explicitBillingChannels(prefs, category)
      || legacyChannels(prefs, category, emailAvailable);
  }
  return payload;
}

module.exports = {
  BILLING_DELIVERY_FIELDS,
  explicitBillingChannels,
  billingChannelAllowed,
  billingChannelsPayload,
};
