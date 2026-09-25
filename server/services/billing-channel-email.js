const db = require('../models/db');
const EmailTemplateLibrary = require('./email-template-library');
const { getInvoiceEmailRecipients } = require('./customer-contact');
const { billingChannelAllowed } = require('./billing-delivery-channels');
const { publicPortalUrl } = require('../utils/portal-url');

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

async function loadContext(input) {
  const category = clean(input?.metadata?.billingDeliveryCategory);
  if (!CATEGORY_LABELS[category]) return { error: blocked('INVALID_BILLING_CATEGORY', 'Unknown billing delivery category') };
  if (!input?.customerId) return { error: blocked('CUSTOMER_REQUIRED', 'Billing email requires a customer') };

  const [customer, prefs, invoice] = await Promise.all([
    db('customers').where({ id: input.customerId }).first(),
    db('notification_prefs').where({ customer_id: input.customerId }).first(),
    input.invoiceId ? db('invoices').where({ id: input.invoiceId }).first() : null,
  ]);
  if (!customer || customer.deleted_at) return { error: blocked('CUSTOMER_NOT_FOUND', 'Customer is unavailable') };
  if (!prefs) return { error: blocked('BILLING_PREFS_UNAVAILABLE', 'Billing delivery preferences are unavailable', { retryable: true }) };
  if (billingChannelAllowed(prefs, category, 'email') !== true) {
    return { error: blocked('BILLING_EMAIL_NOT_SELECTED', 'Email is not selected for this billing category') };
  }
  if (input.invoiceId) {
    if (!invoice || String(invoice.customer_id) !== String(customer.id)) {
      return { error: blocked('INVOICE_CUSTOMER_MISMATCH', 'Invoice does not belong to this customer') };
    }
    const ownership = await require('./invoice-helpers').selfPayAtDispatch(invoice.id, db)();
    if (ownership.ok !== true) {
      return { error: blocked(ownership.code || 'INVOICE_NOT_SELF_PAY', ownership.reason || 'Invoice is not eligible for customer delivery') };
    }
  }

  const [recipient] = getInvoiceEmailRecipients(customer, prefs).filter((entry) => isEmailLike(entry.email));
  if (!recipient?.email) return { error: blocked('NO_EMAIL_RECIPIENT', 'No billing email recipient is available') };
  return { category, customer, prefs, invoice, recipient };
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
  let boundaryBlock = null;
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
      withProviderHandoff: async (dispatch) => {
        let fresh;
        try {
          fresh = await loadContext(input);
        } catch (err) {
          boundaryBlock = blocked('BILLING_EMAIL_RECHECK_FAILED', err.message, { retryable: true });
          return { ok: false };
        }
        if (fresh.error) {
          boundaryBlock = fresh.error;
          return { ok: false };
        }
        if (cleanEmail(fresh.recipient.email) !== recipientEmail) {
          boundaryBlock = blocked('EMAIL_RECIPIENT_CHANGED', 'Billing email recipient changed before delivery', { retryable: true });
          return { ok: false };
        }
        if (typeof preSendCheck === 'function') {
          let verdict;
          try {
            verdict = await preSendCheck({ channel: 'email' });
          } catch (err) {
            verdict = { ok: false, code: err.code, reason: err.message, retryable: err.retryable };
          }
          if (verdict?.ok !== true) {
            boundaryBlock = blocked(
              verdict?.code || 'PRE_SEND_CHECK_FAILED',
              verdict?.reason || 'Pre-send check did not pass',
              { retryable: verdict?.retryable === true },
            );
            return { ok: false };
          }
        }
        await dispatch();
        return { ok: true };
      },
    });

    if (boundaryBlock) return boundaryBlock;
    if (result.sent) {
      return {
        sent: true,
        provider: 'email',
        providerMessageId: result.message?.provider_message_id || null,
        deliveryOutcome: 'accepted',
        blocked: false,
        ...(result.deduped ? { deduped: true } : {}),
      };
    }
    return blocked(
      result.blocked ? 'EMAIL_SUPPRESSED' : 'EMAIL_NOT_SENT',
      result.reason || result.message?.error_message || 'Billing email was not sent',
      { retryable: result.retryable === true },
    );
  } catch (err) {
    return {
      sent: false,
      provider: 'email',
      providerMessageId: null,
      deliveryOutcome: err.code === 'EMAIL_SEND_IN_PROGRESS' ? 'not_sent' : 'uncertain',
      blocked: false,
      code: err.code || 'EMAIL_PROVIDER_ERROR',
      reason: EmailTemplateLibrary.redactEmailAddresses(err.message),
      retryable: err.retryable === true || err.code === 'EMAIL_SEND_IN_PROGRESS',
    };
  }
}

module.exports = { sendBillingChannelEmail };
