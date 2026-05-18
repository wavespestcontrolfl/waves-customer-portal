const { Buffer } = require('node:buffer');
const logger = require('../logger');
const {
  launchBrowser,
  renderReportPdfWithBrowser,
  serviceReportViewerUrl,
} = require('./pdf-puppeteer');
const {
  emitPdfRenderFailed,
  emitPdfRenderSuccess,
} = require('./pdf-events');

const CF_ENDPOINT = (accountId) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/pdf`;

function selectedPdfRenderer() {
  return String(process.env.PDF_RENDERER || 'puppeteer').trim().toLowerCase() === 'cloudflare'
    ? 'cloudflare_browser_rendering'
    : 'puppeteer';
}

async function renderReportPdfWithCloudflare(url, { serviceRecordId } = {}) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_BROWSER_RENDERING_TOKEN;

  if (!accountId || !token) {
    throw new Error('Cloudflare Browser Rendering credentials missing');
  }

  const res = await fetch(CF_ENDPOINT(accountId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      viewport: { width: 816, height: 1056 },
      gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 },
      emulateMediaType: 'print',
      pdfOptions: {
        format: 'letter',
        printBackground: true,
        margin: {
          top: '0.5in',
          right: '0.5in',
          bottom: '0.5in',
          left: '0.5in',
        },
        displayHeaderFooter: true,
        footerTemplate:
          '<div style="font-size:8px;width:100%;text-align:center;color:#999;">Waves Pest Control &middot; Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
        headerTemplate: '<div></div>',
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '<no body>');
    const err = new Error(`Cloudflare Browser Rendering failed: ${res.status} ${errText.slice(0, 200)}`);
    err.status = res.status;
    err.responseText = errText;
    err.serviceRecordId = serviceRecordId || null;
    throw err;
  }

  return Buffer.from(await res.arrayBuffer());
}

async function renderReportPdf(url, { serviceRecordId } = {}) {
  const provider = selectedPdfRenderer();
  if (provider === 'cloudflare_browser_rendering') {
    return renderReportPdfWithCloudflare(url, { serviceRecordId });
  }
  return renderReportPdfWithBrowser(url);
}

async function renderServiceReportV1Pdf(data, { token, req, logger: callLogger, serviceRecordId } = {}) {
  const reportToken = token || data.token;
  const recordId = serviceRecordId || data.serviceRecordId || data.id || null;
  const url = serviceReportViewerUrl(reportToken, req);
  const provider = selectedPdfRenderer();
  const started = Date.now();

  try {
    const pdf = await renderReportPdf(url, { serviceRecordId: recordId });
    const elapsedMs = Date.now() - started;
    emitPdfRenderSuccess({
      service_record_id: recordId,
      provider,
      elapsed_ms: elapsedMs,
      bytes: pdf.byteLength,
    });
    return pdf;
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const errText = err.responseText || err.message || String(err);
    emitPdfRenderFailed({
      service_record_id: recordId,
      provider,
      status: err.status || null,
      elapsed_ms: elapsedMs,
      err: String(errText).slice(0, 500),
    });
    const log = callLogger || logger;
    log.error(`[service-report-v1-pdf] ${provider} render failed for ${recordId || 'unknown-record'}: ${err.message}`);
    throw err;
  }
}

module.exports = {
  launchBrowser,
  renderReportPdf,
  renderReportPdfWithBrowser,
  renderReportPdfWithCloudflare,
  renderServiceReportV1Pdf,
  selectedPdfRenderer,
  serviceReportViewerUrl,
};
