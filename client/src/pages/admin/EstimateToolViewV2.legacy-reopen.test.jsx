// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateToolViewV2 from './EstimateToolViewV2';

vi.mock('../../components/admin/EstimateSendDialog', () => ({ useEstimateSend: () => vi.fn() }));

const ADDRESS = '300 Example Court, Venice, FL 34285';
const pestLine = (extra = {}) => ({ service: 'pest_control', name: 'Pest Control', mo: 50, annual: 600, ...extra });
const resultWith = (line) => ({
  recurring: { tier: 'Bronze', grandTotal: 50, annualAfterDiscount: 600, services: [line] },
  oneTime: { total: 0, items: [] }, results: {}, totals: { year2mo: 50, year1: 600 },
});
const RESULT = resultWith(pestLine());
// A condo record carrying the development's parcel (unit_parcel flag).
const CONDO_ON_DEVELOPMENT_PARCEL = {
  homeSqFt: 1100, lotSqFt: 400000, stories: 1, propertyType: 'Condo',
  fieldVerifyFlags: [{ field: 'lotSize', scope: 'unit_parcel', priority: 'HIGH', reason: 'development parcel' }],
};
const HOUSE = { homeSqFt: 2400, lotSqFt: 9000, stories: 2, propertyType: 'Single Family' };

function jsonResponse(body) {
  return {
    ok: true, status: 200, json: async () => body,
    clone() { return this; }, text: async () => JSON.stringify(body),
  };
}

let fetchMock;
let editSource;
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'qa-token');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  editSource = null;
  fetchMock = vi.fn((url) => {
    const path = String(url);
    if (path.endsWith('/calculate-estimate')) return Promise.resolve(jsonResponse(structuredClone(RESULT)));
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

const callsTo = (suffix) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
const reviewAndSend = () => screen.getByRole('button', { name: 'Review and send', exact: true });
const NOTICE = /Generate the estimate again before saving or sending/;

function reopen(inputs, engineProfile, result = RESULT) {
  editSource = {
    id: 'qa-legacy-estimate', status: 'draft', editable: true, editVersion: 'qa-version',
    customerName: 'QA Contact', address: ADDRESS, inputs, engineProfile, result,
  };
  render(<MemoryRouter><EstimateToolViewV2 editEstimateId="qa-legacy-estimate" /></MemoryRouter>);
}

describe('reopening an estimate saved before the lookup guards', () => {
  it('clears the development lot the lookup filled in and refuses the stored price until regenerated', async () => {
    reopen({ svcPest: true, homeSqFt: '1100', lotSqFt: '400000', stories: '1' }, CONDO_ON_DEVELOPMENT_PARCEL);
    expect(await screen.findByText(/Removed values the lookup filled in: lot size\./)).toBeInTheDocument();
    expect(screen.getByLabelText('Lot Sq Ft')).toHaveValue(null);
    expect(reviewAndSend()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /^(Generate Estimate|Regenerate)$/ }));
    await waitFor(() => expect(callsTo('/calculate-estimate')).toHaveLength(1));
    expect(JSON.parse(callsTo('/calculate-estimate')[0][1].body).profile.lotSqFt).toBe(0);
    await waitFor(() => expect(screen.queryByText(NOTICE)).not.toBeInTheDocument());
  });

  it('keeps a lot the operator typed, and the stored price with it', async () => {
    reopen(
      { svcPest: true, homeSqFt: '1100', lotSqFt: '1500', stories: '1', _lotSqFtEdited: true, _manualFields: ['lotSqFt'] },
      CONDO_ON_DEVELOPMENT_PARCEL,
    );
    await waitFor(() => expect(screen.getByLabelText('Lot Sq Ft')).toHaveValue(1500));
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(reviewAndSend()).toBeEnabled();
  });

  it('refuses a stored price the engine guessed at a 2,000 sq ft house', async () => {
    reopen({ svcPest: true, homeSqFt: '', lotSqFt: '9000', stories: '1' }, HOUSE, resultWith(pestLine({ footprintWasDefaulted: true })));
    expect(await screen.findByText(/a guess at a 2,000 sq ft house — enter home sq ft\./)).toBeInTheDocument();
    expect(screen.getByLabelText('Lot Sq Ft')).toHaveValue(9000);
    expect(reviewAndSend()).toBeDisabled();
  });

  it('asks an association aggregate for stories, not home sq ft (codex r1 P2)', async () => {
    reopen({ svcPest: true, homeSqFt: '48000', lotSqFt: '90000', stories: '1' },
      { ...HOUSE, homeSqFt: 48000, footprintUnknown: true }, resultWith(pestLine({ footprintWasDefaulted: true })));
    expect(await screen.findByText(/a guess at the home's footprint — enter the number of stories\./)).toBeInTheDocument();
    expect(reviewAndSend()).toBeDisabled();
  });

  it('restores a clean estimate as saved', async () => {
    reopen({ svcPest: true, homeSqFt: '2400', lotSqFt: '9000', stories: '2' }, HOUSE);
    await waitFor(() => expect(screen.getByLabelText('Home Sq Ft')).toHaveValue(2400));
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(reviewAndSend()).toBeEnabled();
  });
});
