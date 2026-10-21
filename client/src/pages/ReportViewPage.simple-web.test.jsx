// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage, { reportAskPrompts } from './ReportViewPage';
import legacyLawnReport from './__fixtures__/legacy-lawn-report.json';

// GATE_REPORT_SIMPLE_WEB (owner 2026-10-17): the server sets simpleWebReport on a live payload only while
// the gate is live; the page then shows the work-order document (the PDF's layout) with a Download PDF
// button. Without the key the page is exactly what it was.

function renderReport(payload) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  return render(
    <MemoryRouter initialEntries={['/report/test-simple-web']}>
      <Routes>
        <Route path="/report/:token" element={<ReportViewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((key) => delete store[key]); },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const payload = (extra = {}) => ({ ...structuredClone(legacyLawnReport), pdfUrl: '/api/reports/test-simple-web', ...extra });

describe('the simple web report', () => {
  it('without the key: the long web report renders, as before', async () => {
    const { container } = renderReport(payload());
    await screen.findByText(/This report is provided for your records/);
    expect(screen.getByLabelText('Report tools')).toBeInTheDocument();
    expect(container.querySelector('.service-report-document')).toBeNull();
  });

  it('with simpleWebReport: the work-order document renders with a Download PDF button', async () => {
    const { container } = renderReport(payload({ simpleWebReport: true }));
    await screen.findByText(/This report is provided for your records/);
    expect(container.querySelector('.service-report-document')).not.toBeNull();
    expect(screen.queryByLabelText('Report tools')).toBeNull();
    const pdf = screen.getByRole('link', { name: /Download PDF/ });
    expect(pdf.getAttribute('href')).toMatch(/\/reports\/test-simple-web$/);
    // it IS the online report: no line points the reader to "your online report"
    expect(container.textContent).not.toMatch(/online report/);
    expect(container.textContent).not.toMatch(/Full interactive report/);
    expect(container.textContent).toMatch(/Questions about today.s service\? Call /);
  });

  it('an internal-only payload keeps the old page and its review bar', async () => {
    const { container } = renderReport(payload({ simpleWebReport: true, internalOnly: true }));
    await screen.findByText(/This report is provided for your records/);
    expect(container.querySelector('.service-report-document')).toBeNull();
  });

  it('keeps the recap video at #visit-recap', async () => {
    const { container } = renderReport(payload({ simpleWebReport: true, recap: { ready: true, durationMs: 30000 } }));
    await screen.findByText(/This report is provided for your records/);
    expect(container.querySelector('#visit-recap video')).not.toBeNull();
  });

  it('gives the page a title heading and section headings', async () => {
    renderReport(payload({ simpleWebReport: true }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.getByRole('heading', { level: 1, name: 'SERVICE REPORT' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThan(3);
  });
});

// GATE_REPORT_GLASS_WEB (owner 2026-10-20): the server adds glassWeb beside simpleWebReport; the web page then
// dresses each section as a glass card. The PDF render never takes it.
describe('the glass look on the simple web report', () => {
  it('without glassWeb: no glass attributes anywhere in the document', async () => {
    const { container } = renderReport(payload({ simpleWebReport: true }));
    await screen.findByText(/This report is provided for your records/);
    const doc = container.querySelector('.service-report-document');
    expect(doc.classList.contains('is-glass')).toBe(false);
    expect(doc.querySelector('[data-glass], [data-gt], [data-glass-accent]')).toBeNull();
    expect(container.querySelector('a[data-glass-accent]')).toBeNull();
    expect(doc.style.background).toMatch(/#fff|rgb\(255, 255, 255\)/);
  });

  it('with glassWeb: every section is a glass card with a glass heading, same text and order', async () => {
    const plain = renderReport(payload({ simpleWebReport: true }));
    await screen.findByText(/This report is provided for your records/);
    const plainText = plain.container.querySelector('.service-report-document').textContent;
    const docHeadings = () => within(document.querySelector('.service-report-document')).getAllByRole('heading', { level: 2 });
    const plainHeadings = docHeadings().map((h) => h.textContent);
    cleanup();

    const { container } = renderReport(payload({ simpleWebReport: true, glassWeb: true }));
    await screen.findByText(/This report is provided for your records/);
    const doc = container.querySelector('.service-report-document');
    expect(doc.classList.contains('is-glass')).toBe(true);
    expect(doc.querySelectorAll('[data-glass="card"]').length).toBeGreaterThan(5);
    const headings = docHeadings();
    expect(headings.map((h) => h.textContent)).toEqual(plainHeadings);
    headings.forEach((h) => expect(h.getAttribute('data-gt')).toBe('eyebrow'));
    // the title is a role heading, never an h1/h2 element the theme would resize
    expect(doc.querySelector('h1, h2')).toBeNull();
    expect(doc.textContent).toBe(plainText);
    expect(screen.getByRole('link', { name: /Download PDF/ }).hasAttribute('data-glass-accent')).toBe(true);
    // the white sheet is gone so the scene shows through
    expect(doc.style.background).toBe('transparent');
    expect(document.documentElement.hasAttribute('data-glass-theme')).toBe(true);
  });

  it('the footer and the letterhead sit inside glass cards', async () => {
    const { container } = renderReport(payload({ simpleWebReport: true, glassWeb: true }));
    await screen.findByText(/This report is provided for your records/);
    const doc = container.querySelector('.service-report-document');
    expect(doc.querySelector('.doc-letterhead').closest('[data-glass="card"]')).not.toBeNull();
    expect(doc.querySelector('.doc-footer')?.getAttribute('data-glass')).toBe('card');
  });

  it('pdf mode never takes the glass, even with the key', async () => {
    window.history.pushState({}, '', '/report/test-simple-web?mode=pdf');
    try {
      const { container } = renderReport(payload({ simpleWebReport: true, glassWeb: true }));
      await screen.findByText(/This report is provided for your records/);
      const doc = container.querySelector('.service-report-document');
      expect(doc.classList.contains('is-glass')).toBe(false);
      expect(doc.classList.contains('is-web')).toBe(false);
      expect(doc.querySelector('[data-glass], [data-gt]')).toBeNull();
      expect(document.documentElement.hasAttribute('data-glass-theme')).toBe(false);
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

// Owner 2026-10-20: "keep the same buttons on top that we had before, and keep the Waves AI". With
// glassWeb the simple web report puts the Report Tools bar and then Ask Waves above the document.
describe('the report tools and Ask Waves on the glass simple web report', () => {
  it('glassWeb: tools bar, then Ask Waves, then the document; no lone Download PDF link', async () => {
    const { container } = renderReport(payload({ simpleWebReport: true, glassWeb: true }));
    await screen.findByText(/This report is provided for your records/);
    const tools = screen.getByLabelText('Report tools');
    const ask = screen.getByLabelText(/Waves AI/);
    const doc = container.querySelector('.service-report-document');
    expect(tools.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ask.compareDocumentPosition(doc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('link', { name: /Download PDF/ }).getAttribute('href')).toMatch(/\/reports\/test-simple-web$/);
    expect(screen.getAllByRole('link', { name: /Download PDF/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Portal Login/ })).toBeInTheDocument();
    // the bar carries its own rules here: the simple report has no .service-report-v1 sheet
    expect(container.querySelector('style').textContent).toContain('.report-action-buttons');
    expect(screen.getByLabelText('Ask Waves about this service report')).toBeInTheDocument();
  });

  it('glassWeb absent: today\'s page, a lone Download PDF link and no Ask Waves', async () => {
    renderReport(payload({ simpleWebReport: true }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.queryByLabelText('Report tools')).toBeNull();
    expect(screen.queryByLabelText(/Waves AI/)).toBeNull();
    expect(screen.getAllByRole('link', { name: /Download PDF/ })).toHaveLength(1);
  });

  it('Share copies the report link and shows the copied label', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...window.navigator, share: undefined, clipboard: { writeText } });
    renderReport(payload({ simpleWebReport: true, glassWeb: true }));
    await screen.findByText(/This report is provided for your records/);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await screen.findByRole('button', { name: /Link copied/ });
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/report\/test-simple-web$/));
  });

  it('asks the report route and shows the answer', async () => {
    const fetchMock = vi.fn(async (url) => (String(url).endsWith('/ask')
      ? { ok: true, status: 200, json: async () => ({ answer: 'Your next visit is in about 90 days.' }) }
      : { ok: true, status: 200, json: async () => payload({ simpleWebReport: true, glassWeb: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/report/test-simple-web']}>
        <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/This report is provided for your records/);
    fireEvent.change(screen.getByLabelText('Ask Waves about this service report'), { target: { value: 'When is my next visit?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByText('Your next visit is in about 90 days.');
    const askCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/reports/test-simple-web/ask'));
    expect(askCall[1].method).toBe('POST');
    expect(JSON.parse(askCall[1].body)).toEqual({ question: 'When is my next visit?' });
  });

  it('the example questions still read well from the simple web payload (built as the PDF is)', () => {
    const pdfBuilt = {
      serviceLine: 'pest',
      applications: [{ product: { name: 'Test Perimeter Spray' } }],
      pestPressure: { showOnCustomerReport: true, enabled: true },
      dynamicContext: { reentry: { targets: [{ label: 'Lawn', readyAt: '2026-10-20T20:00:00Z' }] } },
    };
    const prompts = reportAskPrompts(pdfBuilt, 'pest');
    expect(prompts).toContain('Why was Test Perimeter Spray used?');
    expect(prompts).toContain('When is my next service?');
    expect(prompts.length).toBeGreaterThanOrEqual(3);
    expect(prompts.length).toBeLessThanOrEqual(5);
    // a payload with none of the optional fields still gets the two plain questions
    expect(reportAskPrompts({ serviceLine: 'pest' }, 'pest')).toEqual(['What should I watch for next?', 'When is my next service?']);
  });
});

// GATE_REPORT_WEB_TOP (owner 2026-10-20): the server adds webTop beside simpleWebReport; the web page then shows the top
// card, the score strip and the rain bar, and trims the page (tap-to-open products, no letterhead, conditions on one
// line, one footer identity). The PDF never takes it.
describe('the first screen of the simple web report', () => {
  const webTop = () => ({
    score: { value: 72, previous: 61 },
    trend: [{ label: 'Aug 1', value: 61 }, { label: 'Sep 1', value: 66 }, { label: 'Oct 1', value: 72 }],
    action: 'Water in today’s treatment by Sat 9 AM.',
    hold: 'Keep pets off the lawn until it is dry.',
    rain: {
      days: [
        { date: '2026-10-09', inches: 0, isVisit: false }, { date: '2026-10-10', inches: 0.2, isVisit: true },
        { date: '2026-10-11', inches: 0.5, isVisit: false }, { date: '2026-10-12', inches: null, isVisit: false },
      ],
      sinceVisitInches: null,
    },
  });

  it('without webTop: no top card and the page is as it was', async () => {
    const { container } = renderReport(payload({ simpleWebReport: true }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.queryByTestId('web-top')).toBeNull();
    expect(container.querySelector('.doc-letterhead')).not.toBeNull();
    expect(container.querySelector('details.doc-web-product')).toBeNull();
    expect(container.querySelector('.doc-products')).not.toBeNull();
    expect(container.textContent).toMatch(/Family-owned pest control and lawn care in Southwest Florida/);
  });

  it('with webTop: the card shows before the document with the fixed sentences', async () => {
    const { container } = renderReport(payload({ simpleWebReport: true, webTop: webTop() }));
    await screen.findByText(/This report is provided for your records/);
    const card = screen.getByTestId('web-top');
    expect(card.textContent).toMatch(/Lawn score\s*72\s*out of 100/);
    expect(card.textContent).toMatch(/Up 11 points since your last visit\./);
    expect(card.textContent).toMatch(/Your last 3 visits/);
    expect(card.textContent).toMatch(/Do this\s*Water in today.s treatment by Sat 9 AM\./);
    expect(card.textContent).toMatch(/Hold off\s*Keep pets off the lawn until it is dry\./);
    expect(card.compareDocumentPosition(container.querySelector('.service-report-document')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the rain bar is dated, marks the visit day and leaves a gap day blank', async () => {
    renderReport(payload({ simpleWebReport: true, webTop: webTop() }));
    await screen.findByText(/This report is provided for your records/);
    const rain = screen.getByLabelText('Rain at your home');
    expect(rain.textContent).toMatch(/Rain since your visit/);
    expect(rain.textContent).toMatch(/Measured at your home, Oct 9 to Oct 11\./);
    expect(rain.textContent).toMatch(/Visit/);
    expect(within(rain).getByRole('img').getAttribute('aria-label')).toMatch(/Sat 0.2 inch, day of your visit.*Mon no reading/);
    expect(rain.textContent).not.toMatch(/Since your visit:/);
  });

  it('a total since the visit prints when every later day is measured', async () => {
    const t = webTop();
    t.rain = { days: t.rain.days.slice(0, 3), sinceVisitInches: 0.5 };
    renderReport(payload({ simpleWebReport: true, webTop: t }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.getByLabelText('Rain at your home').textContent).toMatch(/Since your visit: 0.5 in of rain\./);
  });

  it('a first visit has no strip; a pest card has no score', async () => {
    renderReport(payload({ simpleWebReport: true, webTop: { score: { value: 70, previous: null }, hold: 'Keep pets off treated areas until they are dry.' } }));
    await screen.findByText(/This report is provided for your records/);
    const card = screen.getByTestId('web-top');
    expect(card.textContent).toMatch(/This is your starting score\./);
    expect(card.textContent).not.toMatch(/Your last/);
    cleanup();
    renderReport(payload({ simpleWebReport: true, webTop: { action: 'Nothing needed from you today.' } }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.getByTestId('web-top').textContent).not.toMatch(/Lawn score/);
  });

  it('trims the page: tap-to-open products, no letterhead, conditions on one line, one footer identity', async () => {
    const { container } = renderReport(payload({ simpleWebReport: true, webTop: webTop() }));
    await screen.findByText(/This report is provided for your records/);
    expect(container.querySelector('.doc-letterhead')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'SERVICE REPORT' })).toBeInTheDocument();
    const products = container.querySelectorAll('details.doc-web-product');
    expect(products.length).toBe(3);
    expect(container.querySelector('.doc-products')).toBeNull();
    expect(products[0].querySelector('summary').textContent).toBe('LESCO K-Flow 0-0-25');
    expect(products[0].textContent).toMatch(/EPA Reg\. No\.:/);
    expect(products[0].hasAttribute('open')).toBe(false);
    expect(container.textContent).not.toMatch(/Family-owned pest control and lawn care in Southwest Florida/);
    // conditions: one line, no card of rows
    expect(screen.queryByRole('heading', { level: 2, name: 'Conditions' })).toBeNull();
    expect(container.textContent).toMatch(/Conditions:/);
  });

  it('conditions read as one line of facts', async () => {
    const { container } = renderReport(payload({ simpleWebReport: true, webTop: {}, conditions: { temp_f: 82, humidity_pct: 60, wind_mph: 5, sky: 'Sunny' } }));
    await screen.findByText(/This report is provided for your records/);
    expect(container.textContent).toMatch(/Conditions: 82 °F · 60% humidity · 5 mph wind · Rain this week [\d.]+ in · Sunny/);
  });

  it('an empty webTop still trims the page and shows no card', async () => {
    const { container } = renderReport(payload({ simpleWebReport: true, webTop: {} }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.queryByTestId('web-top')).toBeNull();
    expect(container.querySelector('.doc-letterhead')).toBeNull();
  });

  it('pdf mode never takes the trims, even with the key', async () => {
    window.history.pushState({}, '', '/report/test-simple-web?mode=pdf');
    try {
      const { container } = renderReport(payload({ simpleWebReport: true, webTop: webTop() }));
      await screen.findByText(/This report is provided for your records/);
      expect(screen.queryByTestId('web-top')).toBeNull();
      expect(container.querySelector('.doc-letterhead')).not.toBeNull();
      expect(container.querySelector('details.doc-web-product')).toBeNull();
      expect(container.querySelector('.doc-products')).not.toBeNull();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});
