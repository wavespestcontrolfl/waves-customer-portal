// @vitest-environment jsdom
import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateToolViewV2 from './EstimateToolViewV2';

vi.mock('../../components/admin/EstimateSendDialog', () => ({ useEstimateSend: () => vi.fn() }));

const ADDRESS_A = '100 Example Court, Venice, FL 34285';
const ADDRESS_B = '200 Example Court, Venice, FL 34285';
const OWNER = {
  id: 'qa-property-owner', firstName: 'QA', lastName: 'Contact',
  address: ADDRESS_B, email: 'qa@example.invalid', phone: '+19415550100',
  tier: null, monthlyRate: 0,
};
const PROPERTY_B = {
  id: 'qa-property-b', address_line1: '200 Example Court',
  city: 'Venice', state: 'FL', zip: '34285',
};
const RESULT = {
  recurring: {
    tier: 'Bronze', grandTotal: 50, annualAfterDiscount: 600,
    services: [{ service: 'pest_control', name: 'Pest Control', mo: 50, annual: 600 }],
  },
  oneTime: { total: 99, items: [] }, results: {}, totals: { year2mo: 50, year1: 699 },
};
const ENRICHED = {
  homeSqFt: 4200, lotSqFt: 9000, stories: 1, estimatedBedAreaSf: 900,
  estimatedPalmCount: 12, palmCountTrusted: true,
};
const SOURCE = {
  id: 'qa-anchor-estimate', status: 'draft', editable: true, editVersion: 'qa-version',
  customerId: OWNER.id, customerName: 'QA Contact', customerPhone: OWNER.phone,
  customerEmail: OWNER.email, address: ADDRESS_A, propertyId: 'qa-property-a',
  inputs: { svcPest: true, homeSqFt: '2000', lotSqFt: '6000' },
  engineRequest: { profile: { homeSqFt: 2000 }, selectedServices: ['PEST'], options: {} },
  result: RESULT, token: 'qa-estimate-token',
};

function jsonResponse(body) {
  return {
    ok: true, status: 200, json: async () => body,
    clone() { return this; }, text: async () => JSON.stringify(body),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

let fetchMock;
let lookupReply;
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'qa-token');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  lookupReply = () => Promise.resolve(jsonResponse({ enriched: structuredClone(ENRICHED), errors: [] }));
  fetchMock = vi.fn((url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/estimator/property-lookup')) return lookupReply(options);
    if (path.endsWith('/calculate-estimate')) return Promise.resolve(jsonResponse(structuredClone(RESULT)));
    if (path.endsWith('/edit-source')) return Promise.resolve(jsonResponse(structuredClone(SOURCE)));
    if (path.includes('/customers?')) return Promise.resolve(jsonResponse({ customers: [OWNER] }));
    if (path.endsWith('/properties')) return Promise.resolve(jsonResponse({ properties: [PROPERTY_B] }));
    if (path.includes('/discounts')) return Promise.resolve(jsonResponse([]));
    if (path === '/api/admin/estimates' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      return Promise.resolve(jsonResponse({
        id: body.clientDraftId, status: 'draft', editVersion: 'qa-saved-version', token: 'qa-new-token',
        monthlyTotal: 50, annualTotal: 600, onetimeTotal: 99,
      }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  // Every request, including lookup/pricing, stays inside this mock.
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

const change = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const selectService = (name) => fireEvent.click(screen.getByRole('checkbox', { name, exact: true }));
const lookUp = () => fireEvent.click(screen.getByRole('button', { name: 'Property Lookup', exact: true }));
const callsTo = (suffix) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
const lastBody = (suffix) => JSON.parse(callsTo(suffix).at(-1)[1].body);

function renderEditor(props = {}) {
  return render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS_A} {...props} /></MemoryRouter>);
}

async function generateAndSave() {
  fireEvent.click(screen.getByRole('button', { name: 'Generate Estimate', exact: true }));
  const save = await screen.findByRole('button', { name: 'Save draft', exact: true });
  fireEvent.click(save);
  await waitFor(() => expect(callsTo('/api/admin/estimates')).toHaveLength(1));
  return lastBody('/api/admin/estimates');
}

describe('estimate property input ownership', () => {
  it('preserves edits made during a same-property lookup, including a deliberately cleared palm count', async () => {
    const pending = deferred();
    lookupReply = () => pending.promise;
    renderEditor();
    selectService('Pest Control');
    selectService('Tree & Shrub');
    lookUp();
    change('Home Sq Ft', '2222');
    change('Stories', '2');
    change('Bed Area (sq ft)', '375');
    change('Palms on property', '3');
    change('Palms on property', '');
    await act(async () => pending.resolve(jsonResponse({ enriched: structuredClone(ENRICHED), errors: [] })));

    expect(screen.getByLabelText('Home Sq Ft')).toHaveValue(2222);
    expect(screen.getByLabelText('Stories')).toHaveValue(2);
    expect(screen.getByLabelText('Bed Area (sq ft)')).toHaveValue(375);
    expect(screen.getByLabelText('Palms on property')).toHaveValue(null);
    expect(screen.getByLabelText('Lot Sq Ft')).toHaveValue(9000);
    const saved = await generateAndSave();
    const calculated = lastBody('/calculate-estimate');
    expect(calculated.profile).toMatchObject({ homeSqFt: 2222, lotSqFt: 9000, stories: 2, estimatedBedAreaSf: 375, bedAreaSource: 'manual' });
    expect(calculated.profile.palmCount).toBeUndefined();
    expect(calculated.profile.estimatedPalmCount).toBeUndefined();
    expect(calculated.profile.palmInventory?.palmCount).toBeUndefined();
    expect(saved.estimateData.engineRequest).toEqual(calculated);
    expect(saved.estimateData.inputs).toMatchObject({ palmCount: '', _palmCountAuto: false });
  });

  it.each(['typed address', 'customer selection', 'saved property', 'incoming prefill', 'autocomplete'])(
    'clears old manual inputs on %s replacement so the new lookup can populate the new property',
    async (replacement) => {
      let placeChanged;
      if (replacement === 'autocomplete') {
        vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'qa-maps-key');
        vi.stubGlobal('google', { maps: { places: { Autocomplete: function Autocomplete() {
          this.addListener = (_event, listener) => { placeChanged = listener; };
          this.getPlace = () => ({ formatted_address: ADDRESS_B });
        } } } });
      }
      const props = replacement === 'saved property' ? { initialCustomerId: OWNER.id } : {};
      const view = renderEditor(props);
      selectService('Pest Control');
      selectService('Tree & Shrub');
      change('Home Sq Ft', '2222');
      change('Stories', '2');
      change('Bed Area (sq ft)', '375');
      change('Palms on property', '3');
      if (replacement === 'customer selection') {
        fireEvent.change(screen.getByPlaceholderText('Name, phone, email, or address...'), { target: { value: 'QA Contact' } });
        fireEvent.click(await screen.findByRole('button', { name: /QA Contact/ }));
      } else if (replacement === 'saved property') {
        await screen.findByRole('option', { name: /200 Example Court/ });
        change('Customer property', PROPERTY_B.id);
      } else if (replacement === 'incoming prefill') {
        view.rerender(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS_B} /></MemoryRouter>);
      } else if (replacement === 'autocomplete') {
        expect(placeChanged).toBeTypeOf('function');
        act(() => placeChanged());
      } else {
        change('Service address', ADDRESS_B);
      }

      expect(screen.getByLabelText('Service address')).toHaveValue(ADDRESS_B);
      expect(screen.getByLabelText('Home Sq Ft')).toHaveValue(null);
      expect(screen.getByLabelText('Stories')).toHaveValue(1);
      expect(screen.getByLabelText('Bed Area (sq ft)')).toHaveValue(null);
      expect(screen.getByLabelText('Palms on property')).toHaveValue(null);
      lookUp();
      await waitFor(() => expect(screen.getByLabelText('Home Sq Ft')).toHaveValue(4200));
      expect(screen.getByLabelText('Bed Area (sq ft)')).toHaveValue(900);
      expect(screen.getByLabelText('Palms on property')).toHaveValue(12);
      const saved = await generateAndSave();
      expect(saved).toMatchObject({ address: ADDRESS_B, propertyId: replacement === 'saved property' ? PROPERTY_B.id : null });
      expect(saved.estimateData.engineRequest.profile).toMatchObject({ homeSqFt: 4200, stories: 1, estimatedBedAreaSf: 900, palmCount: 12 });
      expect(saved.estimateData.inputs._manualFields).not.toContain('homeSqFt');
      if (replacement === 'customer selection' || replacement === 'saved property') expect(saved.customerId).toBe(OWNER.id);
    },
  );

  it('ignores a delayed old-address response after the next property has already populated', async () => {
    const pending = deferred();
    lookupReply = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(jsonResponse({ enriched: structuredClone(ENRICHED), errors: [] }));
    renderEditor();
    selectService('Pest Control');
    lookUp();
    const oldSignal = callsTo('/estimator/property-lookup')[0][1].signal;
    change('Service address', ADDRESS_B);
    lookUp();
    await waitFor(() => expect(screen.getByLabelText('Home Sq Ft')).toHaveValue(4200));
    await act(async () => pending.resolve(jsonResponse({ enriched: { homeSqFt: 1111, lotSqFt: 3000 }, errors: [] })));
    expect(oldSignal.aborted).toBe(true);
    expect(screen.getByLabelText('Home Sq Ft')).toHaveValue(4200);
    const saved = await generateAndSave();
    expect(saved.address).toBe(ADDRESS_B);
    expect(saved.estimateData.engineRequest.profile.homeSqFt).toBe(4200);
  });
});

it('starts a sibling from a reopened draft, clears parent edit identity, and saves with the original group anchor', async () => {
  const started = vi.fn();
  function Workspace() {
    const [editId, setEditId] = useState(SOURCE.id);
    return <EstimateToolViewV2 editEstimateId={editId} onStartNew={() => { started(); setEditId(''); }} />;
  }
  render(<MemoryRouter><Workspace /></MemoryRouter>);
  await screen.findByDisplayValue('QA Contact');
  fireEvent.click(screen.getByRole('button', { name: 'Add another property for this customer', exact: true }));
  expect(started).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Customer name')).toHaveValue('QA Contact');
  expect(screen.getByLabelText('Service address')).toHaveValue('');
  expect(screen.getByLabelText('Home Sq Ft')).toHaveValue(null);
  change('Service address', ADDRESS_B);
  change('Home Sq Ft', '2400');
  selectService('Pest Control');
  const saved = await generateAndSave();
  expect(saved).toMatchObject({
    groupWithEstimateId: SOURCE.id, customerId: OWNER.id, leadId: null,
    address: ADDRESS_B, propertyId: null, customerName: 'QA Contact',
  });
  expect(saved.clientDraftId).toMatch(/^[a-f0-9-]{36}$/);
  expect(saved.clientDraftId).not.toBe(SOURCE.id);
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
});
