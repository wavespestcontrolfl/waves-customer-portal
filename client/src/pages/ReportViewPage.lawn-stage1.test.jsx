// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import { appliedRepeatsResult, withoutRepeatedAppliedCard } from '../components/report/lawnV2/lawnLayoutRules';
import mixedBase from './__fixtures__/lawn-layout/mixed-base.json';

// GATE_LAWN_REPORT_STAGE1_FIXES, the two web changes on the real page: (4) the "What we applied today" card that repeats
// Today's result is left out, (5) the hero leaves out the customer's email and phone. The payload is a saved synthetic lawn
// report (scripts/generate-lawn-report-layout-fixtures.js); the server adds `lawnStage1Fixes` only while the gate is live.

const clone = (value) => structuredClone(value);
const RESULT = 'Today we applied LESCO Dimension 0.21% 18-0-10 and Gravex 20 EW.';
const EMAIL = 'test.customer@example.com';
const PHONE = '555-0190';

// The fixture's own applied sentence starts with RESULT minus its final period and carries the targeting clause after it.
const withStage1 = (base, { layout = true, result = RESULT, flag = true } = {}) => {
  const payload = clone(base);
  if (!layout) delete payload.lawnLayout;
  if (flag) payload.lawnStage1Fixes = true;
  payload.reportV2.todaysResult = result;
  return payload;
};

function renderReport(payload) {
  window.history.pushState({}, '', '/report/tok-stage1');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  return render(
    <MemoryRouter initialEntries={['/report/tok-stage1']}>
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
const heroOf = (container) => container.querySelector('.service-report-hero');
const appliedLabels = (container) => [...container.querySelectorAll('[data-gt="eyebrow"], div, h2')]
  .filter((el) => el.children.length === 0 && el.textContent.trim().toLowerCase() === 'what we applied today');

describe('the pure rules', () => {
  it('appliedRepeatsResult: starts with the result minus its final period, nothing else', () => {
    expect(appliedRepeatsResult('Today we applied A and B, targeting chinch bugs.', 'Today we applied A and B.')).toBe(true);
    expect(appliedRepeatsResult('Today we applied A and B.', 'Today we applied A and B.')).toBe(true);
    // a curly apostrophe and a straight one read the same
    expect(appliedRepeatsResult('We’re done. Extra.', "We're done.")).toBe(true);
    expect(appliedRepeatsResult('Today we applied A.', 'Today we applied A and B.')).toBe(false);
    expect(appliedRepeatsResult('Today we applied A and B.', null)).toBe(false);
    expect(appliedRepeatsResult(null, 'Today we applied A.')).toBe(false);
    expect(appliedRepeatsResult('Today we applied A.', '')).toBe(false);
  });

  it('withoutRepeatedAppliedCard: no flag, no change; a pest report, no change; the same object when nothing repeats', () => {
    const noFlag = withStage1(mixedBase, { flag: false });
    expect(withoutRepeatedAppliedCard(noFlag)).toBe(noFlag);
    const pest = { ...withStage1(mixedBase), serviceLine: 'pest' };
    expect(withoutRepeatedAppliedCard(pest)).toBe(pest);
    const different = withStage1(mixedBase, { result: 'We visited today.' });
    expect(withoutRepeatedAppliedCard(different)).toBe(different);
  });

  it('withoutRepeatedAppliedCard: leaves out the lead and snapshot applied text only, the same object each call', () => {
    const payload = withStage1(mixedBase);
    const out = withoutRepeatedAppliedCard(payload);
    expect(out).not.toBe(payload);
    expect(out.reportV2.lead.applied).toBeNull();
    expect(out.reportV2.snapshot.treatmentSummary).toBeNull();
    expect(out.reportV2.lead.headline).toBe(payload.reportV2.lead.headline);
    expect(out.reportV2.lead.next).toBe(payload.reportV2.lead.next);
    expect(payload.reportV2.lead.applied).toMatch(/^Today we applied/); // the input is not touched
    expect(withoutRepeatedAppliedCard(payload)).toBe(out);
  });
});

describe('the lawn layout page', () => {
  it('gate off (no flag): the contact block and the applied card are as today', async () => {
    const { container } = renderReport(withStage1(mixedBase, { flag: false }));
    await waitForReport();
    expect(heroOf(container)).toHaveTextContent(EMAIL);
    expect(heroOf(container)).toHaveTextContent(PHONE);
    expect(appliedLabels(container)).toHaveLength(1);
  });

  it('gate on: the hero keeps the name and the service address and leaves out the email and phone', async () => {
    const { container } = renderReport(withStage1(mixedBase));
    await waitForReport();
    const hero = heroOf(container);
    expect(hero).toHaveTextContent('Test Customer');
    expect(hero).toHaveTextContent('456 Test Ave W, Testville, FL 34000');
    expect(hero).not.toHaveTextContent(EMAIL);
    expect(hero).not.toHaveTextContent(PHONE);
    expect(container.textContent).not.toContain(EMAIL);
  });

  it('gate on: the applied card that repeats Today\'s result is gone; the hero result and the Visit Summary stay', async () => {
    const { container } = renderReport(withStage1(mixedBase));
    await waitForReport();
    expect(appliedLabels(container)).toHaveLength(0);
    expect(heroOf(container)).toHaveTextContent(RESULT);
    expect(container.querySelector('#visit-summary')).not.toBeNull();
  });

  it('gate on, an applied card that does not start with the result: it stays', async () => {
    const { container } = renderReport(withStage1(mixedBase, { result: 'We visited today.' }));
    await waitForReport();
    expect(appliedLabels(container)).toHaveLength(1);
  });
});

describe('the standard page (no layout key)', () => {
  it('gate off: the applied card prints', async () => {
    const { container } = renderReport(withStage1(mixedBase, { layout: false, flag: false }));
    await waitForReport();
    expect(appliedLabels(container)).toHaveLength(1);
  });

  it('gate on: the repeated applied card is gone and the contact block drops the email and phone', async () => {
    const { container } = renderReport(withStage1(mixedBase, { layout: false }));
    await waitForReport();
    expect(appliedLabels(container)).toHaveLength(0);
    expect(heroOf(container)).toHaveTextContent('Test Customer');
    expect(heroOf(container)).not.toHaveTextContent(EMAIL);
    expect(heroOf(container)).not.toHaveTextContent(PHONE);
  });
});
