// A service report PDF prints only a page built in the writer-rules state its
// key was computed under. The browser that renders the PDF fetches its own
// /data from the web process, so during a rolling restart (a flip of
// GATE_REPORT_WRITER_RULES, or a deploy where a page bundle or server from
// before this rule still answers) the page can carry the other state. /data in
// PDF mode names its state (`writerRules`), the page shows it on its root
// (data-writer-rules), and both PDF providers wait for the state of their own
// key: any other page never matches, so the render times out and nothing is
// stored (pre-push P1s on e73ee6952d, 0e897d73d1 and 51dc88d64d). Only a
// record whose render depends on the switch waits for the state; every other
// record renders the same in both states and waits for the root alone, also
// in a restart overlap (pre-push P1 on 47f088853e).
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

const fs = require('fs');
const path = require('path');
const { renderReportPdf, renderServiceReportV1Pdf, reportPdfReadySelector } = require('../services/service-report/pdf');
const { reportNoteRenderState } = require('../services/service-report/technician-report-copy');

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

  test('a record whose render does not depend on the switch waits for the root alone, with either provider', async () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    expect(reportPdfReadySelector(false)).toBe('.service-report-v1');
    process.env.PDF_RENDERER = 'playwright';
    await renderServiceReportV1Pdf({ token: 'tok-1' }, { serviceRecordId: 'service-1', dependsOnWriterRules: false });
    expect(mockPage.waitForSelector).toHaveBeenCalledWith('.service-report-v1', { timeout: 10000 });

    const calls = cloudflareFetch();
    await renderServiceReportV1Pdf({ token: 'tok-1' }, { serviceRecordId: 'service-1', dependsOnWriterRules: false });
    expect(calls[0].waitForSelector).toEqual({ selector: '.service-report-v1', visible: true, timeout: 10000 });
  });

  test('both render callers pass the flag from the record they key the render on', () => {
    ['services/service-report/pdf-queue.js', 'routes/reports-public.js'].forEach((file) => {
      const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const calls = source.split('renderServiceReportV1Pdf(data, {').slice(1).map((rest) => rest.slice(0, rest.indexOf('});')));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('dependsOnWriterRules: reportDependsOnWriterRules(service),');
      expect(calls[0]).toContain('reportNoteState: reportNoteRenderState(service, data),');
    });
  });

  test('a caller that names no selector keeps the report root alone', async () => {
    process.env.PDF_RENDERER = 'playwright';
    await renderReportPdf('https://example.test/report/tok-1?mode=pdf');
    expect(mockPage.waitForSelector).toHaveBeenCalledWith('.service-report-v1', { timeout: 10000 });
  });

  // The page side (the PDF document's root carries the state, in both
  // states) is a DOM test: client/src/pages/ServiceReportDocument.test.jsx.
});

// A record that carries the technician's own note keys its PDF with `-rn`
// (summaryCopySignature). A page bundle or server from before the note reader
// would print it with the legacy recap and merged note lines, so the render
// also waits for the root showing the note state of its own build: such a
// page never shows it, the render times out and nothing is stored (pre-push
// P1 on 0bc664ed4d and 5b51753cd0). A shown note's state names the digest of
// the signed note, so a page built from another read of the record never
// matches either (pre-push P1 on c020cecb69).
describe("a note record's PDF prints only a page built in its own note state", () => {
  const digestOf = (text) => require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 8);

  test('the ready selector adds the note state, with or without the writer-rules state', () => {
    process.env.GATE_REPORT_WRITER_RULES = 'true';
    expect(reportPdfReadySelector(true, 'shown:1a2b3c4d')).toBe('.service-report-v1[data-writer-rules="on"][data-report-note="shown:1a2b3c4d"]');
    expect(reportPdfReadySelector(false, 'withheld')).toBe('.service-report-v1[data-report-note="withheld"]');
    expect(reportPdfReadySelector(false, null)).toBe('.service-report-v1');
  });

  test('a note record render waits for that selector, with either provider', async () => {
    process.env.PDF_RENDERER = 'playwright';
    await renderServiceReportV1Pdf({ token: 'tok-1' }, { serviceRecordId: 'service-1', dependsOnWriterRules: false, reportNoteState: 'withheld' });
    expect(mockPage.waitForSelector).toHaveBeenCalledWith('.service-report-v1[data-report-note="withheld"]', { timeout: 10000 });

    const calls = cloudflareFetch();
    await renderServiceReportV1Pdf({ token: 'tok-1' }, { serviceRecordId: 'service-1', dependsOnWriterRules: false, reportNoteState: 'shown:1a2b3c4d' });
    expect(calls[0].waitForSelector).toEqual({ selector: '.service-report-v1[data-report-note="shown:1a2b3c4d"]', visible: true, timeout: 10000 });
  });

  test("the note state follows the record and the caller's own build", () => {
    const note = JSON.stringify({ reportNote: { v: 1, text: 'I treated the perimeter.', source: 'cleaned' } });
    const signed = 'I treated the perimeter. — Jordan';
    expect(reportNoteRenderState({ structured_notes: note }, { summaryIsOwnNote: true, summary: signed })).toBe(`shown:${digestOf(signed)}`);
    expect(reportNoteRenderState({ structured_notes: note }, { summary: 'Your routine service is complete.' })).toBe('withheld');
    // Stored notes that cannot be read count as a note, and no note prints.
    expect(reportNoteRenderState({ structured_notes: ['[Found] raw line'] }, {})).toBe('withheld');
    // Every other record names no state.
    expect(reportNoteRenderState({ structured_notes: JSON.stringify({ observations: [] }) }, { summaryIsOwnNote: true })).toBeNull();
    expect(reportNoteRenderState({}, {})).toBeNull();
  });

  test('two different accepted notes, or one note signed by two names, never share a state', () => {
    const note = JSON.stringify({ reportNote: { v: 1, text: 'I treated the perimeter.', source: 'cleaned' } });
    const states = ['I treated the perimeter. — Jordan', 'I treated the lanai and the garage. — Jordan', 'I treated the perimeter. — Casey']
      .map((summary) => reportNoteRenderState({ structured_notes: note }, { summaryIsOwnNote: true, summary }));
    expect(new Set(states).size).toBe(3);
    // So a page another read built never shows the selector the caller waits for.
    expect(new Set(states.map((state) => reportPdfReadySelector(false, state))).size).toBe(3);
  });
});
