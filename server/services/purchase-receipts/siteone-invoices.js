/**
 * purchase-receipts/siteone-invoices.js — SiteOne invoice emails -> invoice
 * lines for the stock sweep (sweep.js records them).
 *
 * The same SiteOne invoice PDF arrives twice: the store's "SiteOne
 * Confirmation : Invoice #N" (from *@siteone.com) and the billing copy
 * ("...Your Invoice From SiteOne...", from siteoneus@billtrust.com). Its
 * lines are read by the existing vendor-invoice pipeline
 * (email/invoice-processor.js), an AI extraction stored on
 * email_attachments.extracted_data. That extraction only proposes lines: an
 * invoice moves stock only when its numbers reconcile — every line's
 * quantity x unit price is its total, the lines sum to the subtotal, the
 * subtotal plus tax is the total — and its invoice number is the one the
 * email itself names (the store email's subject, the billing email's body).
 * Any other invoice holds each line that would move stock as 'unverified'.
 * An invoice never read into lines within EXTRACTION_GRACE_MS gets one
 * 'unreadable' placeholder line. Matching and sizing are the Amazon lane's
 * (receipt-processor.js); SiteOne descriptions carry the container size
 * ("... 78 fl oz. Bottle (QGCY) UOM:EA").
 */
const db = require('../../models/db');

const VENDOR = 'siteone';
const STORE_DOMAIN = '@siteone.com';
const BILLING_FROM = 'siteoneus@billtrust.com';
const INVOICE_NUMBER_RE = /\b(\d{9}-\d{3})\b/;
const MONEY_TOLERANCE = 0.02;
const EXTRACTION_GRACE_MS = 2 * 60 * 60 * 1000;
const EMAIL_COLUMNS = ['id', 'gmail_id', 'from_address', 'subject', 'body_text', 'body_html', 'received_at', 'authentication_results'];

function isSiteOneInvoiceEmail(email) {
  const from = String(email?.from_address || '').trim().toLowerCase();
  const subject = String(email?.subject || '');
  return (from.endsWith(STORE_DOMAIN) && /^siteone confirmation\s*:\s*invoice\s*#/i.test(subject))
    || (from === BILLING_FROM && /your invoice from siteone/i.test(subject));
}

// Candidate invoice emails received at or after `floor`; isSiteOneInvoiceEmail
// is the exact test.
function findSiteOneInvoiceEmails(floor, conn = db) {
  return conn('emails').select(EMAIL_COLUMNS)
    .where((either) => either
      .where((store) => store.whereRaw('LOWER(from_address) LIKE ?', [`%${STORE_DOMAIN}`]).whereRaw('subject ILIKE ?', ['SiteOne Confirmation%Invoice%']))
      .orWhere((billing) => billing.whereRaw('LOWER(from_address) = ?', [BILLING_FROM]).whereRaw('subject ILIKE ?', ['%Your Invoice From SiteOne%'])))
    .where('received_at', '>=', floor)
    .orderBy('received_at', 'asc');
}

// The invoice number the email itself names: the store email's subject, or
// the billing email's body (an HTML table cell).
function emailInvoiceNumber(email) {
  const fromSubject = String(email.subject || '').match(/invoice\s*#\s*(\d{9}-\d{3})/i);
  if (fromSubject) return fromSubject[1];
  const body = `${email.body_text || ''} ${String(email.body_html || '').replace(/<[^>]+>/g, ' ')}`;
  return (body.match(INVOICE_NUMBER_RE) || [])[1] || null;
}

const moneyClose = (a, b) => Math.abs(Number(a) - Number(b)) <= MONEY_TOLERANCE;

// null when the extraction's lines reconcile with themselves and it names the
// email's own invoice number; otherwise which check failed.
function verificationProblem(extracted, invoiceNumber) {
  const lines = extracted.line_items;
  if (extracted.invoice_number !== invoiceNumber) return 'invoice_number';
  if (!lines.every((line) => moneyClose(Number(line.quantity) * Number(line.unit_price), line.total))) return 'line_math';
  if (!moneyClose(lines.reduce((sum, line) => sum + Number(line.total), 0), extracted.subtotal)) return 'subtotal';
  if (!moneyClose(Number(extracted.subtotal) + Number(extracted.tax || 0), extracted.total)) return 'total';
  return null;
}

async function invoiceExtraction(emailId, conn) {
  const attachment = await conn('email_attachments').where({ email_id: emailId, is_invoice: true })
    .whereNotNull('extracted_data').first('extracted_data');
  const data = attachment?.extracted_data;
  if (typeof data !== 'string') return data || null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<null | {pending: true} | {number, problem, lines}>}
 *   null: the email names no invoice number (nothing to key it by).
 *   pending: not read into lines yet, still inside the grace window.
 *   problem: null (use the lines), 'unreadable' (never read, or read with
 *   no usable lines), or the failed check.
 *   lines: [{ title, quantity, lineNo }] — lineNo is the invoice line's own
 *   position, so both copies of an invoice key the same line the same way.
 */
async function readSiteOneInvoice(email, now = Date.now(), conn = db) {
  const number = emailInvoiceNumber(email);
  if (!number) return null;
  const extracted = await invoiceExtraction(email.id, conn);
  if (!extracted) {
    return now - new Date(email.received_at).getTime() < EXTRACTION_GRACE_MS ? { pending: true } : { number, problem: 'unreadable', lines: [] };
  }
  if (!Array.isArray(extracted.line_items) || !extracted.line_items.length) return { number, problem: 'unreadable', lines: [] };
  const problem = verificationProblem(extracted, number);
  const lines = extracted.line_items.map((line, index) => ({
    title: String(line.description || ''), quantity: Number(line.quantity), lineNo: index + 1,
  }));
  return { number, problem, lines };
}

module.exports = { VENDOR, isSiteOneInvoiceEmail, findSiteOneInvoiceEmails, readSiteOneInvoice, verificationProblem, emailInvoiceNumber };
