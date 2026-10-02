// @vitest-environment jsdom
// Lawn re-service Fast Complete: suggestion tiles that start off, amounts only
// from last time, Complete gated on its required taps, and the /complete body
// contract (typed one_time_lawn_treatment findings, spot-treatment rows, the
// full form's customer-text defaults, no customerRecapMode).
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteLawnReserviceSheet, {
  AREA_OPTIONS, LAWN_CONDITION_OPTIONS, TURF_ISSUE_OPTIONS, WEED_PRESSURE_OPTIONS,
} from './FastCompleteLawnReserviceSheet';
import { LAWN_TARGET_SUGGESTIONS, NUTRITION_TARGET_SUGGESTIONS, productTargetsNutrition } from '../../lib/lawn-targets';
import { PROJECT_TYPES } from '../../../../server/services/project-types.js';

// Each test mounts the whole sheet and taps through it: slow on a busy runner.
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CATALOG = [
  { id: 'celsius', name: 'Celsius WG', category: 'herbicide', formulation: 'WG' },
  { id: 'talak', name: 'Talak 7.9%', category: 'insecticide', formulation: 'SC' },
  { id: 'headway', name: 'Headway G', category: 'fungicide', formulation: 'granular' },
  { id: 'empty', name: 'Empty Jug Surfactant', category: 'adjuvant', inventory_unit: 'fl_oz', inventory_on_hand: '0.0000' },
];

const VISIT = {
  id: 'svc-lawn', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-lawn', serviceKey: 'lawn_re_service',
  serviceType: 'Lawn Care Re-Service', scheduledDate: '2026-10-04', address: { line1: '123 Main St' }, status: 'confirmed',
};
const SERVICE = { id: 'svc-lawn', customerName: 'Pat Jones', serviceType: 'Lawn Re-Service', address: '123 Main St', timeLabel: '2:00 PM' };

// The server's shapes (server/services/lawn-reservice-fast-context.js).
const CONTEXT = {
  enabled: true,
  eligible: true,
  reason: null,
  service: VISIT,
  customerRequest: { text: 'Weeds are back along the driveway.', pests: ['Weeds'] },
  products: CATALOG,
  methods: [
    { value: 'spot_treatment', label: 'Spot treatment', common: true, requiresSqft: false },
    { value: 'broadcast_spray', label: 'Broadcast spray', common: true, requiresSqft: true },
    { value: 'granular_broadcast', label: 'Granular broadcast', common: true, requiresSqft: true },
    { value: 'soil_drench', label: 'Soil drench', common: false, requiresSqft: false },
    { value: 'foliar_spray', label: 'Foliar spray', common: false, requiresSqft: false },
  ],
  lawnSqft: 6400,
  lastVisit: {
    serviceRecordId: 'rec-1',
    serviceDate: '2026-09-20',
    serviceType: 'Lawn Care',
    products: [
      { productId: 'celsius', name: 'Celsius WG', totalAmount: 1.5, amountUnit: 'oz', method: 'spot_treatment', areaValue: null, areaUnit: null },
      { productId: 'talak', name: 'Talak 7.9%', totalAmount: 4, amountUnit: 'fl_oz', method: 'broadcast_spray', areaValue: 5200, areaUnit: 'sqft' },
      // No usable recorded method (the server nulls anything it does not offer).
      { productId: 'headway', name: 'Headway G', totalAmount: null, amountUnit: null, method: null, areaValue: null, areaUnit: null },
    ],
  },
};

function makeRequest({ context = CONTEXT, completeError = null } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/lawn-reservice/fast-context')) {
      // An array answers each read in turn (the last one repeats).
      const answer = Array.isArray(context) ? (context.length > 1 ? context.shift() : context[0]) : context;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (path.endsWith('/complete')) {
      if (completeError) throw completeError;
      return { success: true };
    }
    return {};
  });
  request.calls = calls;
  return request;
}

async function openSheet(request = makeRequest(), props = {}) {
  render(<FastCompleteLawnReserviceSheet service={SERVICE} request={request} onClose={() => {}} {...props} />);
  await screen.findByRole('button', { name: /^Celsius WG/ });
  return request;
}

const tile = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const editorFor = (name) => screen.getByRole('group', { name });
const enterAmount = (name, amount) => fireEvent.change(within(editorFor(name)).getByLabelText('How much?'), { target: { value: String(amount) } });
// A Treating-for chip (the same label also shows as a product row's "For" chip).
const issue = (name) => within(screen.getByRole('heading', { name: 'Treating for' }).closest('section')).getByRole('button', { name });
// What one product was applied against, on its own row.
const forTarget = (product, name) => fireEvent.click(within(within(editorFor(product)).getByRole('group', { name: 'For' })).getByRole('button', { name }));
// A product row's own Where chips (default Front lawn).
const whereGroup = (product) => within(editorFor(product)).getByRole('group', { name: 'Where' });
const where = (product, ...names) => {
  for (const name of names.length ? names : ['Front lawn']) fireEvent.click(within(whereGroup(product)).getByRole('button', { name }));
};
const wherePressed = (product) => within(whereGroup(product)).getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
const completeButton = () => screen.getByRole('button', { name: 'Complete lawn re-service' });
const completeBody = async (request) => {
  fireEvent.click(completeButton());
  await waitFor(() => expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true));
  return JSON.parse(request.calls.find((c) => c.path.endsWith('/complete')).options.body);
};

// Celsius on with last time's amount; the three required taps set.
async function readyVisit(request) {
  await openSheet(request);
  fireEvent.click(tile('Celsius WG'));
  fireEvent.click(issue('Dollarweed'));
  forTarget('Celsius WG', 'Dollarweed');
  fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
  where('Celsius WG');
}

describe('the typed form\'s option lists', () => {
  test('match server/services/project-types.js one_time_lawn_treatment exactly (the server rejects anything else)', () => {
    const fields = Object.fromEntries(PROJECT_TYPES.one_time_lawn_treatment.findingsFields.map((f) => [f.key, f]));
    expect(TURF_ISSUE_OPTIONS).toEqual(fields.turf_issues.options);
    expect(WEED_PRESSURE_OPTIONS).toEqual(fields.weed_pressure.options);
    expect(LAWN_CONDITION_OPTIONS).toEqual(fields.lawn_condition.options);
    expect(AREA_OPTIONS).toEqual(fields.spot_treatment_areas.options);
    for (const option of [...TURF_ISSUE_OPTIONS, ...AREA_OPTIONS]) expect(option.includes(',')).toBe(false);
  });
});

describe('products', () => {
  test('the last lawn visit\'s products are suggestions that start off, and nothing is assumed applied', async () => {
    await openSheet();
    for (const name of ['Celsius WG', 'Talak 7.9%', 'Headway G']) {
      expect(tile(name).getAttribute('aria-pressed')).toBe('false');
    }
    expect(screen.queryByRole('group', { name: 'Celsius WG' })).toBeNull();
    expect(completeButton().disabled).toBe(true);
    expect(screen.getByText('Select at least one product.')).toBeTruthy();
  });

  test('an amount fills only from last time, labeled; everything else is blank and required', async () => {
    await openSheet();
    fireEvent.click(tile('Celsius WG'));
    const celsius = editorFor('Celsius WG');
    expect(within(celsius).getByLabelText('How much?').value).toBe('1.5');
    expect(within(within(celsius).getByRole('group', { name: 'Unit' })).getByRole('button', { name: 'oz' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(celsius).getByText('last time')).toBeTruthy();
    // The recorded method is preselected; a spot row asks for no area.
    expect(within(within(celsius).getByRole('group', { name: 'How' })).getByRole('button', { name: 'Spot treatment' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(celsius).queryByLabelText('Area treated (sq ft)')).toBeNull();

    fireEvent.click(tile('Talak 7.9%'));
    const talak = editorFor('Talak 7.9%');
    expect(within(talak).getByLabelText('How much?').value).toBe('4');
    expect(within(within(talak).getByRole('group', { name: 'Unit' })).getByRole('button', { name: 'fl oz' }).getAttribute('aria-pressed')).toBe('true');

    // A last-visit row that recorded no amount: blank.
    fireEvent.click(tile('Headway G'));
    const headway = editorFor('Headway G');
    expect(within(headway).getByLabelText('How much?').value).toBe('');
    expect(within(headway).queryByText('last time')).toBeNull();

    // Typing over last time's amount clears the label.
    fireEvent.change(within(celsius).getByLabelText('How much?'), { target: { value: '2' } });
    expect(within(editorFor('Celsius WG')).queryByText('last time')).toBeNull();
  });

  test('a blank amount blocks Complete and names the product', async () => {
    const request = makeRequest();
    await readyVisit(request);
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(tile('Headway G'));
    expect(screen.getByText('Enter the amount for Headway G.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    enterAmount('Headway G', 0);
    expect(completeButton().disabled).toBe(true);
    enterAmount('Headway G', 6);
    // Headway recorded no usable method last time: the tech's tap is still owed.
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(within(within(editorFor('Headway G')).getByRole('group', { name: 'How' })).getByRole('button', { name: 'Spot treatment' }));
    // A fungicide also owes what it was applied against.
    expect(screen.getByText('Pick what Headway G was for.')).toBeTruthy();
    forTarget('Headway G', 'Dollarweed');
    expect(completeButton().disabled).toBe(false);
  });

  test('"+ Other product" adds any catalog product, blank, and it can be removed', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    const picker = screen.getByRole('dialog', { name: 'Add a product' });
    // A last-visit product already on the sheet is not offered again.
    fireEvent.click(within(picker).getByRole('button', { name: /Empty Jug Surfactant/ }));
    const editor = editorFor('Empty Jug Surfactant');
    expect(within(editor).getByLabelText('How much?').value).toBe('');
    // An added product has no method preselected, and Complete waits for a tap.
    for (const button of within(within(editor).getByRole('group', { name: 'How' })).getAllByRole('button')) {
      expect(button.getAttribute('aria-pressed')).toBe('false');
    }
    // A tracked stock at zero holds Complete before the server refuses it.
    enterAmount('Empty Jug Surfactant', 2);
    expect(screen.getByText('Empty Jug Surfactant shows 0 in stock. Update inventory, then tap Check stock.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('group', { name: 'Empty Jug Surfactant' })).toBeNull();
    expect(completeButton().disabled).toBe(false);
  });

  test('a product at 0 stock holds Complete until Check stock reads it restocked', async () => {
    const restocked = { ...CONTEXT, products: CATALOG.map((p) => (p.id === 'empty' ? { ...p, inventory_on_hand: 64 } : p)) };
    const request = makeRequest({ context: [CONTEXT, restocked] });
    await readyVisit(request);
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a product' })).getByRole('button', { name: /Empty Jug Surfactant/ }));
    enterAmount('Empty Jug Surfactant', 2);
    fireEvent.click(within(within(editorFor('Empty Jug Surfactant')).getByRole('group', { name: 'How' })).getByRole('button', { name: 'Spot treatment' }));
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check stock' }));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Check stock' })).toBeNull();
  });

  test('a WaveGuard lawn callback (stockAdvisory) shows the 0-stock flag but never holds Complete', async () => {
    const request = makeRequest({ context: { ...CONTEXT, stockAdvisory: true } });
    await readyVisit(request);
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a product' })).getByRole('button', { name: /Empty Jug Surfactant/ }));
    enterAmount('Empty Jug Surfactant', 2);
    fireEvent.click(within(within(editorFor('Empty Jug Surfactant')).getByRole('group', { name: 'How' })).getByRole('button', { name: 'Spot treatment' }));
    expect(screen.getByText('0 in stock')).toBeTruthy();
    expect(screen.queryByText(/shows 0 in stock/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check stock' })).toBeNull();
    expect(completeButton().disabled).toBe(false);
  });

  test('a property with no earlier lawn visit starts with no tiles and asks the tech to add what they applied', async () => {
    const request = makeRequest({ context: { ...CONTEXT, lastVisit: null } });
    render(<FastCompleteLawnReserviceSheet service={SERVICE} request={request} onClose={() => {}} />);
    expect(await screen.findByText('No earlier lawn visit products on record. Add what you applied.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Other product' })).toBeTruthy();
  });
});

describe('application method and area', () => {
  const howGroup = (name) => within(editorFor(name)).getByRole('group', { name: 'How' });
  const pressed = (name, label) => within(howGroup(name)).getByRole('button', { name: label }).getAttribute('aria-pressed');
  const areaInput = (name) => within(editorFor(name)).getByLabelText('Area treated (sq ft)');

  test('a seeded last-visit method is preserved, and the body carries each row\'s own method', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(tile('Talak 7.9%'));
    expect(pressed('Celsius WG', 'Spot treatment')).toBe('true');
    expect(pressed('Talak 7.9%', 'Broadcast spray')).toBe('true');
    expect(pressed('Talak 7.9%', 'Spot treatment')).toBe('false');
    // The tech changes Celsius to granular: that is what goes to the server.
    fireEvent.click(within(howGroup('Celsius WG')).getByRole('button', { name: 'Granular broadcast' }));
    forTarget('Talak 7.9%', 'Dollarweed');
    const body = await completeBody(request);
    expect(body.products.map((p) => [p.productId, p.applicationMethod])).toEqual([['celsius', 'granular_broadcast'], ['talak', 'broadcast_spray']]);
  });

  test('a method outside the three buttons is picked from More methods and sent as is', async () => {
    const request = makeRequest();
    await readyVisit(request);
    const more = within(editorFor('Celsius WG')).getByLabelText('More methods for Celsius WG');
    expect(more.value).toBe('');
    fireEvent.change(more, { target: { value: 'soil_drench' } });
    expect(more.value).toBe('soil_drench');
    for (const label of ['Spot treatment', 'Broadcast spray', 'Granular broadcast']) expect(pressed('Celsius WG', label)).toBe('false');
    // Soil drench needs no area on a lawn row (the server's verdict).
    expect(within(editorFor('Celsius WG')).queryByLabelText('Area treated (sq ft)')).toBeNull();
    const body = await completeBody(request);
    expect(body.products.find((p) => p.productId === 'celsius')).toMatchObject({ applicationMethod: 'soil_drench' });
    expect(body.products.find((p) => p.productId === 'celsius').areaValue).toBeUndefined();
  });

  test('a last-visit method under More methods starts selected there', async () => {
    const context = { ...CONTEXT, lastVisit: { ...CONTEXT.lastVisit, products: CONTEXT.lastVisit.products.map((p) => (p.productId === 'celsius' ? { ...p, method: 'foliar_spray' } : p)) } };
    const request = makeRequest({ context });
    await readyVisit(request);
    expect(within(editorFor('Celsius WG')).getByLabelText('More methods for Celsius WG').value).toBe('foliar_spray');
    const body = await completeBody(request);
    expect(body.products.find((p) => p.productId === 'celsius')).toMatchObject({ applicationMethod: 'foliar_spray' });
  });

  test('a last-visit tile with no usable recorded method has none selected, and Complete waits for a tap', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(tile('Headway G'));
    enterAmount('Headway G', 6);
    for (const label of ['Spot treatment', 'Broadcast spray', 'Granular broadcast']) expect(pressed('Headway G', label)).toBe('false');
    expect(screen.getByText('Pick how Headway G went down.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(within(howGroup('Headway G')).getByRole('button', { name: 'Spot treatment' }));
    forTarget('Headway G', 'Dollarweed');
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body.products.find((p) => p.productId === 'headway')).toEqual({
      productId: 'headway', applicationMethod: 'spot_treatment', totalAmount: 6, amountUnit: 'oz', applicationArea: 'Front lawn', targets: ['Dollarweed'],
    });
  });

  test('an added product has no default method', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a product' })).getByRole('button', { name: /Empty Jug Surfactant/ }));
    for (const label of ['Spot treatment', 'Broadcast spray', 'Granular broadcast']) expect(pressed('Empty Jug Surfactant', label)).toBe('false');
    expect(screen.queryByLabelText('Area treated (sq ft)')).toBeNull();
  });

  test('a broadcast row without square feet keeps Complete disabled; with sqft it sends areaValue and areaUnit sqft', async () => {
    const request = makeRequest({ context: { ...CONTEXT, lawnSqft: null, lastVisit: { ...CONTEXT.lastVisit, products: [
      { productId: 'celsius', name: 'Celsius WG', totalAmount: 1.5, amountUnit: 'oz', method: 'spot_treatment', areaValue: null, areaUnit: null },
    ] } } });
    await readyVisit(request);
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(within(howGroup('Celsius WG')).getByRole('button', { name: 'Broadcast spray' }));
    // No recorded area and no lawn size: blank and required.
    expect(areaInput('Celsius WG').value).toBe('');
    expect(screen.queryByText('last time', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('Enter the square feet treated for Celsius WG.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.change(areaInput('Celsius WG'), { target: { value: '0' } });
    expect(completeButton().disabled).toBe(true);
    fireEvent.change(areaInput('Celsius WG'), { target: { value: '3200' } });
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body.products[0]).toEqual({
      productId: 'celsius', applicationMethod: 'broadcast_spray', totalAmount: 1.5, amountUnit: 'oz', applicationArea: 'Front lawn', targets: ['Dollarweed'], areaValue: 3200, areaUnit: 'sqft',
    });
  });

  test('area prefills from what that product recorded last time, labeled, else from the lawn size, labeled', async () => {
    await openSheet();
    // Talak recorded 5200 sq ft last time.
    fireEvent.click(tile('Talak 7.9%'));
    expect(areaInput('Talak 7.9%').value).toBe('5200');
    expect(within(editorFor('Talak 7.9%')).getAllByText('last time').length).toBeGreaterThan(0);
    // Celsius recorded none: switching it to granular uses the property's lawn size.
    fireEvent.click(tile('Celsius WG'));
    expect(within(editorFor('Celsius WG')).queryByLabelText('Area treated (sq ft)')).toBeNull();
    fireEvent.click(within(howGroup('Celsius WG')).getByRole('button', { name: 'Granular broadcast' }));
    expect(areaInput('Celsius WG').value).toBe('6400');
    expect(within(editorFor('Celsius WG')).getByText('lawn size')).toBeTruthy();
    // A typed area is the tech's own: the label goes and a method change keeps it.
    fireEvent.change(areaInput('Celsius WG'), { target: { value: '3000' } });
    expect(within(editorFor('Celsius WG')).queryByText('lawn size')).toBeNull();
    fireEvent.click(within(howGroup('Celsius WG')).getByRole('button', { name: 'Broadcast spray' }));
    expect(areaInput('Celsius WG').value).toBe('3000');
  });

  test('a spot row never sends an area, even after the tech tried a broadcast method on it', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(within(howGroup('Celsius WG')).getByRole('button', { name: 'Broadcast spray' }));
    expect(areaInput('Celsius WG').value).toBe('6400');
    fireEvent.click(within(howGroup('Celsius WG')).getByRole('button', { name: 'Spot treatment' }));
    const body = await completeBody(request);
    expect(body.products[0]).toEqual({ productId: 'celsius', applicationMethod: 'spot_treatment', totalAmount: 1.5, amountUnit: 'oz', applicationArea: 'Front lawn', targets: ['Dollarweed'] });
  });

  test('a context with no methods cannot complete a product (nothing is guessed)', async () => {
    await openSheet(makeRequest({ context: { ...CONTEXT, methods: [] } }));
    fireEvent.click(tile('Celsius WG'));
    fireEvent.click(issue('Dollarweed'));
    fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
    expect(screen.getByText('Pick how Celsius WG went down.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
  });
});

describe('targets use the full form\'s vocabulary', () => {
  const otherTarget = (product, name) => fireEvent.change(within(editorFor(product)).getByLabelText(`Other target for ${product}`), { target: { value: name } });

  test('every Treating-for target name is one of the full form\'s LAWN_TARGET_SUGGESTIONS, with the canonical names', async () => {
    const request = makeRequest();
    await openSheet(request);
    fireEvent.click(tile('Celsius WG'));
    const picks = {
      'Chinch bug damage': 'Southern chinch bugs', 'Sod webworm signs': 'Tropical sod webworms', 'Armyworm signs': 'Fall armyworms',
      'Grub activity': 'White grubs', Sedge: 'Nutsedge / sedge', 'Large patch': 'Large patch', 'Gray leaf spot': 'Gray leaf spot',
      Dollarweed: 'Dollarweed', Crabgrass: 'Crabgrass', 'Broadleaf weeds': 'Broadleaf weeds',
    };
    for (const [issueLabel, name] of Object.entries(picks)) {
      expect(LAWN_TARGET_SUGGESTIONS).toContain(name);
      fireEvent.click(issue(issueLabel));
      forTarget('Celsius WG', issueLabel);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
    where('Celsius WG');
    const body = await completeBody(request);
    expect(new Set(body.products[0].targets)).toEqual(new Set(Object.values(picks)));
  });

  test('"Other target" lists every LAWN_TARGET_SUGGESTIONS entry; a pick is a removable chip and is sent by its canonical name', async () => {
    const request = makeRequest();
    await openSheet(request);
    fireEvent.click(tile('Celsius WG'));
    const select = within(editorFor('Celsius WG')).getByLabelText('Other target for Celsius WG');
    expect([...select.querySelectorAll('option')].map((o) => o.value).filter(Boolean)).toEqual(LAWN_TARGET_SUGGESTIONS);
    // Not required to pick a Treating-for chip's weed: another target satisfies the row.
    fireEvent.click(issue('Crabgrass'));
    otherTarget('Celsius WG', 'Green kyllinga');
    const chips = within(editorFor('Celsius WG')).getByRole('group', { name: 'Other targets for Celsius WG' });
    expect(within(chips).getByRole('button', { name: 'Green kyllinga' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
    where('Celsius WG');
    expect(completeButton().disabled).toBe(false);
    // Clearing the Treating-for chip leaves the other target alone.
    fireEvent.click(issue('Crabgrass'));
    fireEvent.click(issue('Dollarweed'));
    expect(within(editorFor('Celsius WG')).getByRole('button', { name: 'Green kyllinga' })).toBeTruthy();
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body.products[0].targets).toEqual(['Green kyllinga']);
  });

  test('removing the only other target, with no Treating-for pick on the row, blocks Complete again', async () => {
    await openSheet();
    fireEvent.click(tile('Celsius WG'));
    fireEvent.click(issue('Dollarweed'));
    otherTarget('Celsius WG', 'Clover');
    expect(screen.queryByText('Pick what Celsius WG was for.')).toBeNull();
    fireEvent.click(within(editorFor('Celsius WG')).getByRole('button', { name: 'Clover' }));
    expect(screen.getByText('Pick what Celsius WG was for.')).toBeTruthy();
  });
});

describe('where (per product)', () => {
  test('there is no visit-level Where; each active row has its own, and the first row starts empty', async () => {
    await openSheet();
    expect(screen.queryByRole('heading', { name: 'Where' })).toBeNull();
    fireEvent.click(tile('Celsius WG'));
    expect(wherePressed('Celsius WG')).toEqual([]);
    expect(whereGroup('Celsius WG')).toBeTruthy();
  });

  test('a row turned on with no Where copies the first active row\'s areas as editable chips; later edits never sync', async () => {
    await openSheet();
    fireEvent.click(tile('Celsius WG'));
    where('Celsius WG', 'Back lawn', 'Fence line');
    fireEvent.click(tile('Talak 7.9%'));
    expect(wherePressed('Talak 7.9%')).toEqual(['Back lawn', 'Fence line']);
    // Editing one row leaves the other alone, in both directions.
    where('Talak 7.9%', 'Fence line', 'Along driveway / sidewalk');
    expect(wherePressed('Talak 7.9%')).toEqual(['Back lawn', 'Along driveway / sidewalk']);
    expect(wherePressed('Celsius WG')).toEqual(['Back lawn', 'Fence line']);
    where('Celsius WG', 'Back lawn');
    expect(wherePressed('Talak 7.9%')).toEqual(['Back lawn', 'Along driveway / sidewalk']);
    // A third row copies from the FIRST active row that has any.
    fireEvent.click(tile('Headway G'));
    expect(wherePressed('Headway G')).toEqual(['Fence line']);
  });

  test('a product added with + Other product starts from the first active row\'s areas', async () => {
    await openSheet();
    fireEvent.click(tile('Celsius WG'));
    where('Celsius WG', 'Side lawns');
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a product' })).getByRole('button', { name: /Empty Jug Surfactant/ }));
    expect(wherePressed('Empty Jug Surfactant')).toEqual(['Side lawns']);
  });

  test('every active row needs one; the reason names the product, and different areas go out per row', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(tile('Talak 7.9%'));
    forTarget('Talak 7.9%', 'Dollarweed');
    // Clear the copied chip: Talak has none and Complete waits.
    where('Talak 7.9%', 'Front lawn');
    expect(screen.getByText('Pick where Talak 7.9% went.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    where('Talak 7.9%', 'Slope / drainage area', 'Fence line');
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body.products.map((p) => [p.productId, p.applicationArea])).toEqual([
      ['celsius', 'Front lawn'], ['talak', 'Fence line, Slope / drainage area'],
    ]);
    // The findings carry the union, in option order.
    expect(body.structuredFindings.values.spot_treatment_areas).toBe('Front lawn, Fence line, Slope / drainage area');
  });

  test('no area is preselected anywhere before the first product is on', async () => {
    await openSheet();
    expect(screen.queryByRole('button', { name: 'Front lawn' })).toBeNull();
  });
});

describe('Treating-for gate', () => {
  const otherTarget = (product, name) => fireEvent.change(within(editorFor(product)).getByLabelText(`Other target for ${product}`), { target: { value: name } });

  test('a visit whose targets come only from Other target completes with no Treating-for chip, and omits turf_issues', async () => {
    const request = makeRequest();
    await openSheet(request);
    fireEvent.click(tile('Celsius WG'));
    expect(screen.getByText('Pick what Celsius WG was for.')).toBeTruthy();
    otherTarget('Celsius WG', 'Clover');
    expect(screen.queryByText('Pick what Celsius WG was for.')).toBeNull();
    expect(screen.queryByText('Select what you treated for.')).toBeNull();
    where('Celsius WG');
    fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body.products[0].targets).toEqual(['Clover']);
    expect(body.structuredFindings.values).not.toHaveProperty('turf_issues');
  });

  test('the per-row target requirement stays: a second pesticide row with no target blocks, with or without a chip', async () => {
    await openSheet();
    fireEvent.click(tile('Celsius WG'));
    otherTarget('Celsius WG', 'Clover');
    where('Celsius WG');
    fireEvent.click(tile('Talak 7.9%'));
    expect(screen.getByText('Pick what Talak 7.9% was for.')).toBeTruthy();
    fireEvent.click(issue('Dollarweed'));
    expect(screen.getByText('Pick what Talak 7.9% was for.')).toBeTruthy();
  });

  test('the validator accepts findings without turf_issues', async () => {
    const { validateTypedFindings } = await import('../../../../server/services/service-report/activity-indicators.js');
    expect(validateTypedFindings({
      type: 'one_time_lawn_treatment', expectedType: 'one_time_lawn_treatment', enforceRequired: true,
      values: { lawn_condition: 'Fair', weed_pressure: 'Light', spot_treatment_areas: 'Front lawn' },
    })).toMatchObject({ ok: true, missing: [] });
  });
});

describe('fertilizer purpose', () => {
  const FERT = [...CATALOG, { id: 'fert', name: 'Turf Fertilizer 16-4-8', category: 'fertilizer' }, { id: 'micro', name: 'Iron Plus', category: 'micronutrient fertilizer' }];
  const ctxWith = (products) => ({ ...CONTEXT, products: FERT, lastVisit: { ...CONTEXT.lastVisit, products } });
  const lastFert = [
    { productId: 'celsius', name: 'Celsius WG', totalAmount: 1.5, amountUnit: 'oz', method: 'spot_treatment' },
    { productId: 'fert', name: 'Turf Fertilizer 16-4-8', totalAmount: 10, amountUnit: 'lb', method: 'granular_broadcast', areaValue: 5000, areaUnit: 'sqft' },
    { productId: 'micro', name: 'Iron Plus', totalAmount: 2, amountUnit: 'fl_oz', method: 'foliar_spray' },
  ];

  test('fertilizer-family rows get optional Purpose chips from the shared nutrition list, sent as targets', async () => {
    const request = makeRequest({ context: ctxWith(lastFert) });
    await openSheet(request);
    fireEvent.click(tile('Turf Fertilizer 16-4-8'));
    const purpose = within(editorFor('Turf Fertilizer 16-4-8')).getByRole('group', { name: 'Purpose (optional)' });
    expect(within(purpose).getAllByRole('button').map((b) => b.textContent)).toEqual(NUTRITION_TARGET_SUGGESTIONS);
    expect(within(editorFor('Turf Fertilizer 16-4-8')).queryByRole('group', { name: 'For' })).toBeNull();
    fireEvent.click(within(purpose).getByRole('button', { name: 'Iron chlorosis (yellowing turf)' }));
    fireEvent.click(within(purpose).getByRole('button', { name: 'Nitrogen green-up' }));
    where('Turf Fertilizer 16-4-8');
    fireEvent.click(tile('Iron Plus')); // a micronutrient fertilizer, left with no purpose
    fireEvent.click(issue('Dollarweed'));
    fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    const byId = Object.fromEntries(body.products.map((p) => [p.productId, p]));
    expect(byId.fert.targets).toEqual(['Iron chlorosis (yellowing turf)', 'Nitrogen green-up']);
    expect(byId.micro.targets).toEqual([]);
  });

  test('purpose is not required, and a pesticide row keeps its required For targets', async () => {
    await openSheet(makeRequest({ context: ctxWith(lastFert) }));
    fireEvent.click(tile('Turf Fertilizer 16-4-8'));
    fireEvent.click(issue('Dollarweed'));
    fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
    where('Turf Fertilizer 16-4-8');
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(tile('Celsius WG'));
    expect(screen.getByText('Pick what Celsius WG was for.')).toBeTruthy();
  });

  test('the nutrition list and category test are shared with the full form', () => {
    expect(productTargetsNutrition({ category: 'micronutrient fertilizer' })).toBe(true);
    expect(productTargetsNutrition({ category: 'herbicide' })).toBe(false);
    expect(NUTRITION_TARGET_SUGGESTIONS).toContain('Iron chlorosis (yellowing turf)');
  });
});

describe('rate (mirrors the pest sheet)', () => {
  const RATED = [
    { id: 'celsius', name: 'Celsius WG', category: 'herbicide', default_rate_per_1000: '0.0850', default_unit: 'oz', max_label_rate_per_1000: '0.1' },
    { id: 'talak', name: 'Talak 7.9%', category: 'insecticide', default_rate_per_1000: '0.2', default_unit: 'fl_oz' },
    { id: 'headway', name: 'Headway G', category: 'fungicide', default_unit: 'percent_solution' },
    { id: 'empty', name: 'Empty Jug Surfactant', category: 'adjuvant', default_unit: 'fl_oz', default_rate_per_1000: '0.5' },
  ];
  const withLast = (products, extra = {}) => ({ ...CONTEXT, products: RATED, ...extra, lastVisit: { ...CONTEXT.lastVisit, products } });
  const rateInput = (name) => within(editorFor(name)).getByLabelText(`${name} rate`);

  test('a last-visit rate seeds the input, labeled "last time", and goes out with its unit', async () => {
    const request = makeRequest({ context: withLast([
      { productId: 'celsius', name: 'Celsius WG', totalAmount: 1.5, amountUnit: 'oz', method: 'spot_treatment', areaValue: null, areaUnit: null, applicationRate: 0.25, rateUnit: 'oz/1000sf' },
    ]) });
    await readyVisit(request);
    expect(rateInput('Celsius WG').value).toBe('0.25');
    expect(within(editorFor('Celsius WG')).getAllByText('last time').length).toBe(2);
    const body = await completeBody(request);
    expect(body.products[0]).toMatchObject({ productId: 'celsius', rate: 0.25, rateUnit: 'oz/1000sf' });
  });

  test('no recorded rate: the catalog label rate prefills (unlabeled); a typed rate wins and overrides', async () => {
    const request = makeRequest({ context: withLast([
      { productId: 'celsius', name: 'Celsius WG', totalAmount: 1.5, amountUnit: 'oz', method: 'spot_treatment', areaValue: null, areaUnit: null, applicationRate: null, rateUnit: null },
    ]) });
    await readyVisit(request);
    const input = rateInput('Celsius WG');
    expect(Number(input.value)).toBeGreaterThan(0);
    expect(within(editorFor('Celsius WG')).getAllByText('last time').length).toBe(1);
    fireEvent.change(input, { target: { value: '0.2' } });
    expect(screen.getByText(/label max/)).toBeTruthy();
    const body = await completeBody(request);
    expect(body.products[0].rate).toBe(0.2);
    expect(typeof body.products[0].rateUnit).toBe('string');
  });

  test('the last rate applies only at the method it was recorded at; changing the method drops it', async () => {
    const request = makeRequest({ context: withLast([
      { productId: 'celsius', name: 'Celsius WG', totalAmount: 1.5, amountUnit: 'oz', method: 'spot_treatment', areaValue: null, areaUnit: null, applicationRate: 0.25, rateUnit: 'oz/1000sf' },
    ]) });
    await readyVisit(request);
    fireEvent.click(within(within(editorFor('Celsius WG')).getByRole('group', { name: 'How' })).getByRole('button', { name: 'Broadcast spray' }));
    expect(within(editorFor('Celsius WG')).queryByText('last time', { selector: 'p' })).not.toBeNull(); // the amount's own label stays
    expect(rateInput('Celsius WG').value).not.toBe('0.25');
  });

  test('a rate is never required: clearing it sends no rate, and a unit /complete would refuse leaves no rate input', async () => {
    const request = makeRequest({ context: withLast([
      { productId: 'celsius', name: 'Celsius WG', totalAmount: 1.5, amountUnit: 'oz', method: 'spot_treatment', areaValue: null, areaUnit: null, applicationRate: null, rateUnit: null },
      { productId: 'headway', name: 'Headway G', totalAmount: 2, amountUnit: 'lb', method: 'spot_treatment', areaValue: null, areaUnit: null, applicationRate: null, rateUnit: null },
    ]) });
    await readyVisit(request);
    fireEvent.click(tile('Headway G'));
    forTarget('Headway G', 'Dollarweed');
    expect(within(editorFor('Headway G')).queryByLabelText('Headway G rate')).toBeNull();
    fireEvent.change(rateInput('Celsius WG'), { target: { value: '' } });
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body.products[0]).not.toHaveProperty('rate');
    expect(body.products[1]).not.toHaveProperty('rate');
    expect(body.products[1]).not.toHaveProperty('rateUnit');
  });

  test('an added product has a rate only in its label unit and only what the tech types', async () => {
    const request = makeRequest({ context: withLast([
      { productId: 'celsius', name: 'Celsius WG', totalAmount: 1.5, amountUnit: 'oz', method: 'spot_treatment', areaValue: null, areaUnit: null, applicationRate: null, rateUnit: null },
    ]) });
    await readyVisit(request);
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a product' })).getByRole('button', { name: /Empty Jug Surfactant/ }));
    expect(rateInput('Empty Jug Surfactant').value).toBe('');
  });
});

describe('+ Other product is lawn-aware', () => {
  test('the last visit\'s products lead, lawn products are listed, everything else waits behind Show other products', async () => {
    const catalog = [
      ...CATALOG,
      { id: 'fert', name: 'Palm Fertilizer 8-2-12', category: 'fertilizer' },
      { id: 'wet', name: 'Wetting Agent X', category: 'wetting agent' },
      { id: 'bait', name: 'Ant Bait Station', category: 'bait' },
      { id: 'sign', name: 'Yard Sign', category: 'supplies' },
    ];
    await openSheet(makeRequest({ context: { ...CONTEXT, products: catalog } }));
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    const picker = screen.getByRole('dialog', { name: 'Add a product' });
    const group = (title) => within(picker).getByRole('group', { name: title });
    expect(within(group('Used on the last lawn visit')).getByRole('button', { name: /Celsius WG/ })).toBeTruthy();
    expect(within(group('Lawn products')).getByRole('button', { name: /Palm Fertilizer 8-2-12/ })).toBeTruthy();
    expect(within(group('Lawn products')).getByRole('button', { name: /Wetting Agent X/ })).toBeTruthy();
    expect(within(picker).queryByText('Ant Bait Station')).toBeNull();
    expect(within(picker).queryByText('Yard Sign')).toBeNull();
    fireEvent.click(within(picker).getByRole('button', { name: 'Show other products' }));
    expect(within(group('Other products')).getByRole('button', { name: /Ant Bait Station/ })).toBeTruthy();
    expect(within(picker).queryByText('Yard Sign')).toBeNull();
  });
});

describe('what the customer said', () => {
  test('the booking words and chips lead the sheet when present', async () => {
    await openSheet();
    expect(screen.getByRole('heading', { name: 'They said' })).toBeTruthy();
    expect(screen.getByText('“Weeds are back along the driveway.”')).toBeTruthy();
    expect(screen.getByText('Weeds')).toBeTruthy();
  });

  test('no request, no section', async () => {
    const request = makeRequest({ context: { ...CONTEXT, customerRequest: null } });
    await openSheet(request);
    expect(screen.queryByRole('heading', { name: 'They said' })).toBeNull();
  });

  test('nothing is pre-selected in Treating for: the booking chips never map to a typed option', async () => {
    await openSheet();
    for (const label of TURF_ISSUE_OPTIONS) {
      expect(screen.getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('false');
    }
  });
});

describe('required taps', () => {
  test('Complete waits for a product with an amount, its target, where, pressure and condition, in that order', async () => {
    await openSheet();
    expect(screen.getByText('Select at least one product.')).toBeTruthy();
    fireEvent.click(tile('Celsius WG'));
    // Treating for is optional context; the pesticide row's own target is not.
    expect(screen.getByText('Pick what Celsius WG was for.')).toBeTruthy();
    fireEvent.click(issue('Sedge'));
    expect(screen.getByText('Pick what Celsius WG was for.')).toBeTruthy();
    forTarget('Celsius WG', 'Sedge');
    expect(screen.getByText('Pick where Celsius WG went.')).toBeTruthy();
    where('Celsius WG', 'Back lawn');
    expect(screen.getByText('Select the weed pressure.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(screen.getByText('Select the lawn condition.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    expect(completeButton().disabled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('treating-for chips toggle off, and pressure and condition are one tap each', async () => {
    await openSheet();
    const chip = screen.getByRole('button', { name: 'Crabgrass' });
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Heavy' }));
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Heavy' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('the sheet offers no photos, scores, follow-up or home / not-home taps', async () => {
    await openSheet();
    expect(screen.queryByText(/photo/i)).toBeNull();
    expect(screen.queryByText(/follow-up/i)).toBeNull();
    expect(screen.queryByText(/not home/i)).toBeNull();
  });
});

describe('the /complete body', () => {
  test('is typed one_time_lawn_treatment findings with each row\'s own method (and sqft where needed) and the full form\'s customer-text defaults', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(tile('Talak 7.9%'));
    fireEvent.click(issue('Chinch bug damage'));
    fireEvent.click(issue('Drought stress'));
    // Each product records only what it was applied against; a condition like
    // drought stress is never a target.
    const talakFor = within(editorFor('Talak 7.9%')).getByRole('group', { name: 'For' });
    expect(within(talakFor).queryByRole('button', { name: 'Drought stress' })).toBeNull();
    forTarget('Talak 7.9%', 'Chinch bug damage');
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: '  Spot-treated the driveway edge.  ' } });
    const body = await completeBody(request);

    expect(body).toEqual({
      idempotencyKey: expect.any(String),
      visitOutcome: 'completed',
      // The live visit identity the server echo-checks (recapVisitIdentity).
      expectedVisit: {
        customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-lawn', serviceType: 'Lawn Care Re-Service',
        scheduledDate: '2026-10-04', address: { line1: '123 Main St' },
      },
      products: [
        { productId: 'celsius', applicationMethod: 'spot_treatment', totalAmount: 1.5, amountUnit: 'oz', applicationArea: 'Front lawn', targets: ['Dollarweed'] },
        { productId: 'talak', applicationMethod: 'broadcast_spray', totalAmount: 4, amountUnit: 'fl_oz', applicationArea: 'Front lawn', targets: ['Southern chinch bugs'], areaValue: 5200, areaUnit: 'sqft' },
      ],
      structuredFindings: {
        type: 'one_time_lawn_treatment',
        // Chips in the form's own option order, comma-joined.
        values: { lawn_condition: 'Fair', weed_pressure: 'Moderate', turf_issues: 'Chinch bug damage, Dollarweed, Drought stress', spot_treatment_areas: 'Front lawn' },
      },
      technicianNotes: 'Spot-treated the driveway edge.',
      sendCompletionSms: true,
      requestReview: false,
      includePayLink: true,
    });
    expect(body).not.toHaveProperty('customerRecapMode');
    expect(body).not.toHaveProperty('completionPhotos');
    expect(body.structuredFindings.values).not.toHaveProperty('work_completed');
    // A spot row sends no area.
    expect(body.products[0]).not.toHaveProperty('areaValue');
    expect(body.products[0]).not.toHaveProperty('areaUnit');
  });

  test('clearing a Treating-for chip drops it from every row, and a non-pesticide row records no target', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a product' })).getByRole('button', { name: /Empty Jug Surfactant/ }));
    expect(within(editorFor('Empty Jug Surfactant')).queryByRole('group', { name: 'For' })).toBeNull();
    fireEvent.click(issue('Sedge'));
    forTarget('Celsius WG', 'Sedge');
    fireEvent.click(issue('Dollarweed'));
    // Celsius now targets only Sedge.
    expect(within(within(editorFor('Celsius WG')).getByRole('group', { name: 'For' })).queryByRole('button', { name: 'Dollarweed' })).toBeNull();
    // Picking Dollarweed again does not revive Celsius's old Dollarweed target.
    fireEvent.click(issue('Dollarweed'));
    expect(within(within(editorFor('Celsius WG')).getByRole('group', { name: 'For' })).getByRole('button', { name: 'Dollarweed' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(within(editorFor('Empty Jug Surfactant')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(issue('Sedge'));
    expect(screen.getByText('Pick what Celsius WG was for.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
  });

  test('a product left off the sheet is not sent, and an empty note is an empty string', async () => {
    const request = makeRequest();
    await readyVisit(request);
    const body = await completeBody(request);
    expect(body.products.map((p) => p.productId)).toEqual(['celsius']);
    expect(body.technicianNotes).toBe('');
  });

  test('a tsp amount goes to the server as fl oz, never mL', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(tile('Talak 7.9%'));
    const editor = editorFor('Talak 7.9%');
    fireEvent.click(within(within(editor).getByRole('group', { name: 'Unit' })).getByRole('button', { name: 'tsp' }));
    fireEvent.change(within(editor).getByLabelText('How much?'), { target: { value: '3' } });
    forTarget('Talak 7.9%', 'Dollarweed');
    const body = await completeBody(request);
    expect(body.products[1]).toMatchObject({ productId: 'talak', totalAmount: 0.5, amountUnit: 'fl_oz', applicationMethod: 'broadcast_spray' });
  });

  test('after Complete the saved view shows the summary, and Next stop closes the sheet', async () => {
    const onCompleted = vi.fn();
    const request = makeRequest();
    await openSheet(request, { onCompleted });
    fireEvent.click(tile('Celsius WG'));
    fireEvent.click(issue('Dollarweed'));
    forTarget('Celsius WG', 'Dollarweed');
    fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
    where('Celsius WG');
    fireEvent.click(completeButton());
    expect(await screen.findByText('Celsius WG · Dollarweed')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Lawn re-service complete' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next stop' }));
    expect(onCompleted).toHaveBeenCalled();
  });
});

describe('full form and blocked visits', () => {
  test('Full form calls onFullForm', async () => {
    const onFullForm = vi.fn();
    await openSheet(makeRequest(), { onFullForm });
    fireEvent.click(screen.getByRole('button', { name: 'Full form' }));
    expect(onFullForm).toHaveBeenCalledTimes(1);
  });

  test('a gate that is off (404) says the visit needs the full form, and closing asks for a refresh', async () => {
    const err = Object.assign(new Error('not found'), { status: 404 });
    const onClose = vi.fn();
    render(<FastCompleteLawnReserviceSheet service={SERVICE} request={makeRequest({ context: err })} onClose={onClose} />);
    expect(await screen.findByText('This visit needs the full form.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith({ refresh: true });
  });

  test('a visit that is no longer a lawn re-service (409) needs the full form', async () => {
    const err = Object.assign(new Error('not_lawn_re_service'), { status: 409 });
    render(<FastCompleteLawnReserviceSheet service={SERVICE} request={makeRequest({ context: err })} onClose={() => {}} />);
    expect(await screen.findByText('This visit needs the full form.')).toBeTruthy();
  });

  test('an ineligible visit (a grouped stop) needs the full form', async () => {
    const request = makeRequest({ context: { enabled: true, eligible: false, reason: 'grouped_visit', service: VISIT } });
    render(<FastCompleteLawnReserviceSheet service={SERVICE} request={request} onClose={() => {}} />);
    expect(await screen.findByText('This visit needs the full form.')).toBeTruthy();
  });

  test('a stale schedule row (the visit moved to another day) is refused', async () => {
    const request = makeRequest({ context: { ...CONTEXT, service: { ...VISIT, scheduledDate: '2026-10-09' } } });
    render(<FastCompleteLawnReserviceSheet service={{ ...SERVICE, routedScheduledDate: '2026-10-04' }} request={request} onClose={() => {}} />);
    expect(await screen.findByText('This visit changed since your schedule loaded. Close and reopen it from the schedule.')).toBeTruthy();
  });

  test('a failed catalog read offers Try again instead of the full form', async () => {
    const request = makeRequest({ context: [{ enabled: true, eligible: false, reason: 'catalog_unavailable', service: VISIT }, CONTEXT] });
    render(<FastCompleteLawnReserviceSheet service={SERVICE} request={request} onClose={() => {}} />);
    expect(await screen.findByText('Couldn’t load this visit’s products. Try again.')).toBeTruthy();
    expect(screen.queryByText('This visit needs the full form.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^Celsius WG/ })).toBeTruthy();
  });
});
