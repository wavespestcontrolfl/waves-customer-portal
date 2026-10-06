// @vitest-environment jsdom
// Tree & Shrub Fast Complete, GATE_TS_PEST_CHECK: the "Live insects found?"
// block (only when the context carries pestCheck), the insect chips, the Merit
// block with its Remove button, the live-finds-only note, and the
// treeShrubReview.pestCheck payload. Gate off: nothing rendered, nothing sent.
// Synthetic data only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  { id: 'tristar', name: 'TriStar 8.5 SL', category: 'insecticide', active_ingredient: 'Acetamiprid', tsFlags: {} },
  { id: 'iron', name: 'Chelated Iron Plus', category: 'micronutrient', tsFlags: {} },
];
const VISIT = {
  id: 'svc-ts', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-ts',
  serviceType: 'Tree & Shrub Program', scheduledDate: '2026-10-04', address: { line1: '123 Main St' }, status: 'confirmed',
};
const SERVICE = { id: 'svc-ts', customerName: 'Pat Jones', serviceType: 'Tree & Shrub', address: '123 Main St', timeLabel: '2:00 PM' };
const PEST_CHECK = {
  insectTypes: [
    { key: 'armored_scale', label: 'Armored scale' },
    { key: 'soft_scale', label: 'Soft scale' },
    { key: 'whitefly', label: 'Whitefly' },
    { key: 'caterpillars', label: 'Caterpillars' },
    { key: 'mites', label: 'Mites' },
    { key: 'other', label: 'Other' },
  ],
};
const BASE_CONTEXT = {
  eligible: true, reason: null, service: VISIT, products: CATALOG,
  monthProducts: [
    { productId: 'iron', method: 'foliar_spray' },
    { productId: 'merit', method: 'foliar_spray' },
    { productId: 'tristar', method: 'foliar_spray' },
  ],
  lastVisit: { plantGroups: ['Palms'], areasTreated: [], products: [] },
  warnings: [],
};
const CONTEXT = { ...BASE_CONTEXT, pestCheck: PEST_CHECK };
const MERIT_LINE = 'Merit does not control armored scale. Use TriStar or Distance on crawlers.';

function makeRequest({ context = CONTEXT } = {}) {
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

async function openSheet(request = makeRequest()) {
  render(<FastCompleteTreeShrubSheet service={SERVICE} request={request} onClose={() => {}} />);
  await screen.findByRole('button', { name: /^Chelated Iron Plus/ });
  return request;
}

const addPhoto = async (slot, name) => {
  fireEvent.change(screen.getByLabelText(`${slot} photo file`), { target: { files: [new File(['x'], name, { type: 'image/jpeg' })] } });
  await screen.findByAltText(`${slot} photo`);
};
const completeButton = () => screen.getByRole('button', { name: 'Complete tree & shrub' });
const tick = (label) => fireEvent.click(screen.getByRole('button', { name: label }));
const pressed = (name) => screen.getByRole('button', { name }).getAttribute('aria-pressed');
const completeBody = async (request) => {
  fireEvent.click(completeButton());
  await waitFor(() => expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true));
  return JSON.parse(request.calls.find((c) => c.path.endsWith('/complete')).options.body);
};

// Everything the sheet needs except the pest check, so only it can hold Complete.
async function readyVisit(request) {
  await openSheet(request);
  await addPhoto('Front beds', 'front.jpg');
  await addPhoto('Back or side landscape', 'back.jpg');
  tick('Good');
}
// A product on the visit: tap its tile, then fill its amount.
async function useProduct(name, amount = '2') {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
  const input = await screen.findByLabelText('How much?');
  fireEvent.change(input, { target: { value: amount } });
}

describe('gate off', () => {
  test('nothing is rendered', async () => {
    await openSheet(makeRequest({ context: BASE_CONTEXT }));
    expect(screen.queryByText('Live insects found?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Armored scale' })).toBeNull();
  });

  test('nothing is saved: the body has no pest check', async () => {
    const request = makeRequest({ context: BASE_CONTEXT });
    await readyVisit(request);
    fireEvent.click(screen.getByRole('button', { name: /^Chelated Iron Plus/ }));
    const input = await screen.findByLabelText('How much?');
    fireEvent.change(input, { target: { value: '2' } });
    const body = await completeBody(request);
    expect(JSON.stringify(body)).not.toContain('pestCheck');
    expect(body.treeShrubReview).toBeUndefined();
  });
});

describe('the block', () => {
  test('unanswered by default, never required: no types, nothing sent', async () => {
    const request = makeRequest();
    await readyVisit(request);
    expect(screen.getByRole('heading', { name: 'Live insects found?' })).toBeTruthy();
    expect(pressed('Yes')).toBe('false');
    expect(pressed('No')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Armored scale' })).toBeNull();
    await useProduct('Chelated Iron Plus');
    const body = await completeBody(request);
    expect(JSON.stringify(body)).not.toContain('pestCheck');
  });

  test('Yes shows the six chips; tapping Yes again goes back to unanswered', async () => {
    await openSheet();
    tick('Yes');
    for (const label of ['Armored scale', 'Soft scale', 'Whitefly', 'Caterpillars', 'Mites']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    // "Other" is also a plant group and an area: this one sits under its own heading.
    const group = screen.getByRole('heading', { name: 'Which insects?' }).closest('section');
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Armored scale', 'Soft scale', 'Whitefly', 'Caterpillars', 'Mites', 'Other',
    ]);
    tick('Yes');
    expect(screen.queryByRole('button', { name: 'Armored scale' })).toBeNull();
  });

  test('Yes with picks rides the body as treeShrubReview.pestCheck', async () => {
    const request = makeRequest();
    await readyVisit(request);
    await useProduct('Chelated Iron Plus');
    tick('Yes');
    tick('Mites');
    tick('Whitefly');
    const body = await completeBody(request);
    expect(body.treeShrubReview.pestCheck).toEqual({ liveInsectsFound: true, insectTypes: ['whitefly', 'mites'] });
  });

  test('No rides the body with no types', async () => {
    const request = makeRequest();
    await readyVisit(request);
    await useProduct('Chelated Iron Plus');
    tick('No');
    const body = await completeBody(request);
    expect(body.treeShrubReview.pestCheck).toEqual({ liveInsectsFound: false, insectTypes: [] });
  });
});

describe('the Merit rule', () => {
  test('armored scale only with Merit: the line shows, Complete is held, Remove Merit clears it', async () => {
    const request = makeRequest();
    await readyVisit(request);
    await useProduct('Merit 2F');
    expect(completeButton().disabled).toBe(false);
    tick('Yes');
    tick('Armored scale');
    expect(screen.getAllByText(MERIT_LINE).length).toBeGreaterThan(0);
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Merit from this visit' }));
    expect(screen.queryByText(MERIT_LINE)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Merit from this visit' })).toBeNull();
    await useProduct('TriStar 8.5 SL');
    const body = await completeBody(request);
    expect(body.products.map((p) => p.productId)).toEqual(['tristar']);
    expect(body.treeShrubReview.pestCheck).toEqual({ liveInsectsFound: true, insectTypes: ['armored_scale'] });
  });

  test('armored scale with soft scale: the line is a note and Complete stays open', async () => {
    await readyVisit();
    await useProduct('Merit 2F');
    tick('Yes');
    tick('Armored scale');
    tick('Soft scale');
    expect(screen.getByText(MERIT_LINE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove Merit from this visit' })).toBeNull();
    expect(completeButton().disabled).toBe(false);
  });

  test('Merit left off the visit never triggers it', async () => {
    await readyVisit();
    tick('Yes');
    tick('Armored scale');
    expect(screen.queryByText(MERIT_LINE)).toBeNull();
  });
});

describe('the live-finds-only note', () => {
  test('No with TriStar on the visit: a note, and Complete is not held', async () => {
    const request = makeRequest();
    await readyVisit(request);
    await useProduct('TriStar 8.5 SL');
    tick('No');
    expect(screen.getByText('No live insects recorded. TriStar is for live finds only.')).toBeTruthy();
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body.treeShrubReview.pestCheck.liveInsectsFound).toBe(false);
  });

  test('No with an ordinary product: no note', async () => {
    await readyVisit();
    await useProduct('Chelated Iron Plus');
    tick('No');
    expect(screen.queryByText(/is for live finds only/)).toBeNull();
  });
});
