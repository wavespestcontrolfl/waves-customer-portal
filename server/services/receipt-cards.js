/**
 * The add-a-service card and the referral card on a paid receipt
 * (GATE_DOC_CROSS_SELL, owner 2026-11-21): when the receipt shows them. One
 * home for the receipt page (routes/receipt-v2.js) and the receipt email's
 * line (invoice-email.js), so the email never names a card the page will not
 * show.
 *
 * The cards are links into the Waves app and nothing on the receipt acts
 * (services/app-link-cards.js). These are display rules.
 *
 * Shown: a PAID invoice, for 7 days after its payment (owner 2026-11-22,
 * "week": a receipt link never expires; after day 7 it is a plain receipt,
 * with no card and no email line), not for a complaint-driven visit (owner
 * 2026-08-30, the report's rule: no upsell or referral ask after a callback),
 * and only on an account whose receipt goes to the account holder: no
 * third-party payer on the invoice, the job or the account, no service
 * contact on the account (linkReachesOnlyAccountHolder), and no distinct
 * billing contact (the receipt email's own resolver,
 * getReceiptEmailRecipients).
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

// Owner 2026-11-22, "week": how long after the payment a receipt carries its
// cards.
const RECEIPT_CARD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// No payment time on record reads as outside the window. A payment the
// database clock stamped a moment ahead of this server's clock is inside it.
function withinReceiptCardWindow(paidAt, now = Date.now()) {
  if (!paidAt) return false;
  const paid = new Date(paidAt).getTime();
  return Number.isFinite(paid) && now - paid <= RECEIPT_CARD_WINDOW_MS;
}

// A callback flagged on ANY service record of the invoice's job (by either
// job link), not only the record the invoice points at.
const JOB_CALLBACK_RECORD_COLUMN = `EXISTS (SELECT 1 FROM service_records x
     WHERE x.is_callback IS TRUE AND x.scheduled_service_id IN (i.scheduled_service_id, sr.scheduled_service_id)
   ) as job_record_is_callback`;

// What eligibility needs, and nothing more. Never InvoiceService.getByToken,
// whose default records a view (the email line's read is not a view).
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
      'i.id', 'i.customer_id', 'i.status', 'i.paid_at', 'i.payer_id',
      'c.payer_id as customer_payer_id',
      'ij.payer_id as invoice_job_payer_id', 'rj.payer_id as record_job_payer_id',
      'c.email as customer_email', 'c.phone as customer_phone',
      'c.first_name as customer_first_name', 'c.company_name as customer_company_name',
      'np.billing_email', 'np.billing_contact_name',
      // A callback is flagged on the service record and on the job; a
      // receipt can reach its job with no service record at all.
      'sr.is_callback as visit_is_callback',
      'ij.is_callback as invoice_job_is_callback', 'rj.is_callback as record_job_is_callback',
      database.raw(JOB_CALLBACK_RECORD_COLUMN),
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
  // The receipt goes where the receipt email goes: the account holder, or a
  // distinct billing contact. Same resolver as resolveReceiptEmailRecipient.
  const { getReceiptEmailRecipients } = require('./customer-contact');
  const holder = {
    email: row.customer_email, phone: row.customer_phone,
    first_name: row.customer_first_name, company_name: row.customer_company_name,
  };
  const prefs = { billing_email: row.billing_email, billing_contact_name: row.billing_contact_name };
  if (getReceiptEmailRecipients(holder, prefs).some((r) => r.role !== 'primary')) return false;
  const { linkReachesOnlyAccountHolder } = require('./app-link-cards');
  return linkReachesOnlyAccountHolder(row, [
    row.payer_id, row.customer_payer_id, row.invoice_job_payer_id, row.record_job_payer_id,
  ]);
}

// Best-effort: any failure answers {} and the receipt renders without cards.
async function cardsForReceiptRow(row, database = db) {
  try {
    if (!receiptCardsEligible(row)) return {};
    return await require('./app-link-cards').appLinkCardsForCustomer(row.customer_id, database);
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
  receiptCardsEligible,
  receiptCardsForToken,
  receiptCardsForInvoiceId,
};
