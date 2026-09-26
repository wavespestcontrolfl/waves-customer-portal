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

// Explicit choices outrank untouched legacy defaults. Known Email/App
// restrictions still participate so a profile merge cannot resume Text.
function mergeLegacyChannels(prefs, category) {
  const direct = prefs?.[LEGACY_FIELDS[category]];
  const legacy = category === 'payment_issue' && direct == null ? prefs?.billing_channel : direct;
  if (direct === 'email' && ['billing', 'payment_receipt'].includes(category)) return ['email'];
  const intentional = ['email', 'both', 'push'].includes(legacy)
    || (category === 'payment_issue' && direct === 'sms');
  return intentional ? legacyChannels(prefs, category, true) : null;
}

function channelEnabledAfterMerge(winner, loser, category, channel) {
  const enabled = (field) => [winner, loser].every((row) => row?.[field] !== false);
  if (category === 'payment_receipt' && !enabled('payment_receipt')) return false;
  if (channel === 'email') return enabled('email_enabled');
  if (channel === 'push') return enabled('push_enabled');
  return enabled('sms_enabled')
    && (category !== 'payment_receipt' || enabled('payment_confirmation_sms'));
}

function mergedBillingChannelUpdates(winner = {}, loser = {}) {
  const updates = {};
  for (const [category, apiField] of Object.entries(CATEGORY_FIELDS)) {
    const column = BILLING_DELIVERY_FIELDS[apiField];
    if (![winner, loser].some((row) => Array.isArray(row?.[column]))) continue;
    const choices = [winner, loser].map((row) => explicitBillingChannels(row, category)
      || mergeLegacyChannels(row, category));
    const [left, right] = choices;
    const channels = left && right ? left.filter((channel) => right.includes(channel)) : left || right;
    if (!channels.length
      || !channels.some((channel) => channelEnabledAfterMerge(winner, loser, category, channel))) {
      throw Object.assign(new Error('Billing notification choices conflict. Choose a common delivery method before merging these profiles.'), {
        mergeConflictCode: 'billing_delivery_channels_conflict', statusCode: 409,
      });
    }
    if (channels.join() !== (winner?.[column] || []).join()) updates[column] = channels;
  }
  return updates;
}

// A customer's stored billing channel choice for a category. Delivery
// channel choices are account-level and persisted on the account's PRIMARY
// profile (routes/notifications.js), so a sibling property's reminder must
// read the primary's row — the same owner rule the router core applies
// (push-channel-routing readChannelPreference). Throws when the owner or the
// row cannot be read: a delivery decision must fail closed, never fall back
// to legacy routing on an unknown choice. Returns null when none is stored.
async function accountBillingChannels(customerId, category, knex) {
  const database = knex || require('../models/db');
  const customer = await database('customers').where({ id: customerId }).first('account_id');
  if (!customer) return null;
  // Same rule as the messaging core (consent loadContactState overlays the
  // primary's arrays only onto an existing row): a property with no prefs
  // row of its own routes legacy, so every caller agrees with the send path.
  const own = await database('notification_prefs').where({ customer_id: customerId }).first();
  if (!own) return null;
  const { resolvePrimaryProfileId } = require('./account-properties');
  const ownerId = await resolvePrimaryProfileId(
    { customerId, accountId: customer.account_id }, database, { onError: 'throw' },
  );
  const prefs = String(ownerId) === String(customerId)
    ? own : await database('notification_prefs').where({ customer_id: ownerId }).first();
  return explicitBillingChannels(prefs || {}, category);
}

module.exports = {
  BILLING_DELIVERY_FIELDS,
  accountBillingChannels,
  explicitBillingChannels,
  billingChannelAllowed,
  billingChannelsPayload,
  mergedBillingChannelUpdates,
};
