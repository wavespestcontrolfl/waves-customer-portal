// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import cleanOff from './__fixtures__/lawn-layout/clean-off.json';
import cleanOn from './__fixtures__/lawn-layout/clean-on.json';
import SOD from '../dev-preview/new-sod-cards.json';

// GATE_LAWN_NEW_SOD_REPORT_CARD on the real page. The page prints the strings the server built from the block frozen at
// completion (data.lawnNewSod; the words are server/services/lawn-sod-report-card.js's, kept equal to the preview file
// by a server test) and restates no rule. "clean-off" is the standard page body, "clean-on" the lawn layout.

const clone = (value) => structuredClone(value);

function renderReport(payload, search = '') {
  window.history.pushState({}, '', `/report/tok-sod${search}`);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  return render(
    <MemoryRouter initialEntries={[`/report/tok-sod${search}`]}>
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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-09T15:10:00Z'));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const waitForReport = () => screen.findByText(/This report is provided for your records/);
const cardText = (container) => container.querySelector('[data-testid="lawn-new-sod"]')?.textContent ?? null;

describe.each([['the standard page', cleanOff], ['the lawn layout', cleanOn]])('the New sod card on %s', (_name, fixture) => {
  it('whole lawn: the title, the lead, each held item, the close; strings only', async () => {
    const { container } = renderReport({ ...clone(fixture), lawnNewSod: SOD.cards.whole });
    await waitForReport();
    expect(screen.getByRole('heading', { name: 'New sod (laid Oct 3)' })).toBeInTheDocument();
    const items = [...container.querySelectorAll('[data-testid="lawn-new-sod"] li')].map((li) => li.textContent);
    expect(items).toEqual([
      'fertilizer until Nov 2. New sod needs 30 days to root.',
      'weed spot spray until Nov 2, and until the sod has been mowed twice and does not lift.',
    ]);
    expect(cardText(container)).toContain('Today we held:');
    expect(cardText(container)).toContain('Everything else ran as normal. Same visit, same price.');
  });

  it('the bag swap sentence prints once', async () => {
    const { container } = renderReport({ ...clone(fixture), lawnNewSod: SOD.cards.swap });
    await waitForReport();
    expect(cardText(container).split('We used a fertilizer without pre-emergent in place of the usual bag.')).toHaveLength(2);
  });

  it('part of the lawn: the area and the rest-of-lawn sentence', async () => {
    const { container } = renderReport({ ...clone(fixture), lawnNewSod: SOD.cards.part });
    await waitForReport();
    expect(cardText(container)).toContain('Today we held these on the new sod area (Back left corner):');
    expect(cardText(container)).toContain('The rest of the lawn was treated as planned.');
  });

  it('no payload key (gate off, or nothing was held): no card, and the page text is what it was', async () => {
    const withKey = renderReport({ ...clone(fixture), lawnNewSod: SOD.cards.whole });
    await waitForReport();
    expect(cardText(withKey.container)).not.toBeNull();
    cleanup();
    const { container } = renderReport(clone(fixture));
    await waitForReport();
    expect(cardText(container)).toBeNull();
    expect(container.textContent).not.toContain('New sod');
  });

  it('the PDF and static views never print it', async () => {
    for (const mode of ['pdf', 'static']) {
      const { container } = renderReport({ ...clone(fixture), lawnNewSod: SOD.cards.whole }, `?mode=${mode}`);
      await waitForReport();
      expect(cardText(container)).toBeNull();
      cleanup();
    }
  });

  it('a card with nothing held prints nothing', async () => {
    const { container } = renderReport({ ...clone(fixture), lawnNewSod: { ...SOD.cards.whole, items: [] } });
    await waitForReport();
    expect(cardText(container)).toBeNull();
  });
});
