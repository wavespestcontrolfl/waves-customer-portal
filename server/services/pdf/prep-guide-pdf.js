// ============================================================
// prep-guide-pdf.js — downloadable prep guide PDF
//
// Renders the same interpolated prep blocks the public /prep/:token page
// shows (paragraph / heading / details / callout — email-only blocks are
// filtered upstream) as a branded document, so the action bar's Download
// button works on prep guides exactly like it does on service reports.
//
// Chrome follows the unified glass document family (doc-style unify #2543):
// pdf-tokens palette, the same navy header bar + soft title band as
// invoice-pdf / service-details-pdf.
// ============================================================

const PDFDocument = require('pdfkit');
const { PDF_COLORS } = require('./pdf-tokens');
const {
  FIELD_PDF_LAYOUT,
  drawFieldContinuationMasthead,
  drawFieldFooter,
  drawFieldMasthead,
  drawFieldSectionHeading,
} = require('./field-pdf');
const {
  WAVES_ADDRESS_LINE,
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_FL_LICENSE_LINE,
} = require('../../constants/business');

const NAVY = PDF_COLORS.navy;
const BODY = PDF_COLORS.body;
const MUTED = PDF_COLORS.muted;
const SOFT = PDF_COLORS.soft;

// Inline markdown links [label](https://…) in block prose — the PDF twin
// of email-template-library's renderInline link support and of
// PrepGuidePage's client-side renderInlineLinks. Same allowlist
// (http/https/mailto/tel); an unusable scheme is left as literal text.
// pdfkit text runs don't carry per-substring hit regions the way this
// flowing, wrapping body copy is laid out, so — same posture as
// email-template-library's own plain-text arm — a link renders as
// "label (https://…)" rather than as a clickable annotation. See the
// KNOWN GAP comment above renderInlineLinks in PrepGuidePage.jsx: this text
// arrives already {{variable}}-substituted by prep-public.js, so this is
// necessarily parsing server output, not author-only text.
const SAFE_HREF_RE = /^(https?:|mailto:|tel:)/i;
const MD_LINK_RE = /\[([^\]\n]+)\]\((\S+?)\)/g;

function isSafeHref(href) {
  return SAFE_HREF_RE.test(String(href || '').trim());
}

function renderLinksAsText(text) {
  const raw = text == null ? '' : String(text);
  if (!raw) return raw;
  MD_LINK_RE.lastIndex = 0;
  return raw.replace(MD_LINK_RE, (whole, label, href) => (
    isSafeHref(href) ? `${label} (${href.trim()})` : whole
  ));
}

const PAGE_W = 612;
const L = 40;
const W = PAGE_W - 80;
const CONTENT_BOTTOM = FIELD_PDF_LAYOUT.contentBottom;

function footer(doc) {
  drawFieldFooter(doc, {
    tagline: 'Service preparation guide',
    detail: `${WAVES_ADDRESS_LINE} · ${WAVES_FL_LICENSE_LINE}`,
  });
}

function ensureRoom(doc, needed) {
  if (doc.y + needed > CONTENT_BOTTOM) {
    footer(doc);
    doc.addPage();
    drawFieldContinuationMasthead(doc, { title: 'Service preparation guide · continued' });
  }
}

function headerBar(doc, title) {
  drawFieldMasthead(doc, {
    title,
    eyebrow: 'Service preparation',
    addressLine: WAVES_ADDRESS_LINE,
  });
  doc.y = Math.max(152, doc.y);
}

function sectionHeading(doc, text) {
  ensureRoom(doc, 46);
  doc.moveDown(0.8);
  doc.y = drawFieldSectionHeading(doc, text, L, doc.y, W);
}

function paragraph(doc, text) {
  if (!text) return;
  ensureRoom(doc, 40);
  doc.font('Helvetica').fontSize(9.5).fillColor(BODY)
    .text(text, L, doc.y, { width: W, lineGap: 2 });
  doc.moveDown(0.55);
}

// Label/value rows (service info + FAQ). Long values wrap; each row keeps
// label and value together on one page.
function detailsBlock(doc, rows) {
  const items = (rows || []).filter((r) => r && (r.label || r.value));
  if (!items.length) return;
  ensureRoom(doc, 40);
  doc.moveDown(0.2);
  for (const row of items) {
    const label = renderLinksAsText(String(row.label || ''));
    const value = renderLinksAsText(String(row.value || ''));
    doc.font('Helvetica-Bold').fontSize(8.5);
    const labelH = doc.heightOfString(label.toUpperCase(), { width: W, lineGap: 1 });
    doc.font('Helvetica').fontSize(9.5);
    const valueH = doc.heightOfString(value, { width: W, lineGap: 1.5 });
    ensureRoom(doc, labelH + valueH + 18);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED)
      .text(label.toUpperCase(), L, doc.y, { width: W, lineGap: 1 });
    doc.moveDown(0.15);
    doc.font('Helvetica').fontSize(9.5).fillColor(BODY)
      .text(value, L, doc.y, { width: W, lineGap: 1.5 });
    doc.moveDown(0.45);
  }
  doc.moveDown(0.2);
}

function calloutBlock(doc, text) {
  if (!text) return;
  doc.font('Helvetica').fontSize(9.5);
  const textH = doc.heightOfString(text, { width: W - 28, lineGap: 2 });
  const boxH = textH + 20;
  ensureRoom(doc, boxH + 16);
  const top = doc.y + 4;
  doc.save();
  doc.roundedRect(L, top, W, boxH, 6).fill(SOFT);
  doc.rect(L, top, 3, boxH).fill(NAVY);
  doc.restore();
  doc.font('Helvetica').fontSize(9.5).fillColor(NAVY)
    .text(text, L + 14, top + 10, { width: W - 28, lineGap: 2 });
  doc.y = top + boxH;
  doc.moveDown(0.7);
}

// Check-list rows — matches the email renderer's checklist block. Each
// item wraps under a hanging indent; a blank item (after link/whitespace
// resolution) is skipped so a payload-driven empty string leaves no
// dangling check mark.
const LIST_CHECK_GLYPH = '4'; // ZapfDingbats: heavy check mark

function listBlock(doc, items) {
  const rows = (items || []).map((item) => renderLinksAsText(String(item || '')).trim()).filter(Boolean);
  if (!rows.length) return;
  ensureRoom(doc, 30);
  doc.moveDown(0.2);
  const indent = 14;
  doc.font('Helvetica').fontSize(9.5);
  for (const row of rows) {
    const rowH = doc.heightOfString(row, { width: W - indent, lineGap: 2 });
    ensureRoom(doc, rowH + 8);
    const startY = doc.y;
    // U+2713 is not in the standard-14 WinAnsi set (Helvetica renders a
    // missing-glyph box); ZapfDingbats '4' is the heavy check mark (✔).
    doc.font('ZapfDingbats').fillColor(NAVY).text(LIST_CHECK_GLYPH, L, startY, { width: indent, lineGap: 2 });
    doc.font('Helvetica').fillColor(BODY).text(row, L + indent, startY, { width: W - indent, lineGap: 2 });
    doc.moveDown(0.35);
  }
  doc.moveDown(0.2);
}

/**
 * Stream the prep guide PDF into `res`.
 * @param {object} opts
 * @param {string} opts.title        Document title (e.g. "Flea Control Service Prep Guide")
 * @param {Array}  opts.blocks       Interpolated page blocks (email-only types already filtered)
 * @param {string} opts.technicianName
 * @param {string} opts.customerName
 * @param {string} opts.propertyAddress
 * @param {string} opts.fileName     Sanitized download filename
 * @param {object} res               Express response
 */
function renderPrepGuidePdf({ title, blocks, technicianName, customerName, propertyAddress, fileName }, res) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  doc.pipe(res);

  headerBar(doc, title);

  // Identity band (names + address only — same PII posture as the page).
  const identity = [customerName, propertyAddress].filter(Boolean).join(' · ');
  if (identity) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(identity, L, doc.y, { width: W });
    doc.moveDown(0.3);
  }
  if (technicianName) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`Your technician: ${technicianName}`, L, doc.y, { width: W });
    doc.moveDown(0.6);
  }

  for (const block of blocks || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'heading') sectionHeading(doc, String(block.content || ''));
    else if (block.type === 'paragraph') paragraph(doc, renderLinksAsText(String(block.content || '')));
    else if (block.type === 'details') detailsBlock(doc, block.rows);
    else if (block.type === 'callout') calloutBlock(doc, renderLinksAsText(String(block.content || '')));
    else if (block.type === 'list') listBlock(doc, block.items);
    // Unknown block types are skipped — same posture as the page renderer.
  }

  doc.moveDown(0.6);
  ensureRoom(doc, 24);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text(`Questions? Call or text us at ${WAVES_SUPPORT_PHONE_DISPLAY}.`, L, doc.y, { width: W });

  footer(doc);
  doc.end();
}

module.exports = { renderPrepGuidePdf };
