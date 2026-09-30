/**
 * Billing email details (GATE_BILLING_EMAIL_DETAILS, dark; owner-approved
 * 2026-09-29 after an audit of production email_messages).
 *
 * The audit found the customer's billing emails were thin on the facts a
 * customer looks for: invoice.sent and the receipts often went out with a blank
 * service, service date or payment method; payment.failed with no card label,
 * attempt date or retry date; invoices, receipts and estimate follow-ups with no
 * Property row. (The unkeyed sends are a separate follow-up.)
 *
 * This module is the ONE place the sending code asks "what do we know about
 * this invoice / payment" and gets a plain string back ('' when the data does
 * not exist, which the template renderer drops as a blank row). Every reader
 * here is a pure lookup; the callers decide whether to use the answer, and
 * they only do so under billingEmailDetailsLive(), so gate off the payloads and
 * keys are exactly what they were.
 */

const db = require('../models/db');
const logger = require('./logger');
const { propertyStreetAddress } = require('../utils/property-display');
const { invoiceCustomerAddress } = require('./invoice-address');
const { formatDateOnly } = require('../utils/date-only');
const { parseRawAddress } = require('../utils/address-normalizer');
const featureGates = require('../config/feature-gates');

// The one reader every sender in the lane goes through. Read at CALL time; a
// gates module without the reader (a partial test mock) reads as off, which is
// the dark default.
function billingEmailDetailsLive() {
  return typeof featureGates.billingEmailDetailsLive === 'function' && featureGates.billingEmailDetailsLive() === true;
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

// ── Card / tender labels ────────────────────────────────────────────────

const BRAND_NAMES = Object.freeze({
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  american_express: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  diners_club: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
});

// Stripe sends 'visa' / 'amex'; the payments table stores whatever the writer
// had. Customer copy names the brand the way the card does.
function cardBrandName(brand) {
  const raw = clean(brand);
  if (!raw) return '';
  return BRAND_NAMES[raw.toLowerCase().replace(/[\s-]+/g, '_')] || raw;
}

// "VISA ···· 4242" — the format the receipt email already used for cards, kept
// so the same card reads the same way in every email.
function dottedCardLabel(brand, last4) {
  const b = clean(brand);
  const l = clean(last4);
  return b && l ? `${b.toUpperCase()} ···· ${l}` : '';
}

const MANUAL_TENDERS = Object.freeze({
  cash: 'Cash',
  check: 'Check',
  zelle: 'Zelle',
  venmo: 'Venmo',
  paypal: 'PayPal',
  other: 'Other payment',
  card: 'Card',
  card_present: 'Card',
  us_bank_account: 'Bank account (ACH)',
  ach: 'Bank account (ACH)',
});

async function savedMethodRow(customerId) {
  if (!customerId) return null;
  try {
    const customer = await db('customers').where({ id: customerId }).first('autopay_payment_method_id');
    if (customer?.autopay_payment_method_id) {
      const chosen = await db('payment_methods').where({ id: customer.autopay_payment_method_id, customer_id: customerId }).first();
      if (chosen) return chosen;
    }
    return (await db('payment_methods').where({ customer_id: customerId, is_default: true }).first()) || null;
  } catch (err) {
    logger.warn(`[billing-email-details] saved payment method lookup failed for ${customerId}: ${err.message}`);
    return null;
  }
}

function bankOrCardLabel(method = {}) {
  const type = clean(method.method_type || method.payment_method_type).toLowerCase();
  if (type === 'ach' || type === 'us_bank_account') {
    const bank = clean(method.bank_name) || 'Bank account';
    const last4 = clean(method.bank_last_four || method.last_four || method.card_last_four);
    return last4 ? `${bank} ···· ${last4}` : bank;
  }
  return dottedCardLabel(method.card_brand, method.last_four || method.card_last_four);
}

// The card (or bank account) the customer has on file for this invoice — what
// an unpaid invoice.sent email can honestly name. A payer-billed invoice or an
// operator's one-off recipient must never see the homeowner's card, so the
// caller passes `allowed: false` for those and gets '' back.
async function payMethodOnFileLabel(invoice, { allowed = true } = {}) {
  if (!allowed || !invoice?.customer_id || invoice.payer_id) return '';
  // Only the saved method row: the invoice's own card columns can hold a card
  // that was charged and later disputed on a reopened invoice.
  return bankOrCardLabel(await savedMethodRow(invoice.customer_id) || {});
}

// The tender behind a PAID invoice, for the receipt. The receipt email already
// showed a card's brand and last four; it went blank for everything else (cash,
// a check, Zelle, an ACH debit, a card with no stored last four). `payment` is
// the ledger row (or null).
function receiptTenderLabel({ payment = null, invoice = {} } = {}) {
  const paymentType = clean(payment?.payment_method_type).toLowerCase();
  let meta = payment?.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = null; }
  }
  // The CURRENT tender wins: recordManualPayment stamps invoice.payment_method
  // when cash/check/Zelle settles an invoice, and a reopened (disputed card)
  // invoice can still carry the old card columns. Card details are used only
  // when the current tender is card-based (or unknown).
  const invoiceTender = clean(invoice.payment_method).toLowerCase();
  const named = invoiceTender
    || clean(meta?.payment_method).toLowerCase()
    || paymentType;
  const cardBased = !named || named === 'card' || named === 'card_present' || !MANUAL_TENDERS[named];
  if (cardBased) {
    const card = dottedCardLabel(payment?.card_brand, payment?.card_last_four)
      || dottedCardLabel(invoice.card_brand, invoice.card_last_four);
    if (card) return card;
  }
  if (paymentType === 'ach' || paymentType === 'us_bank_account') {
    if (!invoiceTender || invoiceTender === 'ach' || invoiceTender === 'us_bank_account') return bankOrCardLabel(payment);
  }
  return MANUAL_TENDERS[named] || '';
}

// ── Property (full street address) ──────────────────────────────────────

// The visit's own stamped service address (a call booking for a secondary or
// rental property) wins; otherwise the address frozen on the invoice; otherwise
// the customer's. Only ever a STREET address: the nickname in profile_label
// ("Primary", "Rental") is never a fallback here, so a customer with no street
// line simply gets no Property row.
const LOOKUP_FAILED = Symbol('lookup-failed');

async function scheduledServiceIdFor(invoice, { failureSentinel = false } = {}) {
  if (invoice?.scheduled_service_id) return invoice.scheduled_service_id;
  if (!invoice?.service_record_id) return null;
  try {
    const record = await db('service_records').where({ id: invoice.service_record_id }).first('scheduled_service_id');
    return record?.scheduled_service_id || null;
  } catch {
    return failureSentinel ? LOOKUP_FAILED : null;
  }
}

// '' = the visit carries no stamped street address; null = the lookup FAILED.
// The caller must not treat a failure as "no stamp": that would fall back to
// the primary address and name the wrong property on a secondary-property visit.
async function stampedVisitAddress(scheduledServiceId) {
  if (!scheduledServiceId) return '';
  try {
    const row = await db('scheduled_services').where({ id: scheduledServiceId }).first(
      'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_state', 'service_address_zip',
    );
    if (!row) return '';
    return propertyStreetAddress({
      address_line1: row.service_address_line1,
      address_line2: row.service_address_line2,
      city: row.service_address_city,
      state: row.service_address_state,
      zip: row.service_address_zip,
    }) || '';
  } catch (err) {
    logger.warn(`[billing-email-details] visit address lookup failed for ${scheduledServiceId}: ${err.message}`);
    return null;
  }
}

async function invoicePropertyAddress(invoice, customer) {
  try {
    const scheduledId = await scheduledServiceIdFor(invoice, { failureSentinel: true });
    if (scheduledId === LOOKUP_FAILED) return '';
    const stamped = await stampedVisitAddress(scheduledId);
    // A failed visit lookup omits the Property row rather than guessing.
    if (stamped === null) return '';
    if (stamped) return stamped;
    let source = customer;
    // A caller's projection may omit the unit line (address_line2) or the whole
    // address; reload the customer's address columns whenever it is incomplete.
    const complete = source && ['address_line1', 'address_line2', 'city', 'state', 'zip'].every((k) => Object.hasOwn(source, k));
    if (!complete && invoice?.customer_id) {
      source = await db('customers').where({ id: invoice.customer_id })
        .first('address_line1', 'address_line2', 'city', 'state', 'zip');
    }
    return propertyStreetAddress(invoiceCustomerAddress(invoice, source || {})) || '';
  } catch (err) {
    logger.warn(`[billing-email-details] property address lookup failed: ${err.message}`);
    return '';
  }
}

// A customer (no invoice) — estimate follow-ups whose estimate carries no
// address text of its own.
async function customerPropertyAddress(customerId, propertyId = null) {
  if (!customerId && !propertyId) return '';
  try {
    if (propertyId) {
      const property = await db('customer_properties').where({ id: propertyId }).first('address_line1', 'address_line2', 'city', 'state', 'zip');
      const fromProperty = property ? propertyStreetAddress(property) : null;
      if (fromProperty) return fromProperty;
    }
    if (!customerId) return '';
    const customer = await db('customers').where({ id: customerId }).first('address_line1', 'address_line2', 'city', 'state', 'zip');
    return (customer && propertyStreetAddress(customer)) || '';
  } catch (err) {
    logger.warn(`[billing-email-details] customer property lookup failed: ${err.message}`);
    return '';
  }
}

// ── Service and service date ────────────────────────────────────────────

const MONTH_TITLE_SUFFIX = /\s+[—–-]\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\s*$/i;

// What the invoice was for. invoice.service_type is the answer when it is set;
// the audit found it blank on the invoices that were emailed before the visit
// was closed out, so fall back to the visit and the completion record it hangs
// off, the combined-visit packet's services, and last the invoice title.
async function invoiceServiceDetails(invoice) {
  const fromInvoice = clean(invoice?.service_type);
  const invoiceDate = invoice?.service_date ? formatDateOnly(invoice.service_date) : '';
  if (fromInvoice && invoiceDate) return { label: fromInvoice, date: invoiceDate };

  let label = fromInvoice;
  let date = invoiceDate;
  try {
    if (invoice?.visit_completion_packet_id && !label) {
      const members = await db('visit_completion_packet_items as i')
        .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
        .where({ 'i.invoice_id': invoice.id, 'i.packet_id': invoice.visit_completion_packet_id })
        .orderBy('s.id').select('s.service_type');
      const names = [...new Set(members.map((m) => clean(m.service_type)).filter(Boolean))];
      if (names.length) label = names.join(', ');
    }
    if (!label || !date) {
      const scheduledId = await scheduledServiceIdFor(invoice);
      const visit = scheduledId
        ? await db('scheduled_services').where({ id: scheduledId }).first('service_type', 'scheduled_date')
        : null;
      const record = (!visit || !visit.service_type) && invoice?.service_record_id
        ? await db('service_records').where({ id: invoice.service_record_id }).first('service_type', 'service_date')
        : null;
      if (!label) label = clean(visit?.service_type) || clean(record?.service_type);
      if (!date) {
        const raw = record?.service_date || visit?.scheduled_date;
        date = raw ? formatDateOnly(raw) : '';
      }
    }
  } catch (err) {
    logger.warn(`[billing-email-details] service lookup failed for invoice ${invoice?.id}: ${err.message}`);
  }
  if (!label) label = clean(invoice?.title).replace(MONTH_TITLE_SUFFIX, '');
  return { label, date };
}

// The ledger row behind a paid invoice — the same lookup sendReceiptEmail has
// always used, shared so the routed billing.receipt_notice reads the same row.
async function paidPaymentForInvoice(invoice) {
  if (!invoice?.id || !invoice.customer_id) return null;
  try {
    return (await db('payments')
      .where({ customer_id: invoice.customer_id })
      .whereIn('status', ['paid', 'refunded'])
      .whereRaw(`metadata::jsonb ->> 'invoice_id' = ?`, [invoice.id])
      .orderBy('created_at', 'desc')
      .first()) || null;
  } catch {
    return null;
  }
}

// ── Street-shaped address text ──────────────────────────────────────────

// True only for free text that reads as a street address: the shared address
// parser's street line starts with a house number followed by a street name
// ("123 Main St", "5A Palm Ave"). A nickname such as "Rental 2", "Property #2"
// or "Unit 4" is not one, even though it carries a digit.
function isStreetShapedAddress(value) {
  const text = clean(value);
  if (!text) return false;
  try {
    const { line1 } = parseRawAddress(text);
    return /^\d+[A-Za-z]?(?:-\d+)?\s+[A-Za-z]/.test(clean(line1));
  } catch {
    return false;
  }
}

module.exports = {
  billingEmailDetailsLive,
  cardBrandName,
  dottedCardLabel,
  bankOrCardLabel,
  payMethodOnFileLabel,
  receiptTenderLabel,
  invoicePropertyAddress,
  customerPropertyAddress,
  invoiceServiceDetails,
  paidPaymentForInvoice,
  isStreetShapedAddress,
  _private: { stampedVisitAddress, scheduledServiceIdFor, savedMethodRow, MANUAL_TENDERS },
};
