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
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'qa-token');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  fetchMock = vi.fn((url) => {
    const path = String(url);
    if (path.endsWith('/estimator/property-lookup')) {
      return Promise.resolve(jsonResponse({ enriched: { homeSqFt: 1800, lotSqFt: 9000, stories: 1, pool, poolCage, poolCageSize: 'MEDIUM' }, errors: [] }));
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
