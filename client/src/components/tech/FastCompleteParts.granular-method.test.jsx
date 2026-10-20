// @vitest-environment jsdom
// A granular product never starts on a spray method (wrong "Broadcast spray" on a 0.25G record,
// owner 2026-10-20). Synthetic products only.
import { describe, expect, test } from 'vitest';
import { isGranularProduct, startMethodFor } from './FastCompleteParts';

describe('isGranularProduct', () => {
  test.each([
    [{ name: 'Arena 0.25G', category: 'insecticide' }, true],
    [{ name: 'Headway G', category: 'fungicide' }, true],
    [{ name: 'Dylox 6.2 G Granular Insecticide' }, true],
    [{ name: 'Test Feed', formulation: 'granular' }, true],
    [{ name: 'Test Feed', formulation: 'GR' }, true],
    [{ name: 'Test Feed', category: 'Granular insecticide' }, true],
    [{ name: 'Celsius WG', formulation: 'WG', category: 'herbicide' }, false],
    [{ name: 'Prodiamine 65 WDG', formulation: 'WDG' }, false],
    [{ name: 'Talak 7.9%', formulation: 'SC', category: 'insecticide' }, false],
    [{ name: 'Gold Standard', formulation: 'liquid' }, false],
    [null, false],
  ])('%j -> %s', (product, expected) => {
    expect(isGranularProduct(product)).toBe(expected);
  });
});

describe('startMethodFor', () => {
  const granular = { name: 'Arena 0.25G', formulation: 'granular' };
  const liquid = { name: 'Talak 7.9%', formulation: 'SC' };

  test('moves a granular product off every spray method', () => {
    for (const method of ['broadcast_spray', 'foliar_spray', 'perimeter_spray', 'Broadcast spray']) {
      expect(startMethodFor(granular, method)).toBe('granular_broadcast');
    }
  });

  test('leaves granular on its own, spot and drench methods, and every other product, alone', () => {
    expect(startMethodFor(granular, 'granular_broadcast')).toBe('granular_broadcast');
    expect(startMethodFor(granular, 'spot_treatment')).toBe('spot_treatment');
    expect(startMethodFor(granular, 'soil_drench')).toBe('soil_drench');
    expect(startMethodFor(granular, undefined)).toBeUndefined();
    expect(startMethodFor(liquid, 'broadcast_spray')).toBe('broadcast_spray');
  });

  test('changes nothing while the correction is off', () => {
    expect(startMethodFor(granular, 'broadcast_spray', false)).toBe('broadcast_spray');
    expect(startMethodFor(granular, 'broadcast_spray', undefined)).toBe('granular_broadcast');
  });
});
