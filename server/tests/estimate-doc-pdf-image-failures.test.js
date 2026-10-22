// codex #6343 r12: the emailed estimate copy must not go out with a document
// whose satellite image failed to load (the page drops the image and counts the
// failure in window.__WAVES_PDF_IMAGE_FAILURES). The download route keeps the
// old behavior: a document without a map beats no document.
process.env.JWT_SECRET = 'qa-estimate-image-failures';
jest.mock('../services/service-report/pdf-puppeteer', () => ({ launchBrowser: jest.fn(), serviceReportPublicBase: () => 'https://example.invalid' }));
const { launchBrowser } = require('../services/service-report/pdf-puppeteer');
const { renderEstimateDocumentPdf } = require('../services/pdf/estimate-doc-pdf');

const ESTIMATE = { token: 'a'.repeat(64) };

function browserWithFailures(failures) {
  const page = {
    goto: jest.fn().mockResolvedValue(),
    waitForSelector: jest.fn().mockResolvedValue(),
    emulateMedia: jest.fn().mockResolvedValue(),
    pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-fake')),
    evaluate: jest.fn(async (fn) => {
      if (failures instanceof Error) throw failures;
      const previous = globalThis.__WAVES_PDF_IMAGE_FAILURES;
      if (failures === undefined) delete globalThis.__WAVES_PDF_IMAGE_FAILURES;
      else globalThis.__WAVES_PDF_IMAGE_FAILURES = failures;
      try { return fn(); } finally {
        if (previous === undefined) delete globalThis.__WAVES_PDF_IMAGE_FAILURES;
        else globalThis.__WAVES_PDF_IMAGE_FAILURES = previous;
      }
    }),
    close: jest.fn().mockResolvedValue(),
  };
  const browser = { newPage: jest.fn().mockResolvedValue(page), close: jest.fn().mockResolvedValue() };
  launchBrowser.mockResolvedValue(browser);
  return { page, browser };
}

afterEach(() => jest.resetAllMocks());

describe('renderEstimateDocumentPdf failOnImageErrors (opt-in)', () => {
  test('a failed image throws a tagged error and still closes the page and browser', async () => {
    const { page, browser } = browserWithFailures(1);
    await expect(renderEstimateDocumentPdf(ESTIMATE, { failOnImageErrors: true }))
      .rejects.toMatchObject({ code: 'estimate_doc_image_failed', imageFailures: 1 });
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  test('zero failures, or a counter the page does not report, returns the PDF', async () => {
    for (const failures of [0, undefined]) {
      browserWithFailures(failures);
      const out = await renderEstimateDocumentPdf(ESTIMATE, { failOnImageErrors: true });
      expect(Buffer.isBuffer(out)).toBe(true);
    }
  });

  test('a counter that cannot be read never fails the render', async () => {
    browserWithFailures(new Error('page gone'));
    const out = await renderEstimateDocumentPdf(ESTIMATE, { failOnImageErrors: true });
    expect(Buffer.isBuffer(out)).toBe(true);
  });

  test('without the option (the customer Download route) a failed image still returns the PDF and the counter is not read', async () => {
    const { page } = browserWithFailures(1);
    const out = await renderEstimateDocumentPdf(ESTIMATE);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});
