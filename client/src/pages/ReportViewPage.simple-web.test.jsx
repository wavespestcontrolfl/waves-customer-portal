// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
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
    const plainHeadings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    cleanup();

    const { container } = renderReport(payload({ simpleWebReport: true, glassWeb: true }));
    await screen.findByText(/This report is provided for your records/);
    const doc = container.querySelector('.service-report-document');
    expect(doc.classList.contains('is-glass')).toBe(true);
    expect(doc.querySelectorAll('[data-glass="card"]').length).toBeGreaterThan(5);
    const headings = screen.getAllByRole('heading', { level: 2 });
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
