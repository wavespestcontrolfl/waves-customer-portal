const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { getInvoiceEmailRecipients } = require('./customer-contact');
const { publicPortalUrl } = require('../utils/portal-url');
const { formatDisplayDate, dateOnlyString } = require('../utils/date-only');
const { currency } = require('./email-template');
const { customerPhoneDisplay } = require('./home-line');
const { invoiceAmountDue } = require('./invoice-helpers');
const { billingChannelAllowed, explicitBillingChannels } = require('./billing-delivery-channels');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { isDefiniteRejection } = require('./sendgrid-mail');
const BillingEmailDetails = require('./billing-email-details');

const CONTACT_EMAIL = 'contact@wavespestcontrol.com';
const TRANSACTIONAL_GROUP = 'transactional_required';
const PREFS_UNAVAILABLE = Symbol('prefs_unavailable');

function clean(value) {
  return String(value || '').trim();
}

function cleanEmail(value) {
  return clean(value).toLowerCase();
}

function firstToken(value) {
  return clean(value).split(/\s+/)[0] || '';
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value));
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function portalBillingUrl() {
  return `${publicPortalUrl()}/?tab=billing`;
}

function stableDateKey(value) {
  return dateOnlyString(value) || (value ? String(value).slice(0, 10) : dateOnlyString(new Date()));
}

function stableEventKey(value) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime()) && String(value).includes('T')) return parsed.toISOString();
  return String(value).replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

function money(value) {
  if (value == null || value === '') return '';
  return currency(value);
}

function displayDate(value) {
  if (!value) return '';
  return formatDisplayDate(value, { fallback: '' });
}

function displayReason(value, fallback = '') {
  const reason = clean(value || fallback);
  if (!reason) return '';
  return reason.includes('_')
    ? reason.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
    : reason;
}

function methodParts(method = {}) {
  const type = clean(method.method_type || method.payment_method_type || method.type || 'card') || 'card';
  const bankLast4 = clean(method.bank_last_four);
  const last4 = clean(method.last_four || method.last4 || bankLast4);
  const cardBrand = clean(method.card_brand || method.brand);
  const bankName = clean(method.bank_name || method.bankName);
  const brand = cardBrand || (type === 'ach' || type === 'us_bank_account' ? (bankName || 'Bank account') : '');
  const label = brand && last4
    ? `${brand} ending in ${last4}`
    : last4
      ? `your saved payment method ending in ${last4}`
      : 'your saved payment method';

  return {
    brand: brand || 'your saved payment method',
    last4,
    type,
    label,
    expirationMonth: clean(method.exp_month || method.expMonth),
    expirationYear: clean(method.exp_year || method.expYear),
  };
}

function assignMethodPayload(payload, method, prefix = 'payment_method') {
  const parts = methodParts(method);
  payload[`${prefix}_brand`] = parts.brand;
  payload[`${prefix}_last4`] = parts.last4;
  payload[`${prefix}_type`] = parts.type;
  payload[`${prefix}_label`] = parts.label;
  return parts;
}

// The payment's own tender snapshot — the only identity left once its
// saved method is removed (payment_method_id is ON DELETE SET NULL; the
// delete trigger fills payment_method_type/bank_name/card_* first).
function paymentTenderSnapshot(payment = {}) {
  return {
    method_type: payment.method_type || payment.payment_method_type,
    card_brand: payment.card_brand,
    last_four: payment.card_last_four || payment.last_four,
    bank_name: payment.bank_name,
  };
}

async function loadCustomer(customerId) {
  if (!customerId) return null;
  return db('customers')
    .where({ id: customerId })
    .select(
      'id', 'first_name', 'last_name', 'company_name', 'email', 'phone',
      'address_line1', 'address_line2', 'city', 'zip', 'latitude', 'longitude',
      'home_line_location_id', 'home_line_address_key', 'home_line_source',
    )
    .first();
}

async function loadPaymentMethod(paymentMethodId, ownerCustomerId = null) {
  if (!paymentMethodId) return null;
  // With an owner the lookup carries the customer id: a method that belongs to
  // someone else reads as absent.
  return db('payment_methods')
    .where(ownerCustomerId ? { id: paymentMethodId, customer_id: ownerCustomerId } : { id: paymentMethodId })
    .first();
}

async function loadPrefs(customerId) {
  return db('notification_prefs')
    .where({ customer_id: customerId })
    .first()
    .catch((err) => {
      logger.warn(`[payment-lifecycle-email] notification_prefs lookup failed for ${customerId}: ${err.message}`);
      return PREFS_UNAVAILABLE;
    });
}

async function logPaymentLifecycleEmailAttempt({
  customerId,
  invoiceId = null,
  paymentId = null,
  paymentMethodId = null,
  refundId = null,
  paymentPlanId = null,
  templateKey,
  eventType,
  status,
  providerMessageId = null,
  sentAt = null,
  failureReason = null,
}) {
  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'email_outbound',
      subject: `${eventType} email ${status}`,
      body: failureReason
        ? `${eventType} email ${status}: ${failureReason}`
        : `${eventType} email ${status}.`,
      metadata: JSON.stringify({
        customer_id: customerId,
        invoice_id: invoiceId,
        payment_id: paymentId,
        payment_method_id: paymentMethodId,
        refund_id: refundId,
        payment_plan_id: paymentPlanId,
        template_key: templateKey,
        channel: 'email',
        event_type: eventType,
        provider_message_id: providerMessageId,
        status,
        sent_at: sentAt,
        failure_reason: failureReason,
      }),
    });
  } catch (err) {
    logger.warn(`[payment-lifecycle-email] audit log failed for ${eventType}/${customerId}: ${err.message}`);
  }
}

// Lifecycle notices whose body carries a pay / update-card link.
const HOLD_GATED_TEMPLATES = require('./collections/collection-hold').HOLD_GATED_EMAIL_TEMPLATES;
const CUSTOMER_INITIATED_EMAIL_CATEGORY = require('./collections/collection-hold').CUSTOMER_INITIATED_EMAIL_CATEGORY;

async function sendLifecycleTemplate({
  customerId,
  templateKey,
  eventType,
  payload = {},
  idempotencyKey,
  invoiceId = null,
  paymentId = null,
  paymentMethodId = null,
  refundId = null,
  paymentPlanId = null,
  categories = [],
  billingDeliveryCategory = null,
  beforeProviderHandoff = null,
  // TRUSTED provenance from the caller (sendPaymentFailed, from the Stripe webhook's own PI
  // markers): the notice answers a payment the customer just attempted themselves, so it is not
  // billing follow-up and the dispute hold does not withhold it (the same exemption the
  // Text/App boundary applies to a customerInitiated payment_failure).
  customerInitiated = false,
}) {
  const customer = await loadCustomer(customerId);
  if (!customer) return { ok: false, skipped: true, reason: 'customer_not_found',
    ...(billingDeliveryCategory ? { deliveryOutcome: 'not_sent' } : {}),
  };
  // Collections DISPUTE hold (owner ruling 2026-09-30): the notices that carry a pay or
  // update-card link (payment failed, retry notice, method-expiring) are billing follow-up the
  // customer was told is on hold. Suppress - never queue: dunning after the release covers it.
  // One live check at the shared send boundary (every caller - billing-cron, the retry
  // obligation, the Stripe webhook, the expiry workflows - passes through here); fail closed.
  // Confirmations and receipts carry no such link and are untouched.
  const holdApplies = HOLD_GATED_TEMPLATES.has(templateKey);
  // The customer's own payment attempt skips a plain dispute hold only; a wrong-number / wrong-party
  // fallback hold still stops the notice (Codex #5424 r13).
  const holdOpts = { ignoreDisputeHold: customerInitiated === true };
  if (holdApplies) {
    const held = await require('./collections/collection-hold').messagingHeldByCollectionHold(customer.id, undefined, holdOpts);
    if (held.held) {
      logger.info(`[payment-lifecycle-email] ${templateKey} suppressed for customer ${customer.id}: collections dispute hold${held.reason === 'lookup_failed' ? ' (lookup failed - fail closed)' : ''}`);
      // The ONE retryable hold outcome (Codex #5424 r14): a replay handler recognises only
      // COLLECTION_HOLD_DEFER, so a hold that commits after a caller's early check waits, never
      // terminalizes.
      return { ok: false, blocked: true, skipped: true, ...require('./collections/collection-hold').holdDeferOutcome(held) };
    }
  }

  const prefs = await loadPrefs(customer.id);
  if (billingDeliveryCategory) {
    if (prefs === PREFS_UNAVAILABLE) {
      return { ok: false, skipped: true, reason: 'billing_prefs_unavailable', retryable: true, deliveryOutcome: 'not_sent' };
    }
    if (billingChannelAllowed(prefs || {}, billingDeliveryCategory, 'email') === false) {
      return { ok: false, skipped: true, reason: 'billing_email_not_selected', deliveryOutcome: 'not_sent' };
    }
  }

  const [recipient] = getInvoiceEmailRecipients(customer, prefs === PREFS_UNAVAILABLE ? {} : (prefs || {}))
    .filter((entry) => isEmailLike(entry.email));
  if (!recipient?.email) {
    await logPaymentLifecycleEmailAttempt({
      customerId: customer.id,
      invoiceId,
      paymentId,
      paymentMethodId,
      refundId,
      paymentPlanId,
      templateKey,
      eventType,
      status: 'skipped',
      failureReason: 'missing_email',
    });
    return { ok: false, skipped: true, reason: 'missing_email',
      ...(billingDeliveryCategory ? { deliveryOutcome: 'not_sent' } : {}),
    };
  }

  const firstName = firstToken(recipient.name) || firstToken(customer.first_name) || 'there';
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim()
    || customer.company_name
    || firstName;
  const finalPayload = {
    first_name: firstName,
    customer_name: customerName,
    customer_portal_url: portalBillingUrl(),
    company_phone: customerPhoneDisplay(customer),
    company_email: CONTACT_EMAIL,
    ...payload,
  };

  let providerStarted = false;
  let handoffGuardFailed = false;
  // A hold that committed between the up-front check and the provider handoff: a WAIT, reported
  // as the coded retryable COLLECTION_HOLD_DEFER (never a bare not-sent, which the retry
  // obligation would turn into a terminal block).
  let handoffHold = null;
  // The FINAL hold check (round-11 P1), handed to SendGrid as sendOne's providerBoundaryCheck: it
  // runs after every await above and after the provider's own request preparation, immediately
  // before the fetch, so a dispute committed after the up-front read still stops the notice. A
  // refusal throws the boundary-blocked sentinel the library turns into a definite non-send, and
  // the coded retryable COLLECTION_HOLD_DEFER is returned below. Only the gated pay-link templates
  // carry it; customerInitiated skips the dispute part only (holdOpts).
  const holdBoundaryCheck = holdApplies ? async ({ database: handoffDb } = {}) => {
    const heldNow = await require('./collections/collection-hold').messagingHeldByCollectionHold(customer.id, handoffDb, holdOpts);
    if (heldNow.held) {
      handoffHold = heldNow;
      throw Object.assign(new Error('Customer has an active collections dispute hold'), {
        code: require('./collections/collection-hold').HOLD_DEFER_CODE,
        retryable: true,
        providerBoundaryBlocked: true,
      });
    }
    return { ok: true };
  } : null;
  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey,
      to: recipient.email,
      payload: finalPayload,
      recipientType: 'customer',
      recipientId: customer.id,
      triggerEventId: `${eventType}:${customer.id}`,
      idempotencyKey,
      categories: ['payment', eventType.replace(/[^a-zA-Z0-9_-]/g, '_'), ...categories],
      suppressionGroupKey: TRANSACTIONAL_GROUP,
      ...(billingDeliveryCategory ? {
        withProviderHandoff: async (dispatch) => {
          try {
            if (invoiceId) {
              const ownership = await require('./invoice-helpers').selfPayAtDispatch(invoiceId, db)();
              if (ownership.ok !== true) {
                handoffGuardFailed = ownership.retryable === true || ownership.code === 'INVOICE_UNREADABLE';
                return ownership;
              }
            }
            // Dispute hold re-read at the provider boundary (see the up-front check above).
            if (holdApplies) {
              const heldNow = await require('./collections/collection-hold').messagingHeldByCollectionHold(customer.id, undefined, holdOpts);
              if (heldNow.held) {
                handoffHold = heldNow;
                return { ok: false };
              }
            }
            const [freshCustomer, freshPrefs] = await Promise.all([
              loadCustomer(customer.id),
              loadPrefs(customer.id),
            ]);
            if (freshPrefs === PREFS_UNAVAILABLE) handoffGuardFailed = true;
            if (!freshCustomer || freshPrefs === PREFS_UNAVAILABLE
              || billingChannelAllowed(freshPrefs || {}, billingDeliveryCategory, 'email') === false) {
              return { ok: false };
            }
            const [freshRecipient] = getInvoiceEmailRecipients(freshCustomer, freshPrefs || {})
              .filter((entry) => isEmailLike(entry.email));
            if (cleanEmail(freshRecipient?.email) !== cleanEmail(recipient.email)) {
              handoffGuardFailed = true;
              return { ok: false };
            }
            if (beforeProviderHandoff) {
              const guard = await beforeProviderHandoff();
              if (guard === false || guard?.ok === false) throw new Error('Delivery handoff was not acquired');
            }
            providerStarted = true;
            await dispatch(undefined, holdBoundaryCheck || undefined);
            return { ok: true };
          } catch (err) {
            if (!providerStarted) handoffGuardFailed = true;
            throw err;
          }
        },
      } : holdBoundaryCheck ? {
        // No billing-delivery ownership to hold, but the hold-gated notice still needs the
        // final SendGrid boundary check.
        withProviderHandoff: async (dispatch) => {
          await dispatch(undefined, holdBoundaryCheck);
          return { ok: true };
        },
      } : {}),
    });

    if (result.deduped) {
      return {
        ok: !!result.sent,
        deduped: true,
        blocked: !!result.blocked,
        messageId: result.message?.provider_message_id || null,
        ...(billingDeliveryCategory ? { deliveryOutcome: result.sent ? 'accepted' : 'not_sent' } : {}),
      };
    }

    if (!result.sent && handoffHold) {
      await logPaymentLifecycleEmailAttempt({
        customerId: customer.id, invoiceId, paymentId, paymentMethodId, refundId, paymentPlanId, templateKey, eventType,
        status: 'skipped', failureReason: 'collection_hold',
      });
      const { holdDeferOutcome } = require('./collections/collection-hold');
      return { ok: false, blocked: true, ...holdDeferOutcome(handoffHold) };
    }
    const status = result.sent ? 'sent' : result.blocked ? 'blocked' : 'failed';
    await logPaymentLifecycleEmailAttempt({
      customerId: customer.id,
      invoiceId,
      paymentId,
      paymentMethodId,
      refundId,
      paymentPlanId,
      templateKey,
      eventType,
      status,
      providerMessageId: result.message?.provider_message_id || null,
      sentAt: result.message?.sent_at || null,
      failureReason: result.sent ? null : result.reason || result.message?.error_message || 'email_not_sent',
    });

    const outcome = billingDeliveryCategory ? {
      deliveryOutcome: result.sent ? 'accepted' : 'not_sent',
      ...(!result.sent && handoffGuardFailed ? { retryable: true, reason: 'pre_provider_handoff_failed' } : {}),
    } : {};
    return result.sent
      ? { ok: true, messageId: result.message?.provider_message_id || null, ...outcome }
      : { ok: false, blocked: !!result.blocked, reason: result.reason || 'email_not_sent', ...outcome };
  } catch (err) {
    await logPaymentLifecycleEmailAttempt({
      customerId: customer.id,
      invoiceId,
      paymentId,
      paymentMethodId,
      refundId,
      paymentPlanId,
      templateKey,
      eventType,
      status: 'failed',
      failureReason: err.message,
    });
    logger.error(`[payment-lifecycle-email] ${eventType} failed for ${customer.id}: ${err.message}`);
    // A definite provider refusal (SendGrid 4xx, 429 included) after handoff
    // is known not sent: the durable owner may clear its provider-start
    // marker and retry. Only an unknown post-handoff failure stays uncertain.
    const deliveryOutcome = providerStarted && !isDefiniteRejection(err) ? 'uncertain' : 'not_sent';
    return { ok: false, error: err.message,
      ...(billingDeliveryCategory ? {
        deliveryOutcome,
        retryable: deliveryOutcome === 'not_sent',
        ...(handoffGuardFailed ? { reason: 'pre_provider_handoff_failed' } : {}),
      } : {}),
    };
  }
}

async function sendAutopayEnabled({ customerId, paymentMethodId, enabledDate = new Date(), idempotencyKey } = {}) {
  const method = await loadPaymentMethod(paymentMethodId);
  const payload = {
    autopay_enabled_date: displayDate(enabledDate),
  };
  assignMethodPayload(payload, method || {});
  return sendLifecycleTemplate({
    customerId,
    templateKey: 'payment.autopay_enabled',
    eventType: 'payment.autopay_enabled',
    payload,
    paymentMethodId: paymentMethodId || null,
    idempotencyKey: idempotencyKey || `payment.autopay_enabled:${customerId}:${paymentMethodId || 'none'}:${stableEventKey(enabledDate)}`,
  });
}

async function sendPaymentMethodUpdated({
  customerId,
  oldPaymentMethodId = null,
  newPaymentMethodId,
  updatedAt = new Date(),
  idempotencyKey,
} = {}) {
  const [oldMethod, newMethod] = await Promise.all([
    loadPaymentMethod(oldPaymentMethodId),
    loadPaymentMethod(newPaymentMethodId),
  ]);
  const payload = {
    payment_method_updated_date: displayDate(updatedAt),
    old_payment_method_last4: methodParts(oldMethod || {}).last4,
    old_payment_method_label: oldMethod ? methodParts(oldMethod).label : '',
  };
  assignMethodPayload(payload, newMethod || {}, 'new_payment_method');
  return sendLifecycleTemplate({
    customerId,
    templateKey: 'payment.method_updated',
    eventType: 'payment.method_updated',
    payload,
    paymentMethodId: newPaymentMethodId || null,
    idempotencyKey: idempotencyKey || `payment.method_updated:${customerId}:${oldPaymentMethodId || 'none'}:${newPaymentMethodId || 'none'}:${stableEventKey(updatedAt)}`,
  });
}

// Negative counterparts of sendAutopayEnabled / sendPaymentMethodUpdated
// (owner ruling 2026-08-27: a customer hears about every change to the
// custody of a payment credential — off, removed — from whichever surface
// caused it). Both are dark behind GATE_PAYMENT_METHOD_CHANGE_EMAILS.
// Pause is deliberately NOT emailed (reversible, log-only).
function changeEmailsEnabled() {
  return require('../config/feature-gates').isEnabled('paymentMethodChangeEmails');
}

async function sendAutopayDisabled({
  customerId,
  paymentMethodId = null,
  disabledAt = new Date(),
  idempotencyKey,
} = {}) {
  if (!changeEmailsEnabled()) return { ok: false, skipped: true, reason: 'gate_off' };
  const method = await loadPaymentMethod(paymentMethodId);
  const payload = {
    autopay_disabled_date: displayDate(disabledAt),
  };
  assignMethodPayload(payload, method || {});
  return sendLifecycleTemplate({
    customerId,
    templateKey: 'payment.autopay_disabled',
    eventType: 'payment.autopay_disabled',
    payload,
    paymentMethodId: paymentMethodId || null,
    idempotencyKey: idempotencyKey || `payment.autopay_disabled:${customerId}:${paymentMethodId || 'none'}:${stableEventKey(disabledAt)}`,
  });
}

/**
 * The payment_methods row is already DELETED when this fires (portal
 * DELETE and the detached webhook both remove it first), so the caller
 * passes the row SNAPSHOT — brand/last4 only ever reach the template as
 * the label, never a processor id. autopayDisabled=true adds the line
 * explaining Auto Pay went off with it (only the out-of-band webhook path
 * can produce that under the removal guard).
 */
async function sendPaymentMethodRemoved({
  customerId,
  method = {},
  autopayDisabled = false,
  removedAt = new Date(),
  idempotencyKey,
} = {}) {
  if (!changeEmailsEnabled()) return { ok: false, skipped: true, reason: 'gate_off' };
  const payload = {
    payment_method_removed_date: displayDate(removedAt),
    autopay_removed_note: autopayDisabled
      ? 'Auto Pay was turned off because it was using this payment method. Add a payment method and turn Auto Pay back on anytime in your customer portal.'
      : '',
  };
  assignMethodPayload(payload, method || {});
  return sendLifecycleTemplate({
    customerId,
    templateKey: 'payment.method_removed',
    eventType: 'payment.method_removed',
    payload,
    paymentMethodId: method?.id || null,
    // Keyed on the ROW id, not the time: a portal removal (Stripe detach →
    // local delete) and the payment_method.detached webhook it triggers can
    // both reach here for the same row — one notice, whichever lands first
    // (pre-push r1 P1). A row id is never reused, so no timestamp is needed.
    idempotencyKey: idempotencyKey || `payment.method_removed:${customerId}:${method?.id || 'none'}`,
  });
}

function expiryStageFor(method, now = new Date()) {
  const month = Number(method?.exp_month);
  // Legacy rows store 2-digit expiry years — normalize like the charge
  // path's normalizeLegacyExpiry, or new Date(26, ...) reads as 1926 and a
  // valid card stages as 'expired'.
  const rawYear = Number(method?.exp_year);
  const year = Number.isFinite(rawYear) && rawYear > 0 && rawYear < 100 ? rawYear + 2000 : rawYear;
  if (!month || !year) return null;
  // Shared ET outlook (hook #3495 P1): local Date construction here was
  // UTC on Railway, so stage boundaries missed the Eastern month end.
  // Lazy require — autopay-notifications requires this module at load.
  const { cardExpiryOutlook } = require('./autopay-notifications');
  const { daysUntil, expired } = cardExpiryOutlook(year, month, now);
  if (expired) return 'expired';
  if (daysUntil <= 7) return '7_day';
  if (daysUntil <= 30) return '30_day';
  return null;
}

async function sendPaymentMethodExpiring({
  customerId,
  paymentMethodId,
  reminderStage,
  now = new Date(),
  idempotencyKey,
} = {}) {
  const method = await loadPaymentMethod(paymentMethodId);
  if (!method) return { ok: false, skipped: true, reason: 'payment_method_not_found' };
  const stage = reminderStage || expiryStageFor(method, now);
  if (!stage) return { ok: false, skipped: true, reason: 'outside_expiry_window' };
  const payload = {};
  const parts = assignMethodPayload(payload, method);
  payload.expiration_month = parts.expirationMonth;
  payload.expiration_year = parts.expirationYear;
  payload.expiration_label = parts.expirationMonth && parts.expirationYear
    ? `${parts.expirationMonth}/${parts.expirationYear}`
    : '';
  return sendLifecycleTemplate({
    customerId: customerId || method.customer_id,
    templateKey: 'payment.method_expiring',
    eventType: 'payment.method_expiring',
    payload,
    paymentMethodId: method.id,
    idempotencyKey: idempotencyKey || `payment.method_expiring:${method.customer_id}:${method.id}:${payload.expiration_month}:${payload.expiration_year}:${stage}`,
    categories: [`payment_method_expiring_${stage}`],
    billingDeliveryCategory: 'billing',
  });
}

async function invoiceForPayment(payment, explicitInvoiceId = null) {
  const metadata = asObject(payment?.metadata);
  const invoiceId = explicitInvoiceId || payment?.invoice_id || metadata.invoice_id || null;
  if (invoiceId) return db('invoices').where({ id: invoiceId }).first().catch(() => null);
  return null;
}

async function sendPaymentRetryNotice({
  customerId,
  paymentId,
  invoiceId = null,
  retryDate,
  idempotencyKey,
  beforeProviderHandoff,
} = {}) {
  const payment = paymentId ? await db('payments').where({ id: paymentId }).first() : null;
  if (!payment) return { ok: false, skipped: true, reason: 'payment_not_found' };
  const invoice = await invoiceForPayment(payment, invoiceId);
  // Third-party Bill-To: payer-billed invoices never retry against a homeowner
  // saved card (save-card is suppressed for them), but guard the notice anyway
  // so a stray retry can't text/email the homeowner the payer's pay link.
  if (invoice?.payer_id) return { ok: false, skipped: true, reason: 'payer_billed' };
  const method = await loadPaymentMethod(payment.payment_method_id);
  const effectiveRetryDate = retryDate || payment.next_retry_at;
  if (!effectiveRetryDate) return { ok: false, skipped: true, reason: 'missing_retry_date' };
  const payUrl = invoice?.token
    ? `${publicPortalUrl()}/pay/${invoice.token}`
    : portalBillingUrl();
  const payload = {
    invoice_title: invoice?.title || invoice?.service_type || clean(payment.description).replace(/\s+—\s+FAILED$/i, '') || 'your Waves invoice',
    invoice_number: invoice?.invoice_number || '',
    amount_due: money(payment.amount || invoice?.total),
    failed_payment_date: displayDate(payment.payment_date || payment.created_at),
    retry_date: displayDate(effectiveRetryDate),
    pay_url: payUrl,
  };
  assignMethodPayload(payload, method || paymentTenderSnapshot(payment));
  const effectiveCustomerId = customerId || payment.customer_id;
  return sendLifecycleTemplate({
    customerId: effectiveCustomerId,
    templateKey: 'payment.retry_notice',
    eventType: 'payment.retry_notice',
    payload,
    invoiceId: invoice?.id || invoiceId || null,
    paymentId: payment.id,
    paymentMethodId: payment.payment_method_id || null,
    idempotencyKey: idempotencyKey || `payment.retry_notice:${invoice?.id || invoiceId || 'no_invoice'}:${payment.id}:${stableDateKey(effectiveRetryDate)}`,
    billingDeliveryCategory: 'payment_issue',
    beforeProviderHandoff,
  });
}

// The card that was declined, from the failed PaymentIntent Stripe just sent
// (last_payment_error.payment_method — the only place a pay-page failure with
// no payments row still names the card). '' when it is not a card or carries no
// last four.
function failedIntentCardLabel(paymentIntent) {
  const card = paymentIntent?.last_payment_error?.payment_method?.card;
  const last4 = clean(card?.last4);
  if (!last4) return '';
  return methodParts({
    card_brand: BillingEmailDetails.cardBrandName(card.brand), last_four: last4,
  }).label;
}

// The Stripe customer a PaymentIntent belongs to (id string or expanded object).
function intentStripeCustomerId(paymentIntent) {
  const c = paymentIntent?.customer;
  return clean(typeof c === 'string' ? c : c?.id);
}

// True only when every owner we can see for this failure is the customer the
// email goes to: the payments row and the invoice. This alone covers a card the
// payments row snapshotted or a saved method that row points at (both are read
// through the customer id). A PaymentIntent's card needs the stricter check
// below on top of it.
function paymentOwnershipAgrees({ emailedCustomerId, payment, invoice }) {
  if (!emailedCustomerId) return false;
  const emailed = String(emailedCustomerId);
  if (payment?.customer_id && String(payment.customer_id) !== emailed) return false;
  if (invoice?.customer_id && String(invoice.customer_id) !== emailed) return false;
  return true;
}

// FAIL CLOSED: the failed PaymentIntent's card may be named only when its
// ownership is positively confirmed, by EITHER
//  (a) both Stripe customer ids known and equal (the intent's, and the emailed
//      customer's stripe_customer_id), OR
//  (b) the intent has NO Stripe customer (createInvoicePaymentIntent leaves
//      piParams.customer unset unless the payer ticked "save card") and the
//      server-stamped metadata names the emailed customer: waves_customer_id
//      (stripe.js, the pay-page PaymentIntent's metadata) equals the emailed
//      customer, and when waves_invoice_id is stamped too, that invoice belongs
//      to the emailed customer (looked up customer-scoped).
// Unknown on either side, a differing id, or a lookup failure is "cannot
// confirm" and the row stays blank.
async function intentCardOwnedByCustomer({ emailedCustomerId, paymentIntent }) {
  if (!emailedCustomerId || !paymentIntent) return false;
  const intentCustomer = intentStripeCustomerId(paymentIntent);
  try {
    if (intentCustomer) {
      const row = await db('customers').where({ id: emailedCustomerId }).first('stripe_customer_id');
      const known = clean(row?.stripe_customer_id);
      return !!known && known === intentCustomer;
    }
    const stamped = clean(paymentIntent.metadata?.waves_customer_id);
    if (!stamped || stamped !== String(emailedCustomerId)) return false;
    const stampedInvoice = clean(paymentIntent.metadata?.waves_invoice_id);
    if (stampedInvoice) {
      const owned = await db('invoices').where({ id: stampedInvoice, customer_id: emailedCustomerId }).first('id');
      if (!owned) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Positive evidence of a cross-link: the failed intent's Stripe customer and the
// emailed customer's stripe_customer_id are BOTH known and differ. Then no card
// label is shown at all, not even an owned snapshot or saved method. A lookup
// failure counts as a conflict (fail closed).
async function intentCustomerConflicts({ emailedCustomerId, paymentIntent }) {
  const intentCustomer = intentStripeCustomerId(paymentIntent);
  if (!intentCustomer || !emailedCustomerId) return false;
  try {
    const row = await db('customers').where({ id: emailedCustomerId }).first('stripe_customer_id');
    const known = clean(row?.stripe_customer_id);
    return !!known && known !== intentCustomer;
  } catch {
    return true;
  }
}

// Two "<brand> ending in <last4>" labels name the same card when the last four
// match and the brands match once normalized (stored brands arrive as "VISA",
// "visa" or "Visa"). Anything that is not that shape only matches exactly.
function sameCardLabel(a, b) {
  const parse = (label) => {
    const m = /^(.*) ending in (\S+)$/.exec(clean(label));
    return m ? { brand: BillingEmailDetails.cardBrandName(m[1]).toLowerCase(), last4: m[2] } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return clean(a) === clean(b);
  return pa.last4 === pb.last4 && pa.brand === pb.brand;
}

// The retry the dunning ladder ACTUALLY armed for this failure — a stored
// payments.next_retry_at (billing-cron's RETRY_DELAYS_DAYS ladder writes it),
// never a computed guess. A pay-page failure the ladder does not retry has no
// such row, and the answer is '' (the template drops the row).
async function armedRetryDate({ payment, invoice }) {
  if (payment?.next_retry_at) return payment.next_retry_at;
  if (!invoice?.id) return null;
  try {
    const armed = await db('payments')
      .where({ customer_id: invoice.customer_id, status: 'failed' })
      .whereNotNull('next_retry_at')
      .where('next_retry_at', '>', new Date())
      .whereRaw(`metadata::jsonb ->> 'invoice_id' = ?`, [invoice.id])
      .orderBy('created_at', 'desc')
      .first('next_retry_at');
    return armed?.next_retry_at || null;
  } catch {
    return null;
  }
}

async function sendPaymentFailed({
  customerId,
  paymentIntentId,
  attemptId,
  invoiceId = null,
  paymentId = null,
  // GATE_BILLING_EMAIL_DETAILS: the failed PaymentIntent (for the card label)
  // and when Stripe says the attempt failed (for the attempt date). Unused with
  // the gate off.
  paymentIntent = null,
  failedAt = null,
  // Combined full-balance PI (codex #3427 r7 P2): the caller passes the
  // allocation total so the email names the amount the customer actually
  // attempted, never one arbitrary share's remainder.
  amountDueOverride = null,
  idempotencyKey,
  customerInitiated = false,
} = {}) {
  let invoice = invoiceId ? await db('invoices').where({ id: invoiceId }).first().catch(() => null) : null;
  let payment = paymentId ? await db('payments').where({ id: paymentId }).first().catch(() => null) : null;
  if (!payment && paymentIntentId) {
    payment = await db('payments').where({ stripe_payment_intent_id: paymentIntentId }).first().catch(() => null);
  }
  if (!invoice && payment) invoice = await invoiceForPayment(payment, invoiceId);
  if (!invoice && paymentIntentId) {
    invoice = await db('invoices').where({ stripe_payment_intent_id: paymentIntentId }).first().catch(() => null);
  }
  // Third-party Bill-To: a payer-billed invoice's payment lifecycle belongs to
  // the payer AP contact. These templates resolve recipients off the invoice's
  // customer_id (the homeowner) and embed the pay link, so skip them for payer
  // invoices rather than notify the homeowner of the payer's failed payment.
  // (Phase 1 has no payer-facing lifecycle emails.)
  if (invoice?.payer_id) return { ok: false, skipped: true, reason: 'payer_billed' };
  const payUrl = invoice?.token
    ? `${publicPortalUrl()}/pay/${invoice.token}`
    : portalBillingUrl();
  const method = payment ? methodParts(paymentTenderSnapshot(payment)) : null;
  const payload = {
    payment_url: payUrl,
    invoice_title: invoice?.title || invoice?.service_type || clean(payment?.description).replace(/\s+[-\u2014]\s+FAILED$/i, '') || '',
    invoice_number: invoice?.invoice_number || '',
    // No payments row yet on an interactive failure → fall back to amount DUE
    // (total − applied credit), not the gross total, to match /pay and the charge.
    amount_due: money(amountDueOverride != null
      ? amountDueOverride
      : (payment?.amount || (invoice ? invoiceAmountDue(invoice) : 0))),
    failed_payment_date: displayDate(payment?.payment_date || payment?.created_at),
    retry_date: displayDate(payment?.next_retry_at),
    payment_method_label: method?.last4 ? method.label : '',
  };
  if (BillingEmailDetails.billingEmailDetailsLive()) {
    // Card label, attempt date and the ladder's own retry date, each only where
    // the data exists: the payments row first, then the saved method it points
    // at, then the failed intent itself.
    // ANY card label needs the payments row and invoice to agree with the
    // customer this email goes to, else the row stays blank rather than name
    // another customer's card. The failed intent's card needs more: both Stripe
    // customer ids known and equal (intentCardOwnedByCustomer). Known Stripe
    // ids that DIFFER blank every card label (intentCustomerConflicts).
    const emailedCustomerId = customerId || invoice?.customer_id || payment?.customer_id || null;
    if (!paymentOwnershipAgrees({ emailedCustomerId, payment, invoice })
      || await intentCustomerConflicts({ emailedCustomerId, paymentIntent })) {
      payload.payment_method_label = '';
    } else {
      // Pay-page PaymentIntents are reused after a failed attempt and the
      // webhook only updates status / failure_reason on the existing payments
      // row (stripe-webhook.js), so the row's card snapshot and saved-method
      // pointer can be the PREVIOUS attempt's card. When the current intent
      // names a card and its ownership is confirmed, that card wins. When it
      // names a card we cannot confirm and the row's own card differs, either
      // may be the stale one: blank rather than guess.
      const intentLabel = failedIntentCardLabel(paymentIntent);
      const intentOwned = intentLabel
        ? await intentCardOwnedByCustomer({ emailedCustomerId, paymentIntent })
        : false;
      if (intentOwned) {
        payload.payment_method_label = intentLabel;
      } else {
        if (!payload.payment_method_label) {
          // A lookup blip must never throw out of the webhook: blank row instead.
          const owner = payment?.customer_id || null;
          const saved = owner && payment?.payment_method_id
            ? await loadPaymentMethod(payment.payment_method_id, owner).catch(() => null)
            : null;
          const savedParts = saved ? methodParts(saved) : null;
          if (savedParts?.last4) payload.payment_method_label = savedParts.label;
        }
        // Brand AND last four must match the card Stripe reports for this
        // attempt (a Visa 4242 is not a Mastercard 4242); any difference blanks.
        if (intentLabel && payload.payment_method_label && !sameCardLabel(payload.payment_method_label, intentLabel)) {
          payload.payment_method_label = '';
        }
      }
    }
    if (!payload.failed_payment_date) payload.failed_payment_date = displayDate(failedAt);
    // The armed retry is read off the invoice's own customer (armedRetryDate
    // filters by it); an invoice that is not the customer this email goes to
    // supplies no retry date.
    if (!payload.retry_date && !(customerId && invoice?.customer_id && String(invoice.customer_id) !== String(customerId))) {
      payload.retry_date = displayDate(await armedRetryDate({ payment, invoice }));
    }
  }
  const effectiveCustomerId = customerId || invoice?.customer_id || payment?.customer_id;
  if (!effectiveCustomerId) return { ok: false, skipped: true, reason: 'customer_not_resolved' };
  const dedupeKey = idempotencyKey
    || `payment.failed:${paymentIntentId || invoice?.id || effectiveCustomerId}:${attemptId || 'no_attempt'}`;
  const emailResult = await sendLifecycleTemplate({
    customerId: effectiveCustomerId,
    templateKey: 'payment.failed',
    eventType: 'payment.failed',
    payload,
    invoiceId: invoice?.id || invoiceId || null,
    paymentId: payment?.id || paymentId || null,
    paymentMethodId: payment?.payment_method_id || null,
    idempotencyKey: dedupeKey,
    billingDeliveryCategory: 'payment_issue',
    customerInitiated: customerInitiated === true,
    // Stored on the email row so a provider-block retry keeps the exemption (the retry rail
    // reads it before its dispute-hold check).
    categories: customerInitiated === true ? [CUSTOMER_INITIATED_EMAIL_CATEGORY] : [],
  });
  // A hold refusal (the ONE retryable COLLECTION_HOLD_DEFER outcome) is a wait, not an unavailable
  // preference read: nothing to retry the webhook for - the Text/App legs below are gated at their own
  // boundary and dunning after the release covers the email.
  if (emailResult?.retryable && !require('./collections/collection-hold').isHoldSuppression(emailResult)) {
    const err = new Error('Payment-issue delivery preferences are unavailable');
    err.code = 'BILLING_PREFS_UNAVAILABLE';
    err.retryable = true;
    throw err;
  }

  // Legacy rows stay email-only. Explicit Text/App work is first persisted on
  // the scheduled-message rail; Stripe can redeliver the same event after a
  // crash, so the customer communications lock plus event key must establish
  // one durable owner before the webhook is acknowledged. The replay runs the
  // canonical channel router and declares the branded email sidecar.
  const prefs = await loadPrefs(effectiveCustomerId);
  if (prefs === PREFS_UNAVAILABLE) {
    const err = new Error('Payment-issue delivery preferences are unavailable');
    err.code = 'BILLING_PREFS_UNAVAILABLE';
    err.retryable = true;
    throw err;
  }
  const explicit = explicitBillingChannels(prefs || {}, 'payment_issue');
  if (!explicit || !explicit.some((channel) => channel === 'sms' || channel === 'push')) return emailResult;
  const customer = await loadCustomer(effectiveCustomerId);
  if (!customer) return emailResult;
  if (!customer?.phone && !explicit.includes('push')) return emailResult;
  const body = await require('./sms-template-renderer').renderSmsTemplate('payment_failed', {
    first_name: customer.first_name || 'there',
    service_type: invoice?.title || invoice?.service_type || 'your Waves invoice',
    service_date: displayDate(invoice?.service_date || payment?.payment_date || payment?.created_at),
  }, {
    workflow: 'interactive_payment_failed',
    entity_type: 'invoice',
    entity_id: invoice?.id || invoiceId || null,
  }, { throwOnError: true });
  if (!body) return emailResult;
  const eventKey = `payment-failed:${paymentIntentId || invoice?.id || effectiveCustomerId}:${attemptId || 'no_attempt'}`;
  const replayMetadata = {
    original_message_type: 'payment_failed',
    billingDeliveryCategory: 'payment_issue',
    notificationEventKey: eventKey,
    hasEmailLeg: true,
    customer_initiated: customerInitiated === true,
    entry_point: 'stripe_webhook_billing_deferred',
    replay_purpose: 'payment_failure',
    refresh_customer_phone: true,
    resolve_from_by_customer: true,
    customer_id: effectiveCustomerId,
    ...(invoice?.id || invoiceId ? { invoice_id: invoice?.id || invoiceId } : {}),
    ...(payment?.id || paymentId ? { payment_id: payment?.id || paymentId } : {}),
    ...(paymentIntentId ? { stripe_payment_intent_id: paymentIntentId } : {}),
  };
  let channelResult;
  try {
    channelResult = await require('../utils/customer-comms-lock').withCustomerCommsLock(
      db,
      effectiveCustomerId,
      async (trx) => {
        const existing = await excludeUnresolvedSendReservations(trx('sms_log'))
          .where({ customer_id: effectiveCustomerId })
          .whereRaw("metadata->>'entry_point' = ?", ['stripe_webhook_billing_deferred'])
          .whereRaw("metadata->>'notificationEventKey' = ?", [eventKey])
          .first('id', 'status');
        if (existing) {
          return {
            sent: false,
            scheduled: true,
            deduped: true,
            queueId: existing.id,
            deliveryOutcome: 'not_sent',
          };
        }
        const inserted = await trx('sms_log').insert({
          customer_id: effectiveCustomerId,
          direction: 'outbound',
          from_phone: require('../config/twilio-numbers').getOutboundNumber(),
          to_phone: customer.phone || '',
          message_body: body,
          message_type: 'payment_failed',
          status: 'scheduled',
          scheduled_for: new Date(),
          metadata: JSON.stringify(replayMetadata),
        }).returning('id');
        return {
          sent: false,
          scheduled: true,
          queueId: inserted?.[0]?.id || inserted?.[0] || null,
          deliveryOutcome: 'not_sent',
        };
      },
    );
  } catch (queueErr) {
    const err = new Error(`Payment-failure delivery could not be queued: ${queueErr.message}`);
    err.code = 'BILLING_NOTICE_ENQUEUE_FAILED';
    throw err;
  }
  return {
    ok: emailResult?.ok === true || channelResult?.scheduled === true,
    email: emailResult,
    channels: channelResult,
    ...(channelResult?.queueId ? { queueId: channelResult.queueId } : {}),
  };
}

async function sendAchProcessing({
  customerId,
  invoiceId,
  paymentId = null,
  amountPaid = null,
  initiatedAt = new Date(),
  expectedClearDate = null,
  idempotencyKey,
} = {}) {
  const invoice = invoiceId ? await db('invoices').where({ id: invoiceId }).first().catch(() => null) : null;
  if (!invoice) return { ok: false, skipped: true, reason: 'invoice_not_found' };
  // Third-party Bill-To: ACH-processing notice routes to the invoice customer_id
  // (homeowner) with the pay link — skip for payer invoices (the payer AP paid,
  // not the homeowner). Phase 1 has no payer-facing lifecycle emails.
  if (invoice.payer_id) return { ok: false, skipped: true, reason: 'payer_billed' };
  const payUrl = invoice.token
    ? `${publicPortalUrl()}/pay/${invoice.token}`
    : portalBillingUrl();
  const payload = {
    invoice_title: invoice.title || invoice.service_type || `Invoice ${invoice.invoice_number || ''}`.trim() || 'your Waves invoice',
    invoice_number: invoice.invoice_number || '',
    amount_paid: money(amountPaid != null ? amountPaid : invoice.total),
    payment_initiated_date: displayDate(initiatedAt),
    expected_clear_date: expectedClearDate ? displayDate(expectedClearDate) : '',
    pay_url: payUrl,
  };
  const effectiveCustomerId = customerId || invoice.customer_id;
  return sendLifecycleTemplate({
    customerId: effectiveCustomerId,
    templateKey: 'payment.ach_processing',
    eventType: 'payment.ach_processing',
    payload,
    invoiceId: invoice.id,
    paymentId,
    idempotencyKey: idempotencyKey || `payment.ach_processing:${invoice.id}`,
  });
}

async function sendPaymentPlanConfirmed({
  customerId,
  paymentPlanId,
  paymentMethodId = null,
  plan = {},
  invoiceId = null,
  idempotencyKey,
} = {}) {
  // Third-party Bill-To: a payment plan on a payer-billed invoice is the payer's
  // arrangement — don't email the homeowner the plan/balance details.
  const planInvoiceId = invoiceId || plan?.invoice_id || null;
  if (planInvoiceId) {
    const planInvoice = await db('invoices').where({ id: planInvoiceId }).first().catch(() => null);
    if (planInvoice?.payer_id) return { ok: false, skipped: true, reason: 'payer_billed' };
  }
  const method = await loadPaymentMethod(paymentMethodId);
  const payload = {
    plan_start_date: displayDate(plan.plan_start_date || plan.start_date),
    total_balance: money(plan.total_balance),
    payment_amount: money(plan.payment_amount),
    payment_frequency: clean(plan.payment_frequency || plan.frequency),
    next_payment_date: displayDate(plan.next_payment_date),
  };
  assignMethodPayload(payload, method || {});
  return sendLifecycleTemplate({
    customerId,
    templateKey: 'payment.plan_confirmed',
    eventType: 'payment.plan_confirmed',
    payload,
    paymentMethodId,
    paymentPlanId: paymentPlanId || null,
    idempotencyKey: idempotencyKey || `payment.plan_confirmed:${paymentPlanId || 'manual'}:${customerId}`,
  });
}

async function sendRefundIssued({
  customerId,
  paymentId,
  refundId,
  refundAmount,
  refundDate = new Date(),
  refundReason,
  idempotencyKey,
} = {}) {
  const payment = paymentId ? await db('payments').where({ id: paymentId }).first() : null;
  if (!payment) return { ok: false, skipped: true, reason: 'payment_not_found' };
  // Third-party Bill-To: a refund of a payer-billed invoice's payment belongs to
  // the payer AP contact, not the homeowner — don't email the service recipient
  // the payer's refund details.
  const refundInvoice = await invoiceForPayment(payment);
  if (refundInvoice?.payer_id) return { ok: false, skipped: true, reason: 'payer_billed' };
  const method = await loadPaymentMethod(payment.payment_method_id);
  const effectiveCustomerId = customerId || payment.customer_id;
  const effectiveRefundId = refundId || payment.stripe_refund_id || `payment-${payment.id}`;
  const payload = {
    refund_amount: money(refundAmount || payment.refund_amount),
    refund_date: displayDate(refundDate || payment.refunded_at || new Date()),
    refund_reason: displayReason(refundReason || payment.refund_reason, 'Account adjustment'),
    original_payment_date: displayDate(payment.payment_date),
    receipt_url: clean(payment.receipt_url),
  };
  assignMethodPayload(payload, method || paymentTenderSnapshot(payment));
  return sendLifecycleTemplate({
    customerId: effectiveCustomerId,
    templateKey: 'payment.refund_issued',
    eventType: 'payment.refund_issued',
    payload,
    paymentId: payment.id,
    paymentMethodId: payment.payment_method_id || null,
    refundId: effectiveRefundId,
    idempotencyKey: idempotencyKey || `payment.refund_issued:${effectiveRefundId}:${effectiveCustomerId}`,
  });
}

// Combined cancellation-confirmed + deposit-refund notice for the admin
// cancel-signup flow (customer-offboarding.js). Deposits have no payments
// row, so this deliberately does NOT resolve a payment — the orchestrator
// passes the ledger-verified refunded total. The template ships paused;
// activating it in the template admin is the send switch.
async function sendCancellationRefundIssued({
  customerId,
  refundAmount,
  refundDate = new Date(),
  planLabel = '',
  idempotencyKey,
} = {}) {
  if (!(Number(refundAmount) > 0)) {
    return { ok: false, skipped: true, reason: 'no_refund_amount' };
  }
  return sendLifecycleTemplate({
    customerId,
    templateKey: 'account.cancellation_refund',
    eventType: 'account.cancellation_refund',
    payload: {
      refund_amount: money(refundAmount),
      refund_date: displayDate(refundDate),
      plan_label: clean(planLabel),
    },
    idempotencyKey: idempotencyKey || `account.cancellation_refund:${customerId}:${stableDateKey(refundDate)}`,
  });
}

module.exports = {
  sendAutopayEnabled,
  sendAutopayDisabled,
  sendPaymentMethodUpdated,
  sendPaymentMethodRemoved,
  sendPaymentMethodExpiring,
  sendPaymentRetryNotice,
  sendPaymentFailed,
  sendAchProcessing,
  sendPaymentPlanConfirmed,
  sendRefundIssued,
  sendCancellationRefundIssued,
  _private: {
    methodParts,
    assignMethodPayload,
    expiryStageFor,
    sendLifecycleTemplate,
  },
};
