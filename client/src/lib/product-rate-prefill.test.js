import { expect, it } from 'vitest';
import {
  applyTankDose, clearTankOnUnitChange, derivedTankTotal, followTank, isPerGallonUnit,
  isTankCalculation, markTankEntry, promoteTankOwner, tankOwnerRow, tankPropagates,
} from './product-rate-prefill';

const row = (over = {}) => ({ productId: 'p', rateUnit: 'fl_oz/gal', rate: '0.8', carrierGallons: '', amountUnit: 'fl_oz', ...over });

it('recognises a per-gallon rate and a measured tank calculation', () => {
  expect(['fl_oz/gal', 'oz/gal', 'g/gal'].every(isPerGallonUnit)).toBe(true);
  expect(['fl_oz', 'g/spot', 'oz/acre', 'lb/100sf', '', null].some(isPerGallonUnit)).toBe(false);
  // Gallons are what turn a concentration into an applied quantity.
  expect(isTankCalculation(row())).toBe(false);
  expect(isTankCalculation(row({ carrierGallons: '25' }))).toBe(true);
  expect(isTankCalculation(row({ rateUnit: 'fl_oz', carrierGallons: '25' }))).toBe(false);
});

it('keeps the precision the record stores and refuses an unusable pair', () => {
  expect(derivedTankTotal('0.03', '0.5')).toBe(0.015);
  expect(derivedTankTotal('0.8', '25')).toBe(20);
  expect([['', '25'], ['0.8', ''], ['0.8', '0'], ['-1', '25'], [null, null]]
    .map(([r, g]) => derivedTankTotal(r, g))).toEqual(['', '', '', '', '']);
});

it('a dose follows the volume, clears without one, and never outranks an entered total', () => {
  expect(applyTankDose(row({ carrierGallons: '25' }))).toMatchObject({ totalAmount: 20, amountUnit: 'fl_oz' });
  // The unit is the rate's, never a hand-picked one: 20 fl oz, not 20 gal.
  expect(applyTankDose(row({ carrierGallons: '25', amountUnit: 'gal' })).amountUnit).toBe('fl_oz');
  expect(applyTankDose(row({ carrierGallons: '', totalAmount: 20 })).totalAmount).toBe('');
  expect(applyTankDose(row({ carrierGallons: '25', totalAmount: '26', totalAmountManual: true }))).toMatchObject({ totalAmount: '26' });
  expect(applyTankDose(row({ rateUnit: 'fl_oz', totalAmount: 5 })).totalAmount).toBe(5);
});

it('only the tank owner propagates, and only followers take the volume', () => {
  const owner = row({ productId: 'a', carrierGallons: '25', carrierGallonsManual: true, tankOwner: true });
  const follower = row({ productId: 'b', rate: '2', carrierGallons: '25' });
  const detached = row({ productId: 'c', rate: '4', carrierGallons: '10', carrierGallonsManual: true });
  const rows = [owner, follower, detached];
  expect(tankOwnerRow(rows)).toBe(owner);
  expect(tankPropagates(rows, 'a', 'carrierGallons')).toBe(true);
  expect(tankPropagates(rows, 'c', 'carrierGallons')).toBe(false);
  expect(tankPropagates(rows, 'a', 'rate')).toBe(false);
  // Nobody owns the tank yet: the first entry sets it.
  expect(tankPropagates([follower], 'b', 'carrierGallons')).toBe(true);
  expect(followTank(follower, '30')).toMatchObject({ carrierGallons: '30', totalAmount: 60 });
  expect(followTank(detached, '30')).toBe(detached);
  expect(followTank(row({ rateUnit: 'fl_oz' }), '30')).toMatchObject({ rateUnit: 'fl_oz' });
});

it('marks an entry, claims a free owner slot, and retires the tank with the unit', () => {
  expect(markTankEntry(row(), null)).toMatchObject({ carrierGallonsManual: true, tankOwner: true });
  expect(markTankEntry(row(), row({ productId: 'a' })).tankOwner).toBeUndefined();
  expect(clearTankOnUnitChange(row({ rateUnit: 'g', carrierGallons: '25', tankOwner: true }), 'fl_oz/gal'))
    .toMatchObject({ carrierGallons: '', carrierGallonsManual: false, tankOwner: false });
  // Still per-gallon, or never was: nothing to retire.
  expect(clearTankOnUnitChange(row({ rateUnit: 'oz/gal', carrierGallons: '25' }), 'fl_oz/gal').carrierGallons).toBe('25');
  expect(clearTankOnUnitChange(row({ rateUnit: 'g', carrierGallons: '25' }), 'fl_oz').carrierGallons).toBe('25');
});

it('the tank outlives its owner, but a detached row never inherits it', () => {
  const follower = row({ productId: 'b', carrierGallons: '25' });
  const detached = row({ productId: 'c', carrierGallons: '10', carrierGallonsManual: true });
  // A detached row holds its own mix: promoting it would let its next edit
  // rewrite the rows that were following the removed owner.
  expect(promoteTankOwner([detached, follower]).map((r) => !!r.tankOwner)).toEqual([false, true]);
  // No follower left means no shared tank, not a new owner.
  expect(promoteTankOwner([detached]).map((r) => !!r.tankOwner)).toEqual([false]);
  const owned = row({ productId: 'a', carrierGallons: '25', tankOwner: true });
  expect(promoteTankOwner([owned, follower])).toEqual([owned, follower]);
});
