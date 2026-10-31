// Consolidated NET-terms statement PDF (Phase 2). One document per finalized
// `payer_statements` row: a billed summary an AP department can process, with a
// line per attached invoice (the month's visits) and the rolled-up totals.
//
// Self-contained (mirrors invoice-pdf.js / wdo-report-pdf.js style) so the
// statement renderer never drifts when the single-invoice PDF changes. Reads
// the FROZEN snapshot off the statement — never the live payer — so a reprint
// always matches what was billed.

const PDFDocument = require('pdfkit');
const { formatDateOnly, formatDisplayDate, dateOnlyString } = require('../../utils/date-only');
const { etDateString } = require('../../utils/datetime-et');
const { PDF_COLORS } = require('./pdf-tokens');
const {
  FIELD_PDF_LAYOUT,
  drawFieldContinuationMasthead,
  drawFieldFooter,
  drawFieldMasthead,
} = require('./field-pdf');

const NAVY = PDF_COLORS.navy;
const WAVES_BLUE = PDF_COLORS.blue;
const RED = PDF_COLORS.red;
const GREEN = PDF_COLORS.green;
const INK = NAVY;
const BODY = PDF_COLORS.body;
const MUTED = PDF_COLORS.muted;
const RULE = PDF_COLORS.rule;

const PAGE_W = 612;
const PAGE_BOTTOM = FIELD_PDF_LAYOUT.contentBottom;

const safeFilename = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'waves';

function currency(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function dateOnly(d) { return formatDateOnly(d, { fallback: '—' }); }
function dateTime(d) { return formatDisplayDate(d, { fallback: '—' }); }

const TERM_LABEL = { net15: 'Net 15', net30: 'Net 30', net60: 'Net 60', due_on_receipt: 'Due on receipt' };

// Overdue in ET, not UTC: due_date is an ET-derived DATE (stored as a 'YYYY-MM-DD'
// calendar day). Compare its calendar date against TODAY in ET as plain strings —
// `new Date('YYYY-MM-DD')` would parse UTC midnight and flip overdue the prior
// evening in America/New_York. Past-due = due day strictly before today (ET).
function isStatementOverdue(statement, now = new Date()) {
  if (!statement || ['paid', 'void'].includes(statement.status)) return false;
  const dueYmd = dateOnlyString(statement.due_date);
  return !!dueYmd && dueYmd < etDateString(now);
}

function headerBar(doc, statusLabel, statusColor) {
  drawFieldMasthead(doc, {
    title: 'Account Statement',
    eyebrow: 'Billing document',
    statusLabel: statusLabel ? statusLabel.toUpperCase() : '',
    statusColor,
  });
}

function sectionLabel(doc, label, x, y) {
  doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED).text(label.toUpperCase(), x, y, { characterSpacing: 1.2 });
  return y + 14;
}

function billBlock(doc, payer, x, y) {
  y = sectionLabel(doc, 'Billed to', x, y);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(INK)
    .text(payer.company_name || payer.display_name || 'Payer', x, y);
  y += 14;
  doc.fontSize(10).font('Helvetica').fillColor(BODY);
  if (payer.billing_address_line1) { doc.text(payer.billing_address_line1, x, y); y += 12; }
  if (payer.billing_city || payer.billing_state || payer.billing_zip) {
    doc.text(`${payer.billing_city || ''}${payer.billing_city ? ', ' : ''}${payer.billing_state || 'FL'} ${payer.billing_zip || ''}`.trim(), x, y);
    y += 12;
  }
  if (payer.ap_email) { doc.text(payer.ap_email, x, y); y += 12; }
  return y;
}

function metaBlock(doc, statement, x, y) {
  y = sectionLabel(doc, 'Statement details', x, y);
  const isOverdue = isStatementOverdue(statement);
  const rows = [
    ['Statement #', `S-${statement.id}`],
    ['Period', `${dateOnly(statement.period_start)} – ${dateOnly(statement.period_end)}`],
    ['Issued', dateTime(statement.finalized_at)], // timestamp → ET calendar date (NOT dateOnly, which is UTC)
    ['Terms', TERM_LABEL[statement.terms_snapshot] || statement.terms_snapshot || '—'],
    ['Due', dateOnly(statement.due_date)],
  ];
  doc.fontSize(10).font('Helvetica');
  for (const [label, value] of rows) {
    doc.fillColor(MUTED).text(label, x, y, { width: 90 });
    doc.fillColor(label === 'Due' && isOverdue ? RED : INK).text(String(value || '—'), x + 90, y, { width: 180 });
    y += 14;
  }
  return y;
}

// Columns: Date | Service | Property | Invoice # | Amount.
const COL = { date: 40, service: 120, property: 290, invoice: 430, amount: 532 };
const COL_W = { date: 74, service: 164, property: 134, invoice: 96, amount: 40 };

function tableHeader(doc, y) {
  doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED);
  doc.text('DATE', COL.date, y, { characterSpacing: 0.8 });
  doc.text('SERVICE', COL.service, y, { characterSpacing: 0.8 });
  doc.text('PROPERTY', COL.property, y, { characterSpacing: 0.8 });
  doc.text('INVOICE', COL.invoice, y, { characterSpacing: 0.8 });
  doc.text('AMOUNT', COL.amount, y, { width: COL_W.amount + 40, align: 'right', characterSpacing: 0.8 });
  y += 13;
  doc.moveTo(40, y).lineTo(PAGE_W - 40, y).lineWidth(0.75).strokeColor(RULE).stroke();
  return y + 8;
}

function statementTable(doc, lines, startY) {
  let y = tableHeader(doc, startY);
  doc.fontSize(9).font('Helvetica');
  for (const line of lines) {
    // Name AND service address — a consolidated statement to a property manager /
    // HOA spans many homes, so AP needs the serviced location, not just the name.
    const property = [line.customer_name, line.service_address].filter(Boolean).join('\n') || '—';
    const rowH = Math.max(
      doc.heightOfString(line.service_type || 'Service', { width: COL_W.service }),
      doc.heightOfString(property, { width: COL_W.property }),
      12,
    );
    // Page break before a row that would collide with the footer.
    if (y + rowH > PAGE_BOTTOM) {
      doc.addPage();
      drawFieldContinuationMasthead(doc, { title: 'Account Statement · continued' });
      y = tableHeader(doc, 64);
      doc.fontSize(9).font('Helvetica');
    }
    doc.fillColor(BODY).text(dateOnly(line.service_date), COL.date, y, { width: COL_W.date });
    doc.fillColor(INK).text(line.service_type || 'Service', COL.service, y, { width: COL_W.service });
    doc.fillColor(BODY).text(property, COL.property, y, { width: COL_W.property });
    doc.fillColor(MUTED).fontSize(8).text(line.invoice_number || '—', COL.invoice, y, { width: COL_W.invoice });
    doc.fontSize(9).fillColor(INK).text(currency(line.total), COL.amount, y, { width: COL_W.amount + 40, align: 'right' });
    y += rowH + 8;
  }
  return y;
}

function totalsBlock(doc, statement, startY) {
  let y = startY + 4;
  if (y + 90 > PAGE_BOTTOM) {
    doc.addPage();
    drawFieldContinuationMasthead(doc, { title: 'Account Statement · continued' });
    y = 64;
  }
  doc.moveTo(360, y).lineTo(PAGE_W - 40, y).lineWidth(0.75).strokeColor(RULE).stroke();
  y += 10;
  const row = (label, value, bold) => {
    doc.fontSize(bold ? 12 : 10).font(bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.fillColor(bold ? INK : MUTED).text(label, 360, y, { width: 120 });
    doc.fillColor(bold ? INK : BODY).text(value, 480, y, { width: PAGE_W - 40 - 480, align: 'right' });
    y += bold ? 20 : 16;
  };
  row('Subtotal', currency(statement.subtotal));
  if (Number(statement.tax_amount || 0) > 0) row('Tax', currency(statement.tax_amount));
  row(`Total (${statement.invoice_count || 0} visit${Number(statement.invoice_count) === 1 ? '' : 's'})`, currency(statement.total), true);
  return y;
}

function footerBar(doc, tagline) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    drawFieldFooter(doc, {
      tagline,
      detail: `Statement · Page ${i + 1} of ${range.count}`,
    });
  }
}

function generatePayerStatementPDF({ statement, payer, lines }, sink) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });
  const fileName = `statement-S${safeFilename(String(statement.id))}.pdf`;
  if (sink.setHeader) {
    sink.setHeader('Content-Type', 'application/pdf');
    sink.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  }
  doc.pipe(sink);

  const isPaid = statement.status === 'paid';
  const isOverdue = isStatementOverdue(statement);
  const statusLabel = isPaid ? 'Paid' : isOverdue ? 'Overdue' : 'Due';
  const statusColor = isPaid ? GREEN : isOverdue ? RED : WAVES_BLUE;
  headerBar(doc, statusLabel, statusColor);

  let yLeft = billBlock(doc, payer || {}, 40, 160);
  let yRight = metaBlock(doc, statement, 360, 160);
  let y = Math.max(yLeft, yRight) + 20;

  y = statementTable(doc, lines || [], y);
  y = totalsBlock(doc, statement, y + 6);

  footerBar(doc, isPaid ? 'Paid — thank you' : 'Thank you for choosing Waves Pest Control');
  doc.end();
}

function streamToBuffer(streamFn) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = {
      setHeader() {},
      write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve(Buffer.concat(chunks));
      },
      on() {}, once() {}, emit() {},
    };
    try { streamFn(sink); } catch (err) { reject(err); }
  });
}

async function buildPayerStatementPDFBuffer({ statement, payer, lines }) {
  return streamToBuffer((sink) => generatePayerStatementPDF({ statement, payer, lines }, sink));
}

module.exports = {
  generatePayerStatementPDF,
  buildPayerStatementPDFBuffer,
  isStatementOverdue,
};
