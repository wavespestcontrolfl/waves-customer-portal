// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateToolViewV2 from './EstimateToolViewV2';

vi.mock('../../components/admin/EstimateSendDialog', () => ({ useEstimateSend: () => vi.fn() }));

const ADDRESS = '500 Example Court, Venice, FL 34285';
const RESULT = {
  recurring: {
    tier: 'Bronze', grandTotal: 50, annualAfterDiscount: 600,
    services: [{ service: 'pest_control', name: 'Pest Control', mo: 50, annual: 600 }],
  },
  oneTime: { total: 0, items: [] }, results: {}, totals: { year2mo: 50, year1: 600 },
};

function jsonResponse(body) {
  return {
    ok: true, status: 200, json: async () => body,
    clone() { return this; }, text: async () => JSON.stringify(body),
  };
}

let fetchMock;
let pool;
let poolCage;
let cageSize;
let lookupMeta;
beforeEach(() => {
  cageSize = 'MEDIUM';
  lookupMeta = undefined;
  localStorage.setItem('waves_admin_token', 'qa-token');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  fetchMock = vi.fn((url) => {
    const path = String(url);
    if (path.endsWith('/estimator/property-lookup')) {
      return Promise.resolve(jsonResponse({ enriched: { homeSqFt: 1800, lotSqFt: 9000, stories: 1, pool, poolCage, poolCageSize: cageSize }, meta: lookupMeta, errors: [] }));
    }
    if (path.endsWith('/calculate-estimate')) return Promise.resolve(jsonResponse(structuredClone(RESULT)));
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

async function pricedPool() {
  render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Pest Control', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Property Lookup', exact: true }));
  await screen.findByRole('region', { name: 'Property lookup results' });
  fireEvent.click(screen.getByRole('button', { name: 'Generate Estimate', exact: true }));
  const calls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/calculate-estimate'));
  await waitFor(() => expect(calls().length).toBe(1));
  const { profile } = JSON.parse(calls()[0][1].body);
  return { pool: profile.pool, poolCage: profile.poolCage };
}

describe('lookup pool prefill', () => {
  it('a POSSIBLE pool (satellite sees one the records do not) is not priced — nor its cage from the same read', async () => {
    pool = 'POSSIBLE';
    poolCage = 'YES';
    expect(await pricedPool()).toEqual({ pool: 'NO', poolCage: 'NO' });
  });

  it('a same-address refresh that downgrades the pool to POSSIBLE clears the earlier YES; a staff-set value stays', async () => {
    pool = 'YES';
    poolCage = 'YES';
    render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
    const lookUp = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Property Lookup', exact: true }));
      await screen.findByRole('region', { name: 'Property lookup results' });
    };
    await lookUp();
    expect(screen.getByLabelText('Pool')).toHaveValue('YES');
    expect(screen.getByLabelText('Pool Cage')).toHaveValue('YES');

    pool = 'POSSIBLE';
    await lookUp();
    await waitFor(() => expect(screen.getByLabelText('Pool')).toHaveValue('NO'));
    expect(screen.getByLabelText('Pool Cage')).toHaveValue('NO');

    fireEvent.change(screen.getByLabelText('Pool'), { target: { value: 'YES' } });
    await lookUp();
    await waitFor(() => expect(screen.getByLabelText('Pool')).toHaveValue('YES'));
  });

  it('a decided pool is, with its cage', async () => {
    pool = 'YES';
    poolCage = 'YES';
    expect(await pricedPool()).toEqual({ pool: 'YES', poolCage: 'YES' });
  });
});

// GATE_CAGE_START_MEDIUM (owner 2026-11-17): while the gate is on the lookup
// names the office starting size beside the profile (meta.poolCageStartSize).
describe('lookup cage size prefill', () => {
  const lookUp = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Property Lookup', exact: true }));
    await screen.findByRole('region', { name: 'Property lookup results' });
  };
  const pricedProfile = async () => {
    const calls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/calculate-estimate'));
    const before = calls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Generate Estimate', exact: true }));
    await waitFor(() => expect(calls().length).toBe(before + 1));
    return JSON.parse(calls()[before][1].body).profile;
  };

  beforeEach(() => {
    pool = 'YES';
    poolCage = 'YES';
    cageSize = 'LARGE';
  });

  it('with no start size from the lookup, the lookup\'s own size fills and prices (gate off)', async () => {
    render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pest Control', exact: true }));
    await lookUp();
    expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('LARGE');
    expect(await pricedProfile()).toMatchObject({ poolCage: 'YES', poolCageSize: 'LARGE' });
  });

  it('the lookup\'s start size fills the box and prices; the other sizes stay; a hand-set size survives the next lookup', async () => {
    lookupMeta = { poolCageStartSize: 'MEDIUM' };
    render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pest Control', exact: true }));
    await lookUp();
    const sizeBox = () => screen.getByLabelText('Pool Cage Size');
    expect(sizeBox()).toHaveValue('MEDIUM');
    expect([...sizeBox().options].map((o) => o.value)).toEqual(['SMALL', 'MEDIUM', 'LARGE', 'OVERSIZED']);
    expect(await pricedProfile()).toMatchObject({ poolCage: 'YES', poolCageSize: 'MEDIUM', poolCageSizeInferred: false });

    fireEvent.change(sizeBox(), { target: { value: 'OVERSIZED' } });
    await lookUp();
    await waitFor(() => expect(sizeBox()).toHaveValue('OVERSIZED'));
    expect(await pricedProfile()).toMatchObject({ poolCageSize: 'OVERSIZED' });
  });

  // GATE_CAGE_TWO_SIZES (owner 2026-11-19): the lookup says meta.poolCageTwoSizes.
  it('two sizes: the box offers Medium and Large only, and the lookup\'s Large fills and prices', async () => {
    lookupMeta = { poolCageTwoSizes: true };
    render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pest Control', exact: true }));
    await lookUp();
    const sizeBox = screen.getByLabelText('Pool Cage Size');
    expect([...sizeBox.options].map((o) => o.value)).toEqual(['MEDIUM', 'LARGE']);
    expect([...sizeBox.options].map((o) => o.textContent)).toEqual(['Medium (+$8)', 'Large (+$12)']);
    expect(sizeBox).toHaveValue('LARGE');
    expect(await pricedProfile()).toMatchObject({ poolCage: 'YES', poolCageSize: 'LARGE' });
  });

  // A reopened estimate keeps its saved Small or Oversized listed (cage-two-sizes.test.jsx). A size a
  // lookup fills is NOT saved: with two sizes on, a stale Small or Oversized reads as Medium or Large.
  it('two sizes: a lookup-filled Small or Oversized (a lookup from before the flip) reads Medium or Large', async () => {
    lookupMeta = { poolCageTwoSizes: true };
    for (const [filled, expected] of [['OVERSIZED', 'LARGE'], ['SMALL', 'MEDIUM']]) {
      cageSize = filled;
      render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
      fireEvent.click(screen.getByRole('checkbox', { name: 'Pest Control', exact: true }));
      await lookUp();
      const sizeBox = screen.getByLabelText('Pool Cage Size');
      await waitFor(() => expect(sizeBox).toHaveValue(expected));
      expect([...sizeBox.options].map((o) => o.value)).toEqual(['MEDIUM', 'LARGE']);
      expect(await pricedProfile()).toMatchObject({ poolCageSize: expected });
      cleanup();
    }
  });
});
