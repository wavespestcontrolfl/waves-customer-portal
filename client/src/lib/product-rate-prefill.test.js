import { expect, it } from 'vitest';
import {
  applyTankDose, clearTankOnUnitChange, derivedTankTotal, followTank, isPerGallonUnit,
  isTankCalculation, joinTankOnUnitChange, markTankEntry, promoteTankOwner, tankOwnerRow, tankPropagates,
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
  expect(markTankEntry(row({ carrierGallons: '25' }), null)).toMatchObject({ carrierGallonsManual: true, tankOwner: true });
  // Someone already owns the tank: this row detaches, it does not take over.
  expect(markTankEntry(row({ carrierGallons: '10' }), row({ productId: 'a' }))).toMatchObject({ carrierGallonsManual: true, tankOwner: false });
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

it('an owner with no volume owns nothing, so the next entry establishes the tank', () => {
  const empty = row({ productId: 'a', carrierGallons: '', tankOwner: true, carrierGallonsManual: true });
  const other = row({ productId: 'b', rate: '2' });
  expect(tankOwnerRow([empty, other])).toBeNull();
  // So an entry on another row propagates rather than detaching against it.
  expect(tankPropagates([empty, other], 'b', 'carrierGallons')).toBe(true);
  expect(markTankEntry(row({ carrierGallons: '25' }), null).tankOwner).toBe(true);
  // Clearing your own gallons gives up both the claim and the independence.
  expect(markTankEntry(row({ productId: 'a', carrierGallons: '', tankOwner: true, carrierGallonsManual: true }), null))
    .toMatchObject({ tankOwner: false, carrierGallonsManual: false });
});

it('a row converted into a per-gallon rate joins the tank already mixed', () => {
  const owner = row({ productId: 'a', carrierGallons: '25', tankOwner: true, carrierGallonsManual: true });
  const converted = joinTankOnUnitChange(row({ productId: 'b', rateUnit: 'fl_oz/gal', rate: '2', amountUnit: 'fl_oz' }), 'fl_oz', owner);
  expect(converted).toMatchObject({ carrierGallons: '25', carrierGallonsManual: false, totalAmount: 50 });
  // No tank yet, or not a conversion into one: nothing to join.
  expect(joinTankOnUnitChange(row({ rateUnit: 'fl_oz/gal' }), 'fl_oz', null).carrierGallons).toBe('');
  expect(joinTankOnUnitChange(row({ rateUnit: 'fl_oz' }), 'fl_oz/gal', owner).carrierGallons).toBe('');
  expect(joinTankOnUnitChange(row({ rateUnit: 'oz/gal', carrierGallons: '10' }), 'fl_oz/gal', owner).carrierGallons).toBe('10');
});

it('clearing an override rejoins the active tank at once', () => {
  const owner = row({ productId: 'a', carrierGallons: '25', tankOwner: true, carrierGallonsManual: true });
  const cleared = row({ productId: 'b', rate: '2', carrierGallons: '', carrierGallonsManual: true });
  expect(markTankEntry(cleared, owner)).toMatchObject({
    carrierGallons: '25', carrierGallonsManual: false, tankOwner: false, totalAmount: 50,
  });
  // The owner clearing its own gallons is the other case: that clear has
  // already travelled to the followers, so it just gives up the tank.
  expect(markTankEntry(row({ productId: 'a', carrierGallons: '', tankOwner: true }), owner))
    .toMatchObject({ carrierGallons: '', tankOwner: false, carrierGallonsManual: false });
});

it('a stated carrier volume replaces a seeded house total, but never an entered one', () => {
  const seeded = row({ totalAmount: 4, totalAmountManual: true, totalAmountSeeded: true });
  // No volume yet: the house default stands.
  expect(applyTankDose(seeded)).toMatchObject({ totalAmount: 4, totalAmountSeeded: true });
  // With one, the seed gives way and the row is derived from here on.
  expect(applyTankDose({ ...seeded, carrierGallons: '10' })).toMatchObject({
    totalAmount: 8, totalAmountManual: false, totalAmountSeeded: false,
  });
  // A total the technician typed is untouchable either way.
  expect(applyTankDose(row({ carrierGallons: '10', totalAmount: 4, totalAmountManual: true })).totalAmount).toBe(4);
});
