/**
 * Transactional invoice + receipt emails. Layered on top of the existing
 * SMS-only flow (InvoiceService.sendInvoice / .sendReceipt) — does not
 * replace it. Brand-matched HTML with a gold CTA and the invoice/receipt
 * PDF attached.
 *
 * Uses its own nodemailer transporter (same SMTP settings as email.js) so
 * we can attach PDFs without modifying the thin one-off email wrapper.
 */

const logger = require('./logger');
const db = require('../models/db');
const { buildInvoicePDFBuffer, buildReceiptPDFBuffer } = require('./pdf/invoice-pdf');
const { wrapEmail, ctaButton, currency, formatDate, plainText } = require('./email-template');
const EmailTemplateLibrary = require('./email-template-library');
const sendgrid = require('./sendgrid-mail');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('./short-url');
const { formatDateOnly } = require('../utils/date-only');

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

async function sendInvoiceEmail(invoiceId) {
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice) return { ok: false, error: 'Invoice not found' };
  const customer = await db('customers').where({ id: invoice.customer_id })
    .select('id', 'first_name', 'last_name', 'email', 'phone', 'address_line1', 'city', 'state', 'zip', 'property_type', 'company_name')
    .first();
  if (!customer?.email) return { ok: false, error: 'No customer email' };

  const domain = process.env.PORTAL_DOMAIN || 'https://portal.wavespestcontrol.com';
  const longPayUrl = `${domain}/pay/${invoice.token}`;
  const payUrl = await shortenOrPassthrough(longPayUrl, {
    kind: 'invoice',
    entityType: 'invoices',
    entityId: invoice.id,
    customerId: customer.id,
    codePrefix: invoiceShortCodePrefix(invoice),
  });
  const invoiceForPdf = { ...invoice, customer, line_items: invoice.line_items || [] };
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

  const first = customer.first_name || 'there';
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
      ? 'Your PDF invoice is attached. Additional invoice attachments are available from the payment link. Reply to this email or call (941) 318-7612 with any questions.'
      : 'Your PDF invoice is attached. Reply to this email or call (941) 318-7612 with any questions.',
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
    'Questions? Reply to this email or call (941) 318-7612.',
    '— Waves Pest Control',
  ]);

  if (sendgrid.isConfigured()) {
    try {
      const result = await EmailTemplateLibrary.sendTemplate({
        templateKey: 'invoice.sent',
        to: customer.email,
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
      logger.info(`[invoice-email] Template invoice email sent for ${invoice.invoice_number} to customer ${invoice.customer_id || 'unknown'}`);
      return { ok: true, messageId: result.message?.provider_message_id || null };
    } catch (err) {
      if (!canFallbackFromTemplateEmailError(err)) {
        logger.error(`[invoice-email] Template send failed for ${invoice.invoice_number}: ${err.message}`);
        return { ok: false, error: err.message };
      }
      logger.warn(`[invoice-email] Template unavailable for ${invoice.invoice_number}; falling back to SMTP: ${err.message}`);
    }
  }

  const transporter = getTransporter();
  if (!transporter) return { ok: false, error: 'Email not configured' };

  try {
    await transporter.sendMail({
      from: '"Waves Pest Control, LLC" <contact@wavespestcontrol.com>',
      to: customer.email,
      subject: `Invoice ${invoice.invoice_number} — ${currency(invoice.total)}`,
      html,
      text,
      attachments: [{
        filename: `invoice-${invoice.invoice_number}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    });
    logger.info(`[invoice-email] Invoice email sent for ${invoice.invoice_number} to customer ${invoice.customer_id || 'unknown'}`);
    return { ok: true };
  } catch (err) {
    logger.error(`[invoice-email] Send failed for ${invoice.invoice_number}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function sendReceiptEmail(invoiceId, options = {}) {
  const memo = typeof options.memo === 'string' ? options.memo.trim().slice(0, 400) : '';
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice) return { ok: false, error: 'Invoice not found' };
  if (invoice.status !== 'paid') return { ok: false, error: 'Invoice not paid' };

  const customer = await db('customers').where({ id: invoice.customer_id })
    .select('id', 'first_name', 'last_name', 'email', 'phone', 'address_line1', 'city', 'state', 'zip', 'property_type', 'company_name')
    .first();
  if (!customer?.email) return { ok: false, error: 'No customer email' };

  const payment = await db('payments')
    .where({ customer_id: invoice.customer_id })
    .whereIn('status', ['paid', 'refunded'])
    .whereRaw(`metadata::jsonb ->> 'invoice_id' = ?`, [invoice.id])
    .orderBy('created_at', 'desc')
    .first()
    .catch(() => null);

  const domain = process.env.PORTAL_DOMAIN || 'https://portal.wavespestcontrol.com';
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

  const first = customer.first_name || 'there';
  const heading = 'Payment received — thank you';
  const memoEscaped = memo
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const memoHtml = memo
    ? `<div style="margin-top:16px;padding:14px 16px;background:#FDF6EC;border-left:3px solid #009CDE;border-radius:4px;font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.55;color:#334155;white-space:pre-wrap;">${memoEscaped}</div>`
    : '';
  const intro = `Hi ${first}, we received your payment of ${currency(invoice.total)} for invoice ${invoice.invoice_number}. Keep this email as your record — a printable receipt is attached, and the online copy lives at the link below for whenever you need it.${memoHtml ? '' : ''}`;
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
        to: customer.email,
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
        categories: ['invoice_receipt'],
        attachments: [pdfAttachment(`receipt-${invoice.invoice_number}.pdf`, pdfBuffer)],
      });
      logger.info(`[invoice-email] Template receipt email sent for ${invoice.invoice_number} to customer ${invoice.customer_id || 'unknown'}`);
      return { ok: true, messageId: result.message?.provider_message_id || null };
    } catch (err) {
      if (!canFallbackFromTemplateEmailError(err)) {
        logger.error(`[invoice-email] Template receipt send failed for ${invoice.invoice_number}: ${err.message}`);
        return { ok: false, error: err.message };
      }
      logger.warn(`[invoice-email] Template unavailable for receipt ${invoice.invoice_number}; falling back to SMTP: ${err.message}`);
    }
  }

  const transporter = getTransporter();
  if (!transporter) return { ok: false, error: 'Email not configured' };

  try {
    await transporter.sendMail({
      from: '"Waves Pest Control, LLC" <contact@wavespestcontrol.com>',
      to: customer.email,
      subject: `Receipt for ${invoice.invoice_number} — ${currency(invoice.total)}`,
      html,
      text,
      attachments: [{
        filename: `receipt-${invoice.invoice_number}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    });
    logger.info(`[invoice-email] Receipt email sent for ${invoice.invoice_number} to customer ${invoice.customer_id || 'unknown'}`);
    return { ok: true };
  } catch (err) {
    logger.error(`[invoice-email] Receipt send failed for ${invoice.invoice_number}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendInvoiceEmail, sendReceiptEmail };
