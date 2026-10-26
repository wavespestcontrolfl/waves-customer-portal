const PDFDocument = require('pdfkit');
const { formatDateOnly } = require('../../utils/date-only');
const { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_WEBSITE_HOST } = require('../../constants/business');
const { PDF_COLORS, PDF_TYPE } = require('./pdf-tokens');
const {
  FIELD_PDF_LAYOUT,
  drawFieldContinuationMasthead,
  drawFieldFooter,
  drawFieldMasthead,
  drawFieldSectionHeading,
} = require('./field-pdf');

function currency(value) {
  if (value == null || value === '') return 'Not available';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Not available';
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function statusFor(facts) {
  if (facts.declined && facts.unpaid) return {
    label: 'Declined · payment pending', color: PDF_COLORS.red,
    copy: 'Renewal declined. Payment is still pending. This record does not state that coverage is active.',
  };
  if (facts.declined) return {
    label: 'Renewal declined', color: PDF_COLORS.red,
    copy: 'Renewal declined. A nonrenewal decision is saved on this plan record.',
  };
  if (facts.unpaid) return {
    label: 'Payment pending', color: PDF_COLORS.red,
    copy: 'Payment is pending. This record does not state that coverage is active.',
  };
  return {
    label: 'Current plan', color: PDF_COLORS.navy,
    copy: 'This is the current saved plan record. No decline is recorded.',
  };
}

function renderAnnualPlanPdf(record) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 40, right: 40, bottom: 62, left: 40 },
      bufferPages: true,
      info: {
        Title: record?.title || 'Annual plan renewal',
        Author: 'Waves Pest Control',
        Subject: 'Renewal details',
      },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const facts = record?.facts || {};
    const status = statusFor(facts);
    const L = FIELD_PDF_LAYOUT.left;
    const W = FIELD_PDF_LAYOUT.contentWidth;
    const footer = () => drawFieldFooter(doc, {
      tagline: 'Informational annual-plan renewal record',
      detail: `${WAVES_SUPPORT_PHONE_DISPLAY} · ${WAVES_WEBSITE_HOST}`,
    });
    const ensureRoom = (needed) => {
      if (doc.y + needed <= FIELD_PDF_LAYOUT.contentBottom) return;
      doc.addPage();
      drawFieldContinuationMasthead(doc, { title: 'Annual plan renewal · continued' });
    };

    drawFieldMasthead(doc, {
      title: 'Annual plan renewal',
      eyebrow: 'Renewal details',
      statusLabel: status.label,
      statusColor: status.color,
    });
    doc.font('Helvetica').fontSize(PDF_TYPE.body).fillColor(PDF_COLORS.body)
      .text(
        'This informational record reflects the annual plan facts currently saved in your Waves account. '
          + 'It is not a renewal offer and does not replace your signed service agreement.',
        L, doc.y, { width: W, lineGap: 2 },
      );
    doc.moveDown(1.1);

    ensureRoom(180);
    doc.y = drawFieldSectionHeading(doc, 'Renewal details', L, doc.y, W);
    const rows = [
      ['Property', facts.propertyLabel || 'Not available'],
      ['Current plan amount', currency(facts.currentPlanAmount)],
      ['Current term ends', facts.awaitsInstallation
        ? 'Not yet set — awaiting installation'
        : formatDateOnly(facts.currentTermEnds, { fallback: 'Not available' })],
      ['Renewal decision', facts.declined ? 'Declined — nonrenewal is on file' : 'No decline recorded'],
      ['Payment status', facts.unpaid ? 'Payment pending — not shown as paid' : 'No payment-pending status on this record'],
    ];

    for (const [label, value] of rows) {
      doc.font('Helvetica').fontSize(PDF_TYPE.body);
      const rowHeight = Math.max(28, doc.heightOfString(String(value), { width: W - 182, lineGap: 1 }) + 12);
      ensureRoom(rowHeight + 2);
      const y = doc.y;
      doc.save();
      doc.moveTo(L, y + rowHeight).lineTo(L + W, y + rowHeight)
        .lineWidth(0.5).strokeColor(PDF_COLORS.rule).stroke();
      doc.font('Helvetica-Bold').fontSize(PDF_TYPE.caption).fillColor(PDF_COLORS.muted)
        .text(label.toUpperCase(), L + 8, y + 8, { width: 158, characterSpacing: 0.35 });
      doc.font('Helvetica').fontSize(PDF_TYPE.body).fillColor(PDF_COLORS.body)
        .text(String(value), L + 174, y + 7, { width: W - 182, lineGap: 1 });
      doc.restore();
      doc.y = y + rowHeight;
    }

    doc.moveDown(1.2);
    ensureRoom(86);
    const statusTop = doc.y;
    doc.save();
    doc.rect(L, statusTop, W, 64).fill(facts.declined || facts.unpaid ? PDF_COLORS.warm : PDF_COLORS.soft);
    doc.rect(L, statusTop, 4, 64).fill(status.color);
    doc.font('Helvetica-Bold').fontSize(PDF_TYPE.lead).fillColor(status.color)
      .text(status.label, L + 14, statusTop + 11, { width: W - 28 });
    doc.font('Helvetica').fontSize(PDF_TYPE.body).fillColor(PDF_COLORS.body)
      .text(status.copy, L + 14, statusTop + 30, { width: W - 28, lineGap: 1.5 });
    doc.restore();
    doc.y = statusTop + 76;

    if (facts.awaitsInstallation) {
      ensureRoom(56);
      doc.font('Helvetica-Bold').fontSize(PDF_TYPE.body).fillColor(PDF_COLORS.navy)
        .text('Awaiting installation', L, doc.y, { width: W });
      doc.moveDown(0.35);
      doc.font('Helvetica').fontSize(PDF_TYPE.body).fillColor(PDF_COLORS.body)
        .text(
          'The current term-end date has not been set from the installation yet, so no provisional date is shown here.',
          L, doc.y, { width: W, lineGap: 1.5 },
        );
    }

    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      footer();
    }
    doc.end();
  });
}

module.exports = { renderAnnualPlanPdf, _private: { currency, statusFor } };
