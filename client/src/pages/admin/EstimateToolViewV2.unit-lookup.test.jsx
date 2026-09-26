// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateToolViewV2 from './EstimateToolViewV2';

vi.mock('../../components/admin/EstimateSendDialog', () => ({ useEstimateSend: () => vi.fn() }));

const ADDRESS = '210 Example Harbor Way, Unit 3C, Sarasota, FL 34232';
// A unit-address lookup: the server scoped the profile to ONE unit.
const UNIT = {
  homeSqFt: 725, lotSqFt: 0, stories: 1, storiesSource: 'default', propertyType: 'Condo',
  residentialUnitLookup: { wholePropertyCategory: 'RESIDENTIAL', wholePropertySubtype: null },
};

function jsonResponse(body) {
  return {
    ok: true, status: 200, json: async () => body,
    clone() { return this; }, text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'qa-token');
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (String(url).endsWith('/estimator/property-lookup')) {
      return Promise.resolve(jsonResponse({ enriched: structuredClone(UNIT), errors: [] }));
    }
    return Promise.resolve(jsonResponse({}));
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('unit-address lookup — trenching perimeter (codex r5 P2 #4862)', () => {
  it('offers no "estimate from footprint" for one unit, and restores it when staff retype the property', async () => {
    render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Termite Trenching Service', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Property Lookup', exact: true }));
    await screen.findByRole('region', { name: 'Property lookup results' });

    expect(screen.queryByRole('checkbox', { name: 'Estimate trenching perimeter from footprint' })).not.toBeInTheDocument();
    expect(screen.getByText('One unit in a building: enter the measured perimeter LF.')).toBeInTheDocument();
    expect(screen.getByText('Trenching needs measured perimeter LF before pricing.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Property Type'), { target: { value: 'Single Family' } });
    expect(screen.getByRole('checkbox', { name: 'Estimate trenching perimeter from footprint' })).toBeInTheDocument();
  });
});
