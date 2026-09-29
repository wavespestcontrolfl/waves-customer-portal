// @vitest-environment jsdom
//
// Owner ruling (2026-09-27, every service 2026-09-29): a small liquid is
// measured in tsp, 6 to the fl oz, and the Complete Service form sends a tsp
// amount as fl oz. A Total the tech did not type (a tank dose, a rate x area
// total, the house seed) reads in spoons when the tech picks tsp: it never
// keeps its fl oz number under the tsp label (a 6x under-record), and a tank
// row never snaps the pick back to fl oz. A rate is recorded only with a unit.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

// A per-gallon (tank) row: the label band's low end in fl oz per gallon. Spot
// treatment keeps it off the pest perimeter 4 oz house default.
const TANK = {
  id: 'tank-concentrate', name: 'Fixture tank concentrate', category: 'insecticide',
  application_method: 'spot_treatment', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal',
};
// The pest house mix (lib/pest-default-mix): 4 oz, 4 oz and 0.25 fl oz of the
// surfactant, whose catalog label is per gallon (20260712100000).
const HOUSE_MIX = [
  { id: 'taurus', name: 'Taurus SC', category: 'insecticide' },
  { id: 'talak', name: 'Atticus Talak 7.9 F', category: 'insecticide' },
  { id: 'surfactant', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant', default_rate: '0.03-0.64', default_unit: 'fl_oz/gal' },
];
// A lawn liquid on a per-1,000 rate: Total = rate x sq ft / 1,000, in fl oz.
const LAWN_LIQUID = {
  id: 'lawn-liquid', name: 'Fixture lawn liquid', category: 'fertilizer', rate_unit: 'fl_oz', default_rate_per_1000: '0.75',
};
// A label kept in mL: the row starts with no rate and no rate unit.
const KELP = { id: 'clean-kelp', name: 'Bloom City Clean Kelp', category: 'fertilizer', default_rate: '5-10', default_unit: 'ml/gal' };

const PEST_VISIT = {
  id: 'tsp-pest-visit', customerId: 'tsp-customer', customerName: 'Synthetic Customer',
  serviceType: 'Quarterly Pest Control Service', status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 100,
};
// Not a WaveGuard member and no lawn plan defaults: the ungoverned lawn row.
const LAWN_VISIT = {
  id: 'tsp-lawn-visit', customerId: 'tsp-customer', customerName: 'Synthetic Customer',
  serviceType: 'Lawn Care Service', status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 80,
  completionProfile: { serviceKey: 'lawn', requiresProducts: true },
};

async function mount(service, catalog) {
  const onSubmit = vi.fn().mockResolvedValue({});
  await act(async () => {
    render(<CompletionPanel service={service} products={catalog} onClose={() => {}} onSubmit={onSubmit} />);
  });
  return onSubmit;
}

async function pick(product) {
  fireEvent.change(screen.getByPlaceholderText('Search products...'), { target: { value: product.name } });
  fireEvent.click(await screen.findByText(product.name));
}

// A product row: Rate, rate unit, [Gal], Total, amount unit, then its method
// and area fields, all inside the row's card.
function selectAfter(input) {
  let el = input.nextElementSibling;
  while (el && el.tagName !== 'SELECT') el = el.nextElementSibling;
  return el;
}
function row(name) {
  const card = [...document.querySelectorAll('input[placeholder="Total"]')]
    .map((total) => total.parentElement)
    .find((element) => element.textContent.includes(name));
  const rate = card.querySelector('input[placeholder="Rate"]');
  const total = card.querySelector('input[placeholder="Total"]');
  return {
    rate,
    rateUnit: selectAfter(rate),
    gallons: card.querySelector('input[placeholder="Gal"]'),
    total,
    amountUnit: selectAfter(total),
    area: card.querySelector('input[placeholder="Sq ft"], input[placeholder="Linear ft"]'),
  };
}
const set = (element, value) => fireEvent.change(element, { target: { value } });

async function submit(onSubmit) {
  const button = screen.getAllByRole('button', { name: /^Complete (& Send (Recap|Invoice)|Service)/i }).at(-1);
  await act(async () => { fireEvent.click(button); });
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  return onSubmit.mock.calls[0][1];
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ customer: {}, actions: [], available: false }) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('tsp on a tank (per-gallon) row', () => {
  it('keeps a tsp pick before the Total is typed, and sends the spoons as fl oz', async () => {
    const onSubmit = await mount(PEST_VISIT, [TANK]);
    await pick(TANK);
    await waitFor(() => expect(row(TANK.name).rate.value).toBe('0.2'));
    expect(row(TANK.name).rateUnit.value).toBe('fl_oz/gal');
    expect(row(TANK.name).total.value).toBe('');

    set(row(TANK.name).amountUnit, 'tsp');
    expect(row(TANK.name).amountUnit.value).toBe('tsp');
    set(row(TANK.name).total, '3');
    expect(row(TANK.name).amountUnit.value).toBe('tsp');

    const body = await submit(onSubmit);
    // 3 tsp is ½ fl oz, never 3 fl oz.
    expect(body.products[0]).toMatchObject({
      productId: TANK.id, rate: 0.2, rateUnit: 'fl_oz/gal', totalAmount: 0.5, amountUnit: 'fl_oz',
    });
  });

  it('shows the dose from the gallons in spoons while tsp is picked, and in fl oz again when it is not', async () => {
    const onSubmit = await mount(PEST_VISIT, [TANK]);
    await pick(TANK);
    await waitFor(() => expect(row(TANK.name).gallons).toBeTruthy());
    set(row(TANK.name).gallons, '2');
    expect(row(TANK.name).total.value).toBe('0.4');
    expect(row(TANK.name).amountUnit.value).toBe('fl_oz');

    set(row(TANK.name).amountUnit, 'tsp');
    expect(row(TANK.name).total.value).toBe('2.4');
    expect(row(TANK.name).amountUnit.value).toBe('tsp');
    set(row(TANK.name).gallons, '3');
    expect(row(TANK.name).total.value).toBe('3.6');
    expect(row(TANK.name).amountUnit.value).toBe('tsp');

    set(row(TANK.name).amountUnit, 'fl_oz');
    expect(row(TANK.name).total.value).toBe('0.6');
    // Any other hand-picked unit still reads the dose in the rate's own unit.
    set(row(TANK.name).amountUnit, 'gal');
    expect(row(TANK.name).amountUnit.value).toBe('fl_oz');
    expect(row(TANK.name).total.value).toBe('0.6');

    set(row(TANK.name).amountUnit, 'tsp');
    expect(row(TANK.name).total.value).toBe('3.6');
    const body = await submit(onSubmit);
    expect(body.products[0]).toMatchObject({ totalAmount: 0.6, amountUnit: 'fl_oz' });
  });
});

describe('tsp on the pest house seed', () => {
  it('reads the 0.25 fl oz surfactant seed as 1.5 tsp, and withdraws an oz seed rather than relabel it', async () => {
    const onSubmit = await mount(PEST_VISIT, HOUSE_MIX);
    await waitFor(() => expect(document.querySelectorAll('input[placeholder="Total"]')).toHaveLength(3));
    const surfactant = HOUSE_MIX[2].name;
    expect(row(surfactant).total.value).toBe('0.25');
    expect(row(surfactant).amountUnit.value).toBe('fl_oz');

    set(row(surfactant).amountUnit, 'tsp');
    expect(row(surfactant).total.value).toBe('1.5');
    expect(row(surfactant).amountUnit.value).toBe('tsp');
    set(row(surfactant).amountUnit, 'fl_oz');
    expect(row(surfactant).total.value).toBe('0.25');
    set(row(surfactant).amountUnit, 'tsp');

    // A bare oz may be a dry weight, so 4 oz does not become 24 tsp: the
    // seed is withdrawn for the tech to enter, never kept as "4 tsp".
    expect(row('Taurus SC').total.value).toBe('4');
    set(row('Taurus SC').amountUnit, 'tsp');
    expect(row('Taurus SC').total.value).toBe('');
    set(row('Taurus SC').amountUnit, 'oz');
    set(row('Taurus SC').total, '4');

    for (const product of HOUSE_MIX) set(row(product.name).area, '120');
    expect(row(surfactant).total.value).toBe('1.5');
    const body = await submit(onSubmit);
    const byId = Object.fromEntries(body.products.map((product) => [product.productId, product]));
    expect(byId.surfactant).toMatchObject({ totalAmount: 0.25, amountUnit: 'fl_oz' });
    expect(byId.taurus).toMatchObject({ totalAmount: '4', amountUnit: 'oz' });
    expect(byId.talak).toMatchObject({ totalAmount: 4, amountUnit: 'oz' });
  });
});

describe('tsp on an ungoverned lawn row (rate x sq ft)', () => {
  it('reads the calculated Total in spoons and keeps it in spoons through rate, area and rate-unit edits', async () => {
    const onSubmit = await mount(LAWN_VISIT, [LAWN_LIQUID]);
    await pick(LAWN_LIQUID);
    await waitFor(() => expect(row(LAWN_LIQUID.name).area).toBeTruthy());
    expect(row(LAWN_LIQUID.name).rate.value).toBe('0.75');
    set(row(LAWN_LIQUID.name).area, '4000');
    expect(row(LAWN_LIQUID.name).total.value).toBe('3');

    set(row(LAWN_LIQUID.name).amountUnit, 'tsp');
    expect(row(LAWN_LIQUID.name).total.value).toBe('18');
    // 0.75 fl oz x 2,000 sq ft is 1.5 fl oz: 9 tsp, never "1.5 tsp".
    set(row(LAWN_LIQUID.name).area, '2000');
    expect(row(LAWN_LIQUID.name).total.value).toBe('9');
    set(row(LAWN_LIQUID.name).rate, '1');
    expect(row(LAWN_LIQUID.name).total.value).toBe('12');
    expect(row(LAWN_LIQUID.name).amountUnit.value).toBe('tsp');

    // A rate-unit change moves the Total to the rate's unit, recalculated.
    set(row(LAWN_LIQUID.name).rateUnit, 'oz');
    expect(row(LAWN_LIQUID.name).amountUnit.value).toBe('oz');
    expect(row(LAWN_LIQUID.name).total.value).toBe('2');
    set(row(LAWN_LIQUID.name).rateUnit, 'fl_oz');
    set(row(LAWN_LIQUID.name).amountUnit, 'tsp');
    expect(row(LAWN_LIQUID.name).total.value).toBe('12');

    const body = await submit(onSubmit);
    expect(body.products[0]).toMatchObject({
      productId: LAWN_LIQUID.id, rate: '1', rateUnit: 'fl_oz', totalAmount: 2, amountUnit: 'fl_oz', areaValue: '2000', areaUnit: 'sqft',
    });
  });
});

describe('a rate with no unit', () => {
  it('is not recorded as a bare number', async () => {
    const onSubmit = await mount(PEST_VISIT, [KELP]);
    await pick(KELP);
    await waitFor(() => expect(row(KELP.name).rateUnit.value).toBe(''));
    set(row(KELP.name).rate, '2');
    set(row(KELP.name).total, '1');
    const body = await submit(onSubmit);
    expect(body.products[0]).toMatchObject({ productId: KELP.id, rate: '', rateUnit: '', totalAmount: '1', amountUnit: 'fl_oz' });
  });
});
