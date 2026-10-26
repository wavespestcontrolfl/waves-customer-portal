const PDFDocument = require('pdfkit');
const { formatAddress } = require('../../utils/address-normalizer');
const {
  WAVES_FL_LICENSE_LINE,
  WAVES_PRODUCTS_SAFETY_URL,
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_WEBSITE_HOST,
} = require('../../constants/business');
const { PDF_COLORS, PDF_TYPE } = require('./pdf-tokens');
const {
  FIELD_PDF_LAYOUT,
  drawFieldContinuationMasthead,
  drawFieldFooter,
  drawFieldMasthead,
  drawFieldSectionHeading,
} = require('./field-pdf');

function formatServiceDate(value) {
  const date = new Date(typeof value === 'string' ? `${value}T12:00:00` : value);
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/New_York',
  });
}

function renderLegacyServiceReportPdf({
  service,
  products = [],
  weather = null,
  dryTimes = null,
  irrigation = null,
  reviewedNotes = '',
  fileName,
}, res) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 40, right: 40, bottom: 70, left: 40 },
  });
  const { left: L, contentWidth: W } = FIELD_PDF_LAYOUT;
  // PDFKit starts an implicit page once text reaches page.maxY(). Keep every
  // manual fit decision inside that same boundary so wrapped table cells can
  // never move themselves to an undecorated continuation page.
  const contentBottom = Math.min(FIELD_PDF_LAYOUT.contentBottom, doc.page.maxY());
  const serviceDate = formatServiceDate(service.service_date);
  let pageNumber = 1;
  let y;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  doc.pipe(res);

  const drawPageFooter = () => drawFieldFooter(doc, {
    tagline: `Service report · Page ${pageNumber}`,
    detail: `${WAVES_SUPPORT_PHONE_DISPLAY} · ${WAVES_WEBSITE_HOST}`,
  });

  doc.on('pageAdded', () => {
    pageNumber += 1;
    drawFieldContinuationMasthead(doc, { title: 'Service Report · continued' });
    drawPageFooter();
    y = doc.y;
  });

  y = drawFieldMasthead(doc, {
    title: 'Service Report',
    eyebrow: service.service_type || 'Visit documentation',
    reference: serviceDate,
    legalLine: `Licensed & Insured · ${WAVES_FL_LICENSE_LINE}`,
  });
  drawPageFooter();

  const addPage = () => {
    doc.addPage();
    y = doc.y;
  };

  const ensureSpace = (height) => {
    if (y + height > contentBottom) addPage();
  };

  const startSection = (title, minimumBodyHeight = 18) => {
    ensureSpace(34 + minimumBodyHeight);
    y = drawFieldSectionHeading(doc, title, L, y, W);
  };

  const textHeight = (text, {
    width = W - 16,
    font = 'Helvetica',
    size = PDF_TYPE.body,
    lineGap = 2,
  } = {}) => {
    doc.font(font).fontSize(size);
    return doc.heightOfString(String(text ?? ''), { width, lineGap });
  };

  const drawFlowingText = (text, {
    x = L + 8,
    width = W - 16,
    font = 'Helvetica',
    size = PDF_TYPE.body,
    color = PDF_COLORS.body,
    lineGap = 2,
    continuedTitle = '',
    link,
  } = {}) => {
    let remaining = String(text ?? '');
    while (remaining) {
      ensureSpace(size + lineGap + 2);
      doc.font(font).fontSize(size).fillColor(color);
      const available = contentBottom - y;
      const options = { width, lineGap, ...(link ? { link } : {}) };
      if (doc.heightOfString(remaining, options) <= available) {
        doc.text(remaining, x, y, options);
        y = doc.y + 8;
        return;
      }

      let low = 1;
      let high = remaining.length;
      let fitting = 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (doc.heightOfString(remaining.slice(0, middle), options) <= available) {
          fitting = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      const breakAt = remaining.lastIndexOf(' ', fitting);
      const cut = breakAt > Math.floor(fitting / 2) ? breakAt : fitting;
      const chunk = remaining.slice(0, cut).trimEnd();
      if (chunk) doc.text(chunk, x, y, options);
      remaining = remaining.slice(cut).trimStart();
      addPage();
      if (continuedTitle) startSection(`${continuedTitle} · continued`, size + lineGap + 2);
    }
  };

  const drawVisitDetails = () => {
    const columnGap = 16;
    const columnWidth = (W - columnGap) / 2;
    const rightX = L + columnWidth + columnGap;
    const customerRows = [
      { label: 'Name', value: `${service.first_name} ${service.last_name}` },
      {
        label: 'Address',
        value: formatAddress({
          line1: service.address_line1,
          city: service.city,
          state: service.state,
          zip: service.zip,
        }),
      },
      null,
    ];
    const serviceRows = [
      { label: 'Date', value: serviceDate },
      { label: 'Type', value: service.service_type },
      { label: 'Technician', value: service.technician_name || 'Waves Team' },
    ];

    startSection('Customer & Service Details', 112);
    doc.rect(L, y, W, 22).fill(PDF_COLORS.soft);
    doc.font('Helvetica-Bold').fontSize(PDF_TYPE.caption).fillColor(PDF_COLORS.navy)
      .text('Customer', L + 8, y + 6, { width: columnWidth - 16 })
      .text('Service Details', rightX + 8, y + 6, { width: columnWidth - 16 });
    y += 22;

    serviceRows.forEach((serviceRow, index) => {
      const customerRow = customerRows[index];
      const customerValue = customerRow?.value || '';
      const serviceValue = serviceRow.value || '—';
      const customerHeight = textHeight(customerValue, { width: columnWidth - 72, size: PDF_TYPE.caption, lineGap: 1 });
      const serviceHeight = textHeight(serviceValue, { width: columnWidth - 86, size: PDF_TYPE.caption, lineGap: 1 });
      const rowHeight = Math.max(24, customerHeight + 12, serviceHeight + 12);
      if (index % 2 === 1) doc.rect(L, y, W, rowHeight).fill(PDF_COLORS.soft);
      doc.moveTo(L, y + rowHeight).lineTo(L + W, y + rowHeight)
        .lineWidth(0.5).strokeColor(PDF_COLORS.rule).stroke();
      doc.moveTo(rightX - columnGap / 2, y).lineTo(rightX - columnGap / 2, y + rowHeight)
        .lineWidth(0.5).strokeColor(PDF_COLORS.rule).stroke();
      if (customerRow) {
        doc.font('Helvetica-Bold').fontSize(PDF_TYPE.caption).fillColor(PDF_COLORS.muted)
          .text(customerRow.label, L + 8, y + 7, { width: 50 });
        doc.font('Helvetica').fillColor(PDF_COLORS.body)
          .text(customerValue || '—', L + 64, y + 7, { width: columnWidth - 72, lineGap: 1 });
      }
      doc.font('Helvetica-Bold').fontSize(PDF_TYPE.caption).fillColor(PDF_COLORS.muted)
        .text(serviceRow.label, rightX + 8, y + 7, { width: 64 });
      doc.font('Helvetica').fillColor(PDF_COLORS.body)
        .text(serviceValue, rightX + 76, y + 7, { width: columnWidth - 84, lineGap: 1 });
      y += rowHeight;
    });
    y += 12;
  };

  const drawConditionsSection = () => {
    if (!weather) return;
    startSection('Conditions at Time of Service', 28);
    drawFlowingText(
      `Air Temp: ${weather.temp || '—'}°F  Humidity: ${weather.humidity || '—'}%  Wind: ${weather.wind || '—'}  Cloud Cover: ${weather.cloudCover || '—'}%`,
      { continuedTitle: 'Conditions at Time of Service' }
    );
    if (service.soil_temp) {
      drawFlowingText(
        `Soil Temp: ${service.soil_temp}°F  Soil pH: ${service.soil_ph || '—'}  Thatch: ${service.thatch_measurement || '—'}"  Moisture: ${service.soil_moisture || '—'}`,
        { continuedTitle: 'Conditions at Time of Service' }
      );
    }
    y += 4;
  };

  const drawNotesSection = () => {
    if (!reviewedNotes) return;
    startSection('Technician Notes', 32);
    drawFlowingText(reviewedNotes, { lineGap: 3, continuedTitle: 'Technician Notes' });
    y += 4;
  };

  drawVisitDetails();
  drawConditionsSection();
  drawNotesSection();

  const productColumns = [
    { key: 'product_name', label: 'Product', width: 170 },
    { key: 'active_ingredient', label: 'Active Ingredient', width: 150 },
    { key: 'moa_group', label: 'MOA Group', width: 100 },
    { key: 'product_category', label: 'Category', width: 112 },
  ];

  const drawProductHeader = () => {
    const rowHeight = 23;
    doc.rect(L, y, W, rowHeight).fill(PDF_COLORS.soft);
    let x = L;
    productColumns.forEach((column) => {
      doc.font('Helvetica-Bold').fontSize(PDF_TYPE.caption).fillColor(PDF_COLORS.navy)
        .text(column.label, x + 6, y + 7, { width: column.width - 12 });
      x += column.width;
      if (x < L + W) doc.moveTo(x, y).lineTo(x, y + rowHeight).lineWidth(0.5).strokeColor(PDF_COLORS.rule).stroke();
    });
    doc.moveTo(L, y + rowHeight).lineTo(L + W, y + rowHeight)
      .lineWidth(0.75).strokeColor(PDF_COLORS.rule).stroke();
    y += rowHeight;
  };

  const drawProductsSection = () => {
    if (!products.length) return;
    startSection('Products Applied', 52);
    drawProductHeader();
    products.forEach((product, index) => {
      const values = productColumns.map((column) => String(
        product[column.key] || (column.key === 'product_name' ? '' : '—')
      ));
      const rowHeight = Math.max(25, ...values.map((value, columnIndex) => (
        textHeight(value, { width: productColumns[columnIndex].width - 12, size: PDF_TYPE.caption, lineGap: 1 }) + 12
      )));
      if (y + rowHeight > contentBottom) {
        addPage();
        startSection('Products Applied · continued', 52);
        drawProductHeader();
      }
      if (index % 2 === 1) doc.rect(L, y, W, rowHeight).fill(PDF_COLORS.soft);
      let x = L;
      values.forEach((value, columnIndex) => {
        const column = productColumns[columnIndex];
        doc.font('Helvetica').fontSize(PDF_TYPE.caption).fillColor(PDF_COLORS.body)
          .text(value, x + 6, y + 7, { width: column.width - 12, lineGap: 1 });
        x += column.width;
        if (x < L + W) doc.moveTo(x, y).lineTo(x, y + rowHeight).lineWidth(0.5).strokeColor(PDF_COLORS.rule).stroke();
      });
      doc.moveTo(L, y + rowHeight).lineTo(L + W, y + rowHeight)
        .lineWidth(0.5).strokeColor(PDF_COLORS.rule).stroke();
      y += rowHeight;
    });
    y += 12;
  };

  const drawDryTimesSection = () => {
    if (!dryTimes) return;
    startSection('Estimated Dry Times', 28);
    if (dryTimes.lawn) drawFlowingText(`• Lawn treatment: ${dryTimes.lawn}`, { continuedTitle: 'Estimated Dry Times' });
    if (dryTimes.foundation) drawFlowingText(`• Foundation perimeter: ${dryTimes.foundation}`, { continuedTitle: 'Estimated Dry Times' });
    if (dryTimes.interior) drawFlowingText(`• Interior application: ${dryTimes.interior}`, { continuedTitle: 'Estimated Dry Times' });
    if (dryTimes.rainAdvisory) drawFlowingText(`Rain advisory: ${dryTimes.rainAdvisory}`, { continuedTitle: 'Estimated Dry Times' });
    y += 4;
  };

  const drawIrrigationSection = () => {
    if (!irrigation) return;
    startSection('Irrigation Recommendations', 28);
    if (irrigation.recommendation) {
      drawFlowingText(irrigation.recommendation, { lineGap: 3, continuedTitle: 'Irrigation Recommendations' });
    }
    (irrigation.instructions || []).forEach((instruction) => {
      const instructionHeight = Math.max(
        PDF_TYPE.body + 6,
        textHeight(instruction.text, { width: W - 34, size: PDF_TYPE.body }) + 8
      );
      if (y + instructionHeight > contentBottom) {
        addPage();
        startSection('Irrigation Recommendations · continued', instructionHeight);
      }
      // Standard Helvetica has no check/cross glyph. ZapfDingbats keeps the
      // existing allowed/not-allowed mark legible in the generated PDF.
      doc.font('ZapfDingbats').fontSize(PDF_TYPE.body).fillColor(PDF_COLORS.navy)
        .text(instruction.allowed ? '4' : '8', L + 8, y, { width: 12, lineBreak: false });
      drawFlowingText(instruction.text, {
        x: L + 26,
        width: W - 34,
        continuedTitle: 'Irrigation Recommendations',
      });
    });
    y += 4;
  };

  drawProductsSection();
  drawDryTimesSection();
  drawIrrigationSection();

  startSection('Report Information', 60);
  drawFlowingText(
    `This report is provided for your records. For questions contact Waves Pest Control at ${WAVES_SUPPORT_PHONE_DISPLAY}.`,
    { continuedTitle: 'Report Information' }
  );
  drawFlowingText(
    `Every product we use and our safety protocol: ${WAVES_PRODUCTS_SAFETY_URL}`,
    { continuedTitle: 'Report Information', link: `${WAVES_PRODUCTS_SAFETY_URL}#safety-protocol` }
  );
  drawFlowingText(
    `Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}`,
    { continuedTitle: 'Report Information', color: PDF_COLORS.muted, size: PDF_TYPE.micro }
  );

  doc.end();
}

module.exports = { formatServiceDate, renderLegacyServiceReportPdf };
