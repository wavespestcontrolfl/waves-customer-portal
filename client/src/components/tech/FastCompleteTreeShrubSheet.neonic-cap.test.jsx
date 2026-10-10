// @vitest-environment jsdom
// Tree & Shrub Fast Complete, GATE_TS_NEONIC_CAP: the "left this year" line under a capped
// product's amount, the hold when the entered amount passes it, and the gate-off sheet that
// shows and holds nothing. Synthetic data only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FastCompleteTreeShrubSheet from './FastCompleteTreeShrubSheet';

vi.mock('../../lib/completion-photo', () => ({
  prepareCompletionPhoto: vi.fn(async (file) => ({
    data: `data:image/jpeg;base64,${file.name}`,
    name: file.name,
    capturedAt: '2026-10-04T14:00:00.000Z',
  })),
}));

vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CATALOG = [
  { id: 'merit', name: 'Merit 2F', category: 'insecticide', active_ingredient: 'Imidacloprid', tsFlags: {} },
  { id: 'iron', name: 'Chelated Iron Plus', category: 'micronutrient', tsFlags: {} },
];
const VISIT = {
  id: 'svc-ts', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-ts',
  serviceType: 'Tree & Shrub Program', scheduledDate: '2026-10-04', address: { line1: '123 Main St' }, status: 'confirmed',
};
const SERVICE = { id: 'svc-ts', customerName: 'Pat Jones', serviceType: 'Tree & Shrub', address: '123 Main St', timeLabel: '2:00 PM' };
const BASE_CONTEXT = {
  eligible: true, reason: null, service: VISIT, products: CATALOG,
  monthProducts: [{ productId: 'iron', method: 'foliar_spray' }, { productId: 'merit', method: 'foliar_spray' }],
  lastVisit: { plantGroups: ['Palms'], areasTreated: [], products: [] },
  warnings: [],
};
// A quarter acre of bed: Merit's yearly amount is 6.4 fl oz; half is used.
const NEONIC_CAP = {
  available: true,
  year: 2026,
  bedSqft: 10890,
  ingredients: [
    { key: 'dinotefuran', usedShare: 0, capByProduct: [], unsized: 0, reason: null },
    { key: 'imidacloprid', usedShare: 0.5, capByProduct: [{ productId: 'merit', name: 'Merit', unit: 'fl_oz', yearlyAmount: 6.4, remainingAmount: 3.2 }], unsized: 0, reason: null },
  ],
};
const NO_BED = {
  available: true,
  year: 2026,
  bedSqft: null,
  ingredients: [{ key: 'imidacloprid', usedShare: null, capByProduct: [{ productId: 'merit', name: 'Merit', unit: 'fl_oz', yearlyAmount: null, remainingAmount: null }], unsized: 0, reason: 'bed_area_needed' }],
};

function makeRequest(context) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/tree-shrub/fast-context')) return context;
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.endsWith('/complete')) return { success: true };
    return {};
  });
  request.calls = calls;
  return request;
}

const addPhoto = async (slot, name) => {
  fireEvent.change(screen.getByLabelText(`${slot} photo file`), { target: { files: [new File(['x'], name, { type: 'image/jpeg' })] } });
  await screen.findByAltText(`${slot} photo`);
};
const completeButton = () => screen.getByRole('button', { name: 'Complete tree & shrub' });

// Everything the sheet needs except the product amount, so only the cap can hold Complete.
async function readyVisit(context) {
  const request = makeRequest(context);
  render(<FastCompleteTreeShrubSheet service={SERVICE} request={request} onClose={() => {}} />);
  await screen.findByRole('button', { name: /^Chelated Iron Plus/ });
  await addPhoto('Front beds', 'front.jpg');
  await addPhoto('Back or side landscape', 'back.jpg');
  fireEvent.click(screen.getByRole('button', { name: 'Good' }));
  return request;
}
async function useMerit(amount) {
  fireEvent.click(screen.getByRole('button', { name: /^Merit 2F/ }));
  fireEvent.change(await screen.findByLabelText('How much?'), { target: { value: amount } });
}

describe('gate off (no neonicCap in the context)', () => {
  test('no line and no hold, however much is entered', async () => {
    await readyVisit(BASE_CONTEXT);
    await useMerit('99');
    expect(screen.queryByText(/left this year/)).toBeNull();
    expect(completeButton().disabled).toBe(false);
  });
});

describe('gate on', () => {
  test('a capped product shows what is left of its yearly amount; an uncapped one shows nothing', async () => {
    await readyVisit({ ...BASE_CONTEXT, neonicCap: NEONIC_CAP });
    await useMerit('1');
    expect(screen.getByText('Merit left this year: 3.2 fl oz of 6.4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Chelated Iron Plus/ }));
    expect(screen.getAllByText(/left this year/)).toHaveLength(1);
  });

  test('an amount over what is left holds Complete and says why; lowering it releases the hold', async () => {
    const request = await readyVisit({ ...BASE_CONTEXT, neonicCap: NEONIC_CAP });
    await useMerit('4');
    expect(completeButton().disabled).toBe(true);
    expect(screen.getAllByText('Merit: 4.0 fl oz is over the 3.2 fl oz left this year for this property.').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('How much?'), { target: { value: '3.2' } });
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(completeButton());
    await waitFor(() => expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true));
  });

  test('no bed area: the line says so and nothing is held', async () => {
    await readyVisit({ ...BASE_CONTEXT, neonicCap: NO_BED });
    await useMerit('99');
    expect(screen.getByText('Merit: bed area needed to check the yearly limit.')).toBeTruthy();
    expect(completeButton().disabled).toBe(false);
  });

  test('a failed ledger read (available:false) shows nothing and holds nothing', async () => {
    await readyVisit({ ...BASE_CONTEXT, neonicCap: { available: false, reason: 'ledger_unavailable', year: 2026, ingredients: [] } });
    await useMerit('99');
    expect(screen.queryByText(/left this year|bed area needed/)).toBeNull();
    expect(completeButton().disabled).toBe(false);
  });
});
