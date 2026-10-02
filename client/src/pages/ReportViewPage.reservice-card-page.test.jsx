// @vitest-environment jsdom
// Full-page guard for the re-service report card: with the server payload key
// present the live report shows the glass sections (above the plan card, below
// the status hero); with the key absent — gate dark, older cache, not a
// callback — the rendered page is identical to the page without the feature.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import pestReportV2 from './__fixtures__/pest-report-v2.json';

const CALLBACK = {
  ...pestReportV2,
  isCallback: true,
  reserviceGateOn: true,
  reserviceEligible: true,
  reserviceReport: {
    serviceLine: 'pest',
    outcome: 'treated',
    heading: 'we came back and took care of it!',
    result: 'Re-service completed — we returned between your regular visits to address the activity you reported and re-treated the affected areas.',
    completedFallback: 'Reported activity areas were re-treated today.',
    expectation: 'Treatments can take several days to knock activity down fully — contact us if you are still seeing activity after two weeks.',
    includedWithWaveGuard: false,
    billingLine: null,
    billingReason: 'non_member',
  },
};

const CARD = {
  version: 1,
  youToldUs: { source: 'picker', quoted: true, lead: null, text: 'Ants are back in the kitchen.', pests: ['Ants'] },
  whatWeDid: {
    pests: ['ants'], where: 'inside and outside', found: { rating: 2, label: 'Low' },
    safetyLine: 'Keep kids and pets off treated areas until dry; your technician confirms the timing.',
  },
  stillSeeing: 'ants',
};

async function renderReport(payload) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  const view = render(
    <MemoryRouter initialEntries={['/report/test-reservice-card']}>
      <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(view.container.querySelector('#service-status')).not.toBeNull());
  return view;
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ReportViewPage re-service card', () => {
  it('gate on: both glass sections render right after the status hero, before the rest of the report', async () => {
    const { container } = await renderReport({ ...CALLBACK, reserviceReportCard: CARD });
    const told = container.querySelector('#reservice-you-told-us');
    const did = container.querySelector('#reservice-what-we-did');
    expect(told).toHaveAttribute('data-glass', 'card');
    expect(did).toHaveAttribute('data-glass', 'card');
    expect(told.textContent).toContain('“Ants are back in the kitchen.”');
    expect(did.querySelectorAll('[data-glass="soft"]').length).toBeGreaterThan(0);
    expect(told.querySelectorAll('[data-glass="chip"]').length).toBe(1);
    const hero = container.querySelector('#service-status');
    expect(hero.compareDocumentPosition(told) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(told.compareDocumentPosition(did) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The existing no-charge/re-service status copy is untouched.
    expect(container.textContent).toContain('Re-service completed');
    // The button reuses the footer's authenticated Schedule path.
    const cta = [...container.querySelectorAll('a')].find((a) => /Still seeing ants\? Tell us/.test(a.textContent));
    expect(cta).toHaveAttribute('href', '/?tab=schedule');
  });

  it('gate off (no reserviceReportCard key): the page is identical to a page that never knew the feature', async () => {
    const baseline = await renderReport({ ...CALLBACK });
    const baselineHtml = baseline.container.innerHTML;
    cleanup();
    const again = await renderReport({ ...CALLBACK, reserviceReportCard: undefined });
    expect(again.container.innerHTML).toBe(baselineHtml);
    expect(again.container.querySelector('#reservice-you-told-us')).toBeNull();
    expect(again.container.querySelector('#reservice-what-we-did')).toBeNull();
    expect(again.container.textContent).not.toContain('Still seeing');
  });
});
