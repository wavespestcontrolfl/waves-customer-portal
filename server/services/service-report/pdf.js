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
  safePdfRenderError,
} = require('./pdf-events');

const CF_ENDPOINT = (accountId) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/pdf`;
const DEFAULT_CF_BROWSER_RENDERING_TIMEOUT_MS = 45000;

function cfBrowserRenderingTimeoutMs() {
  const parsed = Number(process.env.CF_BROWSER_RENDERING_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CF_BROWSER_RENDERING_TIMEOUT_MS;
}

function selectedPdfRenderer() {
  const requested = String(process.env.PDF_RENDERER || '').trim().toLowerCase();
  if (requested === 'cloudflare' || requested === 'cloudflare_browser_rendering') {
    return 'cloudflare_browser_rendering';
  }
  if (requested === 'puppeteer' || requested === 'playwright') {
    return 'puppeteer';
  }
  return process.env.CF_ACCOUNT_ID && process.env.CF_BROWSER_RENDERING_TOKEN
    ? 'cloudflare_browser_rendering'
    : 'puppeteer';
}

function isPdfBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.byteLength >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-';
}

function assertPdfBuffer(buf, provider) {
  if (isPdfBuffer(buf)) return buf;
  const err = new Error(`${provider} returned a non-PDF response`);
  err.code = 'invalid_pdf_response';
  throw err;
}

async function renderReportPdfWithCloudflare(url, { serviceRecordId } = {}) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_BROWSER_RENDERING_TOKEN;

  if (!accountId || !token) {
    throw new Error('Cloudflare Browser Rendering credentials missing');
  }

  const timeoutMs = cfBrowserRenderingTimeoutMs();
  try {
    const res = await fetch(CF_ENDPOINT(accountId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        url,
        viewport: { width: 816, height: 1056 },
        gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 },
        waitForSelector: { selector: '.service-report-v1', visible: true, timeout: 10000 },
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
      await res.text().catch(() => '');
      const err = new Error(`Cloudflare Browser Rendering failed`);
      err.status = res.status;
      err.serviceRecordId = serviceRecordId || null;
      throw err;
    }

    return assertPdfBuffer(
      Buffer.from(await res.arrayBuffer()),
      'Cloudflare Browser Rendering',
    );
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      const timeoutErr = new Error(`Cloudflare Browser Rendering timed out after ${timeoutMs}ms`);
      timeoutErr.code = 'pdf_render_timeout';
      timeoutErr.serviceRecordId = serviceRecordId || null;
      throw timeoutErr;
    }
    throw err;
  }
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
    const pdf = assertPdfBuffer(
      await renderReportPdf(url, { serviceRecordId: recordId }),
      provider,
    );
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
    const errText = safePdfRenderError(err);
    emitPdfRenderFailed({
      service_record_id: recordId,
      provider,
      status: err.status || null,
      elapsed_ms: elapsedMs,
      err: String(errText).slice(0, 500),
    });
    const log = callLogger || logger;
    log.error(`[service-report-v1-pdf] ${provider} render failed for ${recordId || 'unknown-record'}: ${errText}`);
    throw err;
  }
}

module.exports = {
  launchBrowser,
  assertPdfBuffer,
  cfBrowserRenderingTimeoutMs,
  isPdfBuffer,
  renderReportPdf,
  renderReportPdfWithBrowser,
  renderReportPdfWithCloudflare,
  renderServiceReportV1Pdf,
  selectedPdfRenderer,
  serviceReportViewerUrl,
};
