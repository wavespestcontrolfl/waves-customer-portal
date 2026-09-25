const db = require('../models/db');
const EmailTemplateLibrary = require('./email-template-library');
const { getInvoiceEmailRecipients } = require('./customer-contact');
const { billingChannelAllowed } = require('./billing-delivery-channels');
const { publicPortalUrl } = require('../utils/portal-url');
const { withCustomerCommsLock, lockCustomerEmail } = require('../utils/customer-comms-lock');

const CATEGORY_LABELS = Object.freeze({
  invoice: 'Invoice update',
  payment_issue: 'Payment problem',
  billing: 'Billing reminder',
  payment_receipt: 'Payment receipt',
});

function clean(value) {
  return String(value || '').trim();
}

function cleanEmail(value) {
  return clean(value).toLowerCase();
}

function emailNotificationBody(value) {
  return clean(value).replace(/\s*Reply STOP to opt out\.?\s*$/i, '').trim();
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value));
}

function blocked(code, reason, { retryable = false } = {}) {
  return {
    sent: false,
    provider: 'email',
    providerMessageId: null,
    deliveryOutcome: 'not_sent',
    blocked: true,
    code,
    reason,
    ...(retryable ? { retryable: true } : {}),
  };
}

async function readContextRows(input, database, lockRecipients, lockedInvoice) {
  const customerQuery = database('customers').where({ id: input.customerId });
  const prefsQuery = database('notification_prefs').where({ customer_id: input.customerId });
  if (lockRecipients) {
    customerQuery.forUpdate();
    prefsQuery.forUpdate();
  }
  const customer = await customerQuery.first();
  const prefs = await prefsQuery.first();
  const invoice = lockedInvoice
    || (input.invoiceId ? await database('invoices').where({ id: input.invoiceId }).first() : null);
  return { customer, prefs, invoice };
}

async function contextBlock(input, category, { customer, prefs, invoice }, database) {
  if (!customer || customer.deleted_at) return { error: blocked('CUSTOMER_NOT_FOUND', 'Customer is unavailable') };
  if (!prefs) return { error: blocked('BILLING_PREFS_UNAVAILABLE', 'Billing delivery preferences are unavailable', { retryable: true }) };
  if (prefs.email_enabled === false) {
    return { error: blocked('BILLING_EMAIL_DISABLED', 'Email notifications are disabled for this customer') };
  }
  if (billingChannelAllowed(prefs, category, 'email') !== true) {
    return { error: blocked('BILLING_EMAIL_NOT_SELECTED', 'Email is not selected for this billing category') };
  }
  if (input.invoiceId) {
    if (!invoice || String(invoice.customer_id) !== String(customer.id)) {
      return { error: blocked('INVOICE_CUSTOMER_MISMATCH', 'Invoice does not belong to this customer') };
    }
    const ownership = await require('./invoice-helpers').selfPayAtDispatch(invoice.id, database)();
    if (ownership.ok !== true) {
      return { error: blocked(ownership.code || 'INVOICE_NOT_SELF_PAY', ownership.reason || 'Invoice is not eligible for customer delivery') };
    }
  }
  return null;
}

async function loadContext(input, database = db, { lockRecipients = false, invoice: lockedInvoice = null } = {}) {
  const category = clean(input?.metadata?.billingDeliveryCategory);
  if (!CATEGORY_LABELS[category]) return { error: blocked('INVALID_BILLING_CATEGORY', 'Unknown billing delivery category') };
  if (!input?.customerId) return { error: blocked('CUSTOMER_REQUIRED', 'Billing email requires a customer') };

  const rows = await readContextRows(input, database, lockRecipients, lockedInvoice);
  const invalid = await contextBlock(input, category, rows, database);
  if (invalid) return invalid;

  const [recipient] = getInvoiceEmailRecipients(rows.customer, rows.prefs).filter((entry) => isEmailLike(entry.email));
  if (!recipient?.email) return { error: blocked('NO_EMAIL_RECIPIENT', 'No billing email recipient is available') };
  return { category, ...rows, recipient };
}

async function preSendBlock(preSendCheck) {
  if (typeof preSendCheck !== 'function') return null;
  let verdict;
  try {
    verdict = await preSendCheck({ channel: 'email' });
  } catch (err) {
    verdict = { ok: false, code: err.code, reason: err.message, retryable: err.retryable };
  }
  if (verdict?.ok === true) return null;
  return blocked(
    verdict?.code || 'PRE_SEND_CHECK_FAILED',
    verdict?.reason || 'Pre-send check did not pass',
    { retryable: verdict?.retryable === true },
  );
}

async function suppressionBlock(trx, recipientEmail) {
  await lockCustomerEmail(trx, recipientEmail);
  const loaded = await EmailTemplateLibrary.loadTemplateByKey('billing.notice', trx);
  if (!loaded?.template) {
    return blocked('BILLING_EMAIL_RECHECK_FAILED', 'Billing email template is unavailable', { retryable: true });
  }
  const suppression = await EmailTemplateLibrary.activeSuppressionFor(
    loaded.template,
    recipientEmail,
    'transactional_required',
    trx,
  );
  if (!suppression) return null;
  const detail = suppression.group_key
    ? `${suppression.suppression_type} (${suppression.group_key})`
    : suppression.suppression_type;
  return blocked('EMAIL_SUPPRESSED', `Suppressed: ${detail || 'active suppression'}`);
}

async function verifyAndDispatch({ input, trx, invoice, recipientEmail, preSendCheck, dispatch, state }) {
  const fresh = await loadContext(input, trx, { lockRecipients: true, invoice });
  if (fresh.error) state.boundaryBlock = fresh.error;
  else if (cleanEmail(fresh.recipient.email) !== recipientEmail) {
    state.boundaryBlock = blocked(
      'EMAIL_RECIPIENT_CHANGED',
      'Billing email recipient changed before delivery',
      { retryable: true },
    );
  } else state.boundaryBlock = await preSendBlock(preSendCheck);
  if (!state.boundaryBlock) state.boundaryBlock = await suppressionBlock(trx, recipientEmail);
  if (state.boundaryBlock) return { ok: false };

  state.handoffStarted = true;
  await dispatch();
  state.providerAccepted = true;
  return { ok: true };
}

async function dispatchUnderBillingAuthority({ input, recipientEmail, preSendCheck, dispatch, state }) {
  try {
    const verifiedDispatch = (trx, invoice) => verifyAndDispatch({
      input, trx, invoice, recipientEmail, preSendCheck, dispatch, state,
    });
    const outcome = await withCustomerCommsLock(db, input.customerId, (trx) => (
      input.invoiceId
        ? require('./estimate-deposits').withInvoiceDepositSettlement(input.invoiceId, verifiedDispatch, trx)
        : verifiedDispatch(trx, null)
    ));
    if (!outcome && input.invoiceId) {
      state.boundaryBlock = blocked('INVOICE_CUSTOMER_MISMATCH', 'Invoice does not belong to this customer');
      return { ok: false };
    }
    return outcome;
  } catch (err) {
    if (state.providerAccepted) return { ok: true };
    if (state.handoffStarted) throw err;
    state.boundaryBlock = blocked('BILLING_EMAIL_RECHECK_FAILED', err.message, { retryable: true });
    return { ok: false };
  }
}

function acceptedResult(result) {
  return {
    sent: true,
    provider: 'email',
    providerMessageId: result.message?.provider_message_id || null,
    deliveryOutcome: 'accepted',
    blocked: false,
    ...(result.deduped ? { deduped: true } : {}),
  };
}

function providerFailure(err, handoffStarted) {
  const definitelyNotSent = !handoffStarted || err.code === 'EMAIL_SEND_IN_PROGRESS';
  return {
    sent: false,
    provider: 'email',
    providerMessageId: null,
    deliveryOutcome: definitelyNotSent ? 'not_sent' : 'uncertain',
    blocked: false,
    code: err.code || 'EMAIL_PROVIDER_ERROR',
    reason: EmailTemplateLibrary.redactEmailAddresses(err.message),
    retryable: definitelyNotSent || err.retryable === true,
  };
}

async function sendBillingChannelEmail(input, { preSendCheck } = {}) {
  const notificationEventKey = clean(input?.metadata?.notificationEventKey);
  if (!notificationEventKey) {
    return blocked('NOTIFICATION_EVENT_KEY_REQUIRED', 'Billing email requires a stable notification event key');
  }
  const body = emailNotificationBody(input?.body);
  if (!body) return blocked('EMAIL_BODY_REQUIRED', 'Billing email requires message content');

  let context;
  try {
    context = await loadContext(input);
  } catch (err) {
    return blocked('BILLING_EMAIL_PREPARATION_FAILED', err.message, { retryable: true });
  }
  if (context.error) return context.error;

  const recipientEmail = cleanEmail(context.recipient.email);
  const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'billing.notice',
      to: recipientEmail,
      payload: {
        first_name: clean(context.recipient.name) || clean(context.customer.first_name) || 'there',
        category_label: CATEGORY_LABELS[context.category],
        notification_body: body,
        billing_url: `${publicPortalUrl()}/?tab=billing`,
      },
      recipientType: 'customer',
      recipientId: context.customer.id,
      triggerEventId: notificationEventKey,
      idempotencyKey: `billing_channel_email:${notificationEventKey}:email`,
      categories: ['billing', context.category],
      suppressionGroupKey: 'transactional_required',
      suppressProviderErrorLog: true,
      withProviderHandoff: (dispatch) => dispatchUnderBillingAuthority({
        input, recipientEmail, preSendCheck, dispatch, state,
      }),
    });

    if (state.boundaryBlock) return state.boundaryBlock;
    if (result.sent) return acceptedResult(result);
    return blocked(
      result.blocked ? 'EMAIL_SUPPRESSED' : 'EMAIL_NOT_SENT',
      result.reason || result.message?.error_message || 'Billing email was not sent',
      { retryable: result.retryable === true },
    );
  } catch (err) { return providerFailure(err, state.handoffStarted); }
}

module.exports = { sendBillingChannelEmail };
