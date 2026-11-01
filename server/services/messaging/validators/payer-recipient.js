/**
 * Payer-recipient validator — the identity rule for purpose
 * `payer_payment_link` (GATE_PAYER_INVOICE_SMS, owner 2026-11-01).
 *
 * A payer-billed invoice's pay link may be texted only to the ACTIVE payer's
 * ap_phone for that invoice's payer_id. The recipient is not the customer, so
 * the customer-phone identity of `payment_link` cannot prove it; this does:
 *
 *   - the invoice is read FRESH (id, customer, payer, status, statement);
 *   - the input's customerId is the invoice's customer (the timeline owner);
 *   - invoice.payer_id names a payer that is still active;
 *   - the recipient's last ten digits equal that payer's ap_phone.
 *
 * It runs twice, from the same code: as a pipeline step, and again in the
 * provider-boundary check so a payer edited or deactivated while the send was
 * being prepared is refused before Twilio. Fail closed: an unreadable row is a
 * retryable refusal, never a pass. The customer's own phone never qualifies
 * unless it is also the payer's AP phone.
 */

const db = require('../../../models/db');
const logger = require('../../logger');
const { SEND_FINALIZABLE_STATUSES, invoiceAmountDue, invoiceWithdrawnFromCustomer } = require('../../invoice-helpers');

const last10 = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
};

/**
 * Why an invoice row cannot have its pay link texted to the payer, or null.
 * Shared with services/payer-invoice-sms.js so the sender's early skip and the
 * boundary check never disagree.
 */
function payerTextInvoiceProblem(invoice) {
  if (!invoice) return { code: 'INVOICE_NOT_FOUND', reason: 'Invoice not found' };
  if (!invoice.payer_id) return { code: 'NOT_PAYER_INVOICE', reason: 'Invoice is not billed to a third-party payer' };
  if (invoice.payer_statement_id) {
    return { code: 'STATEMENT_ACCRUED', reason: 'Invoice is billed on the payer\'s monthly statement' };
  }
  if (invoiceWithdrawnFromCustomer(invoice)) {
    return { code: 'INVOICE_WITHDRAWN', reason: 'Invoice was withdrawn from the customer' };
  }
  if (!SEND_FINALIZABLE_STATUSES.includes(String(invoice.status || '').toLowerCase())) {
    return { code: 'INVOICE_NOT_OPEN', reason: `Invoice is ${invoice.status || 'not open'}; there is nothing to pay` };
  }
  if (invoiceAmountDue(invoice) <= 0) return { code: 'INVOICE_NOT_OPEN', reason: 'Invoice has no balance due' };
  return null;
}

const BLOCK = (code, reason, extra = {}) => ({ ok: false, code, reason, deliveryOutcome: 'not_sent', ...extra });

/**
 * @param {import('../policy').SendCustomerMessageInput} input
 * @param {Object} policy
 * @param {Object} [dbh] - the handoff's held transaction when run at the provider boundary
 */
async function checkPayerRecipient(input, policy, dbh = db) {
  if (!policy || policy.requirePayerPhoneMatch !== true) return { ok: true };
  const to = last10(input.to);
  if (!to) return BLOCK('PAYER_RECIPIENT_MISMATCH', 'Recipient is not a valid US phone number');
  let invoice;
  let payer;
  try {
    invoice = await dbh('invoices').where({ id: input.invoiceId })
      .first('id', 'customer_id', 'payer_id', 'payer_statement_id', 'status', 'total', 'credit_applied', 'amount_paid', 'scheduled_send_error');
    payer = invoice && invoice.payer_id
      ? await dbh('payers').where({ id: invoice.payer_id }).first('id', 'active', 'ap_phone')
      : null;
  } catch (err) {
    if (dbh.isTransaction) throw err; // a required handoff read: an aborted transaction cannot authorize a send
    logger.warn(`[messaging:payer-recipient] lookup failed: ${err.message}`);
    return BLOCK('PAYER_RECIPIENT_LOOKUP_FAILED', 'Could not re-read the invoice payer', { retryable: true });
  }
  const problem = payerTextInvoiceProblem(invoice);
  if (problem) return BLOCK(problem.code, problem.reason);
  if (String(invoice.customer_id) !== String(input.customerId)) {
    return BLOCK('PAYER_RECIPIENT_MISMATCH', 'Invoice belongs to a different customer');
  }
  if (!payer || payer.active === false) return BLOCK('PAYER_INACTIVE', 'The invoice payer is missing or inactive');
  const apPhone = last10(payer.ap_phone);
  if (!apPhone) return BLOCK('PAYER_PHONE_MISSING', 'The invoice payer has no usable AP phone');
  if (apPhone !== to) return BLOCK('PAYER_RECIPIENT_MISMATCH', 'Recipient is not the invoice payer\'s AP phone');
  return { ok: true };
}

module.exports = { checkPayerRecipient, payerTextInvoiceProblem, last10 };
