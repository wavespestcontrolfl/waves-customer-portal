// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import mixedBase from './__fixtures__/lawn-layout/mixed-base.json';
import mixedPolish from './__fixtures__/lawn-layout/mixed-polish.json';
import singleBase from './__fixtures__/lawn-layout/single-base.json';
import singlePolish from './__fixtures__/lawn-layout/single-polish.json';
import granularOff from './__fixtures__/lawn-layout/granular-off.json';
import granularOn from './__fixtures__/lawn-layout/granular-on.json';

// GATE_LAWN_REPORT_POLISH on the real page: the Water card's third state, one label line per product card, and the
// status card's keep-off line. The payloads are saved synthetic lawn reports built by
// scripts/generate-lawn-report-layout-fixtures.js with the real server builders (the water context, the frozen
// label-line decision, the re-entry condition); "-base" is the gate off, "-polish" the gate on.

const clone = (value) => structuredClone(value);
const KEEP_OFF = 'Keep people and pets off the lawn until then.';

function renderReport(payload) {
  window.history.pushState({}, '', '/report/tok-polish');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  return render(
    <MemoryRouter initialEntries={['/report/tok-polish']}>
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
const card = (container, name) => [...container.querySelectorAll('.applied-products-grid article, .solution-product-detail, article')]
  .find((el) => el.textContent.includes(name));
const safetyOf = (container, name) => [...card(container, name).querySelectorAll('.product-why')].find((el) => el.textContent.startsWith('Safety'));

describe('the Water card, three states, on the real page', () => {
  it('gate off, a mixed-head system: "Not on file" and the schedule call to action, as today', async () => {
    const { container } = renderReport(clone(mixedBase));
    await waitForReport();
    expect(text(container)).toContain('Not on file');
    expect(text(container)).toContain('we don’t have your watering schedule yet');
    expect(screen.queryByTestId('lawn-water-schedule-on-file')).toBeNull();
  });

  it('gate on, a mixed-head system: the schedule on file, weekly inches asked for, never "Not on file"', async () => {
    const { container } = renderReport(clone(mixedPolish));
    await waitForReport();
    expect(screen.getByTestId('lawn-water-schedule-on-file')).toHaveTextContent('45 min, Mondays');
    expect(text(container)).not.toContain('Not on file');
    expect(text(container)).not.toContain('Add your watering schedule');
    expect(text(container)).toContain('Weekly inches not on file');
    expect(text(container)).toContain('Add your weekly inches →');
    // the banner and the card now say the same thing about the same schedule
    expect(text(container)).toContain('Run spray zones about 30 minutes and rotor zones about 80 minutes.');
    expect(screen.getByTestId('lawn-watering-banner')).toBeInTheDocument();
  });

  it('gate on, one turf head type (drip beside it): a derived figure with its basis line', async () => {
    const { container } = renderReport(clone(singlePolish));
    await waitForReport();
    expect(screen.getByTestId('lawn-water-basis')).toHaveTextContent('About 0.28" a week from 45 minutes per zone, 1 day a week on rotor heads — typical head rates.');
    expect(text(container)).not.toContain('Not on file');
    expect(container.querySelector('.lawn-water-cta')).toBeNull();
  });

  it('gate off, the same single-head system: no derived figure (the package counts drip as a head type)', async () => {
    const { container } = renderReport(clone(singleBase));
    await waitForReport();
    expect(screen.queryByTestId('lawn-water-basis')).toBeNull();
    expect(text(container)).toContain('Not on file');
  });
});

describe('one label line per product card', () => {
  const openProducts = (container) => {
    const summary = [...container.querySelectorAll('summary')].find((el) => el.textContent.includes('Products Applied'));
    fireEvent.click(summary);
  };

  it('gate off: the spray card prints the catalog precaution and the re-entry line, the granule its third sentence too', async () => {
    const { container } = renderReport(clone(mixedBase));
    await waitForReport();
    openProducts(container);
    expect(safetyOf(container, 'Gravex 20 EW').textContent).toContain('Per the product label: keep people and pets off treated areas until sprays have dried.');
    expect(safetyOf(container, 'Gravex 20 EW').textContent).toContain('Stay off treated areas until the application has dried.');
    expect(safetyOf(container, 'Dimension').textContent).toContain('People and pets can use the lawn once it has been watered in');
  });

  it('gate on: the spray card prints the re-entry line alone; the granule its handling sentences and the re-entry line', async () => {
    const { container } = renderReport(clone(mixedPolish));
    await waitForReport();
    openProducts(container);
    const spray = safetyOf(container, 'Gravex 20 EW');
    expect(spray.querySelectorAll('p')).toHaveLength(1);
    expect(spray).toHaveTextContent('Stay off treated areas until the application has dried.');
    expect(spray).not.toHaveTextContent('Per the product label');
    const granule = safetyOf(container, 'Dimension');
    expect(granule).toHaveTextContent('Granules on sidewalks or driveways are swept back into the turf. Water in with about ½ inch within 24 hours.');
    expect(granule).toHaveTextContent('Stay off treated areas until the product has been watered in and the turf is dry.');
    expect(granule).not.toHaveTextContent('People and pets can use the lawn');
  });

  it('gate on: a surfactant keeps both lines (a mix note is not a keep-off line), so no card is left without its keep-off line', async () => {
    const { container } = renderReport(clone(mixedPolish));
    await waitForReport();
    openProducts(container);
    const surfactant = safetyOf(container, 'Surfactant');
    expect(surfactant).toHaveTextContent('Used only as part of a spray mix');
    expect(surfactant).toHaveTextContent('Stay off treated areas until the application has dried.');
    [...container.querySelectorAll('.product-why')].filter((el) => el.textContent.startsWith('Safety')).forEach((el) => {
      expect(el.textContent).toMatch(/Stay off treated areas until/);
    });
  });
});

describe('the status card keep-off line', () => {
  it('gate off: the keep-off line prints under a result that is not the condition sentence (the stray line)', async () => {
    const { container } = renderReport(clone(granularOn));
    await waitForReport();
    const hero = container.querySelector('#service-status');
    expect(hero.textContent).toContain(KEEP_OFF);
  });

  it('gate on: it is left off the status card when another sentence is the result; "Your part" keeps condition and keep-off together', async () => {
    const payload = { ...clone(granularOn), lawnPolish: true };
    const { container } = renderReport(payload);
    await waitForReport();
    expect(container.querySelector('#service-status').textContent).not.toContain(KEEP_OFF);
    const yourPart = screen.getByTestId('lawn-your-part');
    expect(yourPart).toHaveTextContent('Ready to walk on once today’s treatment has dried');
    expect(yourPart).toHaveTextContent(KEEP_OFF);
  });

  it('gate on, no standard result of its own: the layout hero prints the lead\'s status headline, not the walk-on rule that Your part states', async () => {
    const payload = { ...clone(granularOn), lawnPolish: true };
    payload.reportV2.todaysResult = null;
    const { container } = renderReport(payload);
    await waitForReport();
    const hero = container.querySelector('#service-status');
    expect(hero.textContent).toContain(payload.reportV2.lead.headline);
    expect(hero.textContent).not.toContain('Ready to walk on');
    expect(hero.textContent).not.toContain(KEEP_OFF);
    expect(screen.getByTestId('lawn-your-part')).toHaveTextContent('Ready to walk on');
  });

  it('gate on, the standard page (no layout): the condition sentence is the result and the keep-off line follows it, once', async () => {
    const payload = { ...clone(granularOff), lawnPolish: true };
    payload.reportV2.todaysResult = null;
    const { container } = renderReport(payload);
    await waitForReport();
    const hero = container.querySelector('#service-status').textContent;
    expect(hero).toContain('Ready to walk on once today’s treatment has dried');
    expect(hero.split(KEEP_OFF).length - 1).toBe(1);
    expect(hero.indexOf('Ready to walk on')).toBeLessThan(hero.indexOf(KEEP_OFF));
  });

  it('gate off with no result of its own: unchanged (the headline substitution and the flag are gate only)', async () => {
    const payload = clone(granularOn);
    payload.reportV2.todaysResult = null;
    const { container } = renderReport(payload);
    await waitForReport();
    const hero = container.querySelector('#service-status').textContent;
    expect(hero).toContain('Ready to walk on');
    expect(hero).toContain(KEEP_OFF);
  });
});
