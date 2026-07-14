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
const { getLogoBuffer } = require('./brand-logo');
const { PDF_COLORS, PDF_TYPE } = require('./pdf-tokens');
const {
  WAVES_WEBSITE_HOST,
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_FL_LICENSE_LINE,
} = require('../../constants/business');

const NAVY = PDF_COLORS.navy;
const BODY = PDF_COLORS.body;
const MUTED = PDF_COLORS.muted;
const RULE = PDF_COLORS.rule;
const SOFT = PDF_COLORS.soft;
const HEADER_SUB = PDF_COLORS.headerSub;
const WHITE = PDF_COLORS.white;

const PAGE_W = 612;
const L = 40;
const W = PAGE_W - 80;
const FOOTER_TOP = 742;
const CONTENT_BOTTOM = FOOTER_TOP - 24;

// Guides are GLOBAL customer documents → headquarters contact line
// (2026-07-11 publishing rule, same as service-details-pdf).
const GUIDE_ADDRESS_LINE = '9040 Town Center Pkwy, Lakewood Ranch, FL 34202';

function footer(doc) {
  const previousBottomMargin = doc.page.margins.bottom;
  doc.save();
  doc.page.margins.bottom = 0;
  doc.moveTo(L, FOOTER_TOP).lineTo(L + W, FOOTER_TOP).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
  doc.text(`Waves Pest Control, LLC · ${GUIDE_ADDRESS_LINE} · ${WAVES_SUPPORT_PHONE_DISPLAY} · ${WAVES_WEBSITE_HOST}`, L, FOOTER_TOP + 6, { width: W, align: 'center' });
  doc.text(WAVES_FL_LICENSE_LINE, L, FOOTER_TOP + 17, { width: W, align: 'center' });
  doc.page.margins.bottom = previousBottomMargin;
  doc.restore();
}

function ensureRoom(doc, needed) {
  if (doc.y + needed > CONTENT_BOTTOM) {
    footer(doc);
    doc.addPage();
    doc.y = 48;
  }
}

function headerBar(doc, title) {
  doc.save();
  doc.rect(0, 0, PAGE_W, 92).fill(NAVY);
  const logoBuf = getLogoBuffer();
  if (logoBuf) {
    doc.image(logoBuf, 24, 10, { width: 72, height: 72 });
  } else {
    doc.fontSize(PDF_TYPE.display).font('Helvetica-Bold').fillColor(WHITE).text('WAVES', 40, 22);
    doc.fontSize(PDF_TYPE.caption).font('Helvetica').fillColor(HEADER_SUB).text('PEST CONTROL & LAWN CARE', 40, 52);
  }
  doc.fontSize(PDF_TYPE.micro).font('Helvetica').fillColor(HEADER_SUB).text(WAVES_FL_LICENSE_LINE, 108, 70);

  doc.fontSize(PDF_TYPE.body).font('Helvetica-Bold').fillColor(WHITE).text(WAVES_SUPPORT_PHONE_DISPLAY, 430, 22, { width: 142, align: 'right' });
  doc.fontSize(PDF_TYPE.micro).font('Helvetica').fillColor(HEADER_SUB).text(WAVES_WEBSITE_HOST, 430, 38, { width: 142, align: 'right' });
  doc.text('9040 Town Center Pkwy', 430, 52, { width: 142, align: 'right' });
  doc.text('Lakewood Ranch, FL 34202', 430, 64, { width: 142, align: 'right' });
  doc.restore();

  doc.save();
  doc.rect(0, 92, PAGE_W, 44).fill(SOFT);
  doc.fontSize(PDF_TYPE.h1).font('Helvetica').fillColor(NAVY).text(title, L, 104);
  doc.restore();
  doc.y = 152;
}

function sectionHeading(doc, text) {
  ensureRoom(doc, 46);
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text(text, L, doc.y, { width: W });
  doc.moveDown(0.35);
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.75).strokeColor(RULE).stroke();
  doc.moveDown(0.5);
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
    const label = String(row.label || '');
    const value = String(row.value || '');
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
    else if (block.type === 'paragraph') paragraph(doc, String(block.content || ''));
    else if (block.type === 'details') detailsBlock(doc, block.rows);
    else if (block.type === 'callout') calloutBlock(doc, String(block.content || ''));
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
