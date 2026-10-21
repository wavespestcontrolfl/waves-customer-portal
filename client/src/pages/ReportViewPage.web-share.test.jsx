// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import legacyLawnReport from './__fixtures__/legacy-lawn-report.json';

// GATE_REPORT_WEB_SHARE (owner 2026-10-20): the server sends webShare only for a lawn score of 85+ on a
// live simple-web view. Without the key the page is exactly what it was.
function renderReport(payload) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  return render(
    <MemoryRouter initialEntries={['/report/test-web-share']}>
      <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
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

const payload = (extra = {}) => ({ ...structuredClone(legacyLawnReport), pdfUrl: '/api/reports/test-web-share', simpleWebReport: true, ...extra });

describe('the share your lawn button on the simple web report', () => {
  it('without webShare: no button', async () => {
    renderReport(payload());
    await screen.findByText(/This report is provided for your records/);
    expect(screen.queryByRole('button', { name: 'Share your lawn' })).toBeNull();
  });

  it('with webShare at 85 or more: the button shows after the document', async () => {
    const { container } = renderReport(payload({ glassWeb: true, webShare: { score: 85 } }));
    await screen.findByText(/This report is provided for your records/);
    const button = screen.getByRole('button', { name: 'Share your lawn' });
    const doc = container.querySelector('.service-report-document');
    expect(doc.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(doc.contains(button)).toBe(false);
  });

  it('a score under 85 in the key shows no button (the page checks too)', async () => {
    renderReport(payload({ webShare: { score: 84 } }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.queryByRole('button', { name: 'Share your lawn' })).toBeNull();
  });

  it('the old web report (no simpleWebReport) never shows it', async () => {
    renderReport(payload({ simpleWebReport: undefined, webShare: { score: 95 } }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.queryByRole('button', { name: 'Share your lawn' })).toBeNull();
  });
});
