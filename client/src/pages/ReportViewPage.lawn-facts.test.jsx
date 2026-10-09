// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage, { reentryCondition, smartStatusSummary, reportAskPrompts, readinessStatusBadge } from './ReportViewPage';
import lawnReportV2 from './__fixtures__/lawn-report-v2.json';

// GATE_LAWN_REPORT_FACTS (owner 2026-10-08): a lawn visit's "ready to walk on" is a CONDITION frozen at completion,
// and a spot product says where it was used. The client renders what the server sends; a payload without the new
// fields renders exactly as before.

const SPRAY = 'Ready to walk on once the spray has dried.';
const GRANULAR = 'Ready to walk on once today’s treatment has dried and, after you water it in, the grass is dry again.';
const PETS = 'Keep people and pets off the lawn until then.';

const condition = (text = SPRAY, statusLabel = 'Once dry') => ({ rule: 'dry', text, pets: PETS, statusLabel });
const frozenReentry = (c = condition()) => ({
  generatedAt: '2026-10-08T21:00:00.000Z',
  displayTimezone: 'America/New_York',
  targets: [],
  condition: c,
  customerSummary: c.text,
  petAdvisory: c.pets,
});

function renderReport(payload) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  return render(
    <MemoryRouter initialEntries={['/report/test-lawn-facts']}>
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const withReentry = (reentry) => ({ ...structuredClone(lawnReportV2), dynamicContext: { ...lawnReportV2.dynamicContext, reentry } });

describe('the Ready to Re-enter card', () => {
  it('prints the frozen sentence and the precaution line: no ready-at time, no countdown', async () => {
    const { container } = renderReport(withReentry(frozenReentry()));
    await screen.findByText('Ready to Re-enter');
    const card = container.querySelector('#re-entry');
    expect(within(card).getByText(SPRAY)).toBeInTheDocument();
    expect(within(card).getByText(PETS)).toBeInTheDocument();
    expect(within(card).getByText('Once dry')).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/Ready in|Ready after|\d+ min|\d+ sec|Ready now|Ready time pending/);
    expect(container.querySelector('.reentry-target-grid')).toBeNull();
  });

  it('a granular or mixed visit reads the water-in condition', async () => {
    const { container } = renderReport(withReentry(frozenReentry(condition(GRANULAR, 'After watering in'))));
    await screen.findByText('Ready to Re-enter');
    const card = container.querySelector('#re-entry');
    expect(within(card).getByText(GRANULAR)).toBeInTheDocument();
    expect(within(card).getByText('After watering in')).toBeInTheDocument();
  });

  it('the hero says the condition, not "areas are still drying"', async () => {
    const { container } = renderReport(withReentry(frozenReentry()));
    await screen.findByText('Ready to Re-enter');
    expect(container.textContent).not.toMatch(/areas are still drying/);
  });

  it('a payload with the timed targets and no condition renders as before', async () => {
    const { container } = renderReport(structuredClone(lawnReportV2));
    await screen.findByText('Ready to Re-enter');
    const card = container.querySelector('#re-entry');
    expect(card.textContent).not.toContain(SPRAY);
    expect(card.textContent).toMatch(/Ready (now|in|after)/);
  });
});

describe('the pure helpers', () => {
  it('reentryCondition reads only a whole condition', () => {
    expect(reentryCondition(frozenReentry())).toMatchObject({ text: SPRAY });
    expect(reentryCondition({ targets: [] })).toBeNull();
    expect(reentryCondition({ condition: { text: '   ' } })).toBeNull();
    expect(reentryCondition({ condition: 'dry' })).toBeNull();
    expect(reentryCondition(undefined)).toBeNull();
  });

  it('the status summary: a condition is the result line and never counts down', () => {
    const data = { serviceLine: 'lawn', dynamicContext: { reentry: frozenReentry() }, findings: [], coverage: {} };
    const summary = smartStatusSummary(data, 'live', Date.parse('2026-10-08T21:00:00Z'));
    expect(summary).toMatchObject({ status: 'Service complete', statusTone: 'neutral', result: SPRAY, detail: PETS });
    expect(JSON.stringify(summary)).not.toMatch(/still drying|Ready in|Ready after/);
  });

  it('the status summary without a condition and with a pending target still counts down', () => {
    const data = {
      serviceLine: 'lawn',
      dynamicContext: { reentry: { displayTimezone: 'America/New_York', targets: [{ key: 'exterior', label: 'Exterior', readyAt: '2026-10-08T21:30:00.000Z' }] } },
      findings: [],
      coverage: {},
    };
    const summary = smartStatusSummary(data, 'live', Date.parse('2026-10-08T21:00:00Z'));
    expect(summary.result).toBe('Exterior areas are still drying.');
    expect(summary.status).toMatch(/^Ready in/);
  });

  it('a callback that applied nothing never shows the condition', () => {
    const data = { serviceLine: 'lawn', treatmentPerformed: false, dynamicContext: { reentry: frozenReentry() }, findings: [], coverage: {} };
    expect(smartStatusSummary(data, 'live').result).not.toBe(SPRAY);
  });

  it('the hero badge and the ask prompt follow the condition', () => {
    expect(readinessStatusBadge(frozenReentry(), 'live')).toEqual({ label: 'Once dry', ready: false });
    expect(reportAskPrompts({ dynamicContext: { reentry: frozenReentry() }, applications: [] }, 'lawn')).toContain('When can I re-enter treated areas?');
    expect(reportAskPrompts({ dynamicContext: { reentry: { targets: [] } }, applications: [] }, 'lawn')).not.toContain('When can I re-enter treated areas?');
  });
});

describe('the product card: where it was used', () => {
  const productsFrom = (areaUse) => {
    const payload = structuredClone(lawnReportV2);
    payload.applications = payload.applications.map((app, i) => (i === 0 && areaUse !== undefined ? { ...app, areaUse } : app));
    return payload;
  };
  const usedIn = async (payload) => {
    const { container, unmount } = renderReport(payload);
    await screen.findByText('Ready to Re-enter');
    const labels = [...container.querySelectorAll('.applied-product-card')]
      .map((card) => [...card.querySelectorAll('.sr-cell-label')].find((el) => el.textContent === 'Used in')?.nextElementSibling?.textContent);
    unmount();
    return labels;
  };

  it('a spot product with a frozen area reads it; every other card keeps the text it had', async () => {
    const before = await usedIn(productsFrom(undefined));
    const after = await usedIn(productsFrom('Spot treatment, about 250 sq ft'));
    expect(before.length).toBeGreaterThan(1);
    expect(after[0]).toBe('Spot treatment, about 250 sq ft');
    expect(after.slice(1)).toEqual(before.slice(1));
  });

  it('a spot product with no area reads "Spot treatment"', async () => {
    expect((await usedIn(productsFrom('Spot treatment')))[0]).toBe('Spot treatment');
  });

  it('an older payload with no areaUse renders exactly as before', async () => {
    const before = await usedIn(productsFrom(undefined));
    expect(before).toEqual(await usedIn(structuredClone(lawnReportV2)));
    expect(before.some((label) => /^Spot treatment/.test(label || ''))).toBe(false);
  });

  it('a blank areaUse is no areaUse', async () => {
    expect(await usedIn(productsFrom('   '))).toEqual(await usedIn(productsFrom(undefined)));
  });
});
