// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  carrierOf, gallonsBodyFields, gallonsTooLarge, gallonsToArea, maxGallons, mixHelpOf, mixLine, rememberTank, rememberedTank, weedCarrier, weedMixLines, withGallonsArea,
} from './lawn-mix-help';

const dose = (text, coversSqft = 1000) => ({ text, coversSqft });
const entry = (over = {}) => ({ name: 'X', carrierGalPer1000: 1, perTank: { 1: dose('a'), 2: dose('b', 2000), 4: dose('c', 4000) }, per1000: 'p', note: null, ...over });
const HELP = { tanks: [1, 2, 4], weedOrder: ['aaa', 'bbb', 'ccc'], rows: { aaa: entry(), bbb: entry({ carrierGalPer1000: 1 }), ccc: entry({ carrierGalPer1000: null, perTank: { 1: dose('s', null), 2: dose('t', null), 4: dose('u', null) }, concentration: '0.25% v/v' }) } };

describe('mixHelpOf', () => {
  test('reads the block, lower-casing ids', () => {
    const out = mixHelpOf({ plannedProducts: { mixHelp: { v: 1, tanks: [1, 2, 4], rows: { AAA: entry() }, weedOrder: ['AAA'] } } });
    expect(out.tanks).toEqual([1, 2, 4]);
    expect(Object.keys(out.rows)).toEqual(['aaa']);
    expect(out.weedOrder).toEqual(['aaa']);
  });
  test.each([[undefined], [{}], [{ plannedProducts: {} }], [{ plannedProducts: { mixHelp: { v: 2, tanks: [1], rows: {} } } }], [{ plannedProducts: { mixHelp: { v: 1, tanks: [], rows: {} } } }], [{ plannedProducts: { mixHelp: { v: 1, tanks: [1], rows: [] } } }]])('%j: null', (data) => {
    expect(mixHelpOf(data)).toBeNull();
  });
});

describe('the remembered tank', () => {
  afterEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
  test('the largest tank when nothing is stored; the stored one when the server offers it', () => {
    expect(rememberedTank('t1', [1, 2, 4])).toBe(4);
    rememberTank('t1', 2);
    expect(rememberedTank('t1', [1, 2, 4])).toBe(2);
    expect(rememberedTank('t2', [1, 2, 4])).toBe(4);
    expect(rememberedTank('t1', [1, 4])).toBe(4);
  });
  test('storage that throws is not an error', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(rememberedTank('t1', [1, 2, 4])).toBe(4);
    expect(() => rememberTank('t1', 2)).not.toThrow();
  });
});

describe('mixLine', () => {
  test('a full-tank line with what it covers; the per-1,000 dose without a carrier; nothing otherwise', () => {
    expect(mixLine(entry(), 2)).toEqual({ text: '2 gal tank: b', covers: 'Covers about 2,000 sq ft.' });
    expect(mixLine(entry({ perTank: null }), 2)).toEqual({ text: 'Per 1,000 sq ft: p', covers: null });
    expect(mixLine(entry({ perTank: null, per1000: null }), 2)).toBeNull();
    expect(mixLine(null, 2)).toBeNull();
    expect(mixLine(entry({ perTank: { 2: dose('s', null) } }), 2)).toEqual({ text: '2 gal tank: s', covers: null });
  });
});

describe('weedMixLines', () => {
  const rows = [{ productId: 'CCC', name: 'Surf' }, { productId: 'AAA', name: 'Lead' }, { productId: 'BBB', name: 'Cert' }];
  test('in the server\'s order when it lists every product on the card', () => {
    const out = weedMixLines(HELP, rows, 2);
    expect(out.order).toEqual(['Lead', 'Cert', 'Surf']);
    expect(out.lines.map((line) => line.name)).toEqual(['Lead', 'Cert', 'Surf']);
  });
  test('no order when a product on the card is not listed, or when the card has one product', () => {
    expect(weedMixLines({ ...HELP, weedOrder: ['aaa', 'ccc'] }, rows, 2).order).toBeNull();
    expect(weedMixLines(HELP, [rows[1]], 2).order).toBeNull();
    expect(weedMixLines({ ...HELP, weedOrder: null }, rows, 2).order).toBeNull();
  });
  test('a product with no entry is left out of the lines and breaks the order', () => {
    const out = weedMixLines(HELP, [...rows, { productId: 'ZZZ', name: 'Other' }], 2);
    expect(out.lines).toHaveLength(3);
    expect(out.order).toBeNull();
  });
  test('the label lines of the entries ride along', () => {
    const labelled = { ...HELP, rows: { ...HELP.rows, aaa: entry({ labelLines: [{ text: 't', source: 's' }] }) } };
    expect(weedMixLines(labelled, rows, 2).labelLines).toEqual([{ text: 't', source: 's' }]);
  });
});

describe('gallons sprayed', () => {
  test.each([[2, 1, 2000], [1, 4, 250], [0.5, 1, 500], [3, 2, 1500], [0.0001, 1, 1]])('%s gal at %s -> %s sq ft (the server\'s own table)', (gallons, carrier, expected) => {
    expect(gallonsToArea(gallons, carrier)).toBe(expected);
  });
  test.each([[0, 1], [-1, 1], ['x', 1], [null, 1], [2, 0], [2, null], [2, 'x']])('%s gal at %s -> null', (gallons, carrier) => {
    expect(gallonsToArea(gallons, carrier)).toBeNull();
  });

  test('the bound is the server\'s: ten fills of the largest tank (40 with 1, 2 and 4); past it, or on overflow, no area', () => {
    expect(maxGallons([1, 2, 4])).toBe(40);
    expect(maxGallons([1, 2])).toBe(20);
    expect(maxGallons(undefined)).toBe(40);
    expect(gallonsToArea(40, 1)).toBe(40000);
    expect(gallonsToArea(40.01, 1)).toBeNull();
    expect(gallonsToArea(1e308, 1)).toBeNull();
    expect(gallonsToArea(1, 1e-320)).toBeNull();
    expect(gallonsToArea(21, 1, [1, 2])).toBeNull();
    expect(gallonsTooLarge('41', [1, 2, 4])).toBe(true);
    expect(gallonsTooLarge('40', [1, 2, 4])).toBe(false);
    expect(gallonsTooLarge('', [1, 2, 4])).toBe(false);
    expect(gallonsTooLarge('x', [1, 2, 4])).toBe(false);
  });

  test('a plain spot row takes its own gallons; a weed row the entry\'s; the surfactant and a row with no carrier none', () => {
    const spot = { productId: 'AAA', spotRule: true, spotGallons: '2', spotArea: null };
    expect(withGallonsArea(spot, { help: HELP, weedGallons: '' })).toMatchObject({ spotArea: 2000, areaFromGallons: 2 });
    const weed = { productId: 'BBB', spotRule: true, weedGroup: true };
    expect(withGallonsArea(weed, { help: HELP, weedGallons: '1' })).toMatchObject({ spotArea: 1000, areaFromGallons: 1 });
    expect(withGallonsArea({ ...weed, spotExempt: true }, { help: HELP, weedGallons: '1' })).not.toHaveProperty('areaFromGallons');
    expect(withGallonsArea({ ...spot, productId: 'CCC' }, { help: HELP, weedGallons: '' })).not.toHaveProperty('areaFromGallons');
    expect(withGallonsArea({ ...spot, spotRule: false }, { help: HELP, weedGallons: '' })).not.toHaveProperty('areaFromGallons');
    expect(withGallonsArea({ ...spot, spotGallons: '' }, { help: HELP, weedGallons: '' })).not.toHaveProperty('areaFromGallons');
  });

  test('the body field only for a row whose area came from gallons', () => {
    expect(gallonsBodyFields({ areaFromGallons: 2 })).toEqual({ sprayedGallons: 2 });
    expect(gallonsBodyFields({})).toEqual({});
  });

  test('the weed entry\'s carrier is the one volume its sized rows share', () => {
    const rows = [{ productId: 'AAA' }, { productId: 'BBB' }, { productId: 'CCC', spotExempt: true }];
    expect(weedCarrier(HELP, rows)).toBe(1);
    expect(weedCarrier({ ...HELP, rows: { ...HELP.rows, bbb: entry({ carrierGalPer1000: 2 }) } }, rows)).toBeNull();
    expect(weedCarrier({ ...HELP, rows: { ...HELP.rows, bbb: entry({ carrierGalPer1000: null }) } }, rows)).toBeNull();
    expect(carrierOf(HELP, 'ccc')).toBeNull();
  });
});
