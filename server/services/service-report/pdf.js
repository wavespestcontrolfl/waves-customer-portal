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

/**
 * Cacheability probe for the photos the document prints (codex P2 #3176
 * r18): a photo that fails during the headless render is replaced by its
 * placeholder and the renderer still returns success, so the store paths
 * would key that output as the healthy PDF and serve the placeholder
 * forever. The browser's own fetch outcome is invisible from here (the
 * Cloudflare renderer returns only bytes), so the store-time proxy is the
 * server re-probing each printed photo URL: any unreachable photo marks the
 * render uncacheable — it is still SERVED (availability > completeness),
 * just not stored, so the next view re-renders once the photo is back.
 * Ranged GETs, not HEAD: presigned S3 URLs are method-specific and a HEAD
 * against a GET-presign 403s. Fail-soft per URL — a probe error counts as
 * unreachable, which only costs a re-render.
 */
/**
 * Every remote image URL the document prints, from the payload — the
 * server-side mirror of ServiceReportDocument's gallery assembly (its
 * galleryPhotos + v2AssessmentPhotos + momentPhotos + gaugePhoto sources,
 * plus the traced-map snapshot). Probing only data.photos left the other
 * four sources cacheable with placeholders (pre-push P1 r19) — keep this
 * list in lockstep with what the component renders.
 */
function collectRenderedImageUrls(data) {
  const urls = [
    ...(Array.isArray(data?.photos) ? data.photos : []).map((p) => p?.url),
    ...(Array.isArray(data?.reportV2?.photos) ? data.reportV2.photos : [])
      .map((p) => p?.url || p?.imageUrl),
    ...((data?.proofMoments || data?.visualServiceMoments || [])
      .filter((m) => m && m.mediaType !== 'video')
      .map((m) => m?.mediaUrl)),
    data?.mowingHeight?.photoUrl,
    data?.treatmentMap?.traced?.snapshotUrl,
  ];
  return [...new Set(urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)))];
}

async function countUnreachableReportPhotos(data, { timeoutMs = 2500 } = {}) {
  const urls = collectRenderedImageUrls(data);
  if (!urls.length) return 0;
  const probes = urls.map(async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
      });
      return (res.ok || res.status === 206) ? 0 : 1;
    } catch {
      return 1;
    } finally {
      clearTimeout(timer);
    }
  });
  return (await Promise.all(probes)).reduce((a, b) => a + b, 0);
}

// Normalized render result: { pdf, imageFailures }. imageFailures is the
// page's own count of image-load fallbacks (Playwright reads it after
// page.pdf()); null = unknown — the Cloudflare renderer returns only bytes,
// so callers fall back to the server-side URL probe there.
async function renderReportPdf(url, { serviceRecordId } = {}) {
  const provider = selectedPdfRenderer();
  if (provider === 'cloudflare_browser_rendering') {
    return { pdf: await renderReportPdfWithCloudflare(url, { serviceRecordId }), imageFailures: null };
  }
  return renderReportPdfWithBrowser(url);
}

async function renderServiceReportV1Pdf(data, {
  token, req, logger: callLogger, serviceRecordId, pinnedLawnAssessmentId = null,
} = {}) {
  const reportToken = token || data.token;
  const recordId = serviceRecordId || data.serviceRecordId || data.id || null;
  // The pin rides on the URL the browser opens — `data` never reaches the
  // renderer (#3168), so this is the only channel to the page.
  const url = serviceReportViewerUrl(reportToken, req, 'pdf', { pinnedLawnAssessmentId });
  const provider = selectedPdfRenderer();
  const started = Date.now();

  try {
    const rendered = await renderReportPdf(url, { serviceRecordId: recordId });
    const pdf = assertPdfBuffer(rendered.pdf, provider);
    const elapsedMs = Date.now() - started;
    emitPdfRenderSuccess({
      service_record_id: recordId,
      provider,
      elapsed_ms: elapsedMs,
      bytes: pdf.byteLength,
    });
    // imageFailures: the page's own image-load outcome (null = unknown,
    // e.g. the Cloudflare renderer) — store paths gate caching on it.
    return { pdf, imageFailures: rendered.imageFailures ?? null };
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
  countUnreachableReportPhotos,
  isPdfBuffer,
  renderReportPdf,
  renderReportPdfWithBrowser,
  renderReportPdfWithCloudflare,
  renderServiceReportV1Pdf,
  selectedPdfRenderer,
  serviceReportViewerUrl,
};
