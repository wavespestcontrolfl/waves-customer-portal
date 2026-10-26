'use strict';

// Bid kit Product List PDF (GATE_BID_KIT_PRODUCT_LIST_SYNC). Every product applied on a visit in the last 12 months, with its
// active ingredient, EPA Reg. No. and a Label and SDS link, in two tables: registered pesticides, then fertilizers, adjuvants
// and other products. Built with pdfkit like the other print documents (no browser). The caller (services/bid-kit-product-list.js)
// passes rows already read and sorted; nothing here reads the database or the clock.
const PDFDocument = require('pdfkit');
const { PDF_COLORS, PDF_TYPE } = require('./pdf-tokens');
const { FIELD_PDF_LAYOUT, drawFieldContinuationMasthead, drawFieldFooter, drawFieldMasthead } = require('./field-pdf');
const { validEpaRegNumber } = require('../epa-reg-number');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "2026-10-25" -> "October 25, 2026". The day is an Eastern calendar day text, so no time zone can move it.
function longDay(ymd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!match) return String(ymd || '');
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

const fileNameFor = (ymd) => `product-list-${ymd}.pdf`;

const isRegistered = (row) => validEpaRegNumber(row.epa_reg_number);

// The two tables: a row with a real EPA number is a registered pesticide; everything else is the second table.
function splitRows(rows) {
  const registered = [];
  const other = [];
  for (const row of rows) (isRegistered(row) ? registered : other).push(row);
  return { registered, other };
}

// What a Label or SDS cell shows: the word linked when there is a link; a missing link is bold "missing" for a registered
// pesticide (it must have one) and plain "n/a" for anything else.
function linkCell(url, label, registered) {
  const href = String(url || '').trim();
  if (href) return { text: label, link: href, bold: false, missing: false };
  return registered ? { text: 'missing', link: null, bold: true, missing: true } : { text: 'n/a', link: null, bold: false, missing: false };
}

function introLine({ businessName, licenseNumber, asOf }) {
  return `${businessName} · FDACS license ${licenseNumber} · Products applied in the 12 months to ${longDay(asOf)} (ET). `
    + 'Every pesticide is EPA-registered and used according to its label. '
    + 'Current labels and Safety Data Sheets are linked and are available in print on request.';
}

const COLUMNS = [
  { key: 'product', title: 'Product', width: 150 },
  { key: 'ingredient', title: 'Active ingredient', width: 150 },
  { key: 'epa', title: 'EPA Reg. No.', width: 92 },
  { key: 'label', title: 'Label', width: 70 },
  { key: 'sds', title: 'SDS', width: 70 },
];
const PAD = 6;
const FONT = PDF_TYPE.caption;

function drawHeaderRow(doc, y) {
  const { left } = FIELD_PDF_LAYOUT;
  doc.save();
  doc.rect(left, y, FIELD_PDF_LAYOUT.contentWidth, 18).fill(PDF_COLORS.soft);
  doc.font('Helvetica-Bold').fontSize(FONT).fillColor(PDF_COLORS.navy);
  let x = left;
  for (const column of COLUMNS) {
    doc.text(column.title, x + PAD, y + 5, { width: column.width - PAD * 2, lineBreak: false });
    x += column.width;
  }
  doc.restore();
  return y + 18;
}

function cellsFor(row) {
  const registered = isRegistered(row);
  return {
    product: String(row.name || ''),
    ingredient: String(row.active_ingredient || '') || 'n/a',
    epa: registered ? String(row.epa_reg_number).trim() : 'n/a',
    label: linkCell(row.label_url, 'Label', registered),
    sds: linkCell(row.sds_url, 'SDS', registered),
  };
}

function rowHeight(doc, cells) {
  doc.font('Helvetica').fontSize(FONT);
  const heights = ['product', 'ingredient', 'epa'].map((key) => {
    const column = COLUMNS.find((c) => c.key === key);
    return doc.heightOfString(cells[key], { width: column.width - PAD * 2 });
  });
  return Math.max(16, Math.ceil(Math.max(...heights)) + 8);
}

function drawRow(doc, cells, y, height) {
  const { left } = FIELD_PDF_LAYOUT;
  let x = left;
  for (const column of COLUMNS) {
    const value = cells[column.key];
    const options = { width: column.width - PAD * 2 };
    if (typeof value === 'string') {
      doc.font('Helvetica').fontSize(FONT).fillColor(PDF_COLORS.body).text(value, x + PAD, y + 4, options);
    } else if (value.link) {
      doc.font('Helvetica').fontSize(FONT).fillColor(PDF_COLORS.blue).text(value.text, x + PAD, y + 4, { ...options, link: value.link, underline: true });
    } else {
      doc.font(value.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT).fillColor(value.bold ? PDF_COLORS.red : PDF_COLORS.muted).text(value.text, x + PAD, y + 4, options);
    }
    x += column.width;
  }
  doc.moveTo(left, y + height).lineTo(left + FIELD_PDF_LAYOUT.contentWidth, y + height).lineWidth(0.5).strokeColor(PDF_COLORS.rule).stroke();
}

// One titled table; a new page (with the continuation masthead and a repeated header row) when a row would not fit.
function drawTable(doc, title, rows, startY) {
  const bottom = FIELD_PDF_LAYOUT.contentBottom;
  const newPage = () => {
    doc.addPage();
    return drawFieldContinuationMasthead(doc, { title: 'Product List · continued' });
  };
  let y = startY;
  if (y + 24 + 18 + 24 > bottom) y = newPage();
  doc.font('Helvetica-Bold').fontSize(PDF_TYPE.lead).fillColor(PDF_COLORS.navy).text(title, FIELD_PDF_LAYOUT.left, y, { lineBreak: false });
  y = drawHeaderRow(doc, y + 20);
  if (!rows.length) {
    doc.font('Helvetica').fontSize(FONT).fillColor(PDF_COLORS.muted).text('None in this period.', FIELD_PDF_LAYOUT.left + PAD, y + 5, { lineBreak: false });
    return y + 24;
  }
  for (const row of rows) {
    const cells = cellsFor(row);
    const height = rowHeight(doc, cells);
    if (y + height > bottom) y = drawHeaderRow(doc, newPage());
    drawRow(doc, cells, y, height);
    y += height;
  }
  return y + 14;
}

// rows: [{ name, active_ingredient, epa_reg_number, label_url, sds_url }] already sorted. asOf: an Eastern calendar day.
// Resolves to the PDF bytes.
function buildProductListPdf({ rows, asOf, businessName, licenseNumber }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true, info: { Title: 'Product List', Author: businessName } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      const { registered, other } = splitRows(rows);
      let y = drawFieldMasthead(doc, { title: 'Product List', eyebrow: 'Bid document' });
      doc.font('Helvetica').fontSize(PDF_TYPE.body).fillColor(PDF_COLORS.body);
      const intro = introLine({ businessName, licenseNumber, asOf });
      const introOptions = { width: FIELD_PDF_LAYOUT.contentWidth, lineGap: 2 };
      doc.text(intro, FIELD_PDF_LAYOUT.left, y, introOptions);
      y += doc.heightOfString(intro, introOptions) + 16;
      y = drawTable(doc, `Registered pesticides (${registered.length})`, registered, y);
      drawTable(doc, `Fertilizers, adjuvants and other products (${other.length})`, other, y);
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i += 1) {
        doc.switchToPage(i);
        drawFieldFooter(doc, { tagline: 'Product List', detail: `Page ${i + 1} of ${range.count}` });
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildProductListPdf, splitRows, linkCell, introLine, longDay, fileNameFor };
