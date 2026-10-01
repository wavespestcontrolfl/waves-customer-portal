// @vitest-environment jsdom
// Fast Complete: any product on the sheet. "+ Other product" opens a picker
// over the sheet (most-used first, search, hidden non-applied items), an
// added product records only the amount the tech typed in a unit a truck can
// measure (never mL; tsp goes as fl oz), its own way of going down, and a
// tracked stock at zero holds Complete. The house mix, validation and the
// request contract are pinned in FastCompleteSheet.test.jsx.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteSheet, { isSendableRateUnit } from './FastCompleteSheet';
import RATE_UNITS from '../../../../shared/rate-units.json';
import { formatMeasuredAmount } from '../../lib/mix-amount';

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
const DESKTOP_WIDTH = window.innerWidth;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // innerWidth is [Replaceable] in jsdom — plain assignment shadows it.
  window.innerWidth = DESKTOP_WIDTH;
});

const CATALOG = [
  // The house mix (lib/pest-default-mix.js). Numeric stock arrives as a
  // string, the way the database sends numerics.
  { id: 'taurus', name: 'Taurus SC', category: 'insecticide', active_ingredient: 'fipronil', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal', inventory_unit: 'fl_oz', inventory_on_hand: '120.0000' },
  { id: 'talak', name: 'Atticus Talak 7.9 F', category: 'insecticide', active_ingredient: 'bifenthrin', inventory_unit: 'fl_oz', inventory_on_hand: 96 },
  { id: 'lesco', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' },
  // Stock kept in a bare oz says nothing; it is usually recorded in grams.
  { id: 'alpine', name: 'Alpine WSG', category: 'insecticide', active_ingredient: 'dinotefuran', inventory_unit: 'oz', inventory_on_hand: 10 },
  { id: 'delta', name: 'Delta Dust', category: 'insecticide', active_ingredient: 'deltamethrin', inventory_unit: 'lb', inventory_on_hand: 4 },
  { id: 'gentrol', name: 'Gentrol IGR', category: 'igr', active_ingredient: 'hydroprene', inventory_unit: 'fl_oz', inventory_on_hand: 32 },
  { id: 'demand', name: 'Demand CS', category: 'insecticide', active_ingredient: 'lambda-cyhalothrin', inventory_unit: 'fl_oz', inventory_on_hand: '0.0000' },
  // Nothing but a usual bare oz and its form: a liquid.
  { id: 'onslaught', name: 'Onslaught Fastcap', category: 'insecticide', active_ingredient: 'esfenvalerate' },
  // The catalog row (migration 20260816000010): a label band per spot.
  { id: 'advion', name: 'Advion Ant Bait Gel', category: 'bait', active_ingredient: 'indoxacarb', default_rate: '0.1-1', default_unit: 'g/spot', application_method: 'bait_placement' },
  { id: 'tekko', name: 'Tekko Pro', category: 'igr', active_ingredient: 'novaluron', default_rate: '0.5-1', default_unit: 'fl_oz/gal' },
  { id: 'blox', name: 'Contrac Blox', category: 'rodenticide', active_ingredient: 'bromadiolone', inventory_unit: 'each', inventory_on_hand: 50 },
  { id: 'imid2f', name: 'Imidacloprid 2F', category: 'insecticide', active_ingredient: 'imidacloprid' },
  { id: 'qualipro', name: 'Quali-Pro Imidacloprid 2F', category: 'insecticide', active_ingredient: 'imidacloprid' },
  { id: 'bifen', name: 'Bifen XTS', display_name: 'Bifen + Imidacloprid', category: 'insecticide', active_ingredient: 'bifenthrin, imidacloprid' },
  { id: 'temprid', name: 'Temprid FX', category: 'insecticide', active_ingredient: 'imidacloprid, beta-cyfluthrin' },
  // A label rate kept in mL, and a catalog rate unit /complete would refuse.
  { id: 'treeage', name: 'TREE-age G4', category: 'insecticide', active_ingredient: 'emamectin benzoate', default_rate: '2-10', default_unit: 'ml/inch dbh' },
  { id: 'cyzmic', name: 'Cyzmic CS', category: 'insecticide', active_ingredient: 'lambda-cyhalothrin', default_rate: '0.5', default_unit: 'percent_solution' },
  // Not a pest product: behind "Show other products".
  { id: 'celsius', name: 'Celsius WG', category: 'herbicide', active_ingredient: 'thiencarbazone' },
  // Never applied to a property: never listed.
  { id: 'sign', name: 'Yard Sign', category: 'supplies' },
  { id: 'cleaner', name: 'Tank Neutralizer', category: 'cleaner' },
  { id: 'trap', name: 'Snap Trap', category: 'rodent_trap' },
  { id: 'monitor', name: 'Termite Monitor', category: 'termite monitoring' },
];

// A gel bait its name doesn't call one (its formulation does), kept in
// tubes counted "each", at zero.
const VENDETTA = {
  id: 'vendetta', name: 'Vendetta Plus', category: 'bait', formulation: 'gel bait', default_rate: '0.25-0.5',
  default_unit: 'g/spot', application_method: 'bait_placement', inventory_unit: 'each', inventory_on_hand: 0,
};

// Server order: most visits first. The house mix leads it but is always on
// the sheet; an id the catalog no longer has is skipped.
const COMMON = [
  { productId: 'taurus', visits: 120, usualUnit: 'oz', usualAmount: 4 },
  { productId: 'alpine', visits: 74, usualUnit: 'g', usualAmount: 5 },
  { productId: 'delta', visits: 36, usualUnit: 'g', usualAmount: 4 },
  { productId: 'gentrol', visits: 34, usualUnit: 'oz', usualAmount: 1 },
  { productId: 'demand', visits: 25, usualUnit: 'oz', usualAmount: 4 },
  { productId: 'onslaught', visits: 7, usualUnit: 'oz', usualAmount: 2 },
  { productId: 'retired', visits: 3, usualUnit: 'g', usualAmount: 1 },
];

const CONTEXT_SERVICE = {
  id: 'svc-1', customerName: 'Pat Jones', customerId: 'cust-1', propertyId: 'prop-1',
  serviceType: 'Pest Control Re-Service', scheduledDate: '2026-09-26', address: { line1: '123 Main St' },
  serviceKey: 'pest_re_service', status: 'confirmed',
};
const SERVICE = { id: 'svc-1', customerName: 'Pat Jones', serviceType: 'Pest Re-Service', address: '123 Main St', timeLabel: '2:00 PM' };

// `products` may be a function: each context read then gets its current rows.
function makeRequest({ products = CATALOG, commonProducts = COMMON } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.split('?')[0].endsWith('/pest-recap/context')) {
      const rows = typeof products === 'function' ? products() : products;
      return { ok: true, eligible: true, service: CONTEXT_SERVICE, products: rows, commonProducts, existingRecord: null };
    }
    if (path.endsWith('/tech-rating-allowed')) return { allowed: false };
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.endsWith('/photos')) return { photos: [] };
    if (path.endsWith('/complete')) return { success: true };
    return {};
  });
  request.calls = calls;
  return request;
}

async function openSheet(request = makeRequest(), props = {}) {
  render(<FastCompleteSheet service={SERVICE} request={request} onClose={() => {}} {...props} />);
  await screen.findByRole('button', { name: /Taurus SC/ });
  return request;
}

const otherProductButton = () => screen.getByRole('button', { name: '+ Other product' });
function openPicker() {
  fireEvent.click(otherProductButton());
  return screen.getByRole('dialog', { name: 'Add a product' });
}
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const option = (picker, name) => within(picker).getByRole('button', { name: new RegExp(`^${escapeRe(name)}\\b`) });
const optionNames = (group) => within(group).getAllByRole('button')
  .map((button) => button.querySelector('.tech-product-option-name').textContent);

// Adds a product through the picker and returns its editor.
function addProduct(name) {
  fireEvent.click(option(openPicker(), name));
  return screen.getByRole('group', { name });
}
function enterAmount(editor, amount, unit) {
  if (unit) fireEvent.click(within(within(editor).getByRole('group', { name: 'Unit' })).getByRole('button', { name: unit }));
  fireEvent.change(within(editor).getByLabelText('How much?'), { target: { value: String(amount) } });
}
const howChoice = (editor, label) => within(within(editor).getByRole('group', { name: 'How' })).getByRole('button', { name: label });
const visitHowRow = () => screen.getByRole('heading', { name: 'How', level: 3 }).closest('section');

function fillVisit() {
  fireEvent.click(screen.getByRole('button', { name: 'Ants' }));
  fireEvent.click(screen.getByRole('button', { name: 'Outside' }));
}
async function completeBody(request) {
  fireEvent.click(screen.getByRole('button', { name: 'Complete re-service' }));
  await waitFor(() => expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true));
  return JSON.parse(request.calls.find((c) => c.path.endsWith('/complete')).options.body);
}
const productIn = (body, id) => body.products.find((p) => p.productId === id);
function expectNoRate(product) {
  expect(product).not.toHaveProperty('rate');
  expect(product).not.toHaveProperty('rateUnit');
}

describe('FastCompleteSheet + Other product picker', () => {
  test('opens on the sheet, most-used first with its usual amount, then every pest product A–Z', async () => {
    const onFullForm = vi.fn();
    await openSheet(makeRequest(), { onFullForm });
    const picker = openPicker();

    expect(onFullForm).not.toHaveBeenCalled();
    expect(otherProductButton().getAttribute('aria-expanded')).toBe('true');
    // At desktop width it is a popover that takes the search box.
    expect(document.activeElement).toBe(within(picker).getByLabelText('Search products'));
    expect(within(picker).getByLabelText('Search products').getAttribute('placeholder')).toBe('Search name or ingredient…');

    const mostUsed = within(picker).getByRole('group', { name: 'Used most on pest visits' });
    expect(optionNames(mostUsed)).toEqual(['Alpine WSG', 'Delta Dust', 'Gentrol IGR', 'Demand CS', 'Onslaught Fastcap']);
    // The usual amount in the product's own measure: a liquid's bare oz is
    // a fluid ounce.
    expect(option(picker, 'Alpine WSG').textContent).toContain('Insecticide · usually 5 g');
    expect(option(picker, 'Delta Dust').textContent).toContain('Insecticide · usually 4 g');
    expect(option(picker, 'Gentrol IGR').textContent).toContain('IGR · usually 1 fl oz');
    expect(option(picker, 'Demand CS').textContent).toContain('Insecticide · usually 4 fl oz');
    expect(option(picker, 'Onslaught Fastcap').textContent).toContain('Insecticide · usually 2 fl oz');

    const allPest = within(picker).getByRole('group', { name: 'All pest products' });
    expect(optionNames(allPest)).toEqual([
      'Advion Ant Bait Gel', 'Atticus Talak 7.9 F', 'Bifen XTS', 'Contrac Blox', 'Cyzmic CS', 'Imidacloprid 2F',
      'LESCO 90/10 Nonionic Surfactant', 'Quali-Pro Imidacloprid 2F', 'Taurus SC', 'Tekko Pro', 'Temprid FX', 'TREE-age G4',
    ]);
    expect(option(picker, 'Tekko Pro').textContent).toContain('IGR');
  });

  test('never lists supplies, cleaner, traps or termite monitors; other products wait behind a button', async () => {
    await openSheet();
    const picker = openPicker();
    const hidden = ['Yard Sign', 'Tank Neutralizer', 'Snap Trap', 'Termite Monitor'];

    expect(within(picker).queryByText('Celsius WG')).toBeNull();
    fireEvent.click(within(picker).getByRole('button', { name: 'Show other products' }));
    expect(optionNames(within(picker).getByRole('group', { name: 'Other products' }))).toEqual(['Celsius WG']);
    for (const name of hidden) expect(within(picker).queryByText(name)).toBeNull();

    // Search reaches the whole catalog, hidden items excepted.
    const search = within(picker).getByLabelText('Search products');
    fireEvent.change(search, { target: { value: 'trap' } });
    expect(within(picker).getByText('No products match.')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'sign' } });
    expect(within(picker).queryByText('Yard Sign')).toBeNull();
  });

  test('search ranks a name start, then the name, short name, active ingredient and category', async () => {
    await openSheet();
    const picker = openPicker();
    const search = within(picker).getByLabelText('Search products');

    fireEvent.change(search, { target: { value: 'IMIDA' } });
    const results = () => within(picker).getByRole('group', { name: 'Matching products' });
    expect(optionNames(results())).toEqual(['Imidacloprid 2F', 'Quali-Pro Imidacloprid 2F', 'Bifen XTS', 'Temprid FX']);

    fireEvent.change(search, { target: { value: 'igr' } });
    expect(optionNames(results())).toEqual(['Gentrol IGR', 'Tekko Pro']);

    // Not a pest product, still found by name.
    fireEvent.change(search, { target: { value: 'celsius' } });
    expect(optionNames(results())).toEqual(['Celsius WG']);
  });

  test('a product already on the sheet cannot be added twice', async () => {
    const request = await openSheet();
    let picker = openPicker();
    const taurus = option(picker, 'Taurus SC');
    expect(taurus.disabled).toBe(true);
    expect(taurus.textContent).toContain('Already on the sheet');

    fireEvent.click(option(picker, 'Alpine WSG'));
    picker = openPicker();
    const alpine = option(picker, 'Alpine WSG');
    expect(alpine.disabled).toBe(true);
    expect(alpine.textContent).toContain('Already on the sheet');
    fireEvent.click(alpine);
    fireEvent.keyDown(document, { key: 'Escape' });

    enterAmount(screen.getByRole('group', { name: 'Alpine WSG' }), 5);
    fillVisit();
    const body = await completeBody(request);
    expect(body.products.filter((p) => p.productId === 'alpine')).toHaveLength(1);
  });

  test('a tracked stock at zero is flagged, and Complete names it until the product comes off', async () => {
    await openSheet();
    const picker = openPicker();
    expect(option(picker, 'Demand CS').textContent).toContain('0 in stock');
    expect(option(picker, 'Alpine WSG').textContent).not.toContain('0 in stock');

    fireEvent.click(option(picker, 'Demand CS'));
    const editor = screen.getByRole('group', { name: 'Demand CS' });
    enterAmount(editor, 4);
    fillVisit();
    const tile = screen.getByRole('button', { name: /Demand CS — 4 fl oz 0 in stock/ });
    // Name and amount are separate lines on the tile; the amount keeps its unit.
    expect(tile.querySelector('.tech-visit-product-name').textContent).toBe('Demand CS');
    expect(tile.querySelector('.tech-visit-product-amount').textContent).toBe('4 fl oz');
    const hold = screen.getByText('Demand CS shows 0 in stock. Update inventory or remove it.');
    // A warning, not a hint: the footer reason reads amber like the tile.
    expect(hold.classList.contains('tech-visit-status--warn')).toBe(true);
    const submit = screen.getByRole('button', { name: 'Complete re-service' });
    expect(submit.disabled).toBe(true);

    fireEvent.click(within(editor).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('button', { name: /Demand CS/ })).toBeNull();
    expect(screen.queryByText(/shows 0 in stock/)).toBeNull();
    expect(submit.disabled).toBe(false);
    // With the product gone, focus lands on the way to add another.
    expect(document.activeElement).toBe(otherProductButton());
  });

  test('a house-mix stock at zero holds Complete too, and Check stock re-reads it once restocked', async () => {
    let taurusStock = '0.0000';
    const request = makeRequest({ products: () => CATALOG.map((p) => (p.id === 'taurus' ? { ...p, inventory_on_hand: taurusStock } : p)) });
    await openSheet(request);
    fillVisit();
    const submit = screen.getByRole('button', { name: 'Complete re-service' });
    expect(screen.getByText('Taurus SC shows 0 in stock. Update inventory or remove it.')).toBeTruthy();
    expect(submit.disabled).toBe(true);

    // The office restocks it: the open sheet holds until the tech checks.
    taurusStock = '64.0000';
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check stock' }));
    await waitFor(() => expect(submit.disabled).toBe(false));
    expect(screen.queryByText(/shows 0 in stock/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check stock' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Taurus SC — 4 fl oz' })).toBeTruthy();
    // Only the sheet's first read asks for the most-used aggregate; the stock
    // re-read (and the recap modal, which shares the endpoint) never does.
    const contextReads = request.calls.map((c) => c.path).filter((p) => p.includes('/pest-recap/context'));
    expect(contextReads).toEqual([
      '/admin/dispatch/svc-1/pest-recap/context?include=common_products',
      '/admin/dispatch/svc-1/pest-recap/context',
    ]);

    const body = await completeBody(request);
    expect(productIn(body, 'taurus')).toMatchObject({ totalAmount: 4, amountUnit: 'fl_oz', targets: ['Ants'] });
  });

  test('a stock the amount can\'t be counted against is flagged but never holds Complete', async () => {
    // The server deducts only an amount it can convert to the stock's unit:
    // a gel weighed in grams against tubes counted "each" is never refused.
    const request = await openSheet(makeRequest({ products: [...CATALOG, VENDETTA] }));
    const editor = addProduct('Vendetta Plus');
    enterAmount(editor, 2);
    fillVisit();
    expect(screen.getByRole('button', { name: /Vendetta Plus — 2 g 0 in stock/ })).toBeTruthy();
    expect(screen.queryByText(/shows 0 in stock/)).toBeNull();

    const body = await completeBody(request);
    expect(productIn(body, 'vendetta')).toMatchObject({ totalAmount: 2, amountUnit: 'g', applicationMethod: 'bait_placement' });
  });
});

describe('FastCompleteSheet added product amounts', () => {
  test('a liquid entered in tsp is sent as fl oz (tsp ÷ 6) and shown in spoons', async () => {
    const request = await openSheet();
    const editor = addProduct('Gentrol IGR');
    // Fresh from the picker, the amount is the next thing to enter.
    expect(document.activeElement).toBe(within(editor).getByLabelText('How much?'));
    expect(within(editor).getByText('IGR · added by you')).toBeTruthy();
    const units = within(editor).getByRole('group', { name: 'Unit' });
    expect(within(units).getAllByRole('button').map((b) => b.textContent)).toEqual(['tsp', 'fl oz', 'gal']);
    // Its usual unit is preselected, never its amount.
    expect(within(units).getByRole('button', { name: 'fl oz' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(editor).getByLabelText('How much?').value).toBe('');
    expect(screen.getByRole('button', { name: 'Gentrol IGR — How much?' })).toBeTruthy();

    enterAmount(editor, 3, 'tsp');
    expect(screen.getByRole('button', { name: 'Gentrol IGR — 3 tsp' })).toBeTruthy();
    enterAmount(editor, 1);
    expect(screen.getByRole('button', { name: 'Gentrol IGR — 1 tsp' })).toBeTruthy();

    fillVisit();
    const body = await completeBody(request);
    expect(productIn(body, 'gentrol')).toMatchObject({ totalAmount: 0.167, amountUnit: 'fl_oz', applicationMethod: 'spot_treatment', targets: ['Ants'], applicationArea: 'Outside' });
  });

  test('a tsp amount is stored so it reads back as the same spoons', async () => {
    // service_products.total_amount keeps three decimals, so tsp ÷ 6 rounds
    // up there: ½ tsp is 0.084 ("½ tsp"), never 0.083 ("0.083 fl oz").
    const request = await openSheet();
    enterAmount(addProduct('Gentrol IGR'), 0.5, 'tsp');
    enterAmount(addProduct('Onslaught Fastcap'), 2, 'tsp');
    fillVisit();
    const body = await completeBody(request);
    expect(productIn(body, 'gentrol')).toMatchObject({ totalAmount: 0.084, amountUnit: 'fl_oz' });
    expect(productIn(body, 'onslaught')).toMatchObject({ totalAmount: 0.334, amountUnit: 'fl_oz' });
    expect(formatMeasuredAmount(0.084, 'fl_oz')).toBe('½ tsp');
    expect(formatMeasuredAmount(0.334, 'fl_oz')).toBe('2 tsp');
  });

  test('an added product starts in the unit its usual amount was shown in', async () => {
    await openSheet(makeRequest({
      products: [...CATALOG, VENDETTA],
      commonProducts: [
        { productId: 'tekko', visits: 9, usualUnit: 'fl_oz', usualAmount: 0.25 },
        { productId: 'delta', visits: 8, usualUnit: 'oz', usualAmount: 0.5 },
        { productId: 'advion', visits: 7, usualUnit: 'oz', usualAmount: 2 },
      ],
    }));
    const picker = openPicker();
    expect(option(picker, 'Tekko Pro').textContent).toContain('usually 1½ tsp');
    expect(option(picker, 'Delta Dust').textContent).toContain('usually 14.2 g');
    // A gel bait is recorded in grams, so its usual weight reads in grams.
    expect(option(picker, 'Advion Ant Bait Gel').textContent).toContain('usually 56.7 g');
    fireEvent.keyDown(document, { key: 'Escape' });

    const pressedUnit = (editor) => within(within(editor).getByRole('group', { name: 'Unit' }))
      .getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
    const tekko = addProduct('Tekko Pro');
    expect(pressedUnit(tekko)).toEqual(['tsp']);
    // Typing the number the picker showed records that amount.
    enterAmount(tekko, 1.5);
    expect(screen.getByRole('button', { name: 'Tekko Pro — 1½ tsp' })).toBeTruthy();
    expect(pressedUnit(addProduct('Delta Dust'))).toEqual(['g']);
    expect(pressedUnit(addProduct('Advion Ant Bait Gel'))).toEqual(['g']);
    // A gel its name doesn't call one is weighed too, whatever its stock is counted in.
    const vendetta = addProduct('Vendetta Plus');
    expect(within(within(vendetta).getByRole('group', { name: 'Unit' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['g', 'oz', 'lb']);
    expect(pressedUnit(vendetta)).toEqual(['g']);
  });

  test('the unit its stock is kept in settles a product\'s measure before its usual unit', async () => {
    // Gentrol IGR is stocked in fl oz: a usual unit of g never makes it a weight.
    await openSheet(makeRequest({ commonProducts: [{ productId: 'gentrol', visits: 3, usualUnit: 'g', usualAmount: 5 }] }));
    const units = within(addProduct('Gentrol IGR')).getByRole('group', { name: 'Unit' });
    expect(within(units).getAllByRole('button').map((b) => b.textContent)).toEqual(['tsp', 'fl oz', 'gal']);
  });

  test('the house mix keeps its own units: a usual unit never relabels a house total', async () => {
    // Taurus usually logged in gal: its house 4 fl oz must not open as 4 gal.
    const request = await openSheet(makeRequest({ commonProducts: [{ productId: 'taurus', visits: 120, usualUnit: 'gal', usualAmount: 1 }] }));
    expect(screen.getByRole('button', { name: 'Taurus SC — 4 fl oz' })).toBeTruthy();
    // The surfactant's 0.25 fl oz is 1½ tsp on its tile and in Edit amounts.
    fireEvent.click(screen.getByRole('button', { name: 'Edit amounts' }));
    expect(screen.getByLabelText('LESCO 90/10 Nonionic Surfactant').value).toBe('1.5');
    expect(screen.getByLabelText('Unit for LESCO 90/10 Nonionic Surfactant').value).toBe('tsp');

    fillVisit();
    const body = await completeBody(request);
    expect(productIn(body, 'taurus')).toMatchObject({ totalAmount: 4, amountUnit: 'fl_oz' });
    expect(productIn(body, 'lesco')).toMatchObject({ totalAmount: 0.25, amountUnit: 'fl_oz' });
  });

  test('a dry product is weighed in g; a gel bait starts in grams and goes down as a bait placement', async () => {
    const request = await openSheet();
    let editor = addProduct('Alpine WSG');
    let units = within(editor).getByRole('group', { name: 'Unit' });
    expect(within(units).getAllByRole('button').map((b) => b.textContent)).toEqual(['g', 'oz', 'lb']);
    expect(within(units).getByRole('button', { name: 'g' }).getAttribute('aria-pressed')).toBe('true');
    enterAmount(editor, 5);
    expect(screen.getByRole('button', { name: 'Alpine WSG — 5 g' })).toBeTruthy();

    editor = addProduct('Advion Ant Bait Gel');
    units = within(editor).getByRole('group', { name: 'Unit' });
    expect(within(units).getByRole('button', { name: 'g' }).getAttribute('aria-pressed')).toBe('true');
    expect(howChoice(editor, 'Bait placement').getAttribute('aria-pressed')).toBe('true');
    expect(within(editor).queryByText("Same as the visit's How")).toBeNull();
    enterAmount(editor, 2);

    // A count product offers a count.
    editor = addProduct('Contrac Blox');
    units = within(editor).getByRole('group', { name: 'Unit' });
    expect(within(units).getAllByRole('button').map((b) => b.textContent)).toEqual(['each']);
    enterAmount(editor, 3);

    fillVisit();
    const body = await completeBody(request);
    expect(productIn(body, 'alpine')).toMatchObject({ totalAmount: 5, amountUnit: 'g', applicationMethod: 'spot_treatment' });
    expect(productIn(body, 'advion')).toMatchObject({ totalAmount: 2, amountUnit: 'g', applicationMethod: 'bait_placement' });
    expect(productIn(body, 'blox')).toMatchObject({ totalAmount: 3, amountUnit: 'each', applicationMethod: 'bait_placement' });
  });

  test('a rate unit /complete would refuse is left off the record', async () => {
    // Neither a catalog oddity (percent_solution) nor a unit that only looks
    // like one of the server's (fl_oz/1000sf is not on its list) is shown or
    // sent: either would make the server refuse the whole visit.
    const products = CATALOG.map((p) => (p.id === 'talak' ? { ...p, default_rate_per_1000: '0.5', default_unit: 'fl_oz/1000sf' } : p));
    const request = await openSheet(makeRequest({ products }));
    enterAmount(addProduct('Cyzmic CS'), 2);
    fireEvent.click(screen.getByRole('button', { name: 'Edit amounts' }));
    expect(screen.queryByLabelText('Atticus Talak 7.9 F rate')).toBeNull();
    expect(screen.queryByLabelText('Cyzmic CS rate')).toBeNull();
    fillVisit();
    const body = await completeBody(request);
    expect(productIn(body, 'cyzmic')).toMatchObject({ totalAmount: 2, amountUnit: 'fl_oz' });
    expectNoRate(productIn(body, 'talak'));
    expectNoRate(productIn(body, 'cyzmic'));
  });

  test('an added product records a rate only when the tech types one, in its label unit', async () => {
    // Advion's label band starts at 0.1 g/spot. The product's editor shows no
    // rate, so none goes on the record unless the tech types one in Edit
    // amounts. Gentrol's catalog row names no rate unit: at spot the resolver
    // falls back to a bare "oz", and at perimeter to the house default (the
    // house mix's 4 oz). Neither is its label, so it has no rate row at any
    // How (an "oz" rate beside a product kept in tsp would mislead).
    const request = await openSheet();
    enterAmount(addProduct('Gentrol IGR'), 1);
    enterAmount(addProduct('Advion Ant Bait Gel'), 2);
    fireEvent.click(screen.getByRole('button', { name: 'Edit amounts' }));
    expect(screen.queryByLabelText('Gentrol IGR rate')).toBeNull();
    expect(screen.getByLabelText('Advion Ant Bait Gel rate').value).toBe('');
    fireEvent.click(within(visitHowRow()).getByRole('button', { name: 'Perimeter spray' }));
    fillVisit();
    fireEvent.change(screen.getByLabelText('Linear ft sprayed'), { target: { value: '100' } });
    expect(screen.queryByLabelText('Gentrol IGR rate')).toBeNull();
    expect(screen.getByLabelText('Advion Ant Bait Gel rate').value).toBe('');
    fireEvent.change(screen.getByLabelText('Advion Ant Bait Gel rate'), { target: { value: '0.5' } });

    const body = await completeBody(request);
    expectNoRate(productIn(body, 'gentrol'));
    expect(productIn(body, 'advion')).toMatchObject({ rate: 0.5, rateUnit: 'g/spot', totalAmount: 2, amountUnit: 'g' });
    // The house mix still starts at the rate the full form seeds.
    expect(productIn(body, 'taurus')).toMatchObject({ rate: 4, rateUnit: 'oz' });
  });

  test('a label rate kept in mL is neither shown nor recorded', async () => {
    // Nothing on the sheet is in mL (owner ruling 2026-09-27), so the tech
    // could never see — let alone confirm — this rate.
    const products = CATALOG.map((p) => (p.id === 'taurus' ? { ...p, default_rate: '6-24', default_unit: 'ml/gal' } : p));
    const request = await openSheet(makeRequest({ products }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit amounts' }));
    expect(screen.queryByLabelText('Taurus SC rate')).toBeNull();
    fillVisit();
    const taurus = productIn(await completeBody(request), 'taurus');
    expect(taurus).toMatchObject({ totalAmount: 4, amountUnit: 'fl_oz' });
    expectNoRate(taurus);
  });

  test('Done closes the editor, the tile opens it again, and Remove takes the product off the record', async () => {
    const request = await openSheet();
    const editor = addProduct('Alpine WSG');
    // A fresh product's reason is a hint, not the amber stock warning.
    const hint = screen.getByText('Enter the amount for Alpine WSG.');
    expect(hint.classList.contains('tech-visit-status--warn')).toBe(false);
    enterAmount(editor, 5);
    fireEvent.click(within(editor).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('group', { name: 'Alpine WSG' })).toBeNull();
    const tile = screen.getByRole('button', { name: 'Alpine WSG — 5 g' });
    expect(document.activeElement).toBe(tile);
    expect(tile.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(tile);
    expect(tile.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(screen.getByRole('group', { name: 'Alpine WSG' })).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('button', { name: /Alpine WSG/ })).toBeNull();
    expect(option(openPicker(), 'Alpine WSG').disabled).toBe(false);
    fireEvent.keyDown(document, { key: 'Escape' });

    fillVisit();
    const body = await completeBody(request);
    expect(productIn(body, 'alpine')).toBeUndefined();
    expect(body.products.map((p) => p.productId).sort()).toEqual(['lesco', 'talak', 'taurus']);
  });
});

describe('FastCompleteSheet added product method', () => {
  test('a spray follows the visit\'s How until the tech picks another way, and that way is sent', async () => {
    const request = await openSheet();
    const editor = addProduct('Onslaught Fastcap');
    expect(howChoice(editor, 'Spot treatment').getAttribute('aria-pressed')).toBe('true');
    expect(within(editor).getByText("Same as the visit's How")).toBeTruthy();

    fireEvent.click(howChoice(editor, 'Bait placement'));
    expect(howChoice(editor, 'Bait placement').getAttribute('aria-pressed')).toBe('true');
    expect(within(editor).queryByText("Same as the visit's How")).toBeNull();
    enterAmount(editor, 2);

    fillVisit();
    const body = await completeBody(request);
    expect(productIn(body, 'onslaught')).toMatchObject({ applicationMethod: 'bait_placement', totalAmount: 2, amountUnit: 'fl_oz' });
    expect(productIn(body, 'taurus').applicationMethod).toBe('spot_treatment');
  });

  test('a perimeter spray picked for one product asks for its linear feet while the How row says spot', async () => {
    const request = await openSheet();
    const editor = addProduct('Gentrol IGR');
    enterAmount(editor, 1);
    fillVisit();
    expect(screen.queryByLabelText('Linear ft sprayed')).toBeNull();

    fireEvent.click(howChoice(editor, 'Perimeter spray'));
    expect(within(visitHowRow()).getByRole('button', { name: 'Spot treatment' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Enter the linear feet you sprayed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete re-service' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Linear ft sprayed'), { target: { value: '120' } });

    const body = await completeBody(request);
    expect(productIn(body, 'gentrol')).toMatchObject({ applicationMethod: 'perimeter_spray', areaValue: 120, areaUnit: 'linear_ft' });
    expect(productIn(body, 'taurus').applicationMethod).toBe('spot_treatment');
    expect('areaValue' in productIn(body, 'taurus')).toBe(false);
  });

  test('a bait block or granule with no catalog method goes down by its form, not the visit\'s spray', async () => {
    const granule = { id: 'granule', name: 'Talstar XTRA Granular', category: 'insecticide' };
    const request = await openSheet(makeRequest({ products: [...CATALOG, granule] }));
    fireEvent.click(within(visitHowRow()).getByRole('button', { name: 'Perimeter spray' }));
    let editor = addProduct('Contrac Blox');
    expect(howChoice(editor, 'Bait placement').getAttribute('aria-pressed')).toBe('true');
    expect(within(editor).queryByText("Same as the visit's How")).toBeNull();
    enterAmount(editor, 2);
    editor = addProduct('Talstar XTRA Granular');
    expect(howChoice(editor, 'Granular').getAttribute('aria-pressed')).toBe('true');
    enterAmount(editor, 1, 'lb');
    // A dry form that is mixed and sprayed still follows the How row.
    editor = addProduct('Alpine WSG');
    expect(within(editor).getByText("Same as the visit's How")).toBeTruthy();
    enterAmount(editor, 5);
    fillVisit();
    fireEvent.change(screen.getByLabelText('Linear ft sprayed'), { target: { value: '150' } });

    const body = await completeBody(request);
    expect(productIn(body, 'blox')).toMatchObject({ applicationMethod: 'bait_placement', totalAmount: 2, amountUnit: 'each' });
    expect(productIn(body, 'blox')).not.toHaveProperty('areaValue');
    expect(productIn(body, 'granule')).toMatchObject({ applicationMethod: 'granular_broadcast', totalAmount: 1, amountUnit: 'lb' });
    expect(productIn(body, 'alpine')).toMatchObject({ applicationMethod: 'perimeter_spray', areaValue: 150, areaUnit: 'linear_ft' });
  });

  test('a rate typed for one way of going down is cleared when the tech picks another', async () => {
    // Tekko Pro's label rate is per gallon at spot. At perimeter the only
    // rate is the house default's oz, which is the house mix's and not this
    // label's, so the added row has no rate there; a typed 0.5 fl oz/gal
    // must never become 0.5 oz, nor come back when the tech returns to spot.
    const request = await openSheet();
    const editor = addProduct('Tekko Pro');
    enterAmount(editor, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Edit amounts' }));
    fireEvent.change(screen.getByLabelText('Tekko Pro rate'), { target: { value: '0.5' } });
    fireEvent.click(howChoice(editor, 'Perimeter spray'));
    expect(screen.queryByLabelText('Tekko Pro rate')).toBeNull();
    fireEvent.click(howChoice(editor, 'Spot treatment'));
    expect(screen.getByLabelText('Tekko Pro rate').value).toBe('');
    fireEvent.click(howChoice(editor, 'Perimeter spray'));
    fillVisit();
    fireEvent.change(screen.getByLabelText('Linear ft sprayed'), { target: { value: '80' } });

    const tekko = productIn(await completeBody(request), 'tekko');
    expect(tekko).toMatchObject({ applicationMethod: 'perimeter_spray', totalAmount: 1, amountUnit: 'fl_oz' });
    expectNoRate(tekko);
  });
});

describe('FastCompleteSheet picker dismissal', () => {
  test('Escape and × close only the picker, and focus returns to + Other product', async () => {
    const onClose = vi.fn();
    await openSheet(makeRequest(), { onClose });

    openPicker();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Add a product' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Complete re-service' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(otherProductButton());
    expect(otherProductButton().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(within(openPicker()).getByRole('button', { name: 'Close product list' }));
    expect(screen.queryByRole('dialog', { name: 'Add a product' })).toBeNull();
    expect(document.activeElement).toBe(otherProductButton());

    // The popover also closes on a press anywhere else on the sheet.
    openPicker();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Ants' }));
    expect(screen.queryByRole('dialog', { name: 'Add a product' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('on a phone the picker is a sheet over the form, which is out of reach until it closes', async () => {
    window.innerWidth = 390; // useIsMobile reads innerWidth on mount
    await openSheet();
    const picker = openPicker();
    const body = document.querySelector('.tech-visit-body');
    const footer = document.querySelector('.tech-visit-footer');

    expect(body.contains(picker)).toBe(false);
    expect(body.hasAttribute('inert')).toBe(true);
    expect(footer.getAttribute('aria-hidden')).toBe('true');
    // The sheet's header stays in view and in reach.
    expect(screen.getByRole('button', { name: 'Full form' }).closest('[inert]')).toBeNull();
    // Focus goes to the sheet itself, so the keyboard does not cover the list.
    expect(document.activeElement).toBe(picker);

    fireEvent.click(within(picker).getByRole('button', { name: 'Close product list' }));
    expect(body.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(otherProductButton());
  });
});

test('nothing on the sheet is in mL', async () => {
  await openSheet();
  enterAmount(addProduct('TREE-age G4'), 2);
  fireEvent.click(screen.getByRole('button', { name: 'Edit amounts' }));
  const units = screen.getByLabelText('Unit for TREE-age G4');
  expect([...units.options].map((o) => o.textContent)).toEqual(['tsp', 'fl oz', 'gal']);
  expect([...screen.getByLabelText('Unit for Taurus SC').options].map((o) => o.value)).toEqual(['tsp', 'fl_oz', 'gal']);
  // Its label rate is kept in mL: not shown.
  expect(screen.queryByLabelText('TREE-age G4 rate')).toBeNull();
  openPicker();

  expect(document.body.textContent).not.toMatch(/\bml\b/i);
  for (const node of document.querySelectorAll('option')) {
    expect(node.value.toLowerCase()).not.toBe('ml');
    expect(node.textContent.toLowerCase()).not.toBe('ml');
  }
});

describe('FastCompleteSheet catalog formulation and rate units', () => {
  test('a product that is granular only in its catalog formulation is weighed and broadcast, never sprayed', async () => {
    // "granular" is only in the formulation: no method, stock unit or label
    // unit of its own (Codex on #5313: Heritage G, Pillar G Intrinsic).
    const products = [...CATALOG, { id: 'heritage', name: 'Heritage G', category: 'fungicide', formulation: 'granular' }];
    const request = await openSheet(makeRequest({ products }));
    const picker = openPicker();
    fireEvent.click(within(picker).getByRole('button', { name: 'Show other products' }));
    fireEvent.click(option(picker, 'Heritage G'));
    const editor = screen.getByRole('group', { name: 'Heritage G' });
    const units = within(editor).getByRole('group', { name: 'Unit' });
    expect(within(units).getAllByRole('button').map((b) => b.textContent)).toEqual(['g', 'oz', 'lb']);
    expect(howChoice(editor, 'Granular').getAttribute('aria-pressed')).toBe('true');
    enterAmount(editor, 2, 'lb');
    fillVisit();
    // Nothing goes down as a perimeter spray, so no linear feet are asked for.
    expect(screen.queryByLabelText('Linear ft sprayed')).toBeNull();
    const heritage = productIn(await completeBody(request), 'heritage');
    expect(heritage).toMatchObject({ applicationMethod: 'granular_broadcast', totalAmount: 2, amountUnit: 'lb' });
  });

  test("a sprayed dry formulation (soluble granules) is weighed but follows the visit's How", async () => {
    const products = [...CATALOG, { id: 'soluble', name: 'Example 20 Insecticide', category: 'insecticide', formulation: 'soluble granular' }];
    const request = await openSheet(makeRequest({ products }));
    const editor = addProduct('Example 20 Insecticide');
    const units = within(editor).getByRole('group', { name: 'Unit' });
    expect(within(units).getAllByRole('button').map((b) => b.textContent)).toEqual(['g', 'oz', 'lb']);
    expect(howChoice(editor, 'Spot treatment').getAttribute('aria-pressed')).toBe('true');
    expect(within(editor).getByText("Same as the visit's How")).toBeTruthy();
    enterAmount(editor, 5, 'g');
    fillVisit();
    const soluble = productIn(await completeBody(request), 'soluble');
    expect(soluble).toMatchObject({ applicationMethod: 'spot_treatment', totalAmount: 5, amountUnit: 'g' });
  });

  test("a rate goes only in a unit on the server's own list, never one of its mL units", () => {
    // shared/rate-units.json is the list /complete checks (inventory-units.js).
    for (const unit of RATE_UNITS) {
      expect(isSendableRateUnit(unit)).toBe(unit.split('/')[0] !== 'ml');
    }
    expect(isSendableRateUnit(' FL_OZ/GAL ')).toBe(true);
    expect(isSendableRateUnit('percent_solution')).toBe(false);
    expect(isSendableRateUnit('tsp')).toBe(false);
  });
});
