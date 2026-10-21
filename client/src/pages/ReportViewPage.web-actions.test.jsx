// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import legacyLawnReport from './__fixtures__/legacy-lawn-report.json';

// GATE_REPORT_WEB_ACTIONS (owner 2026-10-20): the server adds data.webActions to a live simple-web payload only
// while the gate is live. The page then shows the finding tile and the photo button after the document.
// Without the key the page is what it was.

function renderReport(payload) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  return render(
    <MemoryRouter initialEntries={['/report/test-web-actions']}>
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

const FINDING = {
  kind: 'weeds',
  sentence: 'We saw weeds on this visit.',
  body: 'Lawn Care can take care of this. Tap below to see your estimate. Nothing is booked or charged.',
  button: 'See your estimate',
  tap: { serviceKey: 'lawn_care', serviceLabel: 'Lawn Care', optionId: 'lawn-enhanced', perApplication: 61.5, offerMode: 'priced', fingerprint: 'fp' },
};
const payload = (extra = {}) => ({
  ...structuredClone(legacyLawnReport), pdfUrl: '/api/reports/test-web-actions', simpleWebReport: true, glassWeb: true, ...extra,
});

describe('web actions on the simple web report', () => {
  it('without the key: no tile, no photo button', async () => {
    renderReport(payload());
    await screen.findByText(/This report is provided for your records/);
    expect(screen.queryByText('Seen something since?')).toBeNull();
    expect(screen.queryByText('We saw weeds on this visit.')).toBeNull();
  });

  it('with the key: the tile and the photo button come after the document', async () => {
    const { container } = renderReport(payload({ webActions: { finding: FINDING, photo: { type: 'lawn' } } }));
    await screen.findByText(/This report is provided for your records/);
    const doc = container.querySelector('.service-report-document');
    const tile = screen.getByText('We saw weeds on this visit.');
    const photo = screen.getByText('Seen something since?');
    expect(doc.compareDocumentPosition(tile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tile.compareDocumentPosition(photo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a photo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See your estimate' })).toBeInTheDocument();
  });

  it('the PDF render never shows them, whatever the payload carries', async () => {
    window.history.pushState({}, '', '/report/test-web-actions?mode=pdf');
    const { container } = renderReport(payload({ webActions: { finding: FINDING, photo: { type: 'lawn' } } }));
    await screen.findByText(/This report is provided for your records/);
    expect(container.textContent).not.toMatch(/Seen something since/);
    window.history.pushState({}, '', '/');
  });
});
