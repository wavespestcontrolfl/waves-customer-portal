/**
 * The add-a-service + referral cards on a paid receipt (GATE_DOC_CROSS_SELL,
 * owner 2026-11-21) — who may see them and what they carry. One home for the
 * receipt page (routes/receipt-v2.js) and the receipt email's pointer line
 * (invoice-email.js), so the email never promises a card the page won't show.
 *
 * Eligible: a PAID invoice whose link reaches the account holder alone (no
 * third-party payer on the invoice or the account, no service contact on the
 * account — linkReachesOnlyAccountHolder), and not for a complaint-driven
 * visit (owner 2026-08-30, the report's rule: no upsell or referral ask after
 * a callback). The offer is the service report's
 * own composer over the visit the invoice is for; an invoice with no visit
 * carries the referral card alone.
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

// What eligibility needs, and nothing more. Never InvoiceService.getByToken,
// whose default records a view (a tap is not a view).
function loadReceiptCardRow(where, database = db) {
  const { SERVICE_CONTACT_COLUMNS } = require('./customer-contact');
  return database('invoices as i')
    .leftJoin('customers as c', 'i.customer_id', 'c.id')
    .leftJoin('service_records as sr', 'i.service_record_id', 'sr.id')
    .where(where)
    .first(
      'i.id', 'i.customer_id', 'i.status', 'i.payer_id', 'i.service_record_id',
      'c.payer_id as customer_payer_id',
      'sr.is_callback as visit_is_callback',
      ...SERVICE_CONTACT_COLUMNS.map((col) => `c.${col}`),
    );
}

function loadReceiptCardInvoice(token, database = db) {
  if (typeof token !== 'string' || !token) return null;
  return loadReceiptCardRow({ 'i.token': token }, database);
}

function receiptCardsEligible(row) {
  if (!isEnabled('docCrossSell') || !row?.customer_id || row.status !== 'paid') return false;
  const { reserviceReportCopyGateOn } = require('./service-report/reservice-report');
  if (reserviceReportCopyGateOn() && row.visit_is_callback === true) return false;
  const { linkReachesOnlyAccountHolder } = require('./service-report/cross-sell-tap');
  return linkReachesOnlyAccountHolder(row, [row.payer_id, row.customer_payer_id]);
}

// Best-effort: any failure answers {} and the receipt renders without cards.
async function cardsForReceiptRow(row, database = db) {
  try {
    if (!receiptCardsEligible(row)) return {};
    const cards = {};
    if (row.service_record_id) {
      const { buildCrossSellForServiceRecord } = require('./service-report/cross-sell-tap');
      const crossSell = await buildCrossSellForServiceRecord(database, row.service_record_id);
      if (crossSell) cards.crossSell = crossSell;
    }
    const referral = await require('./referral-share').composeReferralCard();
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
  loadReceiptCardInvoice,
  receiptCardsEligible,
  receiptCardsForToken,
  receiptCardsForInvoiceId,
};
