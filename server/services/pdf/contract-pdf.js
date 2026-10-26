// Branded PDF generator for document-library contracts/agreements
// (customer_contracts rows: Bora-Care, termite bonds, rodent guarantee,
// residential pest agreement, bed-bug prep, etc.).
//
// The body comes from the
// contract's rendered text snapshot; when the contract is signed, the
// execution details already captured on customer_contracts (signed name,
// initials, timestamp, signer IP/user-agent) are stamped into a signature
// block.
const PDFDocument = require('pdfkit');
const { formatDisplayDate } = require('../../utils/date-only');
const { PDF_COLORS } = require('./pdf-tokens');
const {
  FIELD_PDF_LAYOUT,
  drawFieldContinuationMasthead,
  drawFieldFooter,
  drawFieldMasthead,
} = require('./field-pdf');
const { signatureImageBuffer } = require('../signature-image');

const NAVY = PDF_COLORS.navy;
const WAVES_BLUE = PDF_COLORS.blue;
const GREEN = PDF_COLORS.green;
const BODY = PDF_COLORS.body;
const MUTED = PDF_COLORS.muted;
const RULE = PDF_COLORS.rule;

const PAGE_W = 612;
const MARGIN_X = 48;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const FOOTER_TOP = FIELD_PDF_LAYOUT.footerTop;
const BODY_TOP = 150; // below the header + title bar on page 1
const DRAWN_SIGNATURE_W = 240; // the drawn signature's box in the signature block
const DRAWN_SIGNATURE_H = 64;

const safeFilename = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'waves-agreement';

// "**Text**" on its own line = a bold line; the markers are not printed.
function splitBoldLines(text) {
  return String(text || '').split('\n').map((raw) => {
    const match = /^\*\*(.+)\*\*$/.exec(raw.trim());
    return match ? { text: match[1].trim(), bold: true } : { text: raw, bold: false };
  });
}

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

// Mirrors serializeContract / documentRequiresSignature in services/contracts:
// non-document-template contracts (e.g. autopay) always require a signature;
// document-library contracts honor the snapshot/template flag. View-only
// docs (Bora-Care outline, product guides) must NOT show a signature block.
function contractRequiresSignature(contract = {}) {
  if (contract.contract_type !== 'document_template') return true;
  if (contract.requires_signature_snapshot != null) return contract.requires_signature_snapshot !== false;
  if (contract.document_template_requires_signature != null) return contract.document_template_requires_signature !== false;
  return true;
}

// Drawn on page 1 only; the agreement body and signature lifecycle are
// intentionally independent of this presentation shell.
function drawHeader(doc, title, { signed }) {
  const statusLabel = signed ? 'Signed' : 'For review';
  const statusColor = signed ? GREEN : WAVES_BLUE;
  drawFieldMasthead(doc, {
    title,
    eyebrow: 'Service agreement',
    statusLabel: statusLabel.toUpperCase(),
    statusColor,
  });
}

// Drawn on every page (fixed position, independent of content flow).
function drawFooter(doc) {
  drawFieldFooter(doc, { tagline: 'Agreement and service terms' });
}

function recipientBlock(doc, { recipient, requestedDate }) {
  let y = Math.max(BODY_TOP, doc.y);
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
  // The drawn signature (customer_contracts.signature_image, a validated PNG/JPEG data URL) prints
  // above the typed name on the executed copy. An image that fails to decode is skipped, never fatal.
  const drawn = signed ? signatureImageBuffer(contract.signature_image) : null;
  // Keep the block together — push to a new page if it won't fit. A
  // countersigned agreement adds one more stamped line below.
  const needed = (contract.countersigned_at ? 130 : 96) + (drawn ? DRAWN_SIGNATURE_H + 8 : 0);
  if (doc.y + needed > FOOTER_TOP - 16) doc.addPage();

  let y = doc.y + 10;
  doc.save();
  doc.moveTo(MARGIN_X, y).lineTo(PAGE_W - MARGIN_X, y).lineWidth(0.75).strokeColor(RULE).stroke();
  doc.restore();
  y += 12;

  doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED).text('CUSTOMER SIGNATURE', MARGIN_X, y, { characterSpacing: 1.2 });
  y += 14;

  if (signed) {
    if (drawn) {
      try {
        doc.image(drawn, MARGIN_X, y, { fit: [DRAWN_SIGNATURE_W, DRAWN_SIGNATURE_H] });
        y += DRAWN_SIGNATURE_H + 8;
      } catch {
        // Not a decodable image after all: the typed signature below still stands.
      }
    }
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
      y += 11;
    }
  } else {
    doc.fontSize(11).font('Helvetica').fillColor('#9AA1B1').text('X ______________________________', MARGIN_X, y);
    y += 18;
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('Signature                                   Date', MARGIN_X, y);
    y += 13;
  }

  // Certified-operator countersignature — a RECORD step some agreements
  // (termite annual protection, A-14 owner ruling 2026-09-25) collect after
  // the customer signs. Never a blank ink line asking for one on the review
  // or unsigned copy — only stamped once customer_contracts.countersigned_at
  // is actually set. One blank line before it, per the ruling's wording.
  if (contract.countersigned_at) {
    y += 14;
    doc.fontSize(11).font('Helvetica').fillColor(BODY)
      .text(`Certified Operator: ${contract.countersigner_name || '—'}, ${formatDate(contract.countersigned_at)}`, MARGIN_X, y, { width: CONTENT_W });
  }
}

function generateContractPDF(contract, customer, sink, opts = {}) {
  const signed = opts.signed != null ? !!opts.signed : contract.status === 'signed';
  const requiresSignature = contractRequiresSignature(contract);
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
  // While the body prints, a page break (even inside one wrapped line) must
  // not leave the footer's small pale style on the rest of the body.
  let bodyFont = null;
  doc.on('pageAdded', () => {
    drawFooter(doc);
    const bodyTop = drawFieldContinuationMasthead(doc, { title: `${title} · continued` });
    if (bodyFont) doc.fontSize(10.5).font(bodyFont).fillColor(BODY);
    doc.x = MARGIN_X;
    doc.y = bodyTop;
  });

  drawHeader(doc, title, { signed });
  drawFooter(doc);

  let y = recipientBlock(doc, {
    // Prefer the contract's recipient override (e.g. property manager,
    // company contact) before the account customer / signed name.
    recipient: contract.recipient_name || customerName(customer, contract.signed_name),
    requestedDate: contract.shared_at || contract.created_at,
  });

  // Body — the rendered contract text snapshot. Flows across pages; the
  // pageAdded handler keeps a footer on each. A line wrapped in ** prints
  // bold (F.S. 482.227 wants termite-contract statements and headings in
  // bold type); a body with no such line prints exactly as before.
  const bodyText = contract.contract_text_snapshot || '';
  const bodyOptions = { width: CONTENT_W, align: 'left', lineGap: 3, paragraphGap: 6 };
  const bodyLines = splitBoldLines(bodyText);
  bodyFont = 'Helvetica';
  doc.fontSize(10.5).font(bodyFont).fillColor(BODY);
  if (!bodyLines.some((line) => line.bold)) {
    doc.text(bodyText, MARGIN_X, y, bodyOptions);
  } else {
    doc.text('', MARGIN_X, y, bodyOptions);
    for (const line of bodyLines) {
      bodyFont = line.bold ? 'Helvetica-Bold' : 'Helvetica';
      doc.fontSize(10.5).fillColor(BODY).font(bodyFont).text(line.text || ' ', MARGIN_X, doc.y, bodyOptions);
    }
  }
  bodyFont = null;
  doc.font('Helvetica');

  // View-only documents (requires_signature=false) get no signature block —
  // the signing page labels them "no signature required", and the PDF must
  // not contradict that by asking for a signature that can't be given.
  if (requiresSignature) signatureBlock(doc, contract, { signed });

  // E-sign disclosure line (small print) under the signature block.
  if (requiresSignature && contract.esign_disclosure_snapshot) {
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
  splitBoldLines,
};
