// A service report PDF prints only a page built in the writer-rules state its
// key was computed under. The browser that renders the PDF fetches its own
// /data from the web process, so during a rolling restart (a flip of
// GATE_REPORT_WRITER_RULES, or a deploy where a page bundle or server from
// before this rule still answers) the page can carry the other state. /data in
// PDF mode names its state (`writerRules`), the page shows it on its root
// (data-writer-rules), and both PDF providers wait for the state of their own
// key: any other page never matches, so the render times out and nothing is
// stored (pre-push P1s on e73ee6952d, 0e897d73d1 and 51dc88d64d).
const mockPage = {
  goto: jest.fn().mockResolvedValue(),
  waitForSelector: jest.fn().mockResolvedValue(),
  emulateMedia: jest.fn().mockResolvedValue(),
  pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4\n')),
  evaluate: jest.fn().mockResolvedValue(null),
  close: jest.fn().mockResolvedValue(),
};
const mockBrowser = { newPage: jest.fn(async () => mockPage), close: jest.fn().mockResolvedValue() };
jest.mock('playwright', () => ({ chromium: { launch: jest.fn(async () => mockBrowser) } }));
jest.mock('../services/service-report/pdf-events', () => ({
  emitPdfRenderFailed: jest.fn(),
  emitPdfRenderSuccess: jest.fn(),
  safePdfRenderError: (err) => String(err?.message || err),
}));

const { renderReportPdf, renderServiceReportV1Pdf, reportPdfReadySelector } = require('../services/service-report/pdf');

const ENV_KEYS = ['GATE_REPORT_WRITER_RULES', 'PDF_RENDERER', 'CF_ACCOUNT_ID', 'CF_BROWSER_RENDERING_TOKEN'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = global.fetch;

afterEach(() => {
  ENV_KEYS.forEach((key) => {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  });
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function cloudflareFetch() {
  const calls = [];
  process.env.PDF_RENDERER = 'cloudflare';
  process.env.CF_ACCOUNT_ID = 'account-1';
  process.env.CF_BROWSER_RENDERING_TOKEN = 'token-1';
  global.fetch = jest.fn(async (endpoint, options) => {
    const body = Buffer.from('%PDF-1.4\n');
    calls.push(JSON.parse(options.body));
    return { ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  });
  return calls;
}

describe('a service report PDF prints only a page built in its own writer-rules state', () => {
  test('the ready selector names the state the key is computed under', () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    expect(reportPdfReadySelector()).toBe('.service-report-v1[data-writer-rules="on"]');
    process.env.GATE_REPORT_WRITER_RULES = 'false';
    expect(reportPdfReadySelector()).toBe('.service-report-v1[data-writer-rules="off"]');
  });

  test('a service report render waits for that selector, with either provider', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    process.env.PDF_RENDERER = 'playwright';
    await renderServiceReportV1Pdf({ token: 'tok-1' }, { serviceRecordId: 'service-1' });
    expect(mockPage.waitForSelector).toHaveBeenCalledWith('.service-report-v1[data-writer-rules="on"]', { timeout: 10000 });

    process.env.GATE_REPORT_WRITER_RULES = 'false';
    const calls = cloudflareFetch();
    await renderServiceReportV1Pdf({ token: 'tok-1' }, { serviceRecordId: 'service-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].waitForSelector).toEqual({ selector: '.service-report-v1[data-writer-rules="off"]', visible: true, timeout: 10000 });
  });

  test('a page that never shows the state fails the render', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    process.env.PDF_RENDERER = 'playwright';
    mockPage.waitForSelector.mockRejectedValueOnce(new Error('Timeout 10000ms exceeded'));
    await expect(renderServiceReportV1Pdf({ token: 'tok-1' }, { serviceRecordId: 'service-1' })).rejects.toThrow();
    expect(mockPage.pdf).not.toHaveBeenCalled();
  });

  test('a caller that names no selector keeps the report root alone', async () => {
    process.env.PDF_RENDERER = 'playwright';
    await renderReportPdf('https://example.test/report/tok-1?mode=pdf');
    expect(mockPage.waitForSelector).toHaveBeenCalledWith('.service-report-v1', { timeout: 10000 });
  });

  // The page side (the PDF document's root carries the state, in both
  // states) is a DOM test: client/src/pages/ServiceReportDocument.test.jsx.
});
