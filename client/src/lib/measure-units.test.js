import { describe, expect, it } from 'vitest';
import { TSP_PER_FL_OZ, hasMlAmount, isMlUnit, mlToFlOz, submittedAmount } from './measure-units';

// The truck measures every completion form shares (owner ruling 2026-09-27;
// every service 2026-09-29): nothing a tech sees or enters is in mL.

describe('isMlUnit', () => {
  it('recognises any unit whose base is mL, whatever its case or basis', () => {
    for (const unit of [
      'ml', 'mL', 'ML', ' ml ', 'mL/gal', 'ml/gal', 'ml/inch dbh', 'ml/palm',
      'cc', 'CC/gal', 'milliliter', 'milliliters', 'millilitre', 'Millilitres',
    ]) {
      expect(isMlUnit(unit), unit).toBe(true);
    }
  });

  it('leaves the truck measures and anything that is not a unit alone', () => {
    for (const unit of ['fl_oz', 'fl_oz/gal', 'fl_oz/100gal', 'oz', 'gal', 'tsp', 'g/spot', 'lb/1000sf', 'mls', 'mls?', 'mg', '', null, undefined]) {
      expect(isMlUnit(unit), String(unit)).toBe(false);
    }
  });
});

describe('mlToFlOz', () => {
  it('converts at the three decimals the record keeps', () => {
    expect(mlToFlOz(29.5735)).toBe(1);
    expect(mlToFlOz(30)).toBe(1.014);
    expect(mlToFlOz(5)).toBe(0.169);
    expect(mlToFlOz(1.25)).toBe(0.042);
    expect(mlToFlOz('10')).toBe(0.338);
    expect(mlToFlOz(0)).toBe(0);
  });

  it('hands back a value it cannot read instead of inventing a number', () => {
    expect(mlToFlOz('1-6')).toBe('1-6');
    expect(mlToFlOz(undefined)).toBeUndefined();
  });
});

describe('submittedAmount', () => {
  it('sends a spoon amount as fl oz, rounded up so it reads back as the same spoons', () => {
    expect(TSP_PER_FL_OZ).toBe(6);
    expect(submittedAmount(0.5, 'tsp')).toEqual({ totalAmount: 0.084, amountUnit: 'fl_oz' });
    expect(submittedAmount(1, 'tsp')).toEqual({ totalAmount: 0.167, amountUnit: 'fl_oz' });
    expect(submittedAmount(3, 'tsp')).toEqual({ totalAmount: 0.5, amountUnit: 'fl_oz' });
    expect(submittedAmount('1.5', 'tsp')).toEqual({ totalAmount: 0.25, amountUnit: 'fl_oz' });
    expect(submittedAmount(6, 'tsp')).toEqual({ totalAmount: 1, amountUnit: 'fl_oz' });
    // Every half spoon up to 2 fl oz: never under the spoons measured, and
    // never more than 0.001 fl oz over them.
    for (let halves = 1; halves <= 24; halves += 1) {
      const tsp = halves / 2;
      const { totalAmount } = submittedAmount(tsp, 'tsp');
      expect(totalAmount * TSP_PER_FL_OZ, `${tsp} tsp`).toBeGreaterThanOrEqual(tsp - 1e-9);
      expect(totalAmount - tsp / TSP_PER_FL_OZ, `${tsp} tsp`).toBeLessThan(0.001);
    }
  });

  it('keeps a blank spoon amount blank, never a 0 the server would refuse', () => {
    expect(submittedAmount('', 'tsp')).toEqual({ totalAmount: '', amountUnit: 'fl_oz' });
    expect(submittedAmount(null, 'tsp')).toEqual({ totalAmount: null, amountUnit: 'fl_oz' });
  });

  it('sends any other unit as the number entered, in that unit', () => {
    expect(submittedAmount('4', 'fl_oz')).toEqual({ totalAmount: 4, amountUnit: 'fl_oz' });
    expect(submittedAmount(2, 'gal')).toEqual({ totalAmount: 2, amountUnit: 'gal' });
    expect(submittedAmount('5.5', 'g')).toEqual({ totalAmount: 5.5, amountUnit: 'g' });
  });
});

describe('hasMlAmount', () => {
  it('finds an amount written in mL in free text, such as an injection dose', () => {
    for (const text of ['20 mL', '20ml', '20ML', '5 cc', '5cc', '2 milliliters', '1 millilitre', '10 mL per inch DBH', 'ml']) {
      expect(hasMlAmount(text)).toBe(true);
    }
  });

  it('leaves the truck measures and ordinary words alone', () => {
    for (const text of ['½ fl oz', '4 tsp', '1.5 oz', '2 gal', 'accurate to the label', 'small', '', null, undefined]) {
      expect(hasMlAmount(text)).toBe(false);
    }
  });
});

