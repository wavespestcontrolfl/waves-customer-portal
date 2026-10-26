const { getLogoBuffer } = require('./brand-logo');
const { PDF_COLORS, PDF_TYPE } = require('./pdf-tokens');
const {
  WAVES_ADDRESS_LINE,
  WAVES_BRAND_NAME,
  WAVES_BUSINESS_NAME,
  WAVES_FL_LICENSE_LINE,
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_WEBSITE_HOST,
} = require('../../constants/business');

// PDFKit twin of the approved Waves Field document shell. Coordinates are
// points on US Letter (612 x 792); callers keep ownership of document content
// and business copy while sharing the presentation-only page chrome.
const FIELD_PDF_LAYOUT = Object.freeze({
  pageWidth: 612,
  pageHeight: 792,
  left: 40,
  right: 572,
  contentWidth: 532,
  bodyTop: 150,
  footerTop: 748,
  contentBottom: 730,
  accentWidth: 5,
});

function drawFieldPageAccent(doc) {
  doc.save();
  doc.rect(0, 0, FIELD_PDF_LAYOUT.accentWidth, FIELD_PDF_LAYOUT.pageHeight)
    .fill(PDF_COLORS.blue);
  doc.restore();
}

function drawFieldMasthead(doc, {
  title,
  eyebrow = 'Customer document',
  reference = '',
  statusLabel = '',
  statusColor = PDF_COLORS.navy,
  legalLine = WAVES_FL_LICENSE_LINE,
  addressLine = WAVES_ADDRESS_LINE,
} = {}) {
  const { left: L, right: R, contentWidth: W } = FIELD_PDF_LAYOUT;
  drawFieldPageAccent(doc);

  doc.save();
  const logo = getLogoBuffer();
  if (logo) {
    doc.image(logo, L, 16, { width: 52, height: 52 });
  } else {
    doc.font('Helvetica-Bold').fontSize(PDF_TYPE.h1).fillColor(PDF_COLORS.navy)
      .text('WAVES', L, 26);
  }

  doc.font('Helvetica-Bold').fontSize(13).fillColor(PDF_COLORS.navy)
    .text(WAVES_BRAND_NAME, L + 64, 25, { width: 210 });
  doc.font('Helvetica').fontSize(PDF_TYPE.micro).fillColor(PDF_COLORS.muted)
    .text(legalLine, L + 64, 43, { width: 220 });

  doc.font('Helvetica-Bold').fontSize(PDF_TYPE.body).fillColor(PDF_COLORS.navy)
    .text(WAVES_SUPPORT_PHONE_DISPLAY, R - 190, 19, { width: 190, align: 'right' });
  doc.font('Helvetica').fontSize(PDF_TYPE.micro).fillColor(PDF_COLORS.muted)
    .text(WAVES_WEBSITE_HOST, R - 220, 34, { width: 220, align: 'right' })
    .text(addressLine, R - 250, 47, { width: 250, align: 'right' });

  doc.moveTo(L, 80).lineTo(R, 80).lineWidth(2).strokeColor(PDF_COLORS.navy).stroke();

  const refText = String(reference || statusLabel || '').trim();
  const titleWidth = refText ? W - 150 : W;
  doc.font('Helvetica-Bold').fontSize(PDF_TYPE.micro).fillColor(PDF_COLORS.muted)
    .text(String(eyebrow || '').toUpperCase(), L, 94, {
      width: titleWidth,
      characterSpacing: 0.8,
    });
  const titleTop = Math.max(107, doc.y + 4);
  const titleText = String(title || 'Document');
  let titleSize = 19;
  doc.font('Helvetica-Bold').fontSize(titleSize);
  while (titleSize > 13 && doc.widthOfString(titleText) > titleWidth) {
    titleSize -= 1;
    doc.fontSize(titleSize);
  }
  const titleOptions = { width: titleWidth, lineGap: 1 };
  const titleHeight = doc.heightOfString(titleText, titleOptions);
  doc.fillColor(PDF_COLORS.navy)
    .text(titleText, L, titleTop, titleOptions);

  if (refText) {
    doc.moveTo(R - 140, 96).lineTo(R - 140, 130).lineWidth(3).strokeColor(PDF_COLORS.gold).stroke();
    doc.font('Helvetica-Bold').fontSize(PDF_TYPE.caption).fillColor(statusColor)
      .text(refText, R - 128, 106, { width: 128, align: 'right', height: 22, ellipsis: true });
  }
  doc.restore();
  doc.y = Math.max(FIELD_PDF_LAYOUT.bodyTop, titleTop + titleHeight + 16);
  return doc.y;
}

function drawFieldContinuationMasthead(doc, { title = 'Document · continued' } = {}) {
  const { left: L, right: R } = FIELD_PDF_LAYOUT;
  drawFieldPageAccent(doc);
  doc.save();
  doc.font('Helvetica-Bold').fontSize(PDF_TYPE.lead).fillColor(PDF_COLORS.navy)
    .text(WAVES_BRAND_NAME, L, 24, { width: 190 });
  const titleOptions = { width: R - L - 200, align: 'right' };
  doc.font('Helvetica').fontSize(PDF_TYPE.caption).fillColor(PDF_COLORS.muted);
  const ruleY = Math.max(44, 25 + doc.heightOfString(title, titleOptions) + 6);
  doc.text(title, L + 200, 25, titleOptions);
  doc.moveTo(L, ruleY).lineTo(R, ruleY).lineWidth(2).strokeColor(PDF_COLORS.navy).stroke();
  doc.restore();
  doc.y = ruleY + 12;
  return doc.y;
}

function drawFieldSectionHeading(doc, text, x, y, width) {
  const w = width || FIELD_PDF_LAYOUT.contentWidth;
  doc.save();
  doc.font('Helvetica-Bold').fontSize(PDF_TYPE.lead);
  const headingOptions = { width: w - 20 };
  const headingHeight = Math.max(24, doc.heightOfString(text, headingOptions) + 14);
  doc.rect(x, y, w, headingHeight).fill(PDF_COLORS.soft);
  doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.75).strokeColor(PDF_COLORS.rule).stroke();
  doc.moveTo(x, y + headingHeight).lineTo(x + w, y + headingHeight).stroke();
  doc.fillColor(PDF_COLORS.navy).text(text, x + 10, y + 7, headingOptions);
  doc.restore();
  return y + headingHeight + 8;
}

function drawFieldFooter(doc, {
  tagline = 'Thank you for choosing Waves',
  detail = '',
  detailLink = '',
} = {}) {
  const { left: L, right: R, footerTop } = FIELD_PDF_LAYOUT;
  const previousBottomMargin = doc.page.margins.bottom;
  const previousX = doc.x;
  const previousY = doc.y;
  doc.save();
  doc.page.margins.bottom = 0;
  doc.moveTo(L, footerTop).lineTo(R, footerTop)
    .lineWidth(0.75).strokeColor(PDF_COLORS.rule).stroke();
  doc.font('Helvetica-Bold').fontSize(PDF_TYPE.micro).fillColor(PDF_COLORS.navy)
    .text(WAVES_BUSINESS_NAME, L, footerTop + 9, { width: 190 });
  doc.font('Helvetica').fontSize(7).fillColor(PDF_COLORS.muted)
    .text(tagline, L, footerTop + 21, { width: 245, height: 12, ellipsis: true });
  const detailOptions = {
      width: 265,
      align: 'right',
      height: 22,
      ellipsis: true,
      ...(detailLink ? { link: detailLink } : {}),
    };
  doc.font('Helvetica').fontSize(7).fillColor(PDF_COLORS.muted)
    .text(detail || `${WAVES_SUPPORT_PHONE_DISPLAY} · ${WAVES_WEBSITE_HOST}`, R - 265, footerTop + 11, detailOptions);
  doc.page.margins.bottom = previousBottomMargin;
  doc.restore();
  doc.x = previousX;
  doc.y = previousY;
}

module.exports = {
  FIELD_PDF_LAYOUT,
  drawFieldContinuationMasthead,
  drawFieldFooter,
  drawFieldMasthead,
  drawFieldPageAccent,
  drawFieldSectionHeading,
};
