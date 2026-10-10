// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import wetBase from './__fixtures__/lawn-layout/rainwet-base.json';
import wetOn from './__fixtures__/lawn-layout/rainwet-polish.json';
import dryBase from './__fixtures__/lawn-layout/raindry-base.json';
import dryOn from './__fixtures__/lawn-layout/raindry-polish.json';
import noneBase from './__fixtures__/lawn-layout/rainnone-base.json';
import noneOn from './__fixtures__/lawn-layout/rainnone-polish.json';

// GATE_LAWN_WATER_RAIN on the real page (saved payloads built by scripts/generate-lawn-report-layout-fixtures.js with the
// real server builders; "-base" is a record with no frozen permission, "-polish" one that froze it). Was: GATE_LAWN_REPORT_POLISH on the real page: the Water card's third state, one label line per product card, and the
// status card's keep-off line. The payloads are saved synthetic lawn reports built by
// scripts/generate-lawn-report-layout-fixtures.js with the real server builders (the water context, the frozen
// label-line decision, the re-entry condition); "-base" is the gate off, "-polish" the gate on.

const clone = (value) => structuredClone(value);

function renderReport(payload, search = '') {
  window.history.pushState({}, '', `/report/tok-polish${search}`);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  return render(
    <MemoryRouter initialEntries={[`/report/tok-polish${search}`]}>
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
const text = (container) => {
  const copy = container.cloneNode(true);
  copy.querySelectorAll('style').forEach((node) => node.remove());
  return copy.textContent;
};

const waterCard = (container) => [...container.querySelectorAll('section')].find((el) => el.textContent.includes('Water This Week'));
const COVERED_START = 'Rain alone covered your lawn this week. Leave the sprinklers off until the grass shows folded blades, a blue-gray tint, or footprints that stay pressed in, then run one full cycle on an allowed watering day.';
const SENSOR = 'Florida law requires a rain shutoff device on an automatic sprinkler system. If yours skipped a run this week, it is working.';

describe('the rain card on the real page', () => {
  it('6 inches + a schedule, no frozen permission: today\'s card ("Above target", "ease back")', async () => {
    const { container } = renderReport(clone(wetBase));
    await waitForReport();
    const card = waterCard(container);
    expect(card).toHaveTextContent('Above target');
    expect(card).toHaveTextContent('Easing back on irrigation');
    expect(card).not.toHaveTextContent('Rain covered it');
    expect(card.querySelector('[data-testid="lawn-water-rain-sensor"]')).toBeNull();
  });

  it('6 inches + a schedule, permission frozen: "Rain covered it", the sentence, the sensor line once, the measured rain', async () => {
    const { container } = renderReport(clone(wetOn));
    await waitForReport();
    const card = waterCard(container);
    expect(card).toHaveTextContent('Rain covered it');
    expect(card).not.toHaveTextContent('Above target');
    expect(card).toHaveTextContent(COVERED_START);
    const sentence = [...card.querySelectorAll('p')].find((el) => el.textContent === COVERED_START);
    expect(sentence.closest('details')).toBeNull(); // visible on the card, not folded away
    expect(card.textContent.split(SENSOR).length - 1).toBe(1);
    expect(text(container).split(SENSOR).length - 1).toBe(1); // card only
    expect(card).toHaveTextContent('6"');
    expect(card).not.toHaveTextContent('Easing back');
  });

  it('6 inches, no schedule on file: the soaking week is said, and the schedule call to action stays', async () => {
    const off = renderReport(clone(noneBase));
    await waitForReport();
    expect(waterCard(off.container)).not.toHaveTextContent('Rain alone covered');
    cleanup();
    const { container } = renderReport(clone(noneOn));
    await waitForReport();
    const card = waterCard(container);
    expect(card).toHaveTextContent('Rain covered it');
    expect(card).toHaveTextContent(COVERED_START);
    expect(card).toHaveTextContent('Add your watering schedule');
  });

  it('a dry week after the soaking: the new deficit sentence, no "few minutes", no sensor line', async () => {
    const off = renderReport(clone(dryBase));
    await waitForReport();
    expect(waterCard(off.container)).toHaveTextContent('A little more irrigation time will help');
    cleanup();
    const { container } = renderReport(clone(dryOn));
    await waitForReport();
    const card = waterCard(container);
    expect(card).toHaveTextContent('Below target');
    expect(card).toHaveTextContent('Your weekly water is below');
    expect(card).toHaveTextContent('If the grass shows folded blades, a blue-gray tint, or footprints that stay pressed in, run one full cycle on your next allowed watering day.');
    expect(card).not.toHaveTextContent(/few minutes|more irrigation time/);
    expect(card.querySelector('[data-testid="lawn-water-rain-sensor"]')).toBeNull();
  });

  it('"Nothing for you to do after this visit." is decided the same with and without the rain card', async () => {
    const { pageCarriesInstruction } = await import('../components/report/lawnV2/lawnLayoutRules');
    for (const [off, on] of [[wetBase, wetOn], [dryBase, dryOn], [noneBase, noneOn]]) {
      expect(pageCarriesInstruction(clone(on), Date.now())).toBe(pageCarriesInstruction(clone(off), Date.now()));
    }
  });
});
