// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateToolViewV2 from './EstimateToolViewV2';

vi.mock('../../components/admin/EstimateSendDialog', () => ({ useEstimateSend: () => vi.fn() }));

const ADDRESS = '300 Example Court, Venice, FL 34285';
const RESULT = {
  recurring: {
    tier: 'Bronze', grandTotal: 50, annualAfterDiscount: 600,
    services: [{ service: 'pest_control', name: 'Pest Control', mo: 50, annual: 600 }],
  },
  oneTime: { total: 0, items: [] }, results: {}, totals: { year2mo: 50, year1: 600 },
};
const HOUSE = { homeSqFt: 2400, lotSqFt: 9000, stories: 2, propertyType: 'Single Family' };
// A condo record carrying the development's parcel: the lookup's own
// unit-lot flag says the lot (and the area reads off that parcel) describe
// the wrong scope.
const UNIT_PARCEL_FLAG = {
  field: 'lotSize', scope: 'unit_parcel', priority: 'HIGH',
  reason: 'This lot size describes the development’s parcel, not one unit',
};
const CONDO_ON_DEVELOPMENT_PARCEL = {
  homeSqFt: 1100, lotSqFt: 400000, stories: 1, propertyType: 'Condo',
  estimatedTurfSf: 25000, turfSource: 'vision', imperviousSurfacePercent: 35,
  estimatedBedAreaSf: 6000, estimatedBedAreaPercent: 12, bedAreaSource: 'estimated',
  shrubDensity: 'HEAVY',
  fieldVerifyFlags: [UNIT_PARCEL_FLAG],
};

function jsonResponse(body) {
  return {
    ok: true, status: 200, json: async () => body,
    clone() { return this; }, text: async () => JSON.stringify(body),
  };
}

let fetchMock;
let enriched;
let editSource;
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'qa-token');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  enriched = HOUSE;
  editSource = null;
  fetchMock = vi.fn((url) => {
    const path = String(url);
    if (path.endsWith('/estimator/property-lookup')) {
      return Promise.resolve(jsonResponse({ enriched: structuredClone(enriched), errors: [] }));
    }
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

const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const selectService = (name) => fireEvent.click(screen.getByRole('checkbox', { name, exact: true }));
const callsTo = (suffix) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
const lastBody = (suffix) => JSON.parse(callsTo(suffix).at(-1)[1].body);

async function lookUp() {
  fireEvent.click(screen.getByRole('button', { name: 'Property Lookup', exact: true }));
  await screen.findByRole('region', { name: 'Property lookup results' });
}
async function generate() {
  const before = callsTo('/calculate-estimate').length;
  // "Regenerate" once an estimate is on screen (a reopened quote starts there).
  fireEvent.click(screen.getByRole('button', { name: /^(Generate Estimate|Regenerate)$/ }));
  await waitFor(() => expect(callsTo('/calculate-estimate').length).toBe(before + 1));
  return lastBody('/calculate-estimate').profile;
}

describe('estimate dimension boxes govern pricing', () => {
  it('a cleared Lot or Stories box prices as cleared — never the lookup value it no longer shows', async () => {
    render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
    selectService('Pest Control');
    await lookUp();
    expect(screen.getByLabelText('Lot Sq Ft')).toHaveValue(9000);

    change('Lot Sq Ft', '');
    change('Stories', '');
    const profile = await generate();
    expect(profile.lotSqFt).toBe(0);
    expect(profile.stories).toBe(1);
    expect(profile.homeSqFt).toBe(2400);
  });

  it('a cleared Stories box prices the 1-story default as a default, never as staff-entered', async () => {
    render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
    selectService('Pest Control');
    await lookUp();
    change('Stories', '');
    const profile = await generate();
    expect(profile.stories).toBe(1);
    expect(profile.storiesSource).toBe('default');
  });

  it('turf derived from the lookup lot stops pricing once the Lot box no longer holds that lot', async () => {
    enriched = { ...HOUSE, estimatedTurfSf: 6000, turfSource: 'county_prior', countyTurfPriorSf: 6000 };
    render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
    selectService('Pest Control');
    selectService('Lawn Care');
    await lookUp();
    // Unchanged lot: the county-prior turf still shows and prices.
    expect(screen.getByText(/Using AI/)).toBeInTheDocument();
    expect((await generate()).estimatedTurfSf).toBe(6000);
    change('Lot Sq Ft', '12000');
    // The turf panel stops offering it the moment the lot changes…
    expect(screen.queryByText(/Using AI/)).not.toBeInTheDocument();
    // …and pricing drops it.
    const corrected = await generate();
    expect(corrected.lotSqFt).toBe(12000);
    for (const key of ['estimatedTurfSf', 'turfSource', 'countyTurfPriorSf']) expect(corrected[key]).toBeUndefined();
  });

  it('a cleared Home Sq Ft box clears the footprint too — the lookup\'s own footprint never prices pest', async () => {
    enriched = { ...HOUSE, footprint: 1200, squareFootage: 2400 };
    render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
    selectService('Pest Control');
    await lookUp();
    change('Home Sq Ft', '');
    const profile = await generate();
    expect(profile.homeSqFt).toBe(0);
    expect(profile.footprint).toBe(0);
    // A legacy alias the translator would fall back to is gone too.
    expect(profile.squareFootage).toBeUndefined();
    expect(profile.lotSqFt).toBe(9000);
  });

  it('a condo on the development parcel: the lot is never prefilled and its parcel-scope area reads never price', async () => {
    enriched = CONDO_ON_DEVELOPMENT_PARCEL;
    render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
    selectService('Pest Control');
    await lookUp();
    expect(screen.getByLabelText('Lot Sq Ft')).toHaveValue(null);
    expect(screen.getByLabelText('Home Sq Ft')).toHaveValue(1100);

    const profile = await generate();
    expect(profile.lotSqFt).toBe(0);
    expect(profile.estimatedBedAreaSf).toBe(0);
    for (const key of ['estimatedTurfSf', 'turfSource', 'imperviousSurfacePercent', 'estimatedBedAreaPercent']) {
      expect(profile[key]).toBeUndefined();
    }
    // Only the parcel-scope AREA reads are withheld (public-quote's set).
    expect(profile.shrubDensity).toBe('HEAVY');

    // An operator quoting the whole property types the lot — it prices.
    change('Lot Sq Ft', '400000');
    expect((await generate()).lotSqFt).toBe(400000);
  });

  it('reopening a saved condo quote whose priced profile carries the development parcel withholds the same reads', async () => {
    editSource = {
      id: 'qa-unit-parcel-estimate', status: 'draft', editable: true, editVersion: 'qa-version',
      customerName: 'QA Contact', address: ADDRESS,
      inputs: { svcPest: true, homeSqFt: '1100', lotSqFt: '', stories: '1' },
      engineProfile: CONDO_ON_DEVELOPMENT_PARCEL,
      result: RESULT,
    };
    render(<MemoryRouter><EstimateToolViewV2 editEstimateId="qa-unit-parcel-estimate" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText('Home Sq Ft')).toHaveValue(1100));

    const profile = await generate();
    expect(profile.lotSqFt).toBe(0);
    expect(profile.estimatedTurfSf).toBeUndefined();
    expect(profile.estimatedBedAreaSf).toBe(0);
  });
});
