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
});
