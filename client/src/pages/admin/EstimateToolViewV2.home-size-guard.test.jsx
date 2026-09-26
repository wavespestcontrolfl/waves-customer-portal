// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateToolViewV2 from './EstimateToolViewV2';

vi.mock('../../components/admin/EstimateSendDialog', () => ({ useEstimateSend: () => vi.fn() }));

const ADDRESS = '400 Example Court, Venice, FL 34285';
// The engine's pest line when no home size reached it: priced at its
// 2,000 sq ft default and marked footprintWasDefaulted.
const pestLine = (extra = {}) => ({
  service: 'pest_control', name: 'Pest Control', mo: 50, annual: 600, ...extra,
});
const resultWith = (line) => ({
  recurring: { tier: 'Bronze', grandTotal: 50, annualAfterDiscount: 600, services: [line] },
  oneTime: { total: 0, items: [] }, results: {}, totals: { year2mo: 50, year1: 600 },
});

function jsonResponse(body) {
  return {
    ok: true, status: 200, json: async () => body,
    clone() { return this; }, text: async () => JSON.stringify(body),
  };
}

let fetchMock;
let calculated;
let calculateReply;
let lookupEnriched;
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'qa-token');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  lookupEnriched = { homeSqFt: 0, lotSqFt: 9000, stories: 1 };
  calculateReply = null;
  fetchMock = vi.fn((url) => {
    const path = String(url);
    if (path.endsWith('/estimator/property-lookup')) {
      return Promise.resolve(jsonResponse({ enriched: structuredClone(lookupEnriched), errors: [] }));
    }
    if (path.endsWith('/calculate-estimate')) {
      return calculateReply ? calculateReply() : Promise.resolve(jsonResponse(structuredClone(calculated)));
    }
    if (path.includes('/discounts')) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function lookUpAndGenerate() {
  render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Pest Control', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Property Lookup', exact: true }));
  await screen.findByRole('region', { name: 'Property lookup results' });
  fireEvent.click(screen.getByRole('button', { name: 'Generate Estimate', exact: true }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/calculate-estimate'))).toBe(true));
}

describe('home-size guard on a generated estimate', () => {
  it('refuses a price the engine guessed at a 2,000 sq ft house and names the service', async () => {
    calculated = resultWith(pestLine({ footprintWasDefaulted: true }));
    await lookUpAndGenerate();
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(
      expect.stringMatching(/^Enter home sq ft\. Pest Control is priced by the home's size/),
    ));
    expect(screen.queryByRole('button', { name: 'Save draft', exact: true })).not.toBeInTheDocument();
  });

  it('guards bed bug and flea too — their lines land in the specialty list', async () => {
    calculated = {
      ...resultWith(pestLine({ footprintWasDefaulted: false })),
      oneTime: {
        total: 450, items: [],
        specItems: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 450, footprintWasDefaulted: true }],
      },
    };
    await lookUpAndGenerate();
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(
      expect.stringMatching(/^Enter home sq ft\. Bed Bug Treatment is priced by the home's size/),
    ));
  });

  it('honors an operator fee override — the typed amount prices, not the defaulted bracket', async () => {
    calculated = resultWith(pestLine({ footprintWasDefaulted: true, priceOverridden: true }));
    await lookUpAndGenerate();
    expect(await screen.findByRole('button', { name: 'Save draft', exact: true })).toBeInTheDocument();
    expect(window.alert).not.toHaveBeenCalledWith(expect.stringMatching(/^Enter home sq ft/));
  });

  it('asks for the story count when the home size is an association total with unknown stories', async () => {
    lookupEnriched = { homeSqFt: 120000, lotSqFt: 300000, stories: 1, footprintUnknown: true };
    calculated = resultWith(pestLine({ footprintWasDefaulted: true }));
    await lookUpAndGenerate();
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(
      expect.stringMatching(/^Enter the number of stories\. Pest Control is priced by the home's footprint/),
    ));
  });

  it('a response already stale when it lands is dropped silently — no alert for a value just typed', async () => {
    let finish;
    calculateReply = () => new Promise((resolve) => { finish = resolve; });
    await lookUpAndGenerate();
    fireEvent.change(screen.getByLabelText('Home Sq Ft'), { target: { value: '1800' } });
    await act(async () => finish(jsonResponse(resultWith(pestLine({ footprintWasDefaulted: true })))));
    expect(window.alert).not.toHaveBeenCalledWith(expect.stringMatching(/^Enter home sq ft/));
  });

  it('lets a quote-required line through — it is not a price', async () => {
    calculated = resultWith(pestLine({ footprintWasDefaulted: true, quoteRequired: true }));
    await lookUpAndGenerate();
    expect(await screen.findByRole('button', { name: 'Save draft', exact: true })).toBeInTheDocument();
    expect(window.alert).not.toHaveBeenCalledWith(expect.stringMatching(/^Enter home sq ft/));
  });

  it('shows a price sized from a real home size', async () => {
    calculated = resultWith(pestLine({ footprintWasDefaulted: false }));
    await lookUpAndGenerate();
    expect(await screen.findByRole('button', { name: 'Save draft', exact: true })).toBeInTheDocument();
  });
});
