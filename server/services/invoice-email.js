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

// Brand colors — mirrors client/src/theme-brand.js
const NAVY = '#1B2C5B';
const WAVES_BLUE = '#009CDE';
const GOLD = '#FFD700';
const INK = '#0F172A';
const BODY = '#334155';
const MUTED = '#64748B';
const SAND = '#FDF6EC';
const CARD = '#FFFFFF';
const RULE = '#E2E8F0';

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

function currency(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(typeof d === 'string' ? (d.length === 10 ? d + 'T12:00:00' : d) : d);
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

// Gold CTA with navy 3D-offset shadow — matches theme-brand.js GOLD_CTA identity.
// Shadow uses <!--[if mso]>...<![endif]--> fallback for Outlook.
function ctaButton(href, label) {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
      <tr>
        <td style="border-radius:12px;background:${GOLD};border:2px solid ${NAVY};box-shadow:4px 4px 0 ${NAVY};">
          <a href="${href}" style="display:inline-block;padding:16px 28px;font-family:Inter,Arial,sans-serif;font-size:16px;font-weight:800;color:${NAVY};text-decoration:none;text-transform:uppercase;letter-spacing:0.03em;line-height:1;">
            ${label}
          </a>
        </td>
      </tr>
    </table>
  `;
}

function wrapEmail({ preheader, heading, intro, lines, ctaHref, ctaLabel, footerNote }) {
  const linesHtml = (lines || []).map(([label, value, emphasis]) => `
    <tr>
      <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:${MUTED};">${label}</td>
      <td align="right" style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:${INK};font-weight:${emphasis ? '700' : '500'};">${value}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Waves Pest Control</title>
</head>
<body style="margin:0;padding:0;background:${SAND};font-family:Inter,Arial,sans-serif;color:${BODY};">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;color:${SAND};">${preheader}</div>` : ''}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${SAND};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:560px;background:${CARD};border-radius:16px;overflow:hidden;box-shadow:0 10px 24px rgba(27,44,91,.08);">
        <tr><td style="background:${NAVY};padding:28px 32px;">
          <div style="font-family:Inter,Arial,sans-serif;color:#fff;font-size:22px;font-weight:800;letter-spacing:0.04em;">WAVES</div>
          <div style="font-family:Inter,Arial,sans-serif;color:#B8D4EA;font-size:10px;letter-spacing:0.2em;margin-top:4px;">PEST CONTROL &amp; LAWN CARE</div>
        </td></tr>
        <tr><td style="padding:36px 32px 8px 32px;">
          <h1 style="margin:0 0 16px 0;font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:28px;line-height:1.15;color:${INK};font-weight:400;">${heading}</h1>
          <div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.55;color:${BODY};">
            ${intro}
          </div>
        </td></tr>
        ${linesHtml ? `
        <tr><td style="padding:20px 32px 4px 32px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid ${RULE};padding-top:8px;">
            ${linesHtml}
          </table>
        </td></tr>` : ''}
        ${ctaHref && ctaLabel ? `
        <tr><td align="center" style="padding:28px 32px;">
          ${ctaButton(ctaHref, ctaLabel)}
        </td></tr>` : ''}
        <tr><td style="padding:0 32px 28px 32px;">
          <div style="font-family:Inter,Arial,sans-serif;font-size:13px;line-height:1.55;color:${MUTED};">
            ${footerNote || 'Questions? Reply to this email or call <a href="tel:+19413187612" style="color:' + WAVES_BLUE + ';text-decoration:none;">(941) 318-7612</a>.'}
          </div>
        </td></tr>
        <tr><td style="background:${SAND};padding:20px 32px;border-top:1px solid ${RULE};">
          <div style="font-family:Inter,Arial,sans-serif;font-size:11px;color:${MUTED};line-height:1.55;">
            Waves Pest Control, LLC · 13649 Luxe Ave #110, Bradenton, FL 34211 · FL License #JF336375
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function plainText(lines) {
  return lines.filter(Boolean).join('\n');
}

async function sendInvoiceEmail(invoiceId) {
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice) return { ok: false, error: 'Invoice not found' };
  const customer = await db('customers').where({ id: invoice.customer_id })
    .select('first_name', 'last_name', 'email', 'phone', 'address_line1', 'city', 'state', 'zip')
    .first();
  if (!customer?.email) return { ok: false, error: 'No customer email' };

  const transporter = getTransporter();
  if (!transporter) return { ok: false, error: 'Email not configured' };

  const domain = process.env.PORTAL_DOMAIN || 'https://portal.wavespestcontrol.com';
  const payUrl = `${domain}/pay/${invoice.token}`;
  const invoiceForPdf = { ...invoice, customer, line_items: invoice.line_items || [] };
  let pdfBuffer;
  try {
    pdfBuffer = await buildInvoicePDFBuffer(invoiceForPdf);
  } catch (err) {
    logger.error(`[invoice-email] PDF build failed for ${invoice.invoice_number}: ${err.message}`);
    return { ok: false, error: 'PDF generation failed' };
  }

  const first = customer.first_name || 'there';
  const svcType = invoice.service_type || 'your recent service';
  const heading = 'Your invoice from Waves';
  const intro = `Hi ${first}, thank you for letting us take care of ${svcType}. Your invoice for ${currency(invoice.total)} is ready — the full breakdown is attached as a PDF, and you can pay online in a few taps.`;
  const lines = [
    ['Invoice', invoice.invoice_number],
    ['Service', invoice.service_type || '—'],
    invoice.service_date ? ['Service date', formatDate(invoice.service_date)] : null,
    invoice.due_date ? ['Due', formatDate(invoice.due_date)] : null,
    ['Amount due', currency(invoice.total), true],
  ].filter(Boolean);
  const html = wrapEmail({
    preheader: `Invoice ${invoice.invoice_number} — ${currency(invoice.total)} due.`,
    heading,
    intro,
    lines,
    ctaHref: payUrl,
    ctaLabel: `Pay ${currency(invoice.total)}`,
    footerNote: 'Your PDF invoice is attached. Reply to this email or call (941) 318-7612 with any questions.',
  });
  const text = plainText([
    `Hi ${first},`,
    '',
    intro,
    '',
    `Invoice: ${invoice.invoice_number}`,
    invoice.service_type ? `Service: ${invoice.service_type}` : null,
    invoice.due_date ? `Due: ${formatDate(invoice.due_date)}` : null,
    `Amount due: ${currency(invoice.total)}`,
    '',
    `Pay online: ${payUrl}`,
    '',
    'Questions? Reply to this email or call (941) 318-7612.',
    '— Waves Pest Control',
  ]);

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
    logger.info(`[invoice-email] Invoice email sent for ${invoice.invoice_number} to ${customer.email}`);
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
    .select('first_name', 'last_name', 'email', 'phone', 'address_line1', 'city', 'state', 'zip')
    .first();
  if (!customer?.email) return { ok: false, error: 'No customer email' };

  const transporter = getTransporter();
  if (!transporter) return { ok: false, error: 'Email not configured' };

  const payment = await db('payments')
    .where({ customer_id: invoice.customer_id })
    .whereIn('status', ['paid', 'refunded'])
    .whereRaw(`metadata::jsonb ->> 'invoice_id' = ?`, [invoice.id])
    .orderBy('created_at', 'desc')
    .first()
    .catch(() => null);

  const domain = process.env.PORTAL_DOMAIN || 'https://portal.wavespestcontrol.com';
  const receiptUrl = `${domain}/receipt/${invoice.token}`;
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
    ? `<div style="margin-top:16px;padding:14px 16px;background:${SAND};border-left:3px solid ${WAVES_BLUE};border-radius:4px;font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.55;color:${BODY};white-space:pre-wrap;">${memoEscaped}</div>`
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
    logger.info(`[invoice-email] Receipt email sent for ${invoice.invoice_number} to ${customer.email}`);
    return { ok: true };
  } catch (err) {
    logger.error(`[invoice-email] Receipt send failed for ${invoice.invoice_number}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendInvoiceEmail, sendReceiptEmail };
