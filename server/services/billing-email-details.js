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

// RULE A. The Property row resolves through the canonical visit → property
// precedence (service-report/visit-property-scope.js): the visit's own
// IMMUTABLE stamp, else its property_id's customer_properties row, else its
// source_estimate_id's estimate. Each link is read with the OWNING customer id
// in the query, so a pointer to another customer's row reads as unresolvable.
// The customer's primary address is a fallback ONLY when the invoice / estimate
// carries no link at all. Any link that is present but foreign, disagreeing,
// unresolvable, without a street line, or whose lookup throws OMITS the row
// (''): a wrong property in a customer email is worse than a blank row. Only
// ever a STREET address: the nickname in profile_label ("Primary", "Rental") is
// never a fallback here.

const ADDRESS_COLS = ['address_line1', 'address_line2', 'city', 'state', 'zip'];
const VISIT_COLS = [
  'service_type', 'scheduled_date', 'property_id', 'source_estimate_id',
  'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_state', 'service_address_zip',
];

// THE one path to a visit / completion record for an invoice. A stamped
// scheduled_service_id or service_record_id is only a pointer: it can name
// ANOTHER customer's row (a mislinked or merged record), and everything read
// through it (service address, service type, date) would then describe someone
// else's visit. So both rows are read with the OWNING customer id in the query;
// a pointer that does not resolve to that customer's own row reads as "no
// visit / no record linked" (and `unresolved` says a pointer was present).
// When the invoice and its completion record point at DIFFERENT visits the two
// disagree about what was billed: `conflict` is set and NOTHING derived from
// either is returned. Throws when a lookup itself fails: callers decide what a
// failure means (the Property row is omitted, the service falls back).
async function ownedVisitContext(invoice) {
  const customerId = invoice?.customer_id;
  if (!customerId) return { visit: null, record: null, linked: false, unresolved: false, conflict: false };
  const linked = !!(invoice.scheduled_service_id || invoice.service_record_id);
  const record = invoice.service_record_id
    ? (await db('service_records').where({ id: invoice.service_record_id, customer_id: customerId })
      .first('service_type', 'service_date', 'scheduled_service_id')) || null
    : null;
  if (record?.scheduled_service_id && invoice.scheduled_service_id
    && String(record.scheduled_service_id) !== String(invoice.scheduled_service_id)) {
    return { visit: null, record: null, linked, unresolved: true, conflict: true };
  }
  const scheduledId = invoice.scheduled_service_id || record?.scheduled_service_id || null;
  const visit = scheduledId
    ? (await db('scheduled_services').where({ id: scheduledId, customer_id: customerId }).first(...VISIT_COLS)) || null
    : null;
  const unresolved = linked && ((invoice.service_record_id && !record) || (scheduledId && !visit) || (!scheduledId && !!record));
  return { visit, record, linked, unresolved: !!unresolved, conflict: false };
}

// The members of a combined-visit packet that belong to THIS invoice AND this
// customer. Mirrors invoice-email.js's packet receipt lookup: the packet item's
// invoice_id, the member visit's customer_id, and p.visit_id = s.visit_id (the
// visit really belongs to that packet's group), so a mislinked packet_id or
// invoice_id can never name another customer's visits.
async function ownedPacketVisits(invoice, columns) {
  if (!invoice?.id || !invoice.customer_id || !invoice.visit_completion_packet_id) return [];
  return db('visit_completion_packet_items as i')
    .join('visit_completion_packets as p', 'p.id', 'i.packet_id')
    .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
    .where({
      'i.invoice_id': invoice.id,
      'i.packet_id': invoice.visit_completion_packet_id,
      's.customer_id': invoice.customer_id,
    })
    .whereRaw('p.visit_id = s.visit_id')
    .orderBy('s.id')
    .select(columns);
}

// A street address from an OWNED saved property; '' when it is not this
// customer's, is gone, or has no street line.
async function ownedPropertyAddress(propertyId, customerId) {
  if (!propertyId || !customerId) return '';
  const property = await db('customer_properties').where({ id: propertyId, customer_id: customerId })
    .first(...ADDRESS_COLS);
  return (property && propertyStreetAddress(property)) || '';
}

// Rule A on ONE visit row: stamp → property_id → source_estimate_id, each link
// customer-checked. The first link present decides; a present link that yields
// no street address is '' — never a different link's address, never primary.
async function visitPropertyAddress(visit, customerId) {
  if (!visit || !customerId) return '';
  if (clean(visit.service_address_line1)) {
    return propertyStreetAddress({
      address_line1: visit.service_address_line1,
      address_line2: visit.service_address_line2,
      city: visit.service_address_city,
      state: visit.service_address_state,
      zip: visit.service_address_zip,
    }) || '';
  }
  if (visit.property_id) return ownedPropertyAddress(visit.property_id, customerId);
  if (visit.source_estimate_id) {
    const estimate = await db('estimates').where({ id: visit.source_estimate_id, customer_id: customerId })
      .first('address', 'property_id');
    if (!estimate) return '';
    if (estimate.property_id) return ownedPropertyAddress(estimate.property_id, customerId);
    return isStreetShapedAddress(estimate.address) ? clean(estimate.address) : '';
  }
  return '';
}

async function invoicePropertyAddress(invoice, customer) {
  try {
    const customerId = invoice?.customer_id;
    if (!customerId) return '';
    const { visit, linked, unresolved, conflict } = await ownedVisitContext(invoice);
    if (conflict) return '';
    if (linked) {
      // A visit / record pointer is present: only the visit it resolves to may
      // name the property. Foreign or unresolvable → omit, never primary.
      if (unresolved || !visit) return '';
      return await visitPropertyAddress(visit, customerId);
    }
    if (invoice.visit_completion_packet_id) {
      // A combined-visit invoice: every verified member must name the SAME
      // street address; a member that cannot be resolved omits the row.
      const members = await ownedPacketVisits(invoice, VISIT_COLS.map((c) => `s.${c}`));
      if (!members.length) return '';
      const addresses = await Promise.all(members.map((m) => visitPropertyAddress(m, customerId)));
      const first = addresses[0];
      return first && addresses.every((a) => a === first) ? first : '';
    }
    // NO link at all: the address frozen on the invoice, else the customer's.
    // The passed customer is used only when it IS the invoice's customer.
    let source = customer && (customer.id == null || String(customer.id) === String(customerId)) ? customer : null;
    // A caller's projection may omit the unit line (address_line2) or the whole
    // address; reload the customer's address columns whenever it is incomplete.
    const complete = source && ADDRESS_COLS.every((k) => Object.hasOwn(source, k));
    if (!complete) {
      source = await db('customers').where({ id: customerId }).first(...ADDRESS_COLS);
    }
    return propertyStreetAddress(invoiceCustomerAddress(invoice, source || {})) || '';
  } catch (err) {
    logger.warn(`[billing-email-details] property address lookup failed: ${err.message}`);
    return '';
  }
}

// A customer (no invoice) — estimate follow-ups whose estimate carries no
// address text of its own. With a property_id the ONLY answer is that saved
// property when it belongs to THIS customer and has a street line; foreign,
// gone or street-less omits the row. Only an estimate with no property_id at
// all falls back to the customer's own primary address.
async function customerPropertyAddress(customerId, propertyId = null) {
  if (!customerId) return '';
  try {
    if (propertyId) return await ownedPropertyAddress(propertyId, customerId);
    const customer = await db('customers').where({ id: customerId }).first(...ADDRESS_COLS);
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
      // Verified against the customer, the invoice and the packet's own visit
      // (ownedPacketVisits), never trusting packet_id / invoice_id alone.
      const members = await ownedPacketVisits(invoice, ['s.service_type']);
      const names = [...new Set(members.map((m) => clean(m.service_type)).filter(Boolean))];
      if (names.length) label = names.join(', ');
    }
    if (!label || !date) {
      // Both rows come through the ownership-checked path; the completion
      // record is read whenever EITHER half still needs a fallback, so the
      // record's own date beats the visit's scheduled date.
      const { visit, record } = await ownedVisitContext(invoice);
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
// ("123 Main St", "5A Palm Ave") or a numbered street ("100 4th Ave E",
// "20 21st St W"). A nickname such as "Rental 2", "Property #2" or "Unit 4"
// is not one, even though it carries a digit.
function isStreetShapedAddress(value) {
  const text = clean(value);
  if (!text) return false;
  try {
    const { line1 } = parseRawAddress(text);
    return /^\d+[A-Za-z]?(?:-\d+)?\s+(?:[A-Za-z]|\d+(?:st|nd|rd|th)\b)/i.test(clean(line1));
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
  _private: { ownedVisitContext, visitPropertyAddress, savedMethodRow, MANUAL_TENDERS },
};
