/**
 * The add-a-service + referral cards on a paid receipt (GATE_DOC_CROSS_SELL,
 * owner 2026-11-21) — who may see them and what they carry. One home for the
 * receipt page (routes/receipt-v2.js) and the receipt email's pointer line
 * (invoice-email.js), so the email never promises a card the page won't show.
 *
 * Eligible: a PAID invoice, for 7 days after its payment (owner 2026-11-22,
 * "week": a receipt link never expires, and the person who opens it in that
 * first week is the person who paid; after day 7 it is a plain receipt, with
 * no card, no tap and no email line), whose link reaches the account holder alone (no
 * third-party payer on the invoice, the job or the account, no service
 * contact on the account — linkReachesOnlyAccountHolder; and the receipt email's own
 * recipient resolver, getReceiptEmailRecipients, picks the account holder —
 * a distinct notification_prefs.billing_email means the receipt goes to
 * someone else; and no recorded send of this invoice's link to anyone else:
 * a one-off recipient or a CC on the invoice email — THIRD_PARTY_SEND_COLUMNS),
 * and not for a complaint-driven
 * visit (owner 2026-08-30, the report's rule: no upsell or referral ask after
 * a callback). The offer is the service report's
 * own composer over the visit the invoice is for; an invoice with no visit,
 * or for a visit whose report never reaches the customer
 * (receiptOfferRecordId), carries the referral card alone.
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

// Owner 2026-11-22, "week": how long after the payment a receipt carries its
// cards and answers their taps.
const RECEIPT_CARD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// No payment time on record reads as outside the window. A payment the
// database clock stamped a moment ahead of this server's clock is inside it.
function withinReceiptCardWindow(paidAt, now = Date.now()) {
  if (!paidAt) return false;
  const paid = new Date(paidAt).getTime();
  return Number.isFinite(paid) && now - paid <= RECEIPT_CARD_WINDOW_MS;
}

// Has this invoice's link already gone to someone other than the account
// holder? The invoice email takes a one-off recipient (an operator naming a
// bookkeeper or a realtor) and CC addresses; each gets the same token, and
// the paid pay page sends its holder on to this receipt. Two records, either
// one closes the cards (pre-push audit 2026-11-22):
//   - the short link invoice-email.js minted for that send carries the
//     third-party marker (payerCodeMarker: purpose 'payer_invoice' for a
//     payer, a recipient that is not the customer's own, or a CC'd copy);
//   - an invoice or receipt email of this invoice has a CC, or went to an
//     address that is not the account holder's email on file now.
// Fail closed: a row counts whether or not its send reached the provider, and
// a customer who changed their email after the invoice went out reads as
// another address. Both lookups use an index (short_codes entity_type +
// entity_id; email_messages trigger_event_id).
const THIRD_PARTY_SEND_COLUMNS = [
  `EXISTS (SELECT 1 FROM short_codes sc
     WHERE sc.entity_type = 'invoices' AND sc.entity_id = i.id AND sc.purpose = 'payer_invoice'
   ) as link_marked_third_party`,
  `EXISTS (SELECT 1 FROM email_messages em
     WHERE em.trigger_event_id IN ('invoice_sent:' || i.id::text, 'invoice_receipt:' || i.id::text)
       AND (em.cc_email_snapshot IS NOT NULL
         OR lower(btrim(em.recipient_email_snapshot)) IS DISTINCT FROM lower(btrim(c.email)))
   ) as link_emailed_to_other_address`,
];

// A callback flagged on ANY service record of the invoice's job (by either
// job link), not only the record the invoice points at.
const JOB_CALLBACK_RECORD_COLUMN = `EXISTS (SELECT 1 FROM service_records x
     WHERE x.is_callback IS TRUE AND x.scheduled_service_id IN (i.scheduled_service_id, sr.scheduled_service_id)
   ) as job_record_is_callback`;

// What eligibility needs, and nothing more. Never InvoiceService.getByToken,
// whose default records a view (a tap is not a view).
function loadReceiptCardRow(where, database = db) {
  const { SERVICE_CONTACT_COLUMNS } = require('./customer-contact');
  return database('invoices as i')
    .leftJoin('customers as c', 'i.customer_id', 'c.id')
    .leftJoin('service_records as sr', 'i.service_record_id', 'sr.id')
    // The job, by either link an invoice carries: its own
    // scheduled_service_id (an invoice made before completion) or the
    // service record's. A job can bill a third party by itself.
    .leftJoin('scheduled_services as ij', 'i.scheduled_service_id', 'ij.id')
    .leftJoin('scheduled_services as rj', 'sr.scheduled_service_id', 'rj.id')
    .leftJoin('notification_prefs as np', 'np.customer_id', 'i.customer_id')
    .where(where)
    .first(
      'i.id', 'i.customer_id', 'i.status', 'i.paid_at', 'i.payer_id', 'i.service_record_id',
      'c.payer_id as customer_payer_id',
      'ij.payer_id as invoice_job_payer_id', 'rj.payer_id as record_job_payer_id',
      'sr.structured_notes as visit_structured_notes', 'sr.customer_id as record_customer_id',
      'c.email as customer_email', 'c.phone as customer_phone',
      'c.first_name as customer_first_name', 'c.company_name as customer_company_name',
      'np.billing_email', 'np.billing_contact_name',
      // A callback is flagged on the service record and on the job; a
      // receipt can reach its job with no service record at all.
      'sr.is_callback as visit_is_callback',
      'ij.is_callback as invoice_job_is_callback', 'rj.is_callback as record_job_is_callback',
      database.raw(JOB_CALLBACK_RECORD_COLUMN),
      ...THIRD_PARTY_SEND_COLUMNS.map((sql) => database.raw(sql)),
      ...SERVICE_CONTACT_COLUMNS.map((col) => `c.${col}`),
    );
}

function loadReceiptCardInvoice(token, database = db) {
  if (typeof token !== 'string' || !token) return null;
  return loadReceiptCardRow({ 'i.token': token }, database);
}

function receiptCardsEligible(row) {
  if (!isEnabled('docCrossSell') || !row?.customer_id || row.status !== 'paid') return false;
  if (!withinReceiptCardWindow(row.paid_at)) return false;
  const { reserviceReportCopyGateOn } = require('./service-report/reservice-report');
  const callback = row.visit_is_callback === true || row.job_record_is_callback === true
    || row.invoice_job_is_callback === true || row.record_job_is_callback === true;
  if (reserviceReportCopyGateOn() && callback) return false;
  // The link already went to someone else (a one-off recipient, a CC).
  if (row.link_marked_third_party === true || row.link_emailed_to_other_address === true) return false;
  // The receipt goes where the receipt email goes: the account holder, or a
  // distinct billing contact (who must not start the plan or enroll as the
  // homeowner's promoter). Same resolver as resolveReceiptEmailRecipient.
  const { getReceiptEmailRecipients } = require('./customer-contact');
  const holder = {
    email: row.customer_email, phone: row.customer_phone,
    first_name: row.customer_first_name, company_name: row.customer_company_name,
  };
  const prefs = { billing_email: row.billing_email, billing_contact_name: row.billing_contact_name };
  if (getReceiptEmailRecipients(holder, prefs).some((r) => r.role !== 'primary')) return false;
  const { linkReachesOnlyAccountHolder } = require('./service-report/cross-sell-tap');
  return linkReachesOnlyAccountHolder(row, [
    row.payer_id, row.customer_payer_id, row.invoice_job_payer_id, row.record_job_payer_id,
  ]);
}

// The visit the receipt's OFFER is built from and tapped against, or null:
// an eligible receipt, for a visit, whose report reaches the customer (an
// office-only report gives no offer; the referral card still shows). The
// visit must be this invoice's own customer's: the tap files its request
// for the visit's customer. One answer for the page, the email line and the
// tap.
function receiptOfferRecordId(row) {
  if (!receiptCardsEligible(row) || !row.service_record_id) return null;
  if (row.record_customer_id !== row.customer_id) return null;
  const { reportSuppressedForCustomer } = require('./service-report/cross-sell-tap');
  return reportSuppressedForCustomer(row.visit_structured_notes) ? null : row.service_record_id;
}

// Best-effort: any failure answers {} and the receipt renders without cards.
async function cardsForReceiptRow(row, database = db) {
  try {
    if (!receiptCardsEligible(row)) return {};
    const cards = {};
    const offerRecordId = receiptOfferRecordId(row);
    if (offerRecordId) {
      const { buildCrossSellForServiceRecord } = require('./service-report/cross-sell-tap');
      const crossSell = await buildCrossSellForServiceRecord(database, offerRecordId);
      if (crossSell) cards.crossSell = crossSell;
    }
    // The customer's own card: with GATE_REFERRAL_STEP2 on, the report's
    // per-customer reward decision.
    const referral = await require('./referral-share').composeReferralCard({ customerId: row.customer_id });
    if (referral) cards.referral = referral;
    return cards;
  } catch (err) {
    logger.warn(`[receipt-cards] cards suppressed (code=${err?.code || 'none'})`);
    return {};
  }
}

async function receiptCardsForToken(token, database = db) {
  if (!isEnabled('docCrossSell')) return {};
  try {
    return await cardsForReceiptRow(await loadReceiptCardInvoice(token, database), database);
  } catch (err) {
    logger.warn(`[receipt-cards] cards suppressed (code=${err?.code || 'none'})`);
    return {};
  }
}

async function receiptCardsForInvoiceId(invoiceId, database = db) {
  if (!isEnabled('docCrossSell') || !invoiceId) return {};
  try {
    return await cardsForReceiptRow(await loadReceiptCardRow({ 'i.id': invoiceId }, database), database);
  } catch (err) {
    logger.warn(`[receipt-cards] cards suppressed (code=${err?.code || 'none'})`);
    return {};
  }
}

module.exports = {
  RECEIPT_CARD_WINDOW_MS,
  loadReceiptCardInvoice,
  receiptCardsEligible,
  receiptOfferRecordId,
  receiptCardsForToken,
  receiptCardsForInvoiceId,
};
