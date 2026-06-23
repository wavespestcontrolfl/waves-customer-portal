// Branded PDF generator for document-library contracts/agreements
// (customer_contracts rows: Bora-Care, termite bonds, rodent guarantee,
// residential pest agreement, bed-bug prep, etc.).
//
// Self-contained on purpose: it replicates the navy-header / logo /
// license-footer chrome used by invoice-pdf.js and the service-report
// generator rather than importing their (unexported) helpers, so the
// working invoice generator is never touched. The body comes from the
// contract's rendered text snapshot; when the contract is signed, the
// execution details already captured on customer_contracts (signed name,
// initials, timestamp, signer IP/user-agent) are stamped into a signature
// block.
const PDFDocument = require('pdfkit');
const { getLogoBuffer } = require('./brand-logo');
const {
  WAVES_BUSINESS_NAME,
  WAVES_ADDRESS_LINE,
  WAVES_WEBSITE_HOST,
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_FL_LICENSE_LINE,
} = require('../../constants/business');
const { formatDisplayDate } = require('../../utils/date-only');

// Brand palette — mirrors invoice-pdf.js / brand-tokens.css.
const NAVY = '#1B2C5B';
const WAVES_BLUE = '#009CDE';
const GREEN = '#047857';
const BODY = '#3F4A65';
const MUTED = '#6B7280';
const SOFT = '#FAF8F3';

const PAGE_W = 612;
const MARGIN_X = 48;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const FOOTER_TOP = 742;
const BODY_TOP = 150; // below the header + title bar on page 1

const safeFilename = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'waves-agreement';

function formatDate(d) {
  return formatDisplayDate(d, { fallback: '—' });
}

function formatDateTime(d) {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    timeZone: 'America/New_York',
  });
}

function customerName(customer = {}, fallback = '') {
  const name = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
  return name || customer.company_name || fallback || '';
}

// Drawn on page 1 only — full navy header bar with logo, contact block, and
// FL license, then a soft title band carrying the agreement title + status.
function drawHeader(doc, title, { signed }) {
  doc.save();
  doc.rect(0, 0, PAGE_W, 92).fill(NAVY);

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
  doc.rect(0, 92, PAGE_W, 44).fill(SOFT);
  doc.fontSize(18).font('Helvetica').fillColor(NAVY).text(title, MARGIN_X, 104, { width: CONTENT_W - 120 });

  const statusLabel = signed ? 'Signed' : 'For review';
  const statusColor = signed ? GREEN : WAVES_BLUE;
  const badgeW = doc.fontSize(9).font('Helvetica-Bold').widthOfString(statusLabel.toUpperCase()) + 20;
  doc.roundedRect(PAGE_W - MARGIN_X - badgeW, 105, badgeW, 22, 11).fill(statusColor);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text(statusLabel.toUpperCase(), PAGE_W - MARGIN_X - badgeW + 10, 111);
  doc.restore();
}

// Drawn on every page (fixed position, independent of content flow).
function drawFooter(doc) {
  const prevBottom = doc.page.margins.bottom;
  doc.save();
  doc.page.margins.bottom = 0;
  doc.rect(0, FOOTER_TOP, PAGE_W, 50).fill(NAVY);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text(
    'Thank you for choosing Waves',
    0, FOOTER_TOP + 10, { width: PAGE_W, align: 'center' },
  );
  doc.fontSize(7).font('Helvetica').fillColor('#B8D4EA').text(
    `${WAVES_BUSINESS_NAME} · ${WAVES_ADDRESS_LINE} · ${WAVES_SUPPORT_PHONE_DISPLAY} · ${WAVES_WEBSITE_HOST}`,
    0, FOOTER_TOP + 26, { width: PAGE_W, align: 'center' },
  );
  doc.page.margins.bottom = prevBottom;
  doc.restore();
}

function recipientBlock(doc, { recipient, requestedDate }) {
  let y = BODY_TOP;
  doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED).text('PREPARED FOR', MARGIN_X, y, { characterSpacing: 1.2 });
  y += 13;
  doc.fontSize(11).font('Helvetica-Bold').fillColor(NAVY).text(recipient || '—', MARGIN_X, y);
  y += 15;
  doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(`Date: ${formatDate(requestedDate)}`, MARGIN_X, y);
  y += 18;
  return y;
}

// Signature block: stamped execution details when signed, or a blank
// signature line on the review copy.
function signatureBlock(doc, contract, { signed }) {
  // Keep the block together — push to a new page if it won't fit.
  const needed = 96;
  if (doc.y + needed > FOOTER_TOP - 16) doc.addPage();

  let y = doc.y + 10;
  doc.save();
  doc.moveTo(MARGIN_X, y).lineTo(PAGE_W - MARGIN_X, y).lineWidth(0.75).strokeColor('#E7E2D7').stroke();
  doc.restore();
  y += 12;

  doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED).text('CUSTOMER SIGNATURE', MARGIN_X, y, { characterSpacing: 1.2 });
  y += 14;

  if (signed) {
    doc.fontSize(13).font('Helvetica-Bold').fillColor(NAVY).text(contract.signed_name || '—', MARGIN_X, y);
    y += 18;
    doc.fontSize(9).font('Helvetica').fillColor(BODY)
      .text(`Initials: ${contract.recipient_initials || '—'}    Signed: ${formatDateTime(contract.signed_at)}`, MARGIN_X, y);
    y += 13;
    const auditBits = [];
    if (contract.signer_ip) auditBits.push(`IP ${contract.signer_ip}`);
    if (contract.signer_user_agent) auditBits.push(String(contract.signer_user_agent).slice(0, 90));
    if (auditBits.length) {
      doc.fontSize(7).font('Helvetica').fillColor(MUTED)
        .text(`Electronically signed · ${auditBits.join(' · ')}`, MARGIN_X, y, { width: CONTENT_W });
    }
  } else {
    doc.fontSize(11).font('Helvetica').fillColor('#9AA1B1').text('X ______________________________', MARGIN_X, y);
    y += 18;
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('Signature                                   Date', MARGIN_X, y);
  }
}

function generateContractPDF(contract, customer, sink, opts = {}) {
  const signed = opts.signed != null ? !!opts.signed : contract.status === 'signed';
  const title = contract.title || 'Waves Agreement';

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 56, bottom: 64, left: MARGIN_X, right: MARGIN_X },
  });

  if (sink.setHeader) {
    const fileName = `${safeFilename(title)}.pdf`;
    sink.setHeader('Content-Type', 'application/pdf');
    sink.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  }
  doc.pipe(sink);

  // Footer is drawn on every page that gets ADDED after construction; page 1
  // (created in the constructor) is handled manually below. Continuation
  // pages have no header band, so reset the cursor to the top margin.
  doc.on('pageAdded', () => {
    drawFooter(doc);
    doc.x = MARGIN_X;
    doc.y = doc.page.margins.top;
  });

  drawHeader(doc, title, { signed });
  drawFooter(doc);

  let y = recipientBlock(doc, {
    recipient: customerName(customer, contract.signed_name),
    requestedDate: contract.shared_at || contract.created_at,
  });

  // Body — the rendered contract text snapshot. Flows across pages; the
  // pageAdded handler keeps a footer on each.
  doc.fontSize(10.5).font('Helvetica').fillColor(BODY)
    .text(contract.contract_text_snapshot || '', MARGIN_X, y, {
      width: CONTENT_W,
      align: 'left',
      lineGap: 3,
      paragraphGap: 6,
    });

  signatureBlock(doc, contract, { signed });

  // E-sign disclosure line (small print) under the signature block.
  if (contract.esign_disclosure_snapshot) {
    if (doc.y + 30 > FOOTER_TOP - 12) doc.addPage();
    doc.moveDown(0.6);
    doc.fontSize(7.5).font('Helvetica-Oblique').fillColor(MUTED)
      .text(contract.esign_disclosure_snapshot, MARGIN_X, doc.y, { width: CONTENT_W, lineGap: 1.5 });
  }

  doc.end();
}

// Buffer variant for email attachments / archival (used by the post-sign
// executed-copy email). Mirrors invoice-pdf.js streamToBuffer.
function streamToBuffer(streamFn) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const buffSink = {
      setHeader() { /* noop — buffer path ignores HTTP headers */ },
      write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve(Buffer.concat(chunks));
      },
      on() {}, once() {}, emit() {},
    };
    try { streamFn(buffSink); } catch (err) { reject(err); }
  });
}

async function buildContractPDFBuffer(contract, customer, opts = {}) {
  return streamToBuffer((sink) => generateContractPDF(contract, customer, sink, opts));
}

module.exports = {
  generateContractPDF,
  buildContractPDFBuffer,
};
