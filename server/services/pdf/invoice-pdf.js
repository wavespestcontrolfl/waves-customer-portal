const PDFDocument = require('pdfkit');
const { getLogoBuffer } = require('./brand-logo');

// Brand palette — mirrors client/src/styles/brand-tokens.css + theme-brand.js
const NAVY = '#1B2C5B';      // blueDeeper — headings, header bar
const WAVES_BLUE = '#009CDE'; // primary brand accent
const RED = '#C8102E';        // overdue / alert
const GREEN = '#047857';      // paid badge
const INK = '#0F172A';
const BODY = '#334155';
const MUTED = '#64748B';
const RULE = '#E2E8F0';
const SOFT = '#F1F5F9';

const safeFilename = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'waves';

function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(typeof d === 'string' ? (d.length === 10 ? d + 'T12:00:00' : d) : d);
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

function currency(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function headerBar(doc, title, statusLabel, statusColor) {
  doc.save();
  doc.rect(0, 0, 612, 92).fill(NAVY);

  // Logo block (left). PDF header bar is 92px tall; render the square
  // logo at 72px so it fits with 10px padding top/bottom. If the asset
  // is missing we silently fall back to the wordmark so the PDF never
  // breaks in production.
  const logoBuf = getLogoBuffer();
  if (logoBuf) {
    doc.image(logoBuf, 24, 10, { width: 72, height: 72 });
  } else {
    doc.fontSize(26).font('Helvetica-Bold').fillColor('#fff').text('WAVES', 40, 22);
    doc.fontSize(9).font('Helvetica').fillColor('#B8D4EA').text('PEST CONTROL & LAWN CARE', 40, 52);
  }
  doc.fontSize(8).font('Helvetica').fillColor('#B8D4EA').text('FL License #JF336375', 108, 70);

  doc.fontSize(10).font('Helvetica-Bold').fillColor('#fff').text('(941) 318-7612', 430, 22, { width: 142, align: 'right' });
  doc.fontSize(8).font('Helvetica').fillColor('#B8D4EA').text('wavespestcontrol.com', 430, 38, { width: 142, align: 'right' });
  doc.text('13649 Luxe Ave #110', 430, 52, { width: 142, align: 'right' });
  doc.text('Bradenton, FL 34211', 430, 64, { width: 142, align: 'right' });
  doc.restore();

  doc.save();
  doc.rect(0, 92, 612, 44).fill(SOFT);
  doc.fontSize(20).font('Helvetica').fillColor(NAVY).text(title, 40, 104);

  if (statusLabel) {
    const badgeW = doc.widthOfString(statusLabel) + 20;
    doc.roundedRect(612 - 40 - badgeW, 105, badgeW, 22, 11).fill(statusColor);
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff')
      .text(statusLabel.toUpperCase(), 612 - 40 - badgeW + 10, 111);
  }
  doc.restore();
}

function sectionLabel(doc, label, x, y) {
  doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED)
    .text(label.toUpperCase(), x, y, { characterSpacing: 1.2 });
  return y + 14;
}

function billBlock(doc, invoice, customer, x, y) {
  y = sectionLabel(doc, 'Billed to', x, y);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(INK)
    .text(`${customer.first_name || ''} ${customer.last_name || ''}`.trim(), x, y);
  y += 14;
  doc.fontSize(10).font('Helvetica').fillColor(BODY);
  if (customer.address_line1) { doc.text(customer.address_line1, x, y); y += 12; }
  if (customer.city || customer.state || customer.zip) {
    doc.text(`${customer.city || ''}${customer.city ? ', ' : ''}${customer.state || 'FL'} ${customer.zip || ''}`.trim(), x, y);
    y += 12;
  }
  if (customer.email) { doc.text(customer.email, x, y); y += 12; }
  return y;
}

function invoiceMetaBlock(doc, invoice, payment, x, y, mode) {
  y = sectionLabel(doc, mode === 'receipt' ? 'Receipt details' : 'Invoice details', x, y);
  const rows = [
    [mode === 'receipt' ? 'Receipt for' : 'Invoice number', invoice.invoice_number],
    ['Issued', formatDate(invoice.created_at || invoice.sent_at)],
  ];
  if (mode === 'receipt') {
    rows.push(['Paid', formatDate(invoice.paid_at)]);
    if (payment?.card_brand && payment?.card_last_four) {
      rows.push(['Method', `${payment.card_brand.toUpperCase()} ···· ${payment.card_last_four}`]);
    } else if (invoice.card_brand && invoice.card_last_four) {
      rows.push(['Method', `${invoice.card_brand.toUpperCase()} ···· ${invoice.card_last_four}`]);
    }
  } else {
    rows.push(['Due', formatDate(invoice.due_date)]);
  }
  if (invoice.service_date) rows.push(['Service date', formatDate(invoice.service_date)]);
  if (invoice.service_type) rows.push(['Service', invoice.service_type]);

  doc.fontSize(10).font('Helvetica');
  for (const [label, value] of rows) {
    doc.fillColor(MUTED).text(label, x, y, { width: 110 });
    doc.fillColor(INK).text(String(value || '—'), x + 110, y, { width: 180 });
    y += 14;
  }
  return y;
}

function lineItemsTable(doc, lineItems, x, y, width) {
  doc.save();
  doc.moveTo(x, y).lineTo(x + width, y).lineWidth(0.5).strokeColor(RULE).stroke();
  y += 8;
  doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED);
  doc.text('DESCRIPTION', x, y, { characterSpacing: 1.2 });
  doc.text('QTY', x + width - 190, y, { width: 40, align: 'right', characterSpacing: 1.2 });
  doc.text('RATE', x + width - 140, y, { width: 60, align: 'right', characterSpacing: 1.2 });
  doc.text('AMOUNT', x + width - 70, y, { width: 70, align: 'right', characterSpacing: 1.2 });
  y += 14;
  doc.moveTo(x, y).lineTo(x + width, y).lineWidth(0.5).strokeColor(RULE).stroke();
  y += 6;

  doc.fontSize(10).font('Helvetica').fillColor(INK);
  for (const item of (lineItems || [])) {
    const description = String(item.description || '').slice(0, 200);
    const qty = Number(item.quantity || 1);
    const rate = Number(item.unit_price || 0);
    const amount = Number(item.amount ?? qty * rate);
    const descHeight = doc.heightOfString(description, { width: x + width - 210 - x });
    const rowHeight = Math.max(descHeight + 6, 18);
    doc.text(description, x, y, { width: width - 210 });
    doc.text(String(qty), x + width - 190, y, { width: 40, align: 'right' });
    doc.text(currency(rate), x + width - 140, y, { width: 60, align: 'right' });
    doc.text(currency(amount), x + width - 70, y, { width: 70, align: 'right' });
    y += rowHeight;
  }
  doc.restore();
  return y;
}

function totalsBlock(doc, invoice, x, y, width, opts = {}) {
  const { highlightTotal = true, paidStamp = false, refundAmount = 0, customer = null } = opts;
  doc.save();
  doc.moveTo(x, y).lineTo(x + width, y).lineWidth(0.5).strokeColor(RULE).stroke();
  y += 10;

  const subtotal = Number(invoice.subtotal || 0);
  const discount = Number(invoice.discount_amount || 0);
  const tax = Number(invoice.tax_amount || 0);
  const total = Number(invoice.total || 0);
  const isCommercial = customer?.property_type === 'commercial' || customer?.property_type === 'business';

  const labelX = x + width - 240;
  const valueX = x + width - 70;

  const row = (label, value, color = BODY, bold = false) => {
    doc.fontSize(10).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(color);
    doc.text(label, labelX, y, { width: 160, align: 'right' });
    doc.text(value, valueX, y, { width: 70, align: 'right' });
    y += 14;
  };

  row('Subtotal', currency(subtotal));
  if (discount > 0) row(invoice.discount_label || 'Discount', `− ${currency(discount)}`);
  // Tax line is commercial-only per operator policy. Guard defends against
  // legacy invoices that may have a non-zero tax_amount for a residential
  // customer — we still hide the line in that case; the stored total is
  // authoritative since the customer already agreed to it.
  if (tax > 0 && isCommercial) row(`Tax (${(Number(invoice.tax_rate || 0) * 100).toFixed(2)}%)`, currency(tax));

  y += 2;
  doc.moveTo(labelX - 10, y).lineTo(x + width, y).lineWidth(0.5).strokeColor(RULE).stroke();
  y += 8;

  if (highlightTotal) {
    doc.fontSize(13).font('Helvetica-Bold').fillColor(NAVY);
    doc.text('TOTAL', labelX, y, { width: 160, align: 'right', characterSpacing: 1.2 });
    doc.text(currency(total), valueX, y, { width: 70, align: 'right' });
    y += 20;
  }

  if (refundAmount > 0) {
    row('Refunded', `− ${currency(refundAmount)}`, RED, true);
    row('Net paid', currency(total - refundAmount), NAVY, true);
  }
  doc.restore();

  if (paidStamp) {
    doc.save();
    const stampY = y + 6;
    doc.roundedRect(x, stampY, 130, 32, 4)
      .lineWidth(1.5).strokeColor(GREEN).stroke();
    doc.fontSize(14).font('Helvetica-Bold').fillColor(GREEN)
      .text('PAID IN FULL', x, stampY + 9, { width: 130, align: 'center', characterSpacing: 1.5 });
    doc.restore();
    y = stampY + 40;
  }
  return y;
}

function footerBar(doc, tagline) {
  doc.save();
  doc.rect(0, 742, 612, 50).fill(NAVY);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text(
    tagline || 'Thank you for choosing Waves',
    0, 752, { width: 612, align: 'center' },
  );
  doc.fontSize(7).font('Helvetica').fillColor('#B8D4EA').text(
    'Waves Pest Control, LLC · 13649 Luxe Ave #110, Bradenton, FL 34211 · (941) 318-7612 · wavespestcontrol.com',
    0, 768, { width: 612, align: 'center' },
  );
  doc.restore();
}

function generateInvoicePDF(invoice, res) {
  const customer = invoice.customer || {};
  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
  const fileName = `invoice-${safeFilename(invoice.invoice_number)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  doc.pipe(res);

  const isOverdue = invoice.status !== 'paid'
    && invoice.due_date
    && new Date(invoice.due_date).getTime() < Date.now();
  const isPaid = invoice.status === 'paid';

  const statusLabel = isPaid ? 'Paid' : isOverdue ? 'Overdue' : 'Due';
  const statusColor = isPaid ? GREEN : isOverdue ? RED : WAVES_BLUE;
  headerBar(doc, 'Invoice', statusLabel, statusColor);

  const L = 40, W = 612 - 80;
  let yLeft = 160;
  let yRight = 160;
  yLeft = billBlock(doc, invoice, customer, L, yLeft);
  yRight = invoiceMetaBlock(doc, invoice, null, L + W / 2 + 20, yRight, 'invoice');

  let y = Math.max(yLeft, yRight) + 16;
  y = lineItemsTable(doc, invoice.line_items, L, y, W);
  y = totalsBlock(doc, invoice, L, y + 8, W, { highlightTotal: true, paidStamp: isPaid, customer });

  if (invoice.notes) {
    y += 10;
    doc.fontSize(9).font('Helvetica-Bold').fillColor(MUTED).text('NOTES', L, y, { characterSpacing: 1.2 });
    y += 12;
    doc.fontSize(10).font('Helvetica').fillColor(BODY).text(invoice.notes, L, y, { width: W, lineGap: 3 });
  }

  footerBar(doc, isPaid ? 'Paid — thank you' : 'Thank you for choosing Waves');
  doc.end();
}

function generateReceiptPDF(invoice, payment, res) {
  const customer = invoice.customer || {};
  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
  const fileName = `receipt-${safeFilename(invoice.invoice_number)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  doc.pipe(res);

  const refundAmount = payment ? Number(payment.refund_amount || 0) : 0;
  const fullRefund = refundAmount > 0 && refundAmount >= Number(invoice.total || 0);

  const statusLabel = fullRefund ? 'Refunded' : refundAmount > 0 ? 'Partially Refunded' : 'Paid';
  const statusColor = fullRefund ? RED : refundAmount > 0 ? WAVES_BLUE : GREEN;
  headerBar(doc, 'Receipt', statusLabel, statusColor);

  const L = 40, W = 612 - 80;
  let yLeft = 160;
  let yRight = 160;
  yLeft = billBlock(doc, invoice, customer, L, yLeft);
  yRight = invoiceMetaBlock(doc, invoice, payment, L + W / 2 + 20, yRight, 'receipt');

  let y = Math.max(yLeft, yRight) + 16;
  y = lineItemsTable(doc, invoice.line_items, L, y, W);
  y = totalsBlock(doc, invoice, L, y + 8, W, {
    highlightTotal: true,
    paidStamp: !refundAmount,
    refundAmount,
    customer,
  });

  // Commercial-only recordkeeping note. Most residential receipts don't
  // need this boilerplate, but commercial accounts often want explicit
  // language about keeping the receipt for accounting.
  const isCommercial = customer?.property_type === 'commercial' || customer?.property_type === 'business';
  if (isCommercial) {
    y += 14;
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(
      'Keep this receipt for your records. For questions, reply to your receipt email or call (941) 318-7612.',
      L, y, { width: W, lineGap: 3 },
    );
  }

  footerBar(doc, fullRefund ? 'Refund processed' : 'Thank you — payment received');
  doc.end();
}

function streamToBuffer(streamFn) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = {
      setHeader() { /* noop — email path ignores HTTP headers */ },
      write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve(Buffer.concat(chunks));
      },
      on() { /* pdfkit's doc.pipe(sink) uses write/end; ignore lifecycle listeners */ },
      once() {},
      emit() {},
    };
    try { streamFn(sink); } catch (err) { reject(err); }
  });
}

async function buildInvoicePDFBuffer(invoice) {
  return streamToBuffer((sink) => generateInvoicePDF(invoice, sink));
}

async function buildReceiptPDFBuffer(invoice, payment) {
  return streamToBuffer((sink) => generateReceiptPDF(invoice, payment, sink));
}

module.exports = {
  generateInvoicePDF,
  generateReceiptPDF,
  buildInvoicePDFBuffer,
  buildReceiptPDFBuffer,
};
