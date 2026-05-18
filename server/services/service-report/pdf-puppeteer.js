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
