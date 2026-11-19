// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateToolViewV2 from './EstimateToolViewV2';

// The estimator is a very large component; a busy machine can pass the 1 s default.
configure({ asyncUtilTimeout: 15000 });
// The full editor renders slowly on a loaded runner (same setting as the dead-animal and misting suites).
vi.setConfig({ testTimeout: 30000 });

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
// The estimator's startup read of the lawn_pricing_v2 row (also carries the pest cage gate).
// A test can hold it back (gateRead) to model the window before the gate is known.
let startupRow;
let gateRead;
// What the property lookup answers (a test sets it before each lookup).
let lookupAnswer;
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'qa-token');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  calculateResult = resultWith();
  startupRow = {};
  gateRead = null;
  lookupAnswer = { enriched: { poolCageSize: 'MEDIUM' } };
  fetchMock = vi.fn((url) => {
    const path = String(url);
    if (path.endsWith('/estimator/property-lookup')) {
      return Promise.resolve(jsonResponse({ enriched: { homeSqFt: 1800, lotSqFt: 9000, stories: 1, pool: 'YES', poolCage: 'YES', ...lookupAnswer.enriched }, meta: lookupAnswer.meta, errors: [] }));
    }
    if (path.includes('/pricing-config/lawn_pricing_v2')) {
      return gateRead ? gateRead.then(() => jsonResponse(startupRow)) : Promise.resolve(jsonResponse(startupRow));
    }
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
    // Moving to Large keeps the saved Oversized listed, so the operator can return to it.
    fireEvent.change(screen.getByLabelText('Pool Cage Size'), { target: { value: 'LARGE' } });
    await waitFor(() => expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('LARGE'));
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE', 'OVERSIZED']);
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

// The editor learns the gate at startup from the lawn_pricing_v2 read it already makes.
describe('Pool Cage Size box on a fresh editor', () => {
  const openFresh = () => {
    render(<MemoryRouter><EstimateToolViewV2 /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Pool Cage'), { target: { value: 'YES' } });
  };

  it('shows two options before any lookup or calculate when the startup read says two sizes', async () => {
    startupRow = { poolCageTwoSizes: true };
    openFresh();
    await waitFor(async () => expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE']));
  });

  it('shows four options when the startup read has no flag (gate off)', async () => {
    openFresh();
    expect(await sizeValues()).toEqual(['SMALL', 'MEDIUM', 'LARGE', 'OVERSIZED']);
  });

  it('moves a Small or Oversized picked before the gate was known to Medium or Large', async () => {
    let release;
    gateRead = new Promise((resolve) => { release = resolve; });
    startupRow = { poolCageTwoSizes: true };
    openFresh();
    fireEvent.change(await screen.findByLabelText('Pool Cage Size'), { target: { value: 'SMALL' } });
    expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('SMALL');
    release();
    await waitFor(() => expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('MEDIUM'));
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE']);
    fireEvent.change(screen.getByLabelText('Pool Cage Size'), { target: { value: 'LARGE' } });
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE']);
  });

  it('a reopened Oversized stays listed and selected when the startup read also says two sizes', async () => {
    startupRow = { poolCageTwoSizes: true };
    reopen('OVERSIZED', { poolCageTwoSizes: true });
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE', 'OVERSIZED']);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/pricing-config/lawn_pricing_v2'))).toBe(true));
    expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('OVERSIZED');
  });

  it('a reopened Small stays listed and selected; a reopened Medium shows only two', async () => {
    reopen('SMALL', { poolCageTwoSizes: true });
    expect(await sizeValues()).toEqual(['SMALL', 'MEDIUM', 'LARGE']);
    expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('SMALL');
    cleanup();
    reopen('MEDIUM', { poolCageTwoSizes: true });
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE']);
  });
});

// Reuse paths: the saved size of the estimate just opened must not follow the editor into the next one.
describe('Pool Cage Size box after a reuse path', () => {
  const setCageYes = () => fireEvent.change(screen.getByLabelText('Pool Cage'), { target: { value: 'YES' } });

  it('"Next estimate (keep services)" offers only Medium and Large (the saved Oversized is not carried over)', async () => {
    reopen('OVERSIZED', { poolCageTwoSizes: true });
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE', 'OVERSIZED']);
    fireEvent.click(screen.getByRole('button', { name: /Next estimate \(keep services\)/ }));
    await waitFor(() => expect(screen.getByLabelText('Pool Cage')).toHaveValue('NO'));
    setCageYes();
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE']);
    // The previous Oversized is gone from the box and the new estimate starts at the default Medium.
    expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('MEDIUM');
  }, 120000);

  it('"Add another property" offers only Medium and Large (the saved Oversized is not carried over)', async () => {
    reopen('OVERSIZED', { poolCageTwoSizes: true });
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE', 'OVERSIZED']);
    fireEvent.click(screen.getByRole('button', { name: /Add another property/ }));
    await waitFor(() => expect(screen.getByLabelText('Pool Cage')).toHaveValue('NO'));
    setCageYes();
    expect(await sizeValues()).toEqual(['MEDIUM', 'LARGE']);
    // The previous Oversized is gone from the box and the new estimate starts at the default Medium.
    expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('MEDIUM');
  }, 120000);
});

// An automatic conversion (a Small or Oversized read once the gate becomes known) is not an operator pick:
// it keeps its provenance. A later lookup's own two-size answer replaces it; a manual pick is restored.
describe('Pool Cage Size automatic conversion keeps its provenance', () => {
  const ADDRESS = '500 Example Court, Venice, FL 34285';
  const lookUp = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Property Lookup', exact: true }));
    await screen.findByRole('region', { name: 'Property lookup results' });
  };
  const openWithGateHeld = () => {
    let release;
    gateRead = new Promise((resolve) => { release = resolve; });
    startupRow = { poolCageTwoSizes: true };
    render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pest Control', exact: true }));
    return release;
  };

  it('a lookup-filled Small converted to Medium is replaced by a later lookup that measures Large', async () => {
    // A lookup from before the flip fills Small; the gate then becomes known.
    lookupAnswer = { enriched: { poolCageSize: 'SMALL' } };
    const release = openWithGateHeld();
    await lookUp();
    expect(await screen.findByLabelText('Pool Cage Size')).toHaveValue('SMALL');
    release();
    await waitFor(() => expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('MEDIUM'));
    // The next lookup's own two-size answer (over 1,000 sq ft) wins: the conversion was not a manual pick.
    lookupAnswer = { enriched: { poolCageSize: 'LARGE', poolCageSqft: 1200 }, meta: { poolCageTwoSizes: true } };
    await lookUp();
    await waitFor(() => expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('LARGE'));
  }, 120000);

  it('a manual Small pick converted to Medium stays Medium after that lookup', async () => {
    lookupAnswer = { enriched: { poolCageSize: 'MEDIUM' } };
    const release = openWithGateHeld();
    await lookUp();
    fireEvent.change(await screen.findByLabelText('Pool Cage Size'), { target: { value: 'SMALL' } });
    expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('SMALL');
    release();
    await waitFor(() => expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('MEDIUM'));
    lookupAnswer = { enriched: { poolCageSize: 'LARGE', poolCageSqft: 1200 }, meta: { poolCageTwoSizes: true } };
    await lookUp();
    await waitFor(() => expect(screen.getByLabelText('Pool Cage Size')).toHaveValue('MEDIUM'));
  }, 120000);
});
