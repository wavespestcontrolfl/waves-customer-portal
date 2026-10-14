// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import ServiceReportDocument from './ServiceReportDocument';
import legacyLawnReport from './__fixtures__/legacy-lawn-report.json';

// GATE_LAWN_REPORT_COPY_FIXES (fix 4): a lawn report never prints the pest program's re-service
// wording. The server marks a lawn payload with lawnCopyFixes: true only while the gate is live;
// without the key the page is exactly what it was.

const PEST_SENTENCE = /WaveGuard members receive free re-service when covered activity continues/;

function renderReport(payload) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  return render(
    <MemoryRouter initialEntries={['/report/test-legacy-lawn']}>
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

describe('the live lawn report footer', () => {
  const payload = (extra = {}) => ({ ...structuredClone(legacyLawnReport), waveGuardTier: 'Gold', reserviceEligible: true, ...extra });

  it('without the key: the WaveGuard sentence and the booking link print, as before', async () => {
    renderReport(payload());
    const footer = (await screen.findByText(PEST_SENTENCE)).closest('footer');
    expect(footer).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Book a free re-service in your portal' })).toBeInTheDocument();
  });

  it('with lawnCopyFixes: neither the sentence nor the link prints, and the rest of the footer stays', async () => {
    const { container } = renderReport(payload({ lawnCopyFixes: true }));
    const footer = (await screen.findByText(/This report is provided for your records/)).closest('footer');
    expect(footer.textContent).not.toMatch(PEST_SENTENCE);
    expect(container.textContent).not.toMatch(PEST_SENTENCE);
    expect(screen.queryByRole('link', { name: 'Book a free re-service in your portal' })).toBeNull();
    expect(footer.textContent).toMatch(/Questions about today/);
    expect(footer.textContent).toMatch(/See every product we use and our safety protocol/);
  });
});

describe('the legacy re-service header on a lawn re-service', () => {
  const callback = (extra = {}) => ({
    ...structuredClone(legacyLawnReport),
    serviceType: 'Lawn Re-Service',
    serviceDisplayName: 'Lawn Re-Service',
    isCallback: true,
    reserviceReport: null,
    reserviceGateOn: false,
    ...extra,
  });

  it('without the key: the pest wording prints (the defect)', async () => {
    const { container } = renderReport(callback());
    await screen.findByText(/This report is provided for your records/);
    expect(container.textContent).toMatch(/address the activity you reported/);
  });

  it('with lawnCopyFixes: the pest wording never prints', async () => {
    const { container } = renderReport(callback({ lawnCopyFixes: true }));
    await screen.findByText(/This report is provided for your records/);
    expect(container.textContent).not.toMatch(/activity you reported/);
    expect(container.textContent).not.toMatch(/knock activity down/);
  });
});

describe('the PDF document footer', () => {
  const doc = (extra = {}) => ({
    serviceRecordId: '00000000-0000-4000-8000-000000000002',
    serviceDate: '2026-10-08T00:00:00.000Z',
    serviceDisplayName: 'Lawn Care',
    serviceLine: 'lawn',
    technicianName: 'Adam',
    customerName: 'Test Customer',
    serviceAddress: '123 Main St, Bradenton, FL 34209',
    waveGuardTier: 'Gold',
    ...extra,
  });

  it('without the key: the sentence prints, as before', () => {
    const { container } = render(<ServiceReportDocument data={doc()} token="tok123" />);
    expect(container.textContent).toMatch(PEST_SENTENCE);
  });

  it('with lawnCopyFixes: no pest re-service sentence; the rest of the footer stays', () => {
    const { container } = render(<ServiceReportDocument data={doc({ lawnCopyFixes: true })} token="tok123" />);
    expect(container.textContent).not.toMatch(PEST_SENTENCE);
    expect(container.textContent).toMatch(/Questions about today/);
  });

  it('a pest report is unchanged even if the key were present (the server never sets it there)', () => {
    const { container } = render(<ServiceReportDocument data={doc({ serviceLine: 'pest', lawnCopyFixes: undefined })} token="tok123" />);
    expect(container.textContent).toMatch(PEST_SENTENCE);
  });
});
