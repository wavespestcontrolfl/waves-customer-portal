const PDFDocument = require('pdfkit');
const config = require('../../config');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}

function serviceReportPublicBase(req) {
  const explicit = process.env.SERVICE_REPORT_PDF_BASE_URL || process.env.CLIENT_URL || config.clientUrl;
  if (explicit) return explicit;
  if (!req) return 'http://localhost:5173';
  return `${req.protocol}://${req.get('host')}`;
}

function serviceReportViewerUrl(token, req, mode = 'pdf') {
  const base = serviceReportPublicBase(req).replace(/\/+$/, '');
  const modeParam = mode ? `?mode=${encodeURIComponent(mode)}` : '';
  return `${base}/report/${encodeURIComponent(token)}${modeParam}`;
}

async function renderReportPdfWithBrowser(url) {
  if (!chromium) throw new Error('Playwright is not installed');
  const browser = await launchBrowser();
  let page = null;
  try {
    page = await browser.newPage({ viewport: { width: 1120, height: 1440 } });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('.service-report-v1', { timeout: 10000 });
    await page.emulateMedia({ media: 'print', colorScheme: 'light' });
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="font-size:8px; width:100%; text-align:center; color:#999;">Waves Pest Control &middot; Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function launchBrowser() {
  if (!chromium) throw new Error('Playwright is not installed');
  const baseOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };
  const requestedChannel = process.env.SERVICE_REPORT_PDF_BROWSER_CHANNEL;
  if (requestedChannel) {
    return chromium.launch({ ...baseOptions, channel: requestedChannel });
  }

  try {
    return await chromium.launch(baseOptions);
  } catch (err) {
    const canTrySystemChrome = /Executable doesn't exist|playwright install/i.test(err.message || '');
    if (!canTrySystemChrome) throw err;
    try {
      return await chromium.launch({ ...baseOptions, channel: 'chrome' });
    } catch {
      throw err;
    }
  }
}

function writeKeyValue(doc, label, value, x, y, width = 150) {
  doc.font('Helvetica').fontSize(8).fillColor('#666666').text(label, x, y, { width });
  doc.font('Helvetica').fontSize(13).fillColor('#171717').text(value || '-', x, y + 12, { width });
}

function renderFallbackPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 42 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const left = 42;
    const width = 528;
    doc.font('Helvetica').fontSize(10).fillColor('#525252').text('Waves service report', left, 42);
    doc.font('Helvetica').fontSize(28).fillColor('#171717').text(data.serviceLineDisplay || data.serviceType || 'Service report', left, 64, {
      width,
      lineGap: 2,
    });
    doc.fontSize(11).fillColor('#525252').text([
      data.serviceDate,
      data.technicianName,
      data.cityState,
    ].filter(Boolean).join(' | '), left, doc.y + 8);

    const bandTop = doc.y + 22;
    doc.rect(left, bandTop, width, 70).strokeColor('#d4d4d4').lineWidth(0.5).stroke();
    const metricWidth = width / 4;
    (data.metrics || []).slice(0, 4).forEach((metric, index) => {
      const x = left + metricWidth * index + 12;
      const raw = metric.value == null || metric.value === '' ? '-' : `${metric.value}${metric.unit ? ` ${metric.unit}` : ''}`;
      writeKeyValue(doc, metric.label, raw, x, bandTop + 16, metricWidth - 24);
      if (index > 0) doc.moveTo(left + metricWidth * index, bandTop).lineTo(left + metricWidth * index, bandTop + 70).stroke();
    });

    let y = bandTop + 96;
    doc.font('Helvetica').fontSize(16).fillColor('#171717').text('Customer advisory', left, y);
    y += 26;
    const advisory = data.advisory || {};
    writeKeyValue(doc, 'Exterior re-entry', advisory.exterior_reentry_min != null ? `${advisory.exterior_reentry_min} min` : '-', left, y, 160);
    writeKeyValue(doc, 'Interior re-entry', advisory.interior_reentry_min != null ? `${advisory.interior_reentry_min} min` : '-', left + 180, y, 160);
    writeKeyValue(doc, 'Irrigation hold', advisory.irrigation_hold_hr != null ? `${advisory.irrigation_hold_hr} hr` : '-', left + 360, y, 160);
    y += 58;
    if (advisory.pet_advisory) {
      doc.font('Helvetica').fontSize(10).fillColor('#525252').text(advisory.pet_advisory, left, y, { width });
      y = doc.y + 20;
    }

    doc.font('Helvetica').fontSize(16).fillColor('#171717').text('Application log', left, y);
    y = doc.y + 12;
    const applications = data.applications || [];
    if (!applications.length) {
      doc.fontSize(10).fillColor('#525252').text('No product applications were recorded for this visit.', left, y, { width });
      y = doc.y + 20;
    } else {
      for (const app of applications.slice(0, 12)) {
        if (y > 700) { doc.addPage(); y = 42; }
        const detail = [
          app.product?.epa_reg ? `EPA reg. ${app.product.epa_reg}` : null,
          app.product?.active_ingredient,
          app.rate && app.rateUnit ? `${app.rate} ${app.rateUnit}` : null,
          app.totalAmount && app.amountUnit ? `${app.totalAmount} ${app.amountUnit}` : null,
        ].filter(Boolean).join(' | ');
        doc.font('Helvetica').fontSize(11).fillColor('#171717').text(app.product?.name || 'Product application', left, y, { width });
        doc.font('Helvetica').fontSize(9).fillColor('#525252').text(detail || app.methodLabel || 'Application recorded', left, doc.y + 3, { width });
        y = doc.y + 12;
      }
    }

    doc.font('Helvetica').fontSize(16).fillColor('#171717').text('Findings and recommendations', left, y);
    y = doc.y + 12;
    const findings = data.findings || [];
    if (!findings.length) {
      doc.fontSize(10).fillColor('#525252').text('No issues were documented during this visit.', left, y, { width });
      y = doc.y + 20;
    } else {
      for (const finding of findings.slice(0, 12)) {
        if (y > 700) { doc.addPage(); y = 42; }
        doc.font('Helvetica').fontSize(11).fillColor('#171717').text(finding.title || 'Finding', left, y, { width });
        const body = [finding.detail, finding.recommendation].filter(Boolean).join(' ');
        if (body) doc.font('Helvetica').fontSize(9).fillColor('#525252').text(body, left, doc.y + 3, { width });
        y = doc.y + 12;
      }
    }

    doc.moveTo(left, 742).lineTo(left + width, 742).strokeColor('#d4d4d4').lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(8).fillColor('#999999')
      .text('Browser PDF rendering was unavailable, so this compact service report fallback was generated from the same v1 report data.', left, 752, { width, align: 'center' });
    doc.end();
  });
}

async function renderServiceReportV1Pdf(data, { token, req, logger } = {}) {
  const url = serviceReportViewerUrl(token || data.token, req);
  try {
    return await renderReportPdfWithBrowser(url);
  } catch (err) {
    if (logger) logger.warn(`[service-report-v1-pdf] browser render failed: ${err.message}`);
    return renderFallbackPdf(data);
  }
}

module.exports = {
  launchBrowser,
  renderFallbackPdf,
  renderReportPdfWithBrowser,
  renderServiceReportV1Pdf,
  serviceReportViewerUrl,
};
