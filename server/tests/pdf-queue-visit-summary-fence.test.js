// The PDF queue's Visit Summary cache fence (GATE_LAWN_VISIT_SUMMARY_V2, codex
// #6087 r6): a render is uncached only when the summary it printed differs from
// the one the key names, and only when the Visit Summary or the plain recap won
// the summary slot.
const { visitSummaryRenderMismatch } = require('../services/service-report/pdf-queue');

const base = { live: true, pinned: true, renderedSignature: ':vs=abc', keySignature: ':vs=abc' };

test('same signature: cache', () => {
  expect(visitSummaryRenderMismatch({ ...base, renderedSource: 'lawn_visit_summary' })).toBe(false);
});

test('the race: key names a frozen summary, the render printed the plain recap → do not cache', () => {
  expect(visitSummaryRenderMismatch({ ...base, renderedSource: 'recap', renderedSignature: '' })).toBe(true);
});

test('a technician report or typed narrative won the slot: no comparison, cache', () => {
  for (const renderedSource of ['technician_report', 'typed_narrative', 'rodent_narrative']) {
    expect(visitSummaryRenderMismatch({ ...base, renderedSource, renderedSignature: '' })).toBe(false);
  }
});

test('gate off or unpinned render: never fences', () => {
  expect(visitSummaryRenderMismatch({ ...base, live: false, renderedSource: 'recap', renderedSignature: '' })).toBe(false);
  expect(visitSummaryRenderMismatch({ ...base, pinned: false, renderedSource: 'recap', renderedSignature: '' })).toBe(false);
});

// Codex r7: the signature comes from the RENDERED page (the browser fetches its own /data), through
// the same channel as the image-failure count; the worker's own payload is only the fallback.
const { renderedVisitSummary } = require('../services/service-report/pdf-queue');
const { lawnVisitSummaryRenderedSignature } = require('../services/service-report/report-data');

describe('renderedVisitSummary: the page decides', () => {
  const TEXT = 'Today we applied a feeding, which fits the fall season.';
  const local = { summarySource: 'lawn_visit_summary', summary: TEXT };

  test('the page printed the summary: its signature, whatever the worker built', () => {
    const r = renderedVisitSummary({ source: 'lawn_visit_summary', summary: TEXT }, { summarySource: 'recap', summary: 'Thanks for having us.' });
    expect(r).toEqual({ source: 'lawn_visit_summary', signature: lawnVisitSummaryRenderedSignature(local) });
    expect(r.signature).toMatch(/^:vs=[0-9a-f]{8}$/);
  });

  test('the rolling-gate race: the worker built the summary, the page printed the recap -> mismatch with the key', () => {
    const key = lawnVisitSummaryRenderedSignature(local);
    const r = renderedVisitSummary({ source: 'recap', summary: null }, local);
    expect(r).toEqual({ source: 'recap', signature: '' });
    expect(visitSummaryRenderMismatch({ live: true, pinned: true, renderedSource: r.source, renderedSignature: r.signature, keySignature: key })).toBe(true);
  });

  test('the reverse: the key has no summary, the page printed one -> mismatch', () => {
    const r = renderedVisitSummary({ source: 'lawn_visit_summary', summary: TEXT }, { summarySource: 'recap', summary: 'x' });
    expect(visitSummaryRenderMismatch({ live: true, pinned: true, renderedSource: r.source, renderedSignature: r.signature, keySignature: '' })).toBe(true);
  });

  test('a page that reports a higher-precedence source: nothing to compare', () => {
    const r = renderedVisitSummary({ source: 'technician_report', summary: null }, local);
    expect(visitSummaryRenderMismatch({ live: true, pinned: true, renderedSource: r.source, renderedSignature: r.signature, keySignature: lawnVisitSummaryRenderedSignature(local) })).toBe(false);
  });

  test('a renderer that cannot report (Cloudflare, an old bundle): the worker payload is the fallback', () => {
    expect(renderedVisitSummary(null, local)).toEqual({ source: 'lawn_visit_summary', signature: lawnVisitSummaryRenderedSignature(local) });
    expect(renderedVisitSummary(undefined, { summarySource: 'recap', summary: 'x' })).toEqual({ source: 'recap', signature: '' });
  });
});

describe('the headless browser hands the printed summary back with the image count', () => {
  test('renderReportPdfWithBrowser returns visitSummary from window.__WAVES_PDF_VISIT_SUMMARY (null when unknown)', async () => {
    jest.resetModules();
    const evaluations = [];
    const page = {
      goto: async () => {},
      waitForSelector: async () => {},
      emulateMedia: async () => {},
      pdf: async () => Buffer.from('%PDF-1'),
      close: async () => {},
      evaluate: async (fn) => {
        const globals = { __WAVES_PDF_IMAGE_FAILURES: 0, __WAVES_PDF_VISIT_SUMMARY: { source: 'lawn_visit_summary', summary: 'Whole text.', extra: 'dropped' } };
        const saved = globalThis.__WAVES_PDF_IMAGE_FAILURES;
        Object.assign(globalThis, globals);
        try { const out = fn(); evaluations.push(out); return out; } finally {
          delete globalThis.__WAVES_PDF_VISIT_SUMMARY;
          if (saved === undefined) delete globalThis.__WAVES_PDF_IMAGE_FAILURES; else globalThis.__WAVES_PDF_IMAGE_FAILURES = saved;
        }
      },
    };
    jest.doMock('playwright', () => ({ chromium: { launch: async () => ({ newPage: async () => page, close: async () => {} }) } }));
    const { renderReportPdfWithBrowser } = require('../services/service-report/pdf-puppeteer');
    const out = await renderReportPdfWithBrowser('https://example.test/report/t?mode=pdf');
    expect(out.imageFailures).toBe(0);
    expect(out.visitSummary).toEqual({ source: 'lawn_visit_summary', summary: 'Whole text.' });
    // An old page bundle sets nothing: unknown, never a guess.
    page.evaluate = async (fn) => { try { return fn(); } catch { return null; } };
    const unknown = await renderReportPdfWithBrowser('https://example.test/report/t?mode=pdf');
    expect(unknown.visitSummary).toBeNull();
    jest.dontMock('playwright');
  });
});

describe('both PDF writers use the page-reported fence', () => {
  const read = (rel) => require('fs').readFileSync(require('path').join(__dirname, rel), 'utf8');
  test('pdf-queue and the public direct-PDF route take the rendered summary from the renderer and fence the store', () => {
    for (const rel of ['../services/service-report/pdf-queue.js', '../routes/reports-public.js']) {
      const src = read(rel);
      expect(src).toMatch(/renderedVisitSummary\(rendered\.visitSummary, data\)/);
      expect(src).toMatch(/visitSummaryRenderMismatch\(\{/);
    }
    expect(read('../services/service-report/pdf.js')).toMatch(/visitSummary: rendered\.visitSummary \?\? null/);
  });
});
