// @vitest-environment jsdom
// Tree & Shrub Fast Complete: suggestion tiles that start off, amounts only
// from last time, the server's compliance taps (pollinator, IRAC / FRAC), the
// five photo slots and the Analyze read, and the /complete body contract.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteTreeShrubSheet from './FastCompleteTreeShrubSheet';

// The canvas downscale needs a browser; the slot only needs what it returns.
vi.mock('../../lib/completion-photo', () => ({
  prepareCompletionPhoto: vi.fn(async (file) => ({
    data: `data:image/jpeg;base64,${file.name}`,
    name: file.name,
    capturedAt: '2026-10-04T14:00:00.000Z',
  })),
}));

// Each test mounts the whole sheet and taps through it: slow on a busy runner.
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CATALOG = [
  // An insecticide: bee-sensitive and a resistance-rotation product.
  { id: 'merit', name: 'Merit 2F', category: 'insecticide', active_ingredient: 'imidacloprid', tsFlags: { insectFamily: true, needsIracFrac: true } },
  // A fungicide: rotation product, no bee block.
  { id: 'heritage', name: 'Heritage G', category: 'fungicide', active_ingredient: 'azoxystrobin', formulation: 'granular', tsFlags: { needsIracFrac: true } },
  // A micronutrient spray: no flags at all.
  { id: 'iron', name: 'Chelated Iron Plus', category: 'micronutrient', tsFlags: {} },
  // An N/P fertilizer in the summer blackout.
  { id: 'palmfert', name: 'Palm Special 8-2-12', category: 'fertilizer', tsFlags: { npBlackout: true } },
  // The palm injection flow's product: never on this sheet.
  { id: 'inject', name: 'Arbor Inject Palm', category: 'insecticide', tsFlags: { injection: true, insectFamily: true } },
  // Something the tech adds from the picker.
  { id: 'oil', name: 'SuffOil-X', category: 'insecticide', tsFlags: { insectFamily: true } },
  { id: 'drench', name: 'Imidacloprid Drench', category: 'insecticide', inventory_unit: 'fl_oz', inventory_on_hand: '0.0000', tsFlags: {} },
];

const VISIT = {
  id: 'svc-ts', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-ts',
  serviceType: 'Tree & Shrub Program', scheduledDate: '2026-10-04', address: { line1: '123 Main St' }, status: 'confirmed',
};
const SERVICE = { id: 'svc-ts', customerName: 'Pat Jones', serviceType: 'Tree & Shrub', address: '123 Main St', timeLabel: '2:00 PM' };

const CONTEXT = {
  eligible: true,
  reason: null,
  service: VISIT,
  products: CATALOG,
  monthProducts: [
    { productId: 'merit', method: 'foliar_spray', lastAmount: { totalAmount: 2, amountUnit: 'fl_oz', serviceDate: '2026-09-01' } },
    { productId: 'heritage', method: 'soil_drench' },
    { productId: 'iron', method: 'foliar_spray' },
    { productId: 'palmfert', method: 'granular_broadcast' },
  ],
  // The server's shapes (server/services/tree-shrub-fast-context.js).
  lastVisit: {
    plantGroups: ['Palms', 'Shrubs'],
    areasTreated: ['Front landscape'],
    products: [{ productId: 'iron', productName: 'Chelated Iron Plus', totalAmount: 1, amountUnit: 'fl_oz' }],
  },
  warnings: [{
    type: 'rotation', productId: 'merit', productName: 'Merit 2F', group: 'IRAC 4A',
    daysAgo: 20, appliedProductName: 'Zylam Insecticide', appliedOn: '2026-09-11',
  }],
};

const PREVIEW = {
  scores: { foliageFullness: 80 },
  observations: 'Some thin foliage.',
  scoredCount: 2,
  photoCount: 2,
  signature: 'sig-1',
  aiSummary: 'AI flagged 2 items to review.',
  findings: [
    { key: 'pest_activity', label: 'Pest-pressure signals', detail: 'Possible pest-pressure signals on foliage.', defaultAction: 'monitor' },
    { key: 'leaf_color_vigor', label: 'Leaf color & vigor', detail: 'Some off-color foliage.', defaultAction: 'monitor' },
  ],
  suggestedCondition: 'Fair',
  status: 'complete',
};

function makeRequest({ context = CONTEXT, preview = PREVIEW, previewError = null } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/tree-shrub/fast-context')) {
      if (context instanceof Error) throw context;
      return context;
    }
    if (path.endsWith('/tree-shrub/assess-preview')) {
      if (previewError) throw previewError;
      return preview;
    }
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.endsWith('/complete')) return { success: true };
    return {};
  });
  request.calls = calls;
  return request;
}

async function openSheet(request = makeRequest(), props = {}) {
  render(<FastCompleteTreeShrubSheet service={SERVICE} request={request} onClose={() => {}} {...props} />);
  await screen.findByRole('button', { name: /^Merit 2F/ });
  return request;
}

const tile = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const addPhoto = async (slot, name) => {
  fireEvent.change(screen.getByLabelText(`${slot} photo file`), { target: { files: [new File(['x'], name, { type: 'image/jpeg' })] } });
  await screen.findByAltText(`${slot} photo`);
};
const addBothPhotos = async () => {
  await addPhoto('Front beds', 'front.jpg');
  await addPhoto('Back or side landscape', 'back.jpg');
};
const editorFor = (name) => screen.getByRole('group', { name });
const enterAmount = (name, amount) => fireEvent.change(within(editorFor(name)).getByLabelText('How much?'), { target: { value: String(amount) } });
const completeButton = () => screen.getByRole('button', { name: 'Complete tree & shrub' });
const completeBody = async (request) => {
  fireEvent.click(completeButton());
  await waitFor(() => expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true));
  return JSON.parse(request.calls.find((c) => c.path.endsWith('/complete')).options.body);
};

// A visit ready to complete with Iron only (no flags): photos, condition set.
async function readyVisit(request) {
  await openSheet(request);
  await addBothPhotos();
  fireEvent.click(screen.getByRole('button', { name: 'Good' }));
}

describe('products', () => {
  test('this month\'s products are suggestions that start off, and nothing is assumed applied', async () => {
    const request = await openSheet();
    for (const name of ['Merit 2F', 'Heritage G', 'Chelated Iron Plus']) {
      expect(tile(name).getAttribute('aria-pressed')).toBe('false');
    }
    expect(screen.queryByRole('group', { name: 'Merit 2F' })).toBeNull();
    // Nothing on the sheet means an inspection-only visit: no products sent.
    await addBothPhotos();
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    const body = await completeBody(request);
    expect(body.products).toEqual([]);
  });

  test('an amount fills only from last time, labeled; everything else is blank and required', async () => {
    await openSheet();
    fireEvent.click(tile('Merit 2F'));
    const merit = editorFor('Merit 2F');
    expect(within(merit).getByLabelText('How much?').value).toBe('2');
    expect(within(within(merit).getByRole('group', { name: 'Unit' })).getByRole('button', { name: 'fl oz' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(merit).getByText('last time')).toBeTruthy();
    // The month row's own method, not a chip.
    expect(within(merit).getByText('How: Foliar spray')).toBeTruthy();

    // The last visit's recorded products cover a product with no month amount of its own.
    fireEvent.click(tile('Chelated Iron Plus'));
    expect(within(editorFor('Chelated Iron Plus')).getByLabelText('How much?').value).toBe('1');
    expect(within(editorFor('Chelated Iron Plus')).getByText('last time')).toBeTruthy();

    // No last amount: blank, and typing one clears the label.
    fireEvent.click(tile('Heritage G'));
    const heritage = editorFor('Heritage G');
    expect(within(heritage).getByLabelText('How much?').value).toBe('');
    expect(within(heritage).queryByText('last time')).toBeNull();
    fireEvent.change(within(editorFor('Merit 2F')).getByLabelText('How much?'), { target: { value: '3' } });
    expect(within(editorFor('Merit 2F')).queryByText('last time')).toBeNull();
  });

  test('a blank amount blocks Complete and names the product', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(tile('Heritage G'));
    expect(screen.getByText('Enter the amount for Heritage G.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    enterAmount('Heritage G', 0);
    expect(completeButton().disabled).toBe(true);
    enterAmount('Heritage G', 6);
    expect(completeButton().disabled).toBe(false);
  });

  test('a tsp amount goes to the server as fl oz, never mL', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(tile('Chelated Iron Plus'));
    const editor = editorFor('Chelated Iron Plus');
    fireEvent.click(within(within(editor).getByRole('group', { name: 'Unit' })).getByRole('button', { name: 'tsp' }));
    fireEvent.change(within(editor).getByLabelText('How much?'), { target: { value: '3' } });
    const body = await completeBody(request);
    expect(body.products[0]).toMatchObject({ productId: 'iron', totalAmount: 0.5, amountUnit: 'fl_oz', applicationMethod: 'foliar_spray' });
    expect(within(editor).queryByRole('button', { name: 'mL' })).toBeNull();
  });

  test('an injection product is absent from the picker and the sheet', async () => {
    await openSheet();
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    const picker = screen.getByRole('dialog', { name: 'Add a product' });
    expect(within(picker).getByRole('button', { name: /SuffOil-X/ })).toBeTruthy();
    expect(within(picker).queryByText('Arbor Inject Palm')).toBeNull();
    fireEvent.change(within(picker).getByLabelText('Search products'), { target: { value: 'inject' } });
    expect(within(picker).queryByText('Arbor Inject Palm')).toBeNull();
    expect(screen.queryByText('Arbor Inject Palm')).toBeNull();
  });

  test('an added product opens its editor with method chips and can be removed', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a product' })).getByRole('button', { name: /Imidacloprid Drench/ }));
    const editor = editorFor('Imidacloprid Drench');
    // Foliar spray by default; soil drench and granular are chips.
    const how = within(editor).getByRole('group', { name: 'How' });
    expect(within(how).getByRole('button', { name: 'Foliar spray' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(how).getByRole('button', { name: 'Soil drench' }));
    // A tracked stock at zero holds Complete before the server refuses it.
    enterAmount('Imidacloprid Drench', 2);
    expect(screen.getByText('Imidacloprid Drench shows 0 in stock. Update inventory or turn it off.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('group', { name: 'Imidacloprid Drench' })).toBeNull();
    expect(completeButton().disabled).toBe(false);
  });

  test('an N/P blackout product says so and cannot be turned on', async () => {
    await openSheet();
    const blocked = tile('Palm Special 8-2-12');
    expect(blocked.disabled).toBe(true);
    expect(within(blocked).getByText('N/P blackout — can’t apply Jun 1–Sep 30')).toBeTruthy();
    fireEvent.click(blocked);
    expect(blocked.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Palm Special 8-2-12' })).toBeNull();
  });

  test('the server\'s warnings show under their product, never as a block', async () => {
    const palmSpacing = {
      type: 'palm_fertilizer_spacing', productId: 'palmfert', productName: 'Palm Special 8-2-12',
      windowDays: 75, daysAgo: 40, appliedProductName: 'Palm Special 8-2-12', appliedOn: '2026-08-22',
    };
    const request = makeRequest({ context: { ...CONTEXT, warnings: [...CONTEXT.warnings, palmSpacing] } });
    await openSheet(request);
    // A product's warning shows once that product is on the sheet.
    expect(screen.queryByText(/IRAC 4A went down 20 days ago/)).toBeNull();
    fireEvent.click(tile('Merit 2F'));
    expect(within(editorFor('Merit 2F')).getByText('IRAC 4A went down 20 days ago (Zylam Insecticide). Rotate to another group if you can.')).toBeTruthy();
    await addBothPhotos();
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    fireEvent.click(screen.getByRole('button', { name: 'No blooms or no bees' }));
    expect(completeButton().disabled).toBe(false);
  });
});

describe('compliance taps', () => {
  test('pollinator status is required only with an insect product, and bees active blocks', async () => {
    const request = makeRequest();
    await readyVisit(request);
    // A rotation product that is no insect product: no pollinator tap.
    fireEvent.click(tile('Heritage G'));
    enterAmount('Heritage G', 6);
    expect(screen.queryByRole('button', { name: 'No blooms or no bees' })).toBeNull();
    expect(completeButton().disabled).toBe(false);

    fireEvent.click(tile('Merit 2F'));
    expect(screen.getByText('Select the flowering / bee status.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    // Never offered: the server refuses it beside an insect product.
    expect(screen.queryByRole('button', { name: /No insecticide applied/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Blooming — bees active' }));
    expect(screen.getByText('Do not complete bee-sensitive insect/contact applications on blooming plants while bees are active.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Blooming — no bees active' }));
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body.structuredFindings.values.pollinator_status).toBe('Blooming — no bees active');
  });

  test('without an insect product no pollinator status is sent', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(tile('Chelated Iron Plus'));
    const body = await completeBody(request);
    expect(body.structuredFindings.values).not.toHaveProperty('pollinator_status');
    expect(body.structuredFindings.values).not.toHaveProperty('irac_frac_logged');
  });

  test('IRAC / FRAC is sent as Yes when the app ran the rotation check, with no tap asked', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(tile('Heritage G'));
    enterAmount('Heritage G', 6);
    expect(screen.queryByText('IRAC / FRAC rotation checked & logged')).toBeNull();
    expect(screen.getByText('IRAC / FRAC rotation checked by the app.')).toBeTruthy();
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body.structuredFindings.values.irac_frac_logged).toBe('Yes');
  });

  test('when the rotation check is unavailable the tech must tap Yes', async () => {
    const request = makeRequest({ context: { ...CONTEXT, warnings: [], warningsUnavailable: true } });
    await readyVisit(request);
    fireEvent.click(tile('Heritage G'));
    enterAmount('Heritage G', 6);
    expect(screen.getByText('Confirm the IRAC / FRAC rotation was checked and logged.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body.structuredFindings.values.irac_frac_logged).toBe('Yes');
  });
});

describe('photos and the photo read', () => {
  test('five slots show their one-line captions and the first two are the floor', async () => {
    await openSheet();
    for (const label of ['Front beds', 'Back or side landscape', 'Whole palm', 'Oldest fronds', 'Leaf close-up']) {
      expect(screen.getByLabelText(`${label} photo file`)).toBeTruthy();
    }
    expect(screen.getByText(/The whole front bed line from the driveway apron or walk/)).toBeTruthy();
    expect(screen.getByText(/Step back until the worst-looking palm fits top to bottom/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    expect(screen.getByText('Add a front beds photo.')).toBeTruthy();
    await addPhoto('Front beds', 'front.jpg');
    expect(screen.getByText('Add a back or side landscape photo.')).toBeTruthy();
    // A palm photo is optional and does not stand in for the second floor photo.
    await addPhoto('Whole palm', 'palm.jpg');
    expect(screen.getByText('Add a back or side landscape photo.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    await addPhoto('Back or side landscape', 'back.jpg');
    expect(completeButton().disabled).toBe(false);
  });

  test('photos go in the body as completionPhotos in slot order, not through the staged photo manager', async () => {
    const request = makeRequest();
    await openSheet(request);
    await addPhoto('Leaf close-up', 'leaf.jpg');
    await addPhoto('Back or side landscape', 'back.jpg');
    await addPhoto('Front beds', 'front.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    const body = await completeBody(request);
    expect(body.completionPhotos).toEqual([
      { data: 'data:image/jpeg;base64,front.jpg', name: 'front.jpg', photoType: 'after', sortOrder: 0, capturedAt: '2026-10-04T14:00:00.000Z' },
      { data: 'data:image/jpeg;base64,back.jpg', name: 'back.jpg', photoType: 'after', sortOrder: 1, capturedAt: '2026-10-04T14:00:00.000Z' },
      { data: 'data:image/jpeg;base64,leaf.jpg', name: 'leaf.jpg', photoType: 'after', sortOrder: 2, capturedAt: '2026-10-04T14:00:00.000Z' },
    ]);
    expect(request.calls.some((c) => c.path.includes('/tech/services/'))).toBe(false);
  });

  test('Analyze reads the current photos in slot order and a rejected finding goes in the body as hidden', async () => {
    const request = makeRequest();
    await openSheet(request);
    await addPhoto('Back or side landscape', 'back.jpg');
    await addPhoto('Front beds', 'front.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Analyze photos' }));
    expect(await screen.findByText('Pest-pressure signals')).toBeTruthy();
    const preview = request.calls.find((c) => c.path.endsWith('/assess-preview'));
    expect(JSON.parse(preview.options.body)).toEqual({ photos: [{ data: 'data:image/jpeg;base64,front.jpg' }, { data: 'data:image/jpeg;base64,back.jpg' }] });

    fireEvent.click(screen.getByRole('button', { name: 'Reject Pest-pressure signals' }));
    expect(screen.getByRole('button', { name: 'Reject Pest-pressure signals' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    const body = await completeBody(request);
    expect(body.treeShrubReview).toEqual({
      scores: PREVIEW.scores,
      observations: 'Some thin foliage.',
      scoredCount: 2,
      signature: 'sig-1',
      decisions: [
        { key: 'pest_activity', action: 'hidden', detail: 'Possible pest-pressure signals on foliage.' },
        { key: 'leaf_color_vigor', action: 'monitor', detail: 'Some off-color foliage.' },
      ],
    });
  });

  test('a photo change after Analyze drops the read, its tiles and the review from the body', async () => {
    const request = makeRequest();
    await openSheet(request);
    await addBothPhotos();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze photos' }));
    await screen.findByText('Pest-pressure signals');
    expect(screen.getByRole('button', { name: 'Fair (photo read)' })).toBeTruthy();

    await addPhoto('Whole palm', 'palm.jpg');
    expect(screen.queryByText('Pest-pressure signals')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fair (photo read)' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Analyze photos' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    const body = await completeBody(request);
    expect(body).not.toHaveProperty('treeShrubReview');
    expect(body.completionPhotos).toHaveLength(3);
  });

  test('a read that comes back after the photos changed is discarded', async () => {
    let release;
    const request = makeRequest();
    const base = request.getMockImplementation();
    request.mockImplementation(async (path, options) => {
      if (path.endsWith('/assess-preview')) {
        await new Promise((resolve) => { release = resolve; });
      }
      return base(path, options);
    });
    await openSheet(request);
    await addBothPhotos();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze photos' }));
    await waitFor(() => expect(release).toBeTruthy());
    await addPhoto('Leaf close-up', 'leaf.jpg');
    release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Analyze photos' }).disabled).toBe(false));
    expect(screen.queryByText('Pest-pressure signals')).toBeNull();
  });

  test('a failed Analyze never blocks Complete and sends no review', async () => {
    const request = makeRequest({ previewError: Object.assign(new Error('Tree & shrub assessment preview failed'), { status: 500 }) });
    await openSheet(request);
    await addBothPhotos();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze photos' }));
    expect(await screen.findByText(/The photo read is unavailable right now/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body).not.toHaveProperty('treeShrubReview');
  });
});

describe('findings and the body', () => {
  test('condition is required; the photo read\'s suggestion is marked but never preselected', async () => {
    const request = makeRequest();
    await openSheet(request);
    await addBothPhotos();
    expect(screen.getByText('Select the overall landscape condition.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze photos' }));
    const suggested = await screen.findByRole('button', { name: 'Fair (photo read)' });
    expect(suggested.getAttribute('aria-pressed')).toBe('false');
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Poor' }));
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body.structuredFindings.values.landscape_condition).toBe('Poor');
  });

  test('plant groups start from last visit and are required; areas are optional', async () => {
    const request = makeRequest();
    await readyVisit(request);
    expect(screen.getByRole('button', { name: 'Palms' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Front landscape' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Palms' }));
    fireEvent.click(screen.getByRole('button', { name: 'Shrubs' }));
    expect(screen.getByText('Select the plant groups serviced.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Hedges' }));
    fireEvent.click(screen.getByRole('button', { name: 'Front landscape' }));
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body.structuredFindings.values.plant_groups).toBe('Hedges');
    expect(body.structuredFindings.values).not.toHaveProperty('areas_treated');
  });

  test('the body carries the full-form comms flags and never treatments_completed', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(tile('Merit 2F'));
    fireEvent.click(screen.getByRole('button', { name: 'No blooms or no bees' }));
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'Treated the ixora hedge.' } });
    const body = await completeBody(request);
    expect(request.calls.find((c) => c.path.endsWith('/complete')).path).toBe('/admin/dispatch/svc-ts/complete');
    expect(body).toMatchObject({
      visitOutcome: 'completed',
      sendCompletionSms: true,
      requestReview: true,
      includePayLink: true,
      reviewTiming: 'auto',
      technicianNotes: 'Treated the ixora hedge.',
      techTips: null,
    });
    expect(typeof body.idempotencyKey).toBe('string');
    expect(body.expectedVisit).toEqual({
      customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-ts',
      serviceType: 'Tree & Shrub Program', scheduledDate: '2026-10-04', address: { line1: '123 Main St' },
    });
    expect(body.products).toEqual([
      { productId: 'merit', applicationMethod: 'foliar_spray', totalAmount: 2, amountUnit: 'fl_oz', applicationArea: 'Front landscape', targets: [] },
    ]);
    expect(body.structuredFindings).toEqual({
      type: 'tree_shrub',
      values: {
        plant_groups: 'Palms, Shrubs',
        areas_treated: 'Front landscape',
        landscape_condition: 'Good',
        pollinator_status: 'No blooms or no bees',
        irac_frac_logged: 'Yes',
      },
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain('treatments_completed');
    for (const key of ['observed_conditions', 'palms_serviced', 'palm_condition', 'injection_recommended']) expect(text).not.toContain(key);
    expect(await screen.findByText('Tree & shrub complete')).toBeTruthy();
  });
});

describe('blocked states', () => {
  test('the gate being off (404) sends the tech to the full form', async () => {
    const request = makeRequest({ context: Object.assign(new Error('Not found'), { status: 404 }) });
    render(<FastCompleteTreeShrubSheet service={SERVICE} request={request} onClose={() => {}} onFullForm={() => {}} />);
    expect(await screen.findByText('This visit needs the full form.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Full form' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete tree & shrub' })).toBeNull();
  });

  test('a visit that is not eligible needs the full form', async () => {
    const request = makeRequest({ context: { ...CONTEXT, eligible: false, reason: 'companion_sections' } });
    render(<FastCompleteTreeShrubSheet service={SERVICE} request={request} onClose={() => {}} />);
    expect(await screen.findByText('This visit needs the full form.')).toBeTruthy();
  });

  test('a visit that changed since the schedule loaded cannot be completed here', async () => {
    const request = makeRequest();
    const onClose = vi.fn();
    render(<FastCompleteTreeShrubSheet service={{ ...SERVICE, routedScheduledDate: '2026-10-01' }} request={request} onClose={onClose} />);
    expect(await screen.findByText(/This visit changed since your schedule loaded/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith({ refresh: true });
  });

  test('a visit already completed is not completed again', async () => {
    const request = makeRequest({ context: { ...CONTEXT, service: { ...VISIT, status: 'completed' } } });
    render(<FastCompleteTreeShrubSheet service={SERVICE} request={request} onClose={() => {}} />);
    expect(await screen.findByText(/This visit is already completed/)).toBeTruthy();
  });

  test('a failed load shows its error', async () => {
    const request = makeRequest({ context: Object.assign(new Error('Server exploded'), { status: 500 }) });
    render(<FastCompleteTreeShrubSheet service={SERVICE} request={request} onClose={() => {}} />);
    expect(await screen.findByText('Server exploded')).toBeTruthy();
  });
});
