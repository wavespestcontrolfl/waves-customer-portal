const config = require('../../config');
const logger = require('../logger');

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

// pinnedLawnAssessmentId (#3168): the renderer navigates a headless browser to
// this page and the page fetches its own report data, so the only way to make
// the attachment's content deterministic is to tell the page which assessment
// to show. The data route validates the pin against what this token already
// exposes and refuses anything else.
function serviceReportViewerUrl(token, req, mode = 'pdf', { pinnedLawnAssessmentId = null } = {}) {
  const base = serviceReportPublicBase(req).replace(/\/+$/, '');
  const params = [];
  if (mode) params.push(`mode=${encodeURIComponent(mode)}`);
  if (pinnedLawnAssessmentId) {
    // The signature is what makes the pin trustworthy: the route refuses an
    // unsigned pin, because only this server may ask a report to render a
    // specific assessment — or none at all.
    //
    // If we CANNOT sign (no secret configured), emit no pin at all rather than
    // an unsigned one. An unsigned pin is refused, which fails the render,
    // which defers the delivery — so a missing secret would silently stop every
    // lawn report email until its retries exhausted. Degrading to an unpinned
    // render loses the pin's guarantee but keeps the post-render selection
    // re-check that shipped in #3146, and keeps mail flowing.
    const { signAssessmentPin } = require('./assessment-pin');
    const signed = signAssessmentPin(token, pinnedLawnAssessmentId);
    if (!signed) {
      // FAIL CLOSED. I previously degraded to an unpinned render here so a
      // missing secret could not stop mail — wrong trade. The post-render
      // fence cannot compensate: it compares the separately built `data`
      // assessment, not what the browser fetched, so an unpinned render can
      // still mail an attachment nothing verified. Stopping deliveries is
      // visible and recoverable (set the secret); mailing an attachment that
      // disagrees with the permanent report is silent and unrecallable. And a
      // missing JWT_SECRET would already have broken auth app-wide, so this is
      // not a realistic silent-degradation path.
      const err = new Error('report pin cannot be signed — set REPORT_PIN_SECRET or JWT_SECRET');
      err.code = 'report_pin_unsignable';
      err.retryable = true;
      throw err;
    }
    params.push(`assessment=${encodeURIComponent(pinnedLawnAssessmentId)}`);
    params.push(`asig=${encodeURIComponent(signed.signature)}`);
    params.push(`aexp=${encodeURIComponent(signed.expiresAt)}`);
  }
  const query = params.length ? `?${params.join('&')}` : '';
  return `${base}/report/${encodeURIComponent(token)}${query}`;
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

module.exports = {
  launchBrowser,
  renderReportPdfWithBrowser,
  serviceReportViewerUrl,
};
