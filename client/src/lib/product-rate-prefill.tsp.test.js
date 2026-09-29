// A Total the tech did not type (a tank dose, a rate x area total, a house
// seed) reads in spoons when tsp is picked (6 tsp to the fl oz, owner ruling
// 2026-09-27) and is never relabeled into or out of tsp.
import { describe, expect, it } from 'vitest';
import { amountInUnit, applyTankDose } from './product-rate-prefill';

describe('amountInUnit', () => {
  it('converts between fl oz and tsp at the four decimals a derived dose keeps', () => {
    expect(amountInUnit(0.25, 'fl_oz', 'tsp')).toBe(1.5);
    expect(amountInUnit(1.5, 'tsp', 'fl_oz')).toBe(0.25);
    expect(amountInUnit(0.4, 'fl_oz', 'tsp')).toBe(2.4);
    expect(amountInUnit(2.4, 'tsp', 'fl_oz')).toBe(0.4);
    expect(amountInUnit('0.3333', 'fl_oz', 'tsp')).toBe(1.9998);
  });

  it('withdraws any other change to or from tsp: a bare oz may be a dry weight', () => {
    expect(amountInUnit(4, 'oz', 'tsp')).toBe('');
    expect(amountInUnit(12, 'tsp', 'oz')).toBe('');
    expect(amountInUnit(1, 'gal', 'tsp')).toBe('');
    expect(amountInUnit(3, undefined, 'tsp')).toBe('');
  });

  it('leaves a blank blank and every change between other units to its caller', () => {
    expect(amountInUnit('', 'fl_oz', 'tsp')).toBe('');
    expect(amountInUnit(null, 'tsp', 'fl_oz')).toBeNull();
    expect(amountInUnit(20, 'fl_oz', 'gal')).toBe(20);
    expect(amountInUnit('3', 'fl_oz', 'fl_oz')).toBe('3');
    expect(amountInUnit(2, 'tsp', 'tsp')).toBe(2);
  });
});

describe('applyTankDose with tsp picked', () => {
  const tank = { rateUnit: 'fl_oz/gal', rate: 0.2, carrierGallons: '', totalAmount: '', totalAmountManual: false };

  it('keeps tsp on a fl oz tank and shows the dose in spoons', () => {
    expect(applyTankDose({ ...tank, amountUnit: 'tsp' })).toMatchObject({ amountUnit: 'tsp', totalAmount: '' });
    expect(applyTankDose({ ...tank, amountUnit: 'tsp', carrierGallons: '2' })).toMatchObject({ amountUnit: 'tsp', totalAmount: 2.4 });
    expect(applyTankDose({ ...tank, amountUnit: 'fl_oz', carrierGallons: '2' })).toMatchObject({ amountUnit: 'fl_oz', totalAmount: 0.4 });
  });

  it('reads any other picked unit, or tsp on a dry tank, in the rate\'s own unit as before', () => {
    expect(applyTankDose({ ...tank, amountUnit: 'gal', carrierGallons: '2' })).toMatchObject({ amountUnit: 'fl_oz', totalAmount: 0.4 });
    expect(applyTankDose({ ...tank, rateUnit: 'oz/gal', amountUnit: 'tsp', carrierGallons: '2' })).toMatchObject({ amountUnit: 'oz', totalAmount: 0.4 });
  });

  it('leaves a typed spoon count and a seed with no gallons alone', () => {
    const typed = { ...tank, amountUnit: 'tsp', totalAmount: '3', totalAmountManual: true, carrierGallons: '2' };
    expect(applyTankDose(typed)).toBe(typed);
    const seeded = { ...tank, amountUnit: 'tsp', totalAmount: 1.5, totalAmountManual: true, totalAmountSeeded: true };
    expect(applyTankDose(seeded)).toBe(seeded);
    expect(applyTankDose({ ...seeded, carrierGallons: '2' })).toMatchObject({ amountUnit: 'tsp', totalAmount: 2.4, totalAmountSeeded: false });
  });
});
