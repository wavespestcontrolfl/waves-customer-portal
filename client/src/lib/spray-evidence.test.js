import { describe, expect, test } from 'vitest';
import {
  actionShowsSpray, hasSprayMethod, isNonBaitPesticide, rowsShowSpray, sprayEvidence, sprayProductFromRow, sprayProductFromSelection,
} from './spray-evidence';

const bait = { method: 'bait_placement', category: 'Termite Bait', name: 'Example Termite Bait Cartridge', activeIngredient: 'noviflumuron' };
const station = { method: 'station_check', category: 'Monitoring', name: 'Example Station Monitor' };
const liquid = { method: 'spot_treatment', category: 'Insecticide', name: 'Example Liquid SC', activeIngredient: 'bifenthrin' };
const methodless = { method: 'station_check', category: 'Termiticide', name: 'Example Termiticide Foam' };
const trunk = { method: 'trunk_injection', category: 'micronutrient', name: 'Example Trunk Feed' };

describe('sprayEvidence', () => {
  test.each([
    ['nothing recorded', { products: [] }, false],
    ['a bait station visit with only bait rows', { products: [bait] }, false],
    ['bait and station rows', { products: [bait, station] }, false],
    ['bait plus a liquid spray', { products: [bait, liquid] }, true],
    ['a methodless termiticide under the defaulted station_check, by identity', { products: [methodless] }, true],
    ['a trunk injection only', { products: [trunk] }, false],
    ['a granular broadcast', { products: [{ method: 'granular_broadcast', name: 'Example Granule' }] }, true],
    ['an empty method on a plain product', { products: [{ method: '', name: 'Example Product' }] }, false],
    ['a protocol action that applied a treatment', { actionScopes: [{ treatmentApplied: true }] }, true],
    ['a protocol action that applied a treatment with no dry-down', { actionScopes: [{ treatmentApplied: true, dryDown: false }] }, false],
    ['an inspection action', { actionScopes: [{ treatmentApplied: false }, undefined] }, false],
    ['bait rows and a treatment action', { products: [bait], actionScopes: [{ treatmentApplied: true, dryDown: true }] }, true],
  ])('%s', (_name, input, expected) => {
    expect(sprayEvidence(input)).toBe(expected);
  });
});

describe('the pieces', () => {
  test('a method is a spray unless it is empty, a bait placement, a station check or a trunk injection (any spelling)', () => {
    expect(hasSprayMethod('perimeter_spray')).toBe(true);
    expect(hasSprayMethod('Bait Placement')).toBe(false);
    expect(hasSprayMethod('station-check')).toBe(false);
    expect(hasSprayMethod('trunk_injection')).toBe(false);
    expect(hasSprayMethod(undefined)).toBe(false);
  });

  test('identity: a pesticide class, an EPA number or a listed active counts; a bait family name never does', () => {
    expect(isNonBaitPesticide({ category: 'Insecticide', name: 'Example A' })).toBe(true);
    expect(isNonBaitPesticide({ productType: 'Termiticide', name: 'Example B' })).toBe(true);
    expect(isNonBaitPesticide({ category: 'adjuvant', name: 'Example C', epaRegNumber: ' 432-1234 ' })).toBe(true);
    expect(isNonBaitPesticide({ category: 'adjuvant', name: 'Example D', activeIngredient: 'surfactant' })).toBe(true);
    expect(isNonBaitPesticide({ category: 'adjuvant', name: 'Example E' })).toBe(false);
    expect(isNonBaitPesticide({ category: 'Insecticide', name: 'Example Gel Bait', epaRegNumber: '432-1' })).toBe(false);
    expect(isNonBaitPesticide({ category: 'Insecticide', productType: 'monitor', name: 'Example F' })).toBe(false);
  });

  test('a protocol action counts only with a treatment applied and a dry-down left', () => {
    expect(actionShowsSpray({ treatmentApplied: true })).toBe(true);
    expect(actionShowsSpray({ treatmentApplied: true, dryDown: false })).toBe(false);
    expect(actionShowsSpray({ treatmentApplied: false })).toBe(false);
    expect(actionShowsSpray(undefined)).toBe(false);
  });
});

describe('the adapters', () => {
  test('the full form takes the catalog row\'s type and EPA number by product id', () => {
    const catalog = [{ id: 'p-1', product_type: 'Termiticide', epa_reg_number: '432-9' }];
    expect(sprayProductFromSelection({ productId: 'p-1', name: 'Example', category: 'adjuvant', activeIngredient: '', applicationMethod: 'station_check' }, catalog)).toEqual({
      method: 'station_check', category: 'adjuvant', name: 'Example', activeIngredient: '', productType: 'Termiticide', epaRegNumber: '432-9',
    });
    expect(sprayEvidence({ products: [sprayProductFromSelection({ productId: 'p-1', name: 'Example', category: 'adjuvant', method: 'station_check' }, catalog)] })).toBe(true);
    expect(sprayEvidence({ products: [sprayProductFromSelection({ productId: 'p-1', name: 'Example', category: 'adjuvant', method: 'station_check' }, [])] })).toBe(false);
  });

  test('a sheet row reads its own catalog product; a field the sheet\'s catalog lacks cannot count', () => {
    const baitRow = { name: 'Example Bait', product: { category: 'Termite Bait', active_ingredient: 'noviflumuron' } };
    const sprayRow = { name: 'Example Spray', product: { category: 'Insecticide' } };
    const plainRow = { name: 'Example Micronutrient', product: { category: 'micronutrient' } };
    expect(sprayProductFromRow(sprayRow, 'spot_treatment')).toMatchObject({ method: 'spot_treatment', category: 'Insecticide', name: 'Example Spray' });
    expect(rowsShowSpray([baitRow], () => 'bait_placement')).toBe(false);
    expect(rowsShowSpray([baitRow, sprayRow], (row) => (row === baitRow ? 'bait_placement' : 'spot_treatment'))).toBe(true);
    expect(rowsShowSpray([plainRow], () => 'trunk_injection')).toBe(false);
    expect(rowsShowSpray([plainRow], () => 'foliar_spray')).toBe(true);
    expect(rowsShowSpray([], () => 'spot_treatment')).toBe(false);
  });
});
