/**
 * Transactional invoice + receipt emails. Layered on top of the existing
 * SMS-only flow (InvoiceService.sendInvoice / .sendReceipt) — does not
 * replace it. Brand-matched HTML with the shared customer CTA and invoice/receipt
 * PDF attached.
 *
 * Uses its own nodemailer transporter (same SMTP settings as email.js) so
 * we can attach PDFs without modifying the thin one-off email wrapper.
 */

const logger = require('./logger');
const db = require('../models/db');
const { buildInvoicePDFBuffer, buildReceiptPDFBuffer } = require('./pdf/invoice-pdf');
const { loadInvoiceAnnualPrepay } = require('./invoice-prepay');
const { wrapEmail, ctaButton, currency, formatDate, plainText } = require('./email-template');
const EmailTemplateLibrary = require('./email-template-library');
const sendgrid = require('./sendgrid-mail');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('./short-url');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { formatDateOnly } = require('../utils/date-only');
const { getInvoiceEmailRecipients, getReceiptEmailRecipients } = require('./customer-contact');
const PayerService = require('./payer');
const { publicPortalUrl } = require('../utils/portal-url');
const { smtpFallbackAllowed } = require('./email-fallback-gate');

let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  if (!process.env.GOOGLE_SMTP_PASSWORD) return null;
  const nodemailer = require('nodemailer');
  cachedTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: 'contact@wavespestcontrol.com',
      pass: process.env.GOOGLE_SMTP_PASSWORD,
    },
  });
  return cachedTransporter;
}

function canFallbackFromTemplateEmailError(err) {
  return /relation .*email_templates.* does not exist|active template not found|template version not found|template not found/i.test(err?.message || '');
}

function pdfAttachment(filename, buffer) {
  return {
    filename,
    content: buffer.toString('base64'),
    type: 'application/pdf',
    disposition: 'attachment',
  };
}

function clean(value) {
  if (value == null) return '';
  return String(value).trim();
}

function cleanEmail(value) {
  return clean(value).toLowerCase();
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value));
}

function publicRecipient(recipient = {}) {
  return {
    email: recipient.email || '',
    name: recipient.name || '',
    role: recipient.role || 'recipient',
  };
}

function appendPayUrlParams(url, params = null) {
  if (!params || typeof params !== 'object') return url;
  try {
    const parsed = new URL(url);
    Object.entries(params).forEach(([key, value]) => {
      if (value == null || value === '') return;
      parsed.searchParams.set(key, String(value));
    });
    return parsed.toString();
  } catch {
    return url;
  }
}

function invoiceRecipientFor(customer, prefs, recipientOverride) {
  const overrideEmail = cleanEmail(recipientOverride?.email);
  if (overrideEmail) {
    if (!isEmailLike(overrideEmail)) {
      return { error: 'Invalid invoice recipient email' };
    }
    return {
      recipient: {
        email: overrideEmail,
        name: clean(recipientOverride?.name).slice(0, 120),
        role: clean(recipientOverride?.role) || 'invoice_override',
      },
    };
  }
  const [recipient] = getInvoiceEmailRecipients(customer, prefs || {});
  return { recipient };
}

async function sendInvoiceEmail(invoiceId, options = {}) {
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice) return { ok: false, error: 'Invoice not found' };
  const customer = await db('customers').where({ id: invoice.customer_id })
    .select('id', 'first_name', 'last_name', 'email', 'phone', 'address_line1', 'city', 'state', 'zip', 'property_type', 'company_name')
    .first();
  if (!customer) return { ok: false, error: 'Customer not found' };
  const prefs = await db('notification_prefs').where({ customer_id: invoice.customer_id }).first().catch(() => null);

  // Third-party Bill-To reroute. When this invoice carries a payer snapshot,
  // attach the payer (for the PDF bill-to block) and — unless the operator
  // passed an explicit one-off override — route the email to the payer's AP
  // inbox automatically. A payer with no usable AP email must NOT fall back to
  // the homeowner billing contact: that would bill the wrong party and expose
  // the third-party bill (PDF + pay link). Instead we fail so the operator can
  // add the payer's AP email (or set an explicit recipient) and resend.
  await PayerService.attachToInvoice(invoice);
  let effectiveOverride = options.recipientOverride || null;
  if (!effectiveOverride && invoice.payer_id) {
    // Keyed on payer_id (the column), NOT the attached object: a payer-billed
    // invoice whose payer can't be attached (no snapshot + live payer
    // inactive/missing) must still route to the payer AP only. Fail CLOSED when
    // no payer recipient resolves — never fall through to the homeowner.
    effectiveOverride = (invoice.payer ? PayerService.payerRecipient(invoice.payer) : null) || null;
    if (!effectiveOverride) {
      logger.warn(`[invoice-email] Payer invoice ${invoice.invoice_number} has no usable AP recipient — not sending (operator must add a payer AP email or specify a recipient).`);
      return { ok: false, error: 'Payer invoice has no usable AP recipient; not sent. Add an AP email to the payer or specify a recipient.' };
    }
  }

  const { recipient, error: recipientError } = invoiceRecipientFor(customer, prefs, effectiveOverride);
  if (recipientError) return { ok: false, error: recipientError };
  if (!recipient?.email) return { ok: false, error: 'No invoice recipient email' };
  const recipientPayload = publicRecipient(recipient);

  // Freeze a one-off operator AP recipient onto the payer snapshot when the
  // payer had no usable AP email of its own, so the (async) receipt and the pay
  // page route to the same AP contact this invoice was actually billed to —
  // otherwise they'd resolve no recipient and the AP would never get a receipt /
  // would see the homeowner prefilled. Only runs on a successful send.
  async function persistPayerApIfNeeded() {
    try {
      const overrideEmail = cleanEmail(options.recipientOverride?.email);
      if (!overrideEmail || !isEmailLike(overrideEmail)) return;
      if (!invoice.payer_id || !invoice.payer) return;
      if (isEmailLike(invoice.payer.ap_email)) return; // payer already carries its own AP email
      if (cleanEmail(recipient.email) !== overrideEmail) return; // we actually sent to the override
      const snap = { ...invoice.payer, ap_email: overrideEmail };
      await db('invoices').where({ id: invoice.id }).update({ payer_snapshot: JSON.stringify(snap) });
      invoice.payer = snap;
    } catch (err) {
      logger.warn(`[invoice-email] payer AP-email persist failed for ${invoice.invoice_number}: ${err.message}`);
    }
  }

  const domain = publicPortalUrl();
  const longPayUrl = appendPayUrlParams(`${domain}/pay/${invoice.token}`, options.payUrlParams);
  const payUrl = await shortenOrPassthrough(longPayUrl, {
    kind: 'invoice',
    entityType: 'invoices',
    entityId: invoice.id,
    customerId: customer.id,
    codePrefix: invoiceShortCodePrefix(invoice),
  });
  const invoiceForPdf = { ...invoice, customer, line_items: invoice.line_items || [] };
  invoiceForPdf.annual_prepay = await loadInvoiceAnnualPrepay(invoiceForPdf);
  let pdfBuffer;
  try {
    pdfBuffer = await buildInvoicePDFBuffer(invoiceForPdf);
  } catch (err) {
    logger.error(`[invoice-email] PDF build failed for ${invoice.invoice_number}: ${err.message}`);
    return { ok: false, error: 'PDF generation failed' };
  }
  const attachmentCountRow = await db('invoice_attachments')
    .where({ invoice_id: invoice.id })
    .count('* as count')
    .first()
    .catch(() => ({ count: 0 }));
  const extraAttachmentCount = Number(attachmentCountRow?.count || 0);

  const first = recipient.name || customer.first_name || 'there';
  const svcType = invoice.service_type || 'your recent service';
  const heading = 'Your invoice from Waves';
  const attachmentNote = extraAttachmentCount > 0
    ? ` ${extraAttachmentCount} additional attachment${extraAttachmentCount === 1 ? ' is' : 's are'} available from the online invoice.`
    : '';
  const intro = `Hi ${first}, thank you for letting us take care of ${svcType}. Your invoice for ${currency(invoice.total)} is ready — the full breakdown is attached as a PDF, and you can pay online in a few taps.${attachmentNote}`;
  const lines = [
    ['Invoice', invoice.invoice_number],
    ['Service', invoice.service_type || '—'],
    invoice.service_date ? ['Service date', formatDateOnly(invoice.service_date)] : null,
    invoice.due_date ? ['Due', formatDateOnly(invoice.due_date)] : null,
    ['Amount due', currency(invoice.total), true],
  ].filter(Boolean);
  const html = wrapEmail({
    preheader: `Invoice ${invoice.invoice_number} — ${currency(invoice.total)} due.`,
    heading,
    intro,
    lines,
    ctaHref: payUrl,
    ctaLabel: `Pay ${currency(invoice.total)}`,
    footerNote: extraAttachmentCount > 0
      ? `Your PDF invoice is attached. Additional invoice attachments are available from the payment link. Reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY} with any questions.`
      : `Your PDF invoice is attached. Reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY} with any questions.`,
  });
  const text = plainText([
    `Hi ${first},`,
    '',
    intro,
    '',
    `Invoice: ${invoice.invoice_number}`,
    invoice.service_type ? `Service: ${invoice.service_type}` : null,
    invoice.due_date ? `Due: ${formatDateOnly(invoice.due_date)}` : null,
    `Amount due: ${currency(invoice.total)}`,
    '',
    `Pay online: ${payUrl}`,
    extraAttachmentCount > 0 ? `${extraAttachmentCount} additional invoice attachment${extraAttachmentCount === 1 ? ' is' : 's are'} available from that link.` : null,
    '',
    `Questions? Reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY}.`,
    '— Waves Pest Control',
  ]);

  if (sendgrid.isConfigured()) {
    try {
      const result = await EmailTemplateLibrary.sendTemplate({
        templateKey: 'invoice.sent',
        to: recipient.email,
        payload: {
          first_name: first,
          invoice_url: payUrl,
          invoice_number: invoice.invoice_number,
          amount_due: currency(invoice.total),
          due_date: invoice.due_date ? formatDateOnly(invoice.due_date) : '',
          service_label: invoice.service_type || '',
          service_date: invoice.service_date ? formatDateOnly(invoice.service_date) : '',
          attachment_note: extraAttachmentCount > 0
            ? `${extraAttachmentCount} additional invoice attachment${extraAttachmentCount === 1 ? ' is' : 's are'} available from the payment link.`
            : 'Your PDF invoice is attached.',
        },
        recipientType: 'customer',
        recipientId: invoice.customer_id || null,
        triggerEventId: `invoice_sent:${invoice.id}`,
        categories: ['invoice_sent'],
        attachments: [pdfAttachment(`invoice-${invoice.invoice_number}.pdf`, pdfBuffer)],
      });
      // A suppressed/blocked recipient (unsubscribed, on the suppression list)
      // resolves with sent:false — it was NOT delivered, so don't report ok:true.
      // Callers that finalize an invoice off `.ok` (e.g. the dispatch
      // payer-completion send, where the homeowner SMS path is suppressed) would
      // otherwise mark a never-delivered invoice as sent.
      if (result?.sent === false) {
        logger.warn(`[invoice-email] Template invoice email NOT delivered for ${invoice.invoice_number} (${result.reason || 'blocked/suppressed'})`);
        return { ok: false, blocked: !!result.blocked, error: result.reason || 'Email suppressed', recipient: recipientPayload };
      }
      await persistPayerApIfNeeded();
      logger.info(`[invoice-email] Template invoice email sent for ${invoice.invoice_number} to ${recipient.role || 'recipient'} ${invoice.customer_id || 'unknown'}`);
      return { ok: true, messageId: result.message?.provider_message_id || null, recipient: recipientPayload, payUrl };
    } catch (err) {
      if (!canFallbackFromTemplateEmailError(err)) {
        logger.error(`[invoice-email] Template send failed for ${invoice.invoice_number}: ${err.message}`);
        return { ok: false, error: err.message, recipient: recipientPayload };
      }
      logger.warn(`[invoice-email] Template unavailable for ${invoice.invoice_number}; falling back to SMTP: ${err.message}`);
    }
  }

  if (!smtpFallbackAllowed()) {
    logger.error(`[invoice-email] SMTP fallback disabled in production for ${invoice.invoice_number} — SendGrid template send required`);
    return { ok: false, error: 'Email send unavailable: SendGrid template path failed and SMTP fallback is disabled in production', recipient: recipientPayload };
  }

  const transporter = getTransporter();
  if (!transporter) return { ok: false, error: 'Email not configured', recipient: recipientPayload };

  try {
    await transporter.sendMail({
      from: '"Waves Pest Control, LLC" <contact@wavespestcontrol.com>',
      to: recipient.email,
      subject: `Invoice ${invoice.invoice_number} — ${currency(invoice.total)}`,
      html,
      text,
      attachments: [{
        filename: `invoice-${invoice.invoice_number}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    });
    await persistPayerApIfNeeded();
    logger.info(`[invoice-email] Invoice email sent for ${invoice.invoice_number} to ${recipient.role || 'recipient'} ${invoice.customer_id || 'unknown'}`);
    return { ok: true, recipient: recipientPayload, payUrl };
  } catch (err) {
    logger.error(`[invoice-email] Send failed for ${invoice.invoice_number}: ${err.message}`);
    return { ok: false, error: err.message, recipient: recipientPayload };
  }
}

async function sendReceiptEmail(invoiceId, options = {}) {
  const memo = typeof options.memo === 'string' ? options.memo.trim().slice(0, 400) : '';
  // Optional dedupe key. Auto-send paths (Stripe webhook) pass one so a
  // retried delivery doesn't email the customer twice; manual operator
  // resends from /admin/invoices intentionally omit it so the operator
  // can always force a fresh send.
  const idempotencyKey = typeof options.idempotencyKey === 'string' && options.idempotencyKey.trim()
    ? options.idempotencyKey.trim()
    : null;
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice) return { ok: false, error: 'Invoice not found' };
  if (invoice.status !== 'paid') return { ok: false, error: 'Invoice not paid' };

  const customer = await db('customers').where({ id: invoice.customer_id })
    .select('id', 'first_name', 'last_name', 'email', 'phone', 'address_line1', 'city', 'state', 'zip', 'property_type', 'company_name')
    .first();
  const prefs = await db('notification_prefs').where({ customer_id: invoice.customer_id }).first().catch(() => null);
  // Third-party Bill-To: a payer-billed receipt may go ONLY to the payer's AP
  // inbox — the receipt PDF/page exposes the payer's payment-method last4, so we
  // never fall back to the homeowner. No usable AP email => no recipient
  // (returned as the standard "No receipt recipient email" skip, which the
  // receipt delivery queue treats as an expected non-actionable skip rather than
  // retrying forever); the operator fixes the AP email.
  await PayerService.attachToInvoice(invoice);
  // Keyed on payer_id (the column), not the attached object: a payer-billed
  // invoice whose payer can't be attached (inactive/missing live payer, no
  // snapshot) must still NEVER fall back to the homeowner (would leak the
  // payer's card last4). No payer recipient → standard no-recipient skip.
  const recipient = invoice.payer_id
    ? (invoice.payer ? PayerService.payerRecipient(invoice.payer) : null)
    : getReceiptEmailRecipients(customer, prefs || {})[0];
  if (!recipient?.email) return { ok: false, error: 'No receipt recipient email' };

  const payment = await db('payments')
    .where({ customer_id: invoice.customer_id })
    .whereIn('status', ['paid', 'refunded'])
    .whereRaw(`metadata::jsonb ->> 'invoice_id' = ?`, [invoice.id])
    .orderBy('created_at', 'desc')
    .first()
    .catch(() => null);

  const domain = publicPortalUrl();
  const longReceiptUrl = `${domain}/receipt/${invoice.token}`;
  const receiptUrl = await shortenOrPassthrough(longReceiptUrl, {
    kind: 'receipt',
    entityType: 'invoices',
    entityId: invoice.id,
    customerId: customer.id,
    codePrefix: invoiceShortCodePrefix(invoice),
  });
  const invoiceForPdf = { ...invoice, customer, line_items: invoice.line_items || [] };
  let pdfBuffer;
  try {
    pdfBuffer = await buildReceiptPDFBuffer(invoiceForPdf, payment);
  } catch (err) {
    logger.error(`[invoice-email] Receipt PDF build failed for ${invoice.invoice_number}: ${err.message}`);
    return { ok: false, error: 'PDF generation failed' };
  }

  const first = recipient.name || customer.first_name || 'there';
  const heading = 'Payment received — thank you';
  const memoEscaped = memo
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const memoHtml = memo
    ? `<div style="margin-top:16px;padding:14px 16px;background:#F8FCFE;border:1px solid #CFE7F5;border-radius:12px;font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.55;color:#3F4A65;white-space:pre-wrap;">${memoEscaped}</div>`
    : '';
  const intro = `Hi ${first}, we received your payment of ${currency(invoice.total)} for invoice ${invoice.invoice_number}. Keep this email as your record — a printable receipt is attached, and the online copy lives at the link below for whenever you need it.`;
  const introWithMemo = memoHtml ? `${intro}${memoHtml}` : intro;
  const cardText = (payment?.card_brand && payment?.card_last_four)
    ? `${payment.card_brand.toUpperCase()} ···· ${payment.card_last_four}`
    : (invoice.card_brand && invoice.card_last_four)
      ? `${invoice.card_brand.toUpperCase()} ···· ${invoice.card_last_four}`
      : null;
  const lines = [
    ['Invoice', invoice.invoice_number],
    invoice.service_type ? ['Service', invoice.service_type] : null,
    ['Paid', formatDate(invoice.paid_at)],
    cardText ? ['Method', cardText] : null,
    ['Amount paid', currency(invoice.total), true],
  ].filter(Boolean);
  const html = wrapEmail({
    preheader: `Receipt for ${invoice.invoice_number} — ${currency(invoice.total)} paid.`,
    heading,
    intro: introWithMemo,
    lines,
    ctaHref: receiptUrl,
    ctaLabel: 'View receipt online',
    footerNote: 'Your PDF receipt is attached for bookkeeping. Keep this email for your records.',
  });
  const text = plainText([
    `Hi ${first},`,
    '',
    intro,
    memo ? '' : null,
    memo ? `Note from Waves: ${memo}` : null,
    '',
    `Invoice: ${invoice.invoice_number}`,
    `Paid: ${formatDate(invoice.paid_at)}`,
    cardText ? `Method: ${cardText}` : null,
    `Amount: ${currency(invoice.total)}`,
    '',
    `View receipt online: ${receiptUrl}`,
    '',
    '— Waves Pest Control',
  ]);

  if (sendgrid.isConfigured()) {
    try {
      const result = await EmailTemplateLibrary.sendTemplate({
        templateKey: 'invoice.receipt',
        to: recipient.email,
        payload: {
          first_name: first,
          receipt_url: receiptUrl,
          invoice_number: invoice.invoice_number,
          amount_paid: currency(invoice.total),
          paid_at: invoice.paid_at ? formatDate(invoice.paid_at) : '',
          service_label: invoice.service_type || '',
          payment_method: cardText || '',
          memo: memo ? `Note from Waves: ${memo}` : '',
        },
        recipientType: 'customer',
        recipientId: invoice.customer_id || null,
        triggerEventId: `invoice_receipt:${invoice.id}`,
        idempotencyKey,
        categories: ['invoice_receipt'],
        attachments: [pdfAttachment(`receipt-${invoice.invoice_number}.pdf`, pdfBuffer)],
      });
      if (result?.blocked) {
        return { ok: false, error: result.reason || 'Email suppressed', blocked: true };
      }
      if (result?.deduped) {
        logger.info(`[invoice-email] Receipt email deduped for ${invoice.invoice_number} (idempotencyKey=${idempotencyKey})`);
        return { ok: true, deduped: true, messageId: result.message?.provider_message_id || null };
      }
      logger.info(`[invoice-email] Template receipt email sent for ${invoice.invoice_number} to ${recipient.role || 'recipient'} ${invoice.customer_id || 'unknown'}`);
      return { ok: true, messageId: result.message?.provider_message_id || null };
    } catch (err) {
      if (!canFallbackFromTemplateEmailError(err)) {
        logger.error(`[invoice-email] Template receipt send failed for ${invoice.invoice_number}: ${err.message}`);
        return { ok: false, error: err.message };
      }
      logger.warn(`[invoice-email] Template unavailable for receipt ${invoice.invoice_number}; falling back to SMTP: ${err.message}`);
    }
  }

  if (!smtpFallbackAllowed()) {
    logger.error(`[invoice-email] SMTP fallback disabled in production for receipt ${invoice.invoice_number} — SendGrid template send required`);
    return { ok: false, error: 'Email send unavailable: SendGrid template path failed and SMTP fallback is disabled in production' };
  }

  const transporter = getTransporter();
  if (!transporter) return { ok: false, error: 'Email not configured' };

  try {
    await transporter.sendMail({
      from: '"Waves Pest Control, LLC" <contact@wavespestcontrol.com>',
      to: recipient.email,
      subject: `Receipt for ${invoice.invoice_number} — ${currency(invoice.total)}`,
      html,
      text,
      attachments: [{
        filename: `receipt-${invoice.invoice_number}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    });
    logger.info(`[invoice-email] Receipt email sent for ${invoice.invoice_number} to ${recipient.role || 'recipient'} ${invoice.customer_id || 'unknown'}`);
    return { ok: true };
  } catch (err) {
    logger.error(`[invoice-email] Receipt send failed for ${invoice.invoice_number}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  sendInvoiceEmail,
  sendReceiptEmail,
  _private: {
    invoiceRecipientFor,
    isEmailLike,
  },
};
