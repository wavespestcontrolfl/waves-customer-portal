// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateToolViewV2 from './EstimateToolViewV2';

vi.mock('../../components/admin/EstimateSendDialog', () => ({ useEstimateSend: () => vi.fn() }));

// GATE_CAGE_TWO_SIZES (owner 2026-11-19): the Pool Cage Size box offers Medium and Large
// when the server says so, on a reopened estimate and on a calculate result with no
// property lookup. The reopen flag is the edit source's LIVE value; a stored true never
// survives a rollback. A saved Small or Oversized stays listed.
const ADDRESS = '300 Example Court, Venice, FL 34285';
const HOUSE = { homeSqFt: 2400, lotSqFt: 9000, stories: 2, propertyType: 'Single Family' };
const resultWith = (extra = {}) => ({
  recurring: {
    tier: 'Bronze', grandTotal: 50, annualAfterDiscount: 600,
    services: [{ service: 'pest_control', name: 'Pest Control', mo: 50, annual: 600 }],
  },
  oneTime: { total: 0, items: [] }, results: {}, totals: { year2mo: 50, year1: 600 },
  ...extra,
});
const INPUTS = (size) => ({
  svcPest: true, homeSqFt: '2400', lotSqFt: '9000', stories: '2', hasPool: 'YES', hasPoolCage: 'YES', poolCageSize: size,
});

function jsonResponse(body) {
  return {
    ok: true, status: 200, json: async () => body,
    clone() { return this; }, text: async () => JSON.stringify(body),
  };
}

let fetchMock;
let editSource;
let calculateResult;
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'qa-token');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  calculateResult = resultWith();
  fetchMock = vi.fn((url) => {
    const path = String(url);
    if (path.endsWith('/calculate-estimate')) return Promise.resolve(jsonResponse(structuredClone(calculateResult)));
    if (path.endsWith('/edit-source')) return Promise.resolve(jsonResponse(structuredClone(editSource)));
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

function reopen(size, sourceExtra = {}, storedResult = resultWith()) {
  editSource = {
    id: 'qa-cage-estimate', status: 'draft', editable: true, editVersion: 'qa-version',
    customerName: 'QA Contact', address: ADDRESS, inputs: INPUTS(size), engineProfile: HOUSE, result: storedResult,
    ...sourceExtra,
  };
  render(<MemoryRouter><EstimateToolViewV2 editEstimateId="qa-cage-estimate" /></MemoryRouter>);
}
const sizeValues = async () => {
  const box = await screen.findByLabelText('Pool Cage Size');
  return [...box.options].map((o) => o.value);
};

describe('Pool Cage Size box on a reopened estimate', () => {
  it('offers Medium and Large when the edit source says two sizes, and keeps a saved Oversized listed', async () => {
    reopen('OVERSIZED', { poolCageTwoSizes: true });
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE', 'OVERSIZED']);
    expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('OVERSIZED');
  });

  it('offers only Medium and Large for a saved Medium', async () => {
    reopen('MEDIUM', { poolCageTwoSizes: true });
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE']);
  });

  it('keeps two sizes plus the saved value after an edit clears the calculated estimate', async () => {
    reopen('OVERSIZED', { poolCageTwoSizes: true });
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE', 'OVERSIZED']);
    // A pricing edit clears the estimate (setEstimate(null)); the gate value is editor state.
    fireEvent.change(screen.getByLabelText('Home Sq Ft'), { target: { value: '2600' } });
    await waitFor(() => expect(screen.getByLabelText('Home Sq Ft')).toHaveValue(2600));
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE', 'OVERSIZED']);
    fireEvent.change(screen.getByLabelText('Pool Cage Size'), { target: { value: 'LARGE' } });
    await waitFor(() => expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('LARGE'));
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE']);
  });

  it('shows four sizes when the edit source has no flag, even if the stored result carries a stale true', async () => {
    reopen('MEDIUM', {}, resultWith({ poolCageTwoSizes: true }));
    expect(await sizeValues()).toEqual(['SMALL', 'MEDIUM', 'LARGE', 'OVERSIZED']);
  });
});

describe('Pool Cage Size box on a calculate result with no property lookup', () => {
  it('goes to two sizes when the result carries poolCageTwoSizes', async () => {
    reopen('LARGE');
    expect(await sizeValues()).toEqual(['SMALL', 'MEDIUM', 'LARGE', 'OVERSIZED']);
    calculateResult = resultWith({ poolCageTwoSizes: true });
    fireEvent.click(screen.getByRole('button', { name: /^(Generate Estimate|Regenerate)$/ }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/calculate-estimate'))).toHaveLength(1));
    await waitFor(async () => expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE']));
  });
});
