// Provider-boundary authority for billing notification email. This module
// owns everything a billing email send must prove true immediately before
// (and again immediately at) the provider handoff: category/customer/prefs
// validation, the portal-wide opt-out, the explicit Email channel selection,
// invoice ownership, recipient resolution, and the locked recheck that runs
// the moment before dispatch. Callers (the billing-channel-email adapter and
// its tests) go through `loadBillingEmailContext` to prepare a send and
// `dispatchUnderBillingEmailAuthority` to run one under the required locks.
const db = require('../models/db');
const EmailTemplateLibrary = require('./email-template-library');
const { getInvoiceEmailRecipients } = require('./customer-contact');
const { billingChannelAllowed } = require('./billing-delivery-channels');
const { withCustomerCommsLock, lockCustomerEmail } = require('../utils/customer-comms-lock');

const CATEGORY_LABELS = Object.freeze({
  invoice: 'Invoice update',
  payment_issue: 'Payment problem',
  billing: 'Billing reminder',
  payment_receipt: 'Payment receipt',
});

// Single source for which template a billing category's email uses. A
// payment_receipt send reuses the SMS body, which may carry a withheld
// estimate link that estimate-deposits.js's SMS receipt path deliberately
// rewrites rather than refuses — the generic billing.notice template makes
// withheldLinkPolicyForTemplate (estimate-annual-guard.js) resolve 'refuse'
// instead, silently dropping the whole email if the offer is withheld
// before dispatch. Both the adapter's sendTemplate call and this module's
// own suppression recheck (which loads a template by key) resolve the key
// here, so a fresh send and a locked-recheck-time recheck never disagree.
function billingEmailTemplateKey(category) {
  return category === 'payment_receipt' ? 'billing.receipt_notice' : 'billing.notice';
}

function clean(value) {
  return String(value || '').trim();
}

function cleanEmail(value) {
  return clean(value).toLowerCase();
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

async function loadBillingEmailContext(input, database = db, { lockRecipients = false, invoice: lockedInvoice = null } = {}) {
  const category = clean(input?.metadata?.billingDeliveryCategory);
  if (!CATEGORY_LABELS[category]) return { error: blocked('INVALID_BILLING_CATEGORY', 'Unknown billing delivery category') };
  if (!input?.customerId) return { error: blocked('CUSTOMER_REQUIRED', 'Billing email requires a customer') };

  const rows = await readContextRows(input, database, lockRecipients, lockedInvoice);
  const invalid = await contextBlock(input, category, rows, database);
  if (invalid) return invalid;

  const [recipient] = getInvoiceEmailRecipients(rows.customer, rows.prefs).filter((entry) => isEmailLike(entry.email));
  if (!recipient?.email) return { error: blocked('NO_EMAIL_RECIPIENT', 'No billing email recipient is available') };
  return {
    category,
    categoryLabel: CATEGORY_LABELS[category],
    ...rows,
    recipient,
    recipientEmail: cleanEmail(recipient.email),
  };
}

async function preSendBlock(preSendCheck, database) {
  if (typeof preSendCheck !== 'function') return null;
  let verdict;
  try {
    verdict = await preSendCheck({ channel: 'email', database });
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

async function suppressionBlock(trx, recipientEmail, category) {
  await lockCustomerEmail(trx, recipientEmail);
  const loaded = await EmailTemplateLibrary.loadTemplateByKey(billingEmailTemplateKey(category), trx);
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
  const fresh = await loadBillingEmailContext(input, trx, { lockRecipients: true, invoice });
  if (fresh.error) state.boundaryBlock = fresh.error;
  else if (fresh.recipientEmail !== recipientEmail) {
    state.boundaryBlock = blocked(
      'EMAIL_RECIPIENT_CHANGED',
      'Billing email recipient changed before delivery',
      { retryable: true },
    );
  } else state.boundaryBlock = await preSendBlock(preSendCheck, trx);
  if (!state.boundaryBlock) state.boundaryBlock = await suppressionBlock(trx, recipientEmail, fresh.category);
  if (state.boundaryBlock) return { ok: false };

  state.handoffStarted = true;
  await dispatch();
  state.providerAccepted = true;
  return { ok: true };
}

async function dispatchUnderBillingEmailAuthority({ input, recipientEmail, preSendCheck, dispatch, state }) {
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

module.exports = {
  blocked,
  loadBillingEmailContext,
  dispatchUnderBillingEmailAuthority,
  billingEmailTemplateKey,
};
