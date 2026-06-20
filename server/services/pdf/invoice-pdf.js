const PDFDocument = require('pdfkit');
const { getLogoBuffer } = require('./brand-logo');
const {
  WAVES_ADDRESS_LINE,
  WAVES_WEBSITE_HOST,
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_FL_LICENSE_LINE,
} = require('../../constants/business');
const { formatDateOnly, formatDisplayDate } = require('../../utils/date-only');

// Brand palette — mirrors client/src/styles/brand-tokens.css + theme-brand.js
const NAVY = '#1B2C5B';      // blueDeeper — headings, header bar
const WAVES_BLUE = '#009CDE'; // primary brand accent
const RED = '#C8102E';        // overdue / alert
const GREEN = '#047857';      // paid badge
const INK = NAVY;
const BODY = '#3F4A65';
const MUTED = '#6B7280';
const RULE = '#E7E2D7';
const SOFT = '#FAF8F3';

const safeFilename = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'waves';

function formatDate(d) {
  return formatDisplayDate(d, { fallback: '—' });
}

function formatInvoiceDateOnly(d) {
  return formatDateOnly(d, { fallback: '—' });
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
  doc.fontSize(8).font('Helvetica').fillColor('#B8D4EA').text(WAVES_FL_LICENSE_LINE, 108, 70);

  doc.fontSize(10).font('Helvetica-Bold').fillColor('#fff').text(WAVES_SUPPORT_PHONE_DISPLAY, 430, 22, { width: 142, align: 'right' });
  doc.fontSize(8).font('Helvetica').fillColor('#B8D4EA').text(WAVES_WEBSITE_HOST, 430, 38, { width: 142, align: 'right' });
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

function addressLines(doc, x, y, { line1, city, state, zip, email } = {}) {
  doc.fontSize(10).font('Helvetica').fillColor(BODY);
  if (line1) { doc.text(line1, x, y); y += 12; }
  if (city || state || zip) {
    doc.text(`${city || ''}${city ? ', ' : ''}${state || 'FL'} ${zip || ''}`.trim(), x, y);
    y += 12;
  }
  if (email) { doc.text(email, x, y); y += 12; }
  return y;
}

function customerName(customer) {
  return `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || customer.company_name || '';
}

function billBlock(doc, invoice, customer, x, y) {
  const payer = invoice.payer || null;

  // Third-party Bill-To: the payer (builder / property manager / etc.) is who
  // owes the money; the homeowner is the service ("ship-to") address. Showing
  // both — with the PO — is what lets an AP department actually process it.
  if (payer) {
    y = sectionLabel(doc, 'Billed to', x, y);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(INK)
      .text(payer.company_name || payer.display_name || 'Payer', x, y);
    y += 14;
    y = addressLines(doc, x, y, {
      line1: payer.billing_address_line1,
      city: payer.billing_city,
      state: payer.billing_state,
      zip: payer.billing_zip,
      email: payer.ap_email,
    });

    y += 6;
    y = sectionLabel(doc, 'Service address', x, y);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(INK)
      .text(customerName(customer), x, y);
    y += 13;
    y = addressLines(doc, x, y, {
      line1: customer.address_line1,
      city: customer.city,
      state: customer.state,
      zip: customer.zip,
    });
    return y;
  }

  y = sectionLabel(doc, 'Billed to', x, y);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(INK)
    .text(customerName(customer), x, y);
  y += 14;
  y = addressLines(doc, x, y, {
    line1: customer.address_line1,
    city: customer.city,
    state: customer.state,
    zip: customer.zip,
    email: customer.email,
  });
  return y;
}

function invoiceMetaBlock(doc, invoice, payment, x, y, mode) {
  y = sectionLabel(doc, mode === 'receipt' ? 'Receipt details' : 'Invoice details', x, y);
  const rows = [
    [mode === 'receipt' ? 'Receipt for' : 'Invoice number', invoice.invoice_number],
    ['Issued', formatDate(invoice.sent_at || invoice.created_at)],
  ];
  if (mode === 'receipt') {
    rows.push(['Paid', formatDate(invoice.paid_at)]);
    if (payment?.card_brand && payment?.card_last_four) {
      rows.push(['Method', `${payment.card_brand.toUpperCase()} ···· ${payment.card_last_four}`]);
    } else if (invoice.card_brand && invoice.card_last_four) {
      rows.push(['Method', `${invoice.card_brand.toUpperCase()} ···· ${invoice.card_last_four}`]);
    }
  } else if (mode === 'prepaid') {
    // Covered by account credit — nothing due, so no due date.
    rows.push(['Covered', 'Account credit']);
  } else {
    rows.push(['Due', formatInvoiceDateOnly(invoice.due_date)]);
  }
  if (invoice.service_date) rows.push(['Service date', formatInvoiceDateOnly(invoice.service_date)]);
  if (invoice.service_type) rows.push(['Service', invoice.service_type]);
  if (invoice.po_number) rows.push(['PO number', invoice.po_number]);

  doc.fontSize(10).font('Helvetica');
  for (const [label, value] of rows) {
    doc.fillColor(MUTED).text(label, x, y, { width: 110 });
    doc.fillColor(INK).text(String(value || '—'), x + 110, y, { width: 180 });
    y += 14;
  }
  return y;
}

// Annual-prepay coverage callout. Renders only for annual-prepay invoices —
// the raw line item is otherwise the only signal the customer is paying for a
// full year. prepay is the normalized descriptor from services/invoice-prepay.
function annualPrepayCallout(doc, prepay, x, y, width) {
  if (!prepay) return y;

  const startStr = formatInvoiceDateOnly(prepay.termStart);
  const endStr = formatInvoiceDateOnly(prepay.termEnd);
  const months = prepay.coverageMonths;
  const spanLabel = months ? `${months} months of service` : 'a full year of service';
  let body = `This is an annual prepayment — it covers ${spanLabel}`;
  if (startStr !== '—' && endStr !== '—') body += `, ${startStr} – ${endStr}`;
  body += '.';
  if (prepay.setupFeeWaived) body += ' Your one-time setup fee is waived.';

  // The dated visits this prepayment covers, each with its share of the total —
  // makes the "full year" concrete on the printed invoice.
  const visits = Array.isArray(prepay.coverageVisits) ? prepay.coverageVisits : [];
  const prepaid = ['active', 'renewed', 'renewal_pending', 'switch_plan']
    .includes(String(prepay.status || '').toLowerCase());
  const tag = prepaid ? 'Prepaid' : 'Included';

  const padX = 12;
  const padY = 10;
  const labelGap = 16;
  const lineH = 14;
  const textW = width - padX * 2;
  const tagW = 132;

  doc.save();
  doc.fontSize(10).font('Helvetica');
  const bodyH = doc.heightOfString(body, { width: textW, lineGap: 2 });
  // Extra line at the bottom for the "target dates" caption.
  const visitsH = visits.length ? 6 + visits.length * lineH + lineH : 0;
  const boxH = padY * 2 + labelGap + bodyH + visitsH;
  doc.roundedRect(x, y, width, boxH, 6).lineWidth(1).fillAndStroke(SOFT, WAVES_BLUE);
  doc.fontSize(8).font('Helvetica-Bold').fillColor(WAVES_BLUE)
    .text('ANNUAL PREPAYMENT', x + padX, y + padY, { characterSpacing: 1.2 });
  doc.fontSize(10).font('Helvetica').fillColor(BODY)
    .text(body, x + padX, y + padY + labelGap, { width: textW, lineGap: 2 });

  if (visits.length) {
    let vy = y + padY + labelGap + bodyH + 6;
    doc.fontSize(9);
    visits.forEach((v, i) => {
      const left = `•  Visit ${i + 1} of ${visits.length} · target ${formatInvoiceDateOnly(v.date)}`;
      const right = `${v.amount != null ? `${currency(v.amount)}  ` : ''}${tag}`;
      doc.font('Helvetica').fillColor(BODY).text(left, x + padX, vy, { width: textW - tagW });
      doc.fillColor(MUTED).text(right, x + width - padX - tagW, vy, { width: tagW, align: 'right' });
      vy += lineH;
    });
    doc.fontSize(8).fillColor(MUTED)
      .text('Target dates — your actual visits follow your regular service route.', x + padX, vy, { width: textW });
  }
  doc.restore();

  return y + boxH + 14;
}

function lineItemsTable(doc, lineItems, x, y, width) {
  const visibleLineItems = (lineItems || []).filter((item) => {
    const amount = Number(item?.amount ?? ((Number(item?.quantity) || 1) * (Number(item?.unit_price) || 0)));
    return item?._kind !== 'discount' && !item?.discount_for && amount >= 0;
  });
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
  for (const item of visibleLineItems) {
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

// Acceptance-deposit credit lines are prior payments, not discounts — the
// item table hides them (negative lines), so the totals block must surface
// the amount or the visible rows won't reconcile to the total.
function depositCreditTotalFromLineItems(lineItems) {
  let items = lineItems;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { items = []; }
  }
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.category === 'deposit_credit')
    .reduce((sum, item) => {
      const amount = Number(item?.amount ?? ((Number(item?.quantity) || 1) * (Number(item?.unit_price) || 0)));
      return sum + (Number.isFinite(amount) ? Math.abs(amount) : 0);
    }, 0);
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
  const depositCredit = depositCreditTotalFromLineItems(invoice.line_items);
  if (depositCredit > 0) row('Deposit paid at acceptance', `− ${currency(depositCredit)}`);

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
  const previousBottomMargin = doc.page.margins.bottom;
  doc.save();
  doc.page.margins.bottom = 0;
  doc.rect(0, 742, 612, 50).fill(NAVY);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text(
    tagline || 'Thank you for choosing Waves',
    0, 752, { width: 612, align: 'center' },
  );
  doc.fontSize(7).font('Helvetica').fillColor('#B8D4EA').text(
    `Waves Pest Control, LLC · ${WAVES_ADDRESS_LINE} · ${WAVES_SUPPORT_PHONE_DISPLAY} · ${WAVES_WEBSITE_HOST}`,
    0, 768, { width: 612, align: 'center' },
  );
  doc.page.margins.bottom = previousBottomMargin;
  doc.restore();
}

function generateInvoicePDF(invoice, res) {
  const customer = invoice.customer || {};
  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
  const fileName = `invoice-${safeFilename(invoice.invoice_number)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  doc.pipe(res);

  // `prepaid` is settled (covered by account credit) — never label it Due/
  // Overdue. It gets its own "Prepaid" badge and no "PAID IN FULL" cash stamp
  // (the credit may be goodwill, not a payment).
  const isPrepaid = invoice.status === 'prepaid';
  const isPaid = invoice.status === 'paid';
  const isSettled = isPaid || isPrepaid;
  const isOverdue = !isSettled
    && invoice.due_date
    && new Date(invoice.due_date).getTime() < Date.now();

  const statusLabel = isPaid ? 'Paid' : isPrepaid ? 'Prepaid' : isOverdue ? 'Overdue' : 'Due';
  const statusColor = isSettled ? GREEN : isOverdue ? RED : WAVES_BLUE;
  headerBar(doc, 'Invoice', statusLabel, statusColor);

  const L = 40, W = 612 - 80;
  let yLeft = 160;
  let yRight = 160;
  yLeft = billBlock(doc, invoice, customer, L, yLeft);
  yRight = invoiceMetaBlock(doc, invoice, null, L + W / 2 + 20, yRight, isPrepaid ? 'prepaid' : 'invoice');

  let y = Math.max(yLeft, yRight) + 16;
  y = annualPrepayCallout(doc, invoice.annual_prepay, L, y, W);
  y = lineItemsTable(doc, invoice.line_items, L, y, W);
  y = totalsBlock(doc, invoice, L, y + 8, W, { highlightTotal: true, paidStamp: isPaid, customer });

  if (invoice.notes) {
    y += 10;
    doc.fontSize(9).font('Helvetica-Bold').fillColor(MUTED).text('NOTES', L, y, { characterSpacing: 1.2 });
    y += 12;
    doc.fontSize(10).font('Helvetica').fillColor(BODY).text(invoice.notes, L, y, { width: W, lineGap: 3 });
  }

  footerBar(doc, isPaid ? 'Paid — thank you' : isPrepaid ? 'Covered by account credit — thank you' : 'Thank you for choosing Waves');
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
      `Keep this receipt for your records. For questions, reply to your receipt email or call ${WAVES_SUPPORT_PHONE_DISPLAY}.`,
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
